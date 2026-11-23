<script setup lang="ts">
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { encodePath } from "shared";
import IconShare from "~icons/solar/share-linear";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import IconFolder from "~icons/solar/folder-linear";
import IconAdd from "~icons/solar/add-circle-linear";
import IconCheck from "~icons/solar/check-circle-linear";
import IconCopy from "~icons/solar/copy-linear";
import type { ShareView } from "~/composables/useTreehouseApi";
import { fileActivity } from "~/utils/activity";
import { basename } from "~/utils/format";
import { viewerKind } from "~/utils/treehouse";

// Works for a single file or a whole folder. Version pinning is file-only —
// folders are always shared live.
const props = defineProps<{
  workspaceId: string;
  path: string;
  kind: "file" | "folder";
  version?: number;
  /** The file's stored type, so this classifies exactly as the viewer does. */
  contentType?: string;
}>();

const api = useTreehouseApi();
const qc = useQueryClient();

const origin = ref("");
onMounted(() => {
  origin.value = window.location.origin;
});

const sharesQuery = useQuery({
  queryKey: computed(() => ["shares", props.workspaceId, props.path]),
  queryFn: () => api.getShares(props.workspaceId, props.path),
});
const shares = computed(() => sharesQuery.data.value?.shares ?? []);

// Public folder shares on an ancestor: this path is already reachable through
// the parent folder's link, so warn (deepest ancestor first — the most specific).
const inheritedPublic = computed(() =>
  [...(sharesQuery.data.value?.inherited ?? [])]
    .filter((s) => s.access === "public")
    .sort((a, b) => b.path.length - a.path.length),
);
function folderHref(path: string): string {
  return `/w/${props.workspaceId}/${encodePath(path)}`;
}
function folderName(path: string): string {
  return basename(path);
}
/**
 * The parent folder's link, opened straight onto this path. The folder viewer
 * selects whatever `?p=` names, so the recipient lands on this file rather than
 * on the folder's top level — the same URL the viewer itself links siblings by.
 */
function inheritedLink(token: string): string {
  return origin.value ? `${origin.value}/s/${token}?p=${encodeURIComponent(props.path)}` : "";
}

// Current version's content hash, for pinning a file permalink. Read straight
// from the file rather than from the change feed: the bytes and their identity
// then come from ONE answer, so a pin cannot name content that no longer exists
// at that version. The server checks it against the head regardless.
const isFile = computed(() => props.kind === "file");
const snapshotQuery = useQuery({
  queryKey: computed(() => ["file-snapshot", props.workspaceId, props.path, props.version]),
  queryFn: () => api.readFileSnapshot(props.workspaceId, props.path),
  enabled: computed(() => isFile.value && props.version != null),
  staleTime: Number.POSITIVE_INFINITY,
});
const currentHash = computed(() =>
  isFile.value ? (snapshotQuery.data.value?.contentHash ?? null) : null,
);
const renderedVersion = computed(() => snapshotQuery.data.value?.version ?? null);
/** A pin names exact bytes, so it needs both halves of that identity. */
const pinnable = computed(
  () => isFile.value && renderedVersion.value != null && !!currentHash.value,
);

const memberLink = computed(() =>
  origin.value ? `${origin.value}/w/${props.workspaceId}/${encodePath(props.path)}` : "",
);
function publicLink(token: string): string {
  return origin.value ? `${origin.value}/s/${token}` : "";
}

const copiedKey = ref<string | null>(null);
async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedKey.value = key;
    setTimeout(() => (copiedKey.value = null), 1500);
  } catch {
    /* clipboard can be blocked */
  }
}

// Which shares may be offered the setting at all.
//
// FILE shares only, and this is a security rule rather than a UI simplification
// (the API refuses a folder either way). A folder share is the one case where
// the viewer rewrites references to sibling files, and those URLs carry the
// share's own token — so a folder page that could run script could read that
// token out of its own DOM and post it anywhere, handing a stranger the whole
// shared subtree. A file share has nothing rewritten into it.
//
// Classified by content type first, exactly as the viewer does: a `text/html`
// file with no extension must still get the control, and a `.html` path stored
// as something else must not get a control that would do nothing.
const canRunScripts = computed(
  () => props.kind === "file" && viewerKind(props.contentType ?? "", props.path) === "html",
);

