// Shared workspace state. Server reads (workspace + file list) go through
// vue-query so the sidebar tree and the workspace page share one cache. The
// open file is URL-driven (/w/<workspaceId>/<path>) so files are linkable and
// back/forward works — selection is derived from the route, not stored.
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { contentTypeFor, isSafeRelPath } from "shared";
import { mapPool } from "~/utils/concurrency";
import { ACTIVE_WS_KEY } from "~/utils/workspaceState";
import { accessAt, buildTree, findNode, type TreeEntry } from "~/utils/treehouse";
import { uniqueName, uploadPath } from "~/utils/upload";

/** How to handle files whose name already exists in the destination folder. */
export type UploadStrategy = "overwrite" | "skip" | "keep-both";

// Persisted per-browser so the "current" workspace survives leaving the /w route.
export const LAST_WS_KEY = "th:lastWorkspaceId";

// ACTIVE_WS_KEY (utils/workspaceState.ts) is where the resolved id is
// republished for lightweight consumers — see there for why.

// The file a create just opened, which the workspace view should open straight
// into the editor rather than dropping the user on a blank rendered page. Shared
// state because the sidebar creates the file and the workspace view acts on it;
// each holds its own `useWorkspaceData()` instance.
export const PENDING_EDIT_KEY = "th:pendingEditPath";

/** What a move left undone (see moveTo). */
interface MoveProblems {
  /** Files that didn't move. */
  failed: string[];
  /** Files the server declined to move yet: it is still indexing links. */
  pending: string[];
  /** Notes whose links to a moved file couldn't be updated. */
  unlinked: string[];
}

/** The HTTP status of a failed $fetch, whichever field this ofetch version sets. */
function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number } | null;
  return e?.status ?? e?.statusCode;
}

