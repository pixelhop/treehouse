// Owns the editable state for one file: the working buffer, the version it was
// loaded at, dirty tracking, and the explicit save (with version-CAS conflict
// handling). The markdown/code editors bind to `buffer`; WorkspaceView drives
// the Save button and ⌘/Ctrl-S. Live "changed on server" detection (U7) layers
// on top via `serverChanged` + `reload`.
import { useQueryClient } from "@tanstack/vue-query";
import type { Ref } from "vue";
// Relative, not `~/`: this composable is exercised by plain unit tests
// (test/fileEditorSave.test.ts), where the Nuxt alias does not resolve.
import { detectServerChange } from "../utils/changeFeed";
import { registerUnsavedWork } from "../utils/unsavedWork";
import type { FileEntry } from "~/composables/useTreehouseApi";

export interface FileConflict {
  /** Where the server stashed our rejected bytes (never lost). */
  conflictCopyPath?: string;
  currentVersion: number | null;
}

export function useFileEditor(workspaceId: Ref<string>, entry: Ref<FileEntry | null>) {
  const api = useTreehouseApi();
  const qc = useQueryClient();

  const buffer = ref("");
  // The bytes as last loaded/saved — the baseline for dirty detection.
  const loadedValue = ref("");
  const loadedVersion = ref<number | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const conflict = ref<FileConflict | null>(null);
  // Set by the change-feed poll (U7) when the open file's version advances on
  // the server while we're editing.
  const serverChanged = ref(false);

  const dirty = computed(() => buffer.value !== loadedValue.value);
  // Bumped by every successful save. A seeded editor can save before its
  // confirming read lands; that read then describes an older version and must
  // not overwrite the newer baseline the save just set.
  let saves = 0;

  // Announce unsaved edits to the global registry so the service-worker update
  // flow (plugins/pwa.client.ts) never reloads the page over a dirty buffer.
  onScopeDispose(registerUnsavedWork(() => dirty.value));

  // The reading view has almost always just shown this file, so its text is in
  // the viewers' cache: open the editor on it straight away instead of a
  // loading state, and confirm it against the server in load(). Saving from the
  // seed is safe even before that lands — the write is CAS'd on the listed
  // version, so if the cached text was newer or older than the server's the save
  // is refused into a conflict copy, never applied over someone's work.
  function seedFromCache(e: FileEntry): string | undefined {
    const seed = qc.getQueryData<string>(["file", workspaceId.value, e.path, e.version]);
    if (seed !== undefined) {
      loadedValue.value = seed;
      buffer.value = seed;
      loadedVersion.value = e.version;
    }
    return seed;
  }

  // The server's answer to load()'s read, for the file still open.
  function applyRead(read: { body: string; version: number }, seed: string | undefined) {
    if (seed !== undefined && buffer.value !== seed) {
      // Typed into the seed before the read landed. Keep the keystrokes; if the
      // server's text turned out different, say so rather than swap the
      // document out from under them.
      if (read.body === seed) loadedVersion.value = read.version;
      else serverChanged.value = true;
      return;
    }
    loadedValue.value = read.body;
    buffer.value = read.body;
    loadedVersion.value = read.version;
  }

  async function load() {
    const e = entry.value;
    if (!e) return;
    // Guard against a fast file-switch race: if the selection changed while this
    // read was in flight, drop the (now stale) result instead of clobbering the
    // buffer with the wrong file's bytes.
    const loadingPath = e.path;
    const stillOn = () => entry.value?.path === loadingPath;
    error.value = null;
    conflict.value = null;
    serverChanged.value = false;
    const seed = seedFromCache(e);
    // Set either way: a seeded open must also clear a loading state left by a
    // read of the previous file that is still in flight.
    loading.value = seed === undefined;
    const savesAtStart = saves;
    try {
      const { body, version } = await api.readFileWithMeta(workspaceId.value, loadingPath);
      if (!stillOn() || saves !== savesAtStart) return;
      applyRead({ body, version: version ?? e.version }, seed);
    } catch (err) {
      if (stillOn()) error.value = (err as Error).message;
    } finally {
      if (stillOn()) loading.value = false;
    }
  }

  async function save(): Promise<boolean> {
    const e = entry.value;
    if (!e || loadedVersion.value === null) return false;
    // Snapshot everything the request AND its completion need before the
    // await. The user can keep typing (buffer) or navigate (entry, workspace)
    // while the write is in flight; re-reading the refs afterwards would mark
    // unsent keystrokes as saved, or file the bytes under another file's — or
    // another workspace's — cache key.
    const wsId = workspaceId.value;
    const path = e.path;
    const body = buffer.value;
    const baseVersion = loadedVersion.value;
    const contentType = e.contentType;
    saving.value = true;
    error.value = null;
    try {
      const res = await api.writeFile(wsId, path, body, { baseVersion, contentType });
      // Editor-local state (clean marker, version, conflict banner) belongs to
      // the file that was SAVED — if the selection moved on mid-flight, leave
      // the new file's state alone. Cache writes below are keyed by the
      // snapshots and are correct either way.
      const stillHere = entry.value?.path === path && workspaceId.value === wsId;
      if (res.ok) {
        // The bytes the server just accepted ARE the new version — seed both
        // text caches so surfaces keyed on version render the save without a
        // refetch round-trip. Two keys on purpose: "file" is the viewers'
        // cache (filled by head reads), "file-version" is the changes diff's
        // exact-version namespace, kept separate so a head read can never
        // masquerade as a specific revision. Without these, the entries
        // invalidation below advances the version first and the diff briefly
        // compares against nothing.
        qc.setQueryData(["file", wsId, path, res.version], body);
        qc.setQueryData(["file-version", wsId, path, res.version], body);
        // Keep the entries cache in sync so the new version flows to the tree
        // (and a subsequent delete/move uses a fresh If-Match, not a stale one).
        void qc.invalidateQueries({ queryKey: ["entries"] });
        void qc.invalidateQueries({ queryKey: ["changes"] });
        void qc.invalidateQueries({ queryKey: ["tags"] });
        if (stillHere) {
          saves++;
          // The SUBMITTED body, not buffer.value: keystrokes typed during the
          // await are not on the server and must stay dirty.
          loadedValue.value = body;
          loadedVersion.value = res.version;
          conflict.value = null;
          serverChanged.value = false;
        }
        return true;
      }
      // 412 — a concurrent write won; the server kept our bytes as a copy.
      if (stillHere) {
        conflict.value = {
          conflictCopyPath: res.conflictCopyPath,
          currentVersion: res.currentVersion,
        };
      }
      return false;
    } catch (err) {
      if (entry.value?.path === path && workspaceId.value === wsId) {
        error.value = (err as Error).message;
      }
      return false;
    } finally {
      saving.value = false;
    }
  }

  // Discard local edits and re-pull the latest server bytes/version.
  function reload() {
    return load();
  }

  function dismiss() {
    conflict.value = null;
    serverChanged.value = false;
  }

  // Re-load when the selected file changes (by path). A version bump from our
  // own save does NOT reload — that would clobber edits made after saving.
  watch(
    () => entry.value?.path ?? null,
    () => void load(),
    { immediate: true },
  );

  // Live collision detection: while a file is open, poll the change feed and
  // flag when someone else advances (or deletes) it underneath us.
  useChangeFeedPoll(
    workspaceId,
    computed(() => !!entry.value),
    (events) => {
      const e = entry.value;
      if (!e || loadedVersion.value === null) return;
      if (detectServerChange(events, e.path, loadedVersion.value)) serverChanged.value = true;
    },
  );

  return {
    buffer,
    dirty,
    loading,
    saving,
    error,
    conflict,
    serverChanged,
    loadedVersion,
    load,
    save,
    reload,
    dismiss,
  };
}