// ---- Create public link ----
const showForm = ref(false);
const withPassword = ref(false);
const password = ref("");
const target = ref<"live" | "pinned">("live");
const allowScripts = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);

/** The link just created, and whether it made it onto the clipboard. */
const justCreated = ref<{ id: string; copied: boolean } | null>(null);
let justCreatedTimer: ReturnType<typeof setTimeout> | undefined;
onScopeDispose(() => clearTimeout(justCreatedTimer));

async function createPublic() {
  creating.value = true;
  createError.value = null;
  justCreated.value = null;
  // Both halves of the identity, or no pin at all: the server treats the hash
  // as a precondition and refuses one it cannot match.
  const pinned =
    isFile.value &&
    target.value === "pinned" &&
    !!currentHash.value &&
    renderedVersion.value != null;
  const created = api
    .createShare(props.workspaceId, {
      path: props.path,
      kind: props.kind,
      access: "public",
      password: withPassword.value && password.value ? password.value : undefined,
      pinnedVersion: pinned ? (renderedVersion.value as number) : undefined,
      pinnedContentHash: pinned ? (currentHash.value as string) : undefined,
      allowScripts: canRunScripts.value && allowScripts.value,
    })
    .then((r) => r.share);
  // Started inside the click, before the request returns: a new link is
  // almost always made to be pasted somewhere, so it goes straight onto the
  // clipboard. See copyWhenReady for why it can't wait for the response.
  const copied = copyWhenReady(
    created.then((share) => {
      if (!share.token) throw new Error("No token");
      return publicLink(share.token);
    }),
  );
  try {
    const share = await created;
    await qc.invalidateQueries({ queryKey: ["shares", props.workspaceId, props.path] });
    justCreated.value = { id: share.id, copied: await copied };
    clearTimeout(justCreatedTimer);
    justCreatedTimer = setTimeout(() => (justCreated.value = null), 6000);
    showForm.value = false;
    withPassword.value = false;
    password.value = "";
    target.value = "live";
    allowScripts.value = false;
  } catch (err) {
    createError.value = (err as Error).message ?? "Could not create link";
  } finally {
    creating.value = false;
  }
}

// ---- Change what an existing link may do ----
// Separate from creation because the link is usually already sent: someone
// reaches for this when the client reports that the deck does not respond, and
// revoke-and-recreate would hand them a different URL to re-send.
//
// Which is exactly why turning it ON here asks first. On a LIVE link this
// authorizes not the page that was reviewed but whatever the file becomes — and
// unlike the creation form, the person deciding is not necessarily looking at
// the document, and the audience already has the URL. Turning it OFF applies
// straight away: taking a capability back needs no ceremony.
const scriptsBusy = ref(false);
const scriptsError = ref<string | null>(null);
/** The share awaiting an explicit "yes, and here is which bytes" confirmation. */
const confirmingScripts = ref<string | null>(null);

/**
 * A link whose current setting we can no longer vouch for.
 *
 * When a write fails there is no honest checkbox to render: a refused request
 * changed nothing, but a lost response may have committed on its way out, and
 * showing "off" for a link that is in fact executing is the one outcome worth
 * designing against. So the row stops showing a switch at all and asks for a
 * reload, which is the only thing that produces a state we actually know.
 *
 * The alternative — reconciling in the background, comparing revisions, waiting
 * for the mutation's terminal result — is a real distributed-systems problem,
 * and not one a share panel should be solving.
 */
const scriptsStale = ref<string | null>(null);

function onScriptsToggle(share: ShareView, event: Event) {
  // Nothing is granted until the server says so; the box must not sit there
  // looking as though it had been.
  (event.target as HTMLInputElement).checked = share.allowScripts;
  scriptsError.value = null;
  if (share.allowScripts) return void applyScripts(share, false);
  // A pinned link serves fixed bytes, so there is nothing to warn about.
  if (share.pinnedVersion != null) return void applyScripts(share, true);
  confirmingScripts.value = share.id;
}