export function useWorkspaceData() {
  const api = useTreehouseApi();
  const qc = useQueryClient();
  const route = useRoute();
  const pendingEditPath = useState<string | null>(PENDING_EDIT_KEY, () => null);
  const tabs = useWorkspaceTabs();

  // The list is every workspace the signed-in user is a member of, so key the
  // cache by user id — otherwise signing out and back in as someone else would
  // keep serving the previous person's workspaces until the staleTime elapses.
  const session = useAuthClient().useSession();
  const userId = computed(() => session.value.data?.user?.id ?? null);

  // Every workspace the user belongs to — drives the switcher and provides a
  // fallback "current" workspace when the route doesn't carry one (e.g. /dashboard).
  const workspacesQuery = useQuery({
    queryKey: ["workspaces", userId],
    queryFn: () => api.listWorkspaces().then((r) => r.workspaces),
    staleTime: 5 * 60 * 1000,
  });
  const workspaces = computed(() => workspacesQuery.data.value ?? []);

  const routeWsId = computed(() => route.params.workspaceId as string | undefined);

  // Remember the last workspace actually opened, so leaving the workspace route
  // (e.g. to the dashboard) and coming back doesn't snap to the first one.
  const lastOpened = ref<string | null>(
    import.meta.client ? localStorage.getItem(LAST_WS_KEY) : null,
  );
  watch(
    routeWsId,
    (id) => {
      if (!id) return;
      lastOpened.value = id;
      try {
        localStorage.setItem(LAST_WS_KEY, id);
      } catch {
        // storage disabled — in-memory ref still carries it for the session
      }
    },
    { immediate: true },
  );

  // Current workspace: the route's, else the last-opened one (if the user is
  // still a member of it), else the first.
  const workspaceId = computed(() => {
    if (routeWsId.value) return routeWsId.value;
    const remembered = lastOpened.value;
    if (remembered && workspaces.value.some((w) => w.id === remembered)) return remembered;
    return workspaces.value[0]?.id;
  });

  // A workspace made SOMEWHERE ELSE — in the browser while the desktop app was
  // open, or by an invite just accepted — is missing from a list cached for five
  // minutes. The desktop app could be syncing a workspace its own switcher didn't
  // list, and the dashboard then fell back to the FIRST workspace and labelled its
  // folder: "synced with" a folder that wasn't the one in question. A wanted id the
  // cache doesn't know is the signal the cache is stale, so refetch — once per id,
  // so a workspace the user genuinely lost access to can't loop.
  const refetchedFor = new Set<string>();
  watchEffect(() => {
    const wanted = routeWsId.value ?? lastOpened.value;
    if (!wanted || !workspacesQuery.data.value || workspacesQuery.isFetching.value) return;
    if (refetchedFor.has(wanted) || workspaces.value.some((w) => w.id === wanted)) return;
    refetchedFor.add(wanted);
    void workspacesQuery.refetch();
  });

  // Republish the resolved id for lightweight consumers (see ACTIVE_WS_KEY).
  const activeWorkspaceId = useState<string | null>(ACTIVE_WS_KEY, () => null);
  watchEffect(() => {
    activeWorkspaceId.value = workspaceId.value ?? null;
  });

  // Authoritative metadata (name/icon/colour) for the current workspace.
  const metaQuery = useQuery({
    queryKey: ["workspace-meta", workspaceId],
    queryFn: () => api.getWorkspaceById(workspaceId.value as string),
    enabled: computed(() => !!workspaceId.value),
    staleTime: 5 * 60 * 1000,
  });
  const workspace = computed(
    () => metaQuery.data.value ?? workspaces.value.find((w) => w.id === workspaceId.value) ?? null,
  );
  // This member can read here but change nothing. Unknown reads as false: the
  // server refuses regardless, and a member shouldn't watch their controls
  // vanish and reappear while the metadata loads.
  const viewOnly = computed(() => metaQuery.data.value?.access?.canWrite === false);

  const entriesQuery = useQuery({
    queryKey: ["entries", workspaceId],
    queryFn: () => api.list(workspaceId.value as string),
    enabled: computed(() => !!workspaceId.value),
    // Shallow, not deep, reactivity: this list is thousands of entries and is
    // read-only server state, so wrapping every entry in its own Proxy only to
    // have buildTree iterate them is pure overhead.
    //
    // Deliberately no staleTime. The app-wide default is 0 (see
    // plugins/vue-query.client.ts) so queries revalidate on mount and focus, and
    // nothing invalidates `entries` when an agent or the CLI writes a file —
    // focus revalidation is the only way those writes reach the sidebar. Raising
    // it here would hide other people's changes for the length of the window.
    shallow: true,
  });
  const entries = computed(() => entriesQuery.data.value?.entries ?? []);
  const icons = computed(() => entriesQuery.data.value?.icons ?? {});
  const orders = computed(() => entriesQuery.data.value?.orders ?? {});
  const privatePaths = computed(() => entriesQuery.data.value?.privatePaths ?? []);
  const restrictions = computed(() => entriesQuery.data.value?.restrictions ?? []);
  // Can this member change `path`? For showing the right controls: the server
  // decides for itself. Keeps `viewOnly`'s rule that unknown reads as yes.
  function canWritePath(path: string): boolean {
    return accessAt(restrictions.value, path, viewOnly.value) === "write";
  }

  // Storage usage is a secondary, non-blocking fetch: its error is deliberately
  // NOT folded into `loading`/`error`, so a failed usage call just hides the
  // widget rather than erroring the whole workspace view.
  const usageQuery = useQuery({
    queryKey: ["usage", workspaceId],
    queryFn: () => api.getUsage(workspaceId.value as string),
    enabled: computed(() => !!workspaceId.value),
    // Deliberately shorter than its sibling queries, and refetched on focus.
    //
    // This response carries the workspace's PLAN, not just its file counts, and
    // billing state changes from a Stripe webhook at a moment the user never
    // chose — a failed payment can begin a grace period while the tab sits open.
    // At the five minutes the siblings use (and with this cache persisted to
    // IndexedDB, so a reload does not clear it) someone could watch writes fail
    // while the panel still showed a healthy plan.
    //
    // 30s matches the server's own plan-resolution TTL, so the two agree about
    // how stale a plan is allowed to be.
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });
  const usage = computed(() => usageQuery.data.value ?? null);

  // Files opened in this session, by the `updatedAt` that was current when
  // they were. The server only learns a file was seen when you LEAVE it (the
  // catch-up recap depends on that), so without this the "new" marker would sit
  // on the file you are reading, and come back on the next refetch until you
  // navigate away. A later change has a new `updatedAt`, so it shows again.
  const seenLocally = useState<Record<string, string>>("th:seen-locally", () => ({}));
  const seenKey = (path: string) => `${workspaceId.value}:${path}`;
  function isUnseen(e: TreeEntry): boolean {
    return !!e.unseen && seenLocally.value[seenKey(e.path)] !== e.updatedAt;
  }

  const tree = computed(() =>
    buildTree(
      entries.value,
      icons.value,
      orders.value,
      privatePaths.value,
      isUnseen,
      restrictions.value.map((r) => r.path).filter((p) => !privatePaths.value.includes(p)),
    ),
  );

  // --- selection (derived from the URL path) ---
  const selectedPath = computed(() => {
    const p = route.params.path;
    return Array.isArray(p) ? p.join("/") : ((p as string) ?? "");
  });
  const selectedEntry = computed(() =>
    selectedPath.value ? (entries.value.find((e) => e.path === selectedPath.value) ?? null) : null,
  );
  watch(
    selectedEntry,
    (e) => {
      if (!e?.unseen || !e.updatedAt || seenLocally.value[seenKey(e.path)] === e.updatedAt) return;
      seenLocally.value = { ...seenLocally.value, [seenKey(e.path)]: e.updatedAt };
    },
    { immediate: true },
  );
  const selectedFolder = computed(() => {
    if (!selectedPath.value) return null;
    const node = findNode(tree.value, selectedPath.value);
    return node?.isDir ? node : null;
  });

  // Navigate to a node's URL (raw path — vue-router handles encoding); null = overview.
  function select(node: { path: string; isDir: boolean } | null) {
    const id = workspaceId.value;
    if (!id) return;
    return navigateTo(node ? `/w/${id}/${node.path}` : `/w/${id}`);
  }

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["entries"] });
    void qc.invalidateQueries({ queryKey: ["changes"] });
    void qc.invalidateQueries({ queryKey: ["tags"] });
    void qc.invalidateQueries({ queryKey: ["usage"] });
  }

  // Apply a path change from→to (a file is one move; a folder moves every
  // descendant file), then follow the open file if it moved.
  async function moveTo(from: string, to: string, isDir: boolean) {
    const id = workspaceId.value;
    if (!id || to === from) return;
    if (isDir && !(await moveFolderSettings(id, from, to))) return;
    let problems: MoveProblems = { failed: [], pending: [], unlinked: [] };
    try {
      // Links follow a moved or renamed FILE: notes that pointed at it are
      // rewritten server-side. A folder's files keep their names, so wikilinks
      // to them still resolve; rewriting per file there would churn every
      // note's history once per file moved, so folders are left to a batch move.
      problems = await runMoves(id, plannedMoves(from, to, isDir), !isDir);
      await followMoved(id, from, to, [...problems.failed, ...problems.pending]);
    } finally {
      refresh();
    }
    reportMoveProblems(problems);
  }

  // A folder's own ACL + metadata live on its (virtual) folder path, which the
  // per-file moves never touch. Re-path them first so the destination subtree is
  // private the moment its files arrive — otherwise renaming a private folder
  // would silently expose it. False (move aborted) if this fails, rather than
  // proceeding and orphaning the privacy setting.
  async function moveFolderSettings(id: string, from: string, to: string): Promise<boolean> {
    try {
      await api.moveFolderMeta(id, from, to);
      return true;
    } catch {
      refresh();
      window.alert("Couldn't move the folder's settings — move aborted. Refresh and try again.");
      return false;
    }
  }

  // Every file move a path change needs: one for a file, one per descendant file
  // for a folder.
  function plannedMoves(from: string, to: string, isDir: boolean): Array<[string, string]> {
    if (!isDir) return [[from, to]];
    return entries.value
      .filter((e) => e.path === from || e.path.startsWith(`${from}/`))
      .map((e) => [e.path, to + e.path.slice(from.length)]);
  }

  // Each move isolated, so one failure (a concurrent agent write, a transient
  // error) doesn't abort the batch and silently leave a folder half-moved. A 503
  // means the server is still indexing links and moved nothing: worth a retry.
  async function runMoves(
    id: string,
    moves: Array<[string, string]>,
    updateLinks: boolean,
  ): Promise<MoveProblems> {
    const problems: MoveProblems = { failed: [], pending: [], unlinked: [] };
    for (const [f, t] of moves) {
      try {
        const res = await api.move(id, f, t, { updateLinks });
        problems.unlinked.push(...(res.links?.failed ?? []));
      } catch (err) {
        (httpStatus(err) === 503 ? problems.pending : problems.failed).push(f);
      }
    }
    return problems;
  }

  // Tabs on the moved paths follow them (the open one is re-pointed again by the
  // navigation below, harmlessly). A partly failed folder move leaves its tabs
  // alone: some of them would point at files that didn't move. The open file is
  // followed only if its own move actually succeeded.
  async function followMoved(id: string, from: string, to: string, stayed: string[]) {
    if (!stayed.length) tabs.repath(id, from, to);
    const open = selectedPath.value;
    if ((open === from || open.startsWith(`${from}/`)) && !stayed.includes(open)) {
      await navigateTo(`/w/${id}/${to + open.slice(from.length)}`);
    }
  }

  // Tell the person what a move left undone: files that didn't move, or notes
  // whose links couldn't follow the file that did.
  function reportMoveProblems({ failed, pending, unlinked }: MoveProblems) {
    if (failed.length) {
      window.alert(
        `Couldn't move ${failed.length} item(s) — they may have changed on the server. Refresh and try again.`,
      );
    } else if (pending.length) {
      window.alert(
        "Nothing was renamed yet: Treehouse is still indexing the links between notes in this workspace, so it can update them for you. Try again in a few seconds.",
      );
    } else if (unlinked.length) {
      window.alert(
        `Moved, but couldn't update the links in ${unlinked.length} note(s), which may still point at the old name: ${unlinked.join(", ")}`,
      );
    }
  }

  // Move a node into another folder (real path change). Guards self/descendant.
  async function moveNode(args: { from: string; isDir: boolean; destParent: string }) {
    const { from, isDir, destParent } = args;
    const name = from.split("/").pop() as string;
    const to = destParent ? `${destParent}/${name}` : name;
    if (isDir && (destParent === from || destParent.startsWith(`${from}/`))) return;
    await moveTo(from, to, isDir);
  }

  // Rename a node in place (same parent, new name). The new name is a single
  // segment — reject slashes and anything the path rules forbid (traversal,
  // backslashes, dot segments) before issuing the move.
  async function renameNode(args: { from: string; isDir: boolean; newName: string }) {
    const { from, isDir, newName } = args;
    const name = newName.trim();
    if (!name || name.includes("/") || !isSafeRelPath(name)) return;
    const slash = from.lastIndexOf("/");
    const to = slash >= 0 ? `${from.slice(0, slash)}/${name}` : name;
    await moveTo(from, to, isDir);
  }

  // Create a new empty file at a path and open it, in the editor when the kind
  // has one. Returns the write result so the caller can surface an "already
  // exists" conflict. Pre-checks the cache so a doomed create-only PUT doesn't
  // mint a junk conflicted copy of the seed.
  async function createFile(path: string) {
    const id = workspaceId.value;
    if (!id) return;
    if (entries.value.some((e) => e.path === path)) {
      return { ok: false as const, conflict: true as const, currentVersion: null };
    }
    try {
      const res = await api.createFile(id, path);
      if (res.ok) {
        await navigateTo(`/w/${id}/${path}`);
        // Set AFTER the navigation lands, so the flag is never live against the
        // previously-open file (WorkspaceView drops it the moment the open path
        // stops matching).
        pendingEditPath.value = path;
      }
      return res;
    } finally {
      refresh();
    }
  }

  // Create an (empty) folder by writing its hidden `.keep` placeholder. If the
  // folder already exists (any entry under it), do nothing rather than write a
  // redundant `.keep` that would conflict.
  async function createFolder(folderPath: string) {
    const id = workspaceId.value;
    if (!id) return;
    const prefix = `${folderPath.replace(/\/$/, "")}/`;
    if (entries.value.some((e) => e.path === folderPath || e.path.startsWith(prefix))) return;
    try {
      return await api.createFolder(id, folderPath);
    } finally {
      refresh();
    }
  }

  // Delete a file, or every file under a folder (its `.keep` included). Uses
  // each file's current version for the required If-Match. Each delete is
  // isolated so one stale-version conflict doesn't abort the rest; failures are
  // surfaced and the open file is only left if it was actually removed.
  async function deleteNode(args: { path: string; isDir: boolean }) {
    const id = workspaceId.value;
    if (!id) return;
    const { path, isDir } = args;
    const targets = isDir
      ? entries.value.filter((e) => e.path === path || e.path.startsWith(`${path}/`))
      : entries.value.filter((e) => e.path === path);
    const failed: string[] = [];
    try {
      for (const e of targets) {
        try {
          const res = await api.deleteFile(id, e.path, e.version);
          if (!res.ok && !("notFound" in res)) failed.push(e.path);
        } catch {
          failed.push(e.path);
        }
      }
      const open = selectedPath.value;
      if ((open === path || open.startsWith(`${path}/`)) && !failed.includes(open)) {
        await navigateTo(`/w/${id}`);
      }
    } finally {
      refresh();
    }
    if (failed.length) {
      window.alert(
        `Couldn't delete ${failed.length} item(s) — they may have changed on the server. Refresh and try again.`,
      );
    }
  }

  // Upload files into a destination folder with bounded parallelism. Names that
  // already exist are handled per `strategy`: overwrite (CAS against the current
  // version), skip, or keep-both (upload under a non-colliding " (n)" name).
  async function uploadFiles(
    files: File[],
    destDir: string,
    strategy: UploadStrategy,
    onProgress?: (done: number, total: number) => void,
  ) {
    const id = workspaceId.value;
    if (!id) return;
    const versions = new Map(entries.value.map((e) => [e.path, e.version]));

    const tasks: Array<{ path: string; file: File; overwrite: boolean; baseVersion?: number }> = [];
    for (const file of files) {
      let path = uploadPath(destDir, file.name);
      const existingVersion = versions.get(path);
      if (existingVersion !== undefined) {
        if (strategy === "skip") continue;
        if (strategy === "overwrite") {
          tasks.push({ path, file, overwrite: true, baseVersion: existingVersion });
          continue;
        }
        // keep-both: land under a fresh name so neither file is lost.
        path = uniqueName(path, (p) => versions.has(p));
        versions.set(path, 1); // reserve within this batch
      }
      tasks.push({ path, file, overwrite: false });
    }

    let done = 0;
    const failures: Array<{ path: string; error: string }> = [];
    // Report the stable denominator up front so the progress total doesn't jump
    // when skipped collisions shrink the task list.
    onProgress?.(0, tasks.length);
    try {
      // Each task is isolated: one unreadable file (e.g. a dropped directory,
      // whose arrayBuffer() throws) records a failure instead of aborting the
      // whole batch.
      await mapPool(tasks, 4, async (t) => {
        try {
          const bytes = new Uint8Array(await t.file.arrayBuffer());
          const res = await api.uploadFile(id, t.path, bytes, {
            // Our table first: a browser's own guess is unreliable for code
            // (Chrome calls a .ts file video/mp2t). It's kept for types the
            // table doesn't know, such as video.
            contentType: contentTypeFor(t.path, t.file.type || undefined),
            overwrite: t.overwrite,
            baseVersion: t.baseVersion,
          });
          if (!res.ok) failures.push({ path: t.path, error: "version_conflict" });
        } catch (err) {
          failures.push({ path: t.path, error: (err as Error).message });
        } finally {
          done += 1;
          onProgress?.(done, tasks.length);
        }
      });
    } finally {
      refresh();
    }
    return { uploaded: tasks.length - failures.length, failures };
  }

  // Persist a folder's custom child order. Optimistically patches the cached
  // orders map (snappy drag), then writes through and revalidates.
  async function reorder(orderedPaths: string[]) {
    const id = workspaceId.value;
    if (!id) return;
    const key = ["entries", id];
    const next: Record<string, number> = {};
    orderedPaths.forEach((p, i) => {
      next[p] = i;
    });
    qc.setQueryData(key, (old: typeof entriesQuery.data.value) =>
      old ? { ...old, orders: { ...old.orders, ...next } } : old,
    );
    try {
      await api.setNodeOrder(id, orderedPaths);
    } finally {
      void qc.invalidateQueries({ queryKey: ["entries"] });
    }
  }

  // Which node's icon is being edited (drives the shared NodeIconDialog). Lives
  // here so the deeply-nested tree rows can open one shared dialog.
  const editingIconPath = useState<string | null>("th:editing-icon", () => null);
  const editingAccess = useState<{ path: string; isDir: boolean } | null>(
    "th:editing-access",
    () => null,
  );
  function editIcon(path: string) {
    editingIconPath.value = path;
  }

  // Mark a node private to the current user, or clear it. Refreshes so the tree
  // re-renders with (or without) the lock and any now-hidden siblings update.
  async function setPrivate(args: { path: string; isDir: boolean; makePrivate: boolean }) {
    const id = workspaceId.value;
    if (!id) return;
    try {
      await api.setNodePrivate(id, args.path, args.isDir ? "folder" : "file", args.makePrivate);
    } finally {
      refresh();
    }
  }

  const loading = computed(() => entriesQuery.isPending.value || workspacesQuery.isPending.value);
  const error = computed(
    () =>
      (workspacesQuery.error.value as Error | null)?.message ??
      (entriesQuery.error.value as Error | null)?.message ??
      null,
  );

  return {
    workspace,
    workspaces,
    workspaceId,
    entries,
    icons,
    orders,
    privatePaths,
    restrictions,
    canWritePath,
    editingAccess,
    usage,
    viewOnly,
    loading,
    error,
    tree,
    selectedPath,
    selectedEntry,
    selectedFolder,
    select,
    refresh,
    reorder,
    moveNode,
    renameNode,
    createFile,
    pendingEditPath,
    createFolder,
    deleteNode,
    uploadFiles,
    editingIconPath,
    editIcon,
    setPrivate,
  };
}