async function applyScripts(share: ShareView, allow: boolean) {
  scriptsBusy.value = true;
  scriptsError.value = null;
  try {
    const { share: updated } = await api.setShareScripts(props.workspaceId, share.id, allow);
    // The server's own answer, rather than whatever a later refetch reports.
    qc.setQueryData<{ shares: ShareView[]; inherited: ShareView[] }>(
      ["shares", props.workspaceId, props.path],
      (old) =>
        old ? { ...old, shares: old.shares.map((s) => (s.id === updated.id ? updated : s)) } : old,
    );
    confirmingScripts.value = null;
  } catch {
    scriptsStale.value = share.id;
    confirmingScripts.value = null;
  } finally {
    scriptsBusy.value = false;
  }
}

// ---- Revoke ----
const confirmingRevoke = ref<string | null>(null);
const revokingId = ref<string | null>(null);
async function revoke(id: string) {
  revokingId.value = id;
  try {
    await api.revokeShare(props.workspaceId, id);
    await qc.invalidateQueries({ queryKey: ["shares", props.workspaceId, props.path] });
    confirmingRevoke.value = null;
  } finally {
    revokingId.value = null;
  }
}

// One public link per target: show the most recent active one (listShares is
// newest-first); creating is hidden while one exists.
const publicShare = computed(() => shares.value.find((s) => s.access === "public") ?? null);

const noun = computed(() => (props.kind === "folder" ? "folder" : "file"));

/**
 * "2 days ago" for the last-opened line.
 *
 * The whole point of the view count is answering "did the client actually open
 * the proposal?", and a raw timestamp makes the reader do the arithmetic.
 */
function sinceLabel(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86_400, "day"],
    [604_800, "week"],
  ];
  let label = "";
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n < 1) break;
    label = `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return label || "just now";
}
</script>

<template>
  <section class="space-y-3">
    <!-- Inherited share warning: this path is already public via a parent folder. -->
    <div
      v-for="p in inheritedPublic"
      :key="p.id"
      class="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs"
    >
      <div class="flex items-center gap-1.5 font-medium text-warning">
        <IconLock v-if="p.hasPassword" class="h-3.5 w-3.5 shrink-0" />
        <IconShare v-else class="h-3.5 w-3.5 shrink-0" />
        Shared publicly via a parent folder
      </div>
      <p class="mt-1 text-fg-muted">
        Anyone with the link to
        <NuxtLink :to="folderHref(p.path)" class="inline-flex items-center gap-0.5 underline">
          <IconFolder
            class="h-3 w-3"
          /><!-- ph-mask: user-authored file/folder name; masked in session replay (see app/plugins/posthog.client.ts). --><span
            class="ph-mask"
            >{{ folderName(p.path) }}</span
          ></NuxtLink
        >
        can already open this {{ noun }}. Manage that link from the folder.
      </p>
      <button
        type="button"
        class="th-btn th-btn-secondary mt-2 w-full"
        @click="copy(inheritedLink(p.token ?? ''), `inherited-${p.id}`)"
      >
        <IconLock v-if="p.hasPassword" class="h-4 w-4" />
        <IconShare v-else class="h-4 w-4" />
        {{ copiedKey === `inherited-${p.id}` ? "Link copied" : `Copy link to this ${noun}` }}
      </button>
      <p v-if="p.hasPassword" class="mt-1 text-fg-subtle">Opens with the folder's password.</p>
    </div>

    <!-- Member link: just a URL, opens for logged-in org members. Each audience is
         one row — who it is for on the left, its one action on the right. -->
    <div class="panel-setting">
      <div class="min-w-0">
        <p class="text-sm font-medium text-fg">Members of this workspace</p>
        <p class="text-xs text-fg-subtle">Opens for signed-in members</p>
      </div>
      <button
        type="button"
        class="th-btn th-btn-secondary th-btn-sm shrink-0"
        @click="copy(memberLink, 'member')"
      >
        <IconCopy v-if="copiedKey !== 'member'" class="h-3.5 w-3.5" />
        <IconCheck v-else class="h-3.5 w-3.5 text-success" />
        {{ copiedKey === "member" ? "Copied" : "Copy link" }}
      </button>
    </div>

    <!-- Public link (one per target) -->
    <div class="space-y-2 border-t border-border pt-3">
      <div class="panel-setting">
        <div class="min-w-0">
          <p class="text-sm font-medium text-fg">Anyone with the link</p>
          <p class="text-xs text-fg-subtle">
            {{ publicShare ? "Public link is on" : "No public link yet" }}
          </p>
        </div>
        <button
          v-if="!publicShare && !showForm"
          type="button"
          class="th-btn th-btn-secondary th-btn-sm shrink-0"
          @click="showForm = true"
        >
          <IconAdd class="h-3.5 w-3.5" />
          Create link
        </button>
      </div>

      <div v-if="publicShare" class="rounded-md border border-border p-2.5 text-xs">
        <!-- Said where the eye already is: a new link goes straight onto the
             clipboard (see createPublic), and the only other sign of that was a
             button label flickering for a moment. -->
        <p
          v-if="justCreated?.id === publicShare.id"
          role="status"
          class="mb-2 flex items-center gap-1.5 font-medium"
          :class="justCreated.copied ? 'text-success' : 'text-fg-muted'"
        >
          <IconCheck class="h-4 w-4 shrink-0" />
          {{ justCreated.copied ? "Link created and copied to your clipboard" : "Link created" }}
        </p>
        <div class="flex items-center gap-1.5">
          <IconLock v-if="publicShare.hasPassword" class="h-3 w-3 shrink-0 text-fg-subtle" />
          <span class="truncate text-fg-muted">{{ publicLink(publicShare.token ?? "") }}</span>
          <span v-if="publicShare.pinnedVersion != null" class="shrink-0 font-mono text-fg-subtle"
            >v{{ publicShare.pinnedVersion }}</span
          >
        </div>
        <p class="mt-1 text-fg-subtle">
          <template v-if="publicShare.viewCount > 0">
            {{ publicShare.viewCount }}
            {{ publicShare.viewCount === 1 ? "view" : "views" }}
            <template v-if="publicShare.lastViewedAt">
              · last opened {{ sinceLabel(publicShare.lastViewedAt) }}
            </template>
          </template>
          <template v-else>Not opened yet</template>
        </p>
        <!-- Shown whenever it could run, AND whenever it already does. Those are
             not the same set: `canRunScripts` describes the live file, while a
             pinned link keeps serving the bytes it stored — so if the live path
             stops being HTML, hiding this would remove the only way to turn off
             a public link that is still executing. -->
        <label
          v-if="(canRunScripts || publicShare.allowScripts) && scriptsStale !== publicShare.id"
          class="mt-1.5 flex items-center gap-2 text-fg-muted"
          :title="
            publicShare.allowScripts
              ? 'The page runs its own JavaScript for anyone opening this link.'
              : 'Interactive pages — a slide deck\'s arrow keys, a chart that draws itself — need this. The page runs sealed off from your workspace.'
          "
        >
          <input
            type="checkbox"
            class="accent-accent"
            :checked="publicShare.allowScripts"
            :disabled="scriptsBusy || (!canRunScripts && !publicShare.allowScripts)"
            @change="onScriptsToggle(publicShare, $event)"
          />
          Let the page run its scripts
        </label>
        <!-- No switch at all once we have lost track of what this link does. A
             checkbox here would be a guess, and the wrong guess hides a link
             that is executing. -->
        <div
          v-if="scriptsStale === publicShare.id"
          class="mt-1 rounded border border-warning/30 bg-warning/10 p-2"
        >
          <p class="text-fg">We could not confirm what this link does now.</p>
          <p class="mt-0.5 text-fg-muted">Reload the page to see its current setting.</p>
        </div>
        <!-- The link is already with its audience, so "runs whatever this file
             becomes" is a bigger promise here than in the creation form. Pinning
             belongs there, where the person is looking at the file. -->
        <div
          v-if="confirmingScripts === publicShare.id"
          class="mt-1 rounded border border-warning/30 bg-warning/10 p-2"
        >
          <p class="text-fg">This link will run whatever this file becomes.</p>
          <p class="mt-0.5 text-fg-muted">
            Anyone already holding it gets the change, without being asked again. For fixed bytes,
            revoke this link and create a pinned one.
          </p>
          <div class="mt-1.5 flex flex-wrap gap-3">
            <button
              type="button"
              class="font-medium text-accent hover:underline disabled:opacity-50"
              :disabled="scriptsBusy"
              @click="applyScripts(publicShare, true)"
            >
              Enable anyway
            </button>
            <button
              type="button"
              class="text-fg-subtle hover:text-fg"
              @click="confirmingScripts = null"
            >
              Cancel
            </button>
          </div>
        </div>
        <p v-if="scriptsError" class="mt-1 text-danger">{{ scriptsError }}</p>
        <div class="mt-2 flex gap-1.5">
          <button
            type="button"
            class="th-btn th-btn-secondary th-btn-sm flex-1"
            @click="copy(publicLink(publicShare.token ?? ''), publicShare.id)"
          >
            <IconCheck v-if="copiedKey === publicShare.id" class="h-3.5 w-3.5 text-success" />
            <IconCopy v-else class="h-3.5 w-3.5" />
            {{ copiedKey === publicShare.id ? "Copied" : "Copy link" }}
          </button>
          <template v-if="confirmingRevoke === publicShare.id">
            <button
              type="button"
              class="th-btn th-btn-sm th-btn-quiet text-danger! hover:bg-danger/10!"
              :disabled="revokingId === publicShare.id"
              @click="revoke(publicShare.id)"
            >
              {{ revokingId === publicShare.id ? "Revoking…" : "Confirm revoke" }}
            </button>
            <button
              type="button"
              class="th-btn th-btn-quiet th-btn-sm"
              @click="confirmingRevoke = null"
            >
              Cancel
            </button>
          </template>
          <button
            v-else
            type="button"
            class="th-btn th-btn-quiet th-btn-sm"
            @click="confirmingRevoke = publicShare.id"
          >
            Revoke
          </button>
        </div>
      </div>

      <!-- Create form (only when no public link exists yet) -->
      <div v-else-if="showForm" class="space-y-2 rounded-md border border-border p-2.5">
        <label class="flex items-center gap-2 text-xs text-fg-muted">
          <input v-model="withPassword" type="checkbox" class="accent-accent" />
          Password protect
        </label>
        <input
          v-if="withPassword"
          v-model="password"
          type="password"
          placeholder="Password"
          class="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        />
        <label v-if="canRunScripts" class="flex items-center gap-2 text-xs text-fg-muted">
          <input v-model="allowScripts" type="checkbox" class="accent-accent" />
          Let the page run its scripts
        </label>
        <!-- Said plainly at the moment of choosing, because the two settings
             interact: a live link runs whatever the file becomes, and the
             visitor is never asked again. Pinning it to this version is the
             answer for anything going to a client. -->
        <p v-if="allowScripts && canRunScripts && target === 'live'" class="text-xs text-fg-subtle">
          A live link runs whatever this file becomes. Pin it to keep the version you have seen.
        </p>
        <label v-if="isFile" class="flex items-center justify-between gap-2 text-xs text-fg-muted">
          Link target
          <select
            v-model="target"
            class="rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none"
          >
            <option value="live">Live (always latest)</option>
            <option value="pinned" :disabled="!currentHash">Pinned to v{{ version }}</option>
          </select>
        </label>
        <div class="flex gap-1.5 pt-0.5">
          <button
            type="button"
            class="th-btn th-btn-primary flex-1"
            :disabled="creating || (withPassword && !password)"
            @click="createPublic"
          >
            {{ creating ? "Creating…" : "Create and copy link" }}
          </button>
          <button type="button" class="th-btn th-btn-quiet" @click="showForm = false">
            Cancel
          </button>
        </div>
        <p v-if="createError" class="text-xs text-danger">{{ createError }}</p>
      </div>
    </div>
  </section>
</template>