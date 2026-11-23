<script setup lang="ts">
import { cardFields, cardLabel, declaredColumns } from "~/utils/board";
import {
  boardAvailable,
  findDefaultPage,
  folderHeading,
  resolveDefaultView,
  viewerKind,
} from "~/utils/treehouse";
import { fillsCanvas } from "~/utils/viewers";

// The public share viewer. It is WorkspaceView with everything a visitor can't
// do removed (no editing, no activity, no details panel) — the same shell, the
// same tree, the same document rendering, so a shared folder reads like the
// workspace it came from rather than like a different product.
const props = defineProps<{ token: string }>();
const token = computed(() => props.token);
const share = useShareData(token);

// Dress the viewer in the workspace's own theme. A share has no personal
// override to layer on (there's no account here), so the workspace default is
// the effective theme.
//
// `applyTheme` mutates the document, and nothing outside the signed-in app
// layout claims it back — so restore the default on the way out, or following
// the sign-up link would leave a stranger's palette on the sign-up page.
watch(
  () => share.meta.value,
  (m) => applyTheme(m ? { theme: m.theme ?? DEFAULT_THEME, themeCss: m.themeCss } : null),
  { immediate: true },
);
onBeforeUnmount(() => applyTheme(null));

const password = ref("");
const unlocking = ref(false);
const gateError = ref<string | null>(null);
async function submitPassword() {
  unlocking.value = true;
  gateError.value = null;
  try {
    await share.submitPassword(password.value);
    password.value = "";
  } catch {
    gateError.value = "Incorrect password";
  } finally {
    unlocking.value = false;
  }
}

// A folder share browses; a file share is one document with no sidebar.
const isFolderShare = computed(() => share.kind.value === "folder");
const showSidebar = computed(() => isFolderShare.value && !share.locked.value);
// The brand lockup and the sign-up link live in the sidebar. When there is no
// sidebar on screen — a file share, the password gate, or a folder share whose
// sidebar the visitor collapsed — they move into the top bar rather than
// disappearing with it.
const sb = useSidebar();
const sidebarVisible = computed(() => showSidebar.value && sb.open.value);

const kind = computed(() =>
  share.selectedEntry.value
    ? viewerKind(share.selectedEntry.value.contentType, share.selectedEntry.value.path)
    : null,
);

// Folder pages, exactly as in the app: a folder with a default page
// (README/index) fronts it, with the file listing and — when children are dated
// or carry a status — a calendar or board one toggle away. Resets per
// navigation; `userPickedView` marks a manual choice so the declared default
// doesn't override the user afterwards.
type FolderViewMode = "page" | "files" | "calendar" | "board";
const folderView = ref<FolderViewMode>("page");
const userPickedView = ref(false);
// A card opened from the board, read in a drawer over it. No edit here: a
// visitor reads, and "Open" goes to the card's own page within the share.
const openCardPath = ref<string | null>(null);
watch(
  () => share.selectedPath.value,
  () => {
    folderView.value = "page";
    userPickedView.value = false;
    openCardPath.value = null;
  },
);

// The folder being viewed: the selected folder, or the share's own root.
const isRoot = computed(
  () => !share.selectedPath.value || share.selectedPath.value === share.root.value,
);
const folderChildren = computed(() => {
  if (share.selectedFolder.value) return share.selectedFolder.value.children;
  return isRoot.value ? share.tree.value : null;
});

const {
  loading: folderLoading,
  datedChildren,
  hasDatedChildren,
  boardCards,
  hasStatusChildren,
  defaultPageFrontMatter,
} = useFolderFrontMatter(share.fileSource, folderChildren, share.entries);
const hasBoard = computed(() =>
  boardAvailable(defaultPageFrontMatter.value, hasStatusChildren.value),
);
const boardColumns = computed(() => declaredColumns(defaultPageFrontMatter.value));
const boardFields = computed(() => cardFields(defaultPageFrontMatter.value));
const declaredView = computed(() =>
  resolveDefaultView(defaultPageFrontMatter.value, hasDatedChildren.value),
);
watchEffect(() => {
  if (userPickedView.value) return;
  folderView.value = declaredView.value === "default" ? "page" : declaredView.value;
});
function pickView(view: FolderViewMode) {
  userPickedView.value = true;
  folderView.value = view;
}

const folderTitle = computed(() =>
  folderHeading(
    defaultPageFrontMatter.value,
    share.selectedFolder.value?.name ?? share.meta.value?.name ?? "",
  ),
);
const defaultPageNode = computed(() =>
  folderChildren.value ? findDefaultPage(folderChildren.value) : null,
);
const defaultPageEntry = computed(() =>
  defaultPageNode.value
    ? (share.entries.value.find((e) => e.path === defaultPageNode.value?.path) ?? null)
    : null,
);
const showDefaultPage = computed(() => !!defaultPageEntry.value && folderView.value === "page");
const defaultPageKind = computed(() =>
  defaultPageEntry.value
    ? viewerKind(defaultPageEntry.value.contentType, defaultPageEntry.value.path)
    : null,
);
const folderMode = computed(
  () => isFolderShare.value && (!!share.selectedFolder.value || isRoot.value),
);
// The same switcher the app's folder pages use — one control, one style.
const folderViewOptions = computed(() => {
  const opts: { value: FolderViewMode; label: string; mask?: boolean }[] = [];
  if (defaultPageNode.value) {
    opts.push({ value: "page", label: defaultPageNode.value.name, mask: true });
  }
  if (hasDatedChildren.value) opts.push({ value: "calendar", label: "Calendar" });
  if (hasBoard.value) opts.push({ value: "board", label: "Board" });
  opts.push({ value: "files", label: "Files" });
  return opts;
});
const showFolderSwitcher = computed(() => folderMode.value && folderViewOptions.value.length > 1);

// Breadcrumbs walk the shared subtree only — the share's own folder is the
// root, and the workspace path above it is never shown (it isn't shared, and a
// visitor has no way to reach it).
const crumbs = computed(() => {
  const path = share.selectedPath.value;
  const root = share.root.value;
  if (!isFolderShare.value || !path || path === root) return [];
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const parts = rel.split("/");
  const lastIsDir = !!share.selectedFolder.value;
  return parts.map((name, i) => ({
    name,
    path: [root, ...parts.slice(0, i + 1)].filter(Boolean).join("/"),
    isDir: i < parts.length - 1 || lastIsDir,
  }));
});

// A `?p=` that isn't a file or folder in this share (a stale or hand-edited link).
const notFound = computed(
  () =>
    isFolderShare.value &&
    !share.loading.value &&
    !!share.selectedPath.value &&
    !share.selectedEntry.value &&
    !share.selectedFolder.value,
);

// Whether the share's content may be shown at all: not paused, revoked, locked
// behind its password, or still loading. The main viewer gets this from its
// v-if chain; the card drawer sits outside that chain, so it checks explicitly.
const shareReadable = computed(
  () => !share.paused.value && !share.notFound.value && !share.locked.value && !share.loading.value,
);

// A board needs the width for its columns, so it leaves the reading column.
const boardFull = computed(
  () => shareReadable.value && folderMode.value && !notFound.value && folderView.value === "board",
);
// Losing access (the unlock expires, the link is revoked) closes an open card,
// so its cached text can't stay on screen over the password or "unavailable"
// page.
watch(shareReadable, (readable) => {
  if (!readable) openCardPath.value = null;
});

const openCardEntry = computed(() =>
  openCardPath.value
    ? (share.entries.value.find((e) => e.path === openCardPath.value) ?? null)
    : null,
);
const openCardTitle = computed(() => {
  const card = boardCards.value.find((c) => c.path === openCardPath.value);
  return card ? cardLabel(card) : "";
});
function openCardPage() {
  const path = openCardPath.value;
  openCardPath.value = null;
  if (path) share.select({ path, isDir: false });
}

// Full-bleed kinds (utils/viewers.ts) get the whole canvas, with no prose
// container or padding, matching the app. A share has no source view, so the
// file is always rendered.
const canvasKind = computed(() =>
  share.selectedEntry.value ? kind.value : showDefaultPage.value ? defaultPageKind.value : null,
);
const fullBleed = computed(() => fillsCanvas(canvasKind.value));
</script>

<template>
  <AppShell :sidebar="showSidebar">
    <template #sidebar>
      <ShareSidebar
        :token="token"
        :name="share.meta.value?.name ?? 'Shared'"
        :icon="share.meta.value?.icon ?? null"
        :workspace="share.meta.value?.workspace ?? { id: null, name: '', icon: null, color: null }"
        :nodes="share.tree.value"
        :selected="share.selectedPath.value || null"
        :loading="share.loading.value"
        @select="share.select($event)"
      />
    </template>

    <AppTopBar :sidebar-toggle="showSidebar">
      <template #breadcrumb>
        <!-- With no sidebar to carry it, the workspace's identity leads the
             breadcrumb instead — the same place the app puts it. -->
        <template v-if="!sidebarVisible && share.meta.value">
          <WorkspaceIcon
            :icon="share.meta.value.workspace.icon"
            :color="share.meta.value.workspace.color"
            :workspace-id="share.meta.value.workspace.id"
            size="sm"
            class="mr-1 shrink-0"
          />
          <span
            v-if="share.meta.value.workspace.name"
            class="hidden truncate px-1.5 py-1 text-fg-muted sm:inline"
            :title="share.meta.value.workspace.name"
          >
            {{ share.meta.value.workspace.name }}
          </span>
          <span v-if="share.meta.value.workspace.name" class="hidden text-fg-subtle sm:inline"
            >/</span
          >
        </template>
        <PathBreadcrumb
          :root-label="share.meta.value?.name ?? 'Shared'"
          :root-clickable="isFolderShare"
          :crumbs="crumbs"
          @select="share.select($event && { path: $event.path, isDir: $event.isDir })"
        >
          <template #after>
            <span
              v-if="share.meta.value?.pinnedVersion != null"
              class="ml-1 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-subtle"
              title="This link is pinned to one version of the file"
              >v{{ share.meta.value.pinnedVersion }}</span
            >
          </template>
        </PathBreadcrumb>
      </template>
      <!-- Folder view switcher — default page (when present), calendar (when the
           folder has dated children), and the file listing. -->
      <template #menu>
        <SegmentedControl
          v-if="showFolderSwitcher"
          :model-value="folderView"
          :options="folderViewOptions"
          label="Folder view"
          @update:model-value="pickView"
        />
      </template>
      <template #actions>
        <!-- The one ask, for visitors who can't see the sidebar's copy of it.
             It stays in the bar rather than moving into the "⋯" — a share is
             often someone's first sight of Treehouse, and the ask shouldn't be
             the thing that gets hidden. Shorter copy where there's less room. -->
        <NuxtLink
          v-if="!sidebarVisible"
          to="/sign-up"
          class="shrink-0 rounded-md px-2.5 py-1.5 text-fg-muted no-underline transition hover:bg-surface-2 hover:text-fg"
        >
          <span class="lg:hidden">Try Treehouse</span>
          <span class="hidden lg:inline">Create your own workspace →</span>
        </NuxtLink>
      </template>
    </AppTopBar>

    <div class="relative flex min-h-0 flex-1">
      <section class="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <!-- Over the workspace's monthly share allowance.
           The person reading this is the CLIENT the link was sent to, not the
           customer who owns it — so it says nothing about plans, limits, or
           payment. The nudge to upgrade goes to the owner by email; putting it
           here would embarrass them in front of the person they are trying to
           impress, and free users would stop sharing links at all. -->
        <div v-if="share.paused.value" class="mx-auto max-w-3xl px-4 py-16 text-center sm:px-8">
          <p class="text-sm text-fg-muted">This link is temporarily unavailable.</p>
          <p class="mt-1 text-sm text-fg-subtle">Please check back shortly.</p>
        </div>

        <!-- Revoked, expired, or never existed. -->
        <div
          v-else-if="share.notFound.value"
          class="mx-auto max-w-3xl px-4 py-16 text-center sm:px-8"
        >
          <p class="text-sm text-fg-muted">This link is no longer available.</p>
        </div>

        <!-- Password gate -->
        <div v-else-if="share.locked.value" class="mx-auto max-w-sm px-4 py-16 sm:px-8">
          <div class="rounded-lg border border-border bg-surface p-6 text-center">
            <h1 class="text-base font-semibold text-fg">Password required</h1>
            <p class="mt-1 text-sm text-fg-subtle">This link is password-protected.</p>
            <form class="mt-4 space-y-2" @submit.prevent="submitPassword">
              <input
                v-model="password"
                type="password"
                placeholder="Password"
                class="w-full rounded-md border border-border bg-app px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
              <button
                type="submit"
                class="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
                :disabled="unlocking || !password"
              >
                {{ unlocking ? "Unlocking…" : "Unlock" }}
              </button>
              <p v-if="gateError" class="text-xs text-danger">{{ gateError }}</p>
            </form>
          </div>
        </div>

        <p v-else-if="share.loading.value" class="px-4 py-8 text-sm text-fg-subtle sm:px-8">
          Loading…
        </p>

        <!-- Full-bleed kinds fill the whole canvas. `html-scripts` is
           the link's own setting, decided by the member who minted it (see
           api/share/[token]/meta.get.ts) — a visitor is never asked to make a
           judgement about content they cannot see the provenance of. The
           sandbox it runs in is the same opaque-origin one the workspace uses. -->
        <FileViewer
          v-else-if="fullBleed"
          class="h-full"
          :file-source="share.fileSource.value"
          :entry="share.selectedEntry.value ?? defaultPageEntry"
          :kind="canvasKind"
          :html-scripts="share.meta.value?.allowScripts === true"
          @media-error="share.recheckLock()"
        />

        <!-- A board, read-only: no `actions`, so no drags, no adding, no menus. -->
        <div v-else-if="boardFull" class="min-h-full px-4 pt-6 pb-10 sm:px-8">
          <LazyBoardView
            :name="folderTitle"
            :cards="boardCards"
            :columns="boardColumns"
            :fields="boardFields"
            :loading="folderLoading"
            @open="openCardPath = $event"
          />
        </div>

        <!-- Everything else: the app's centered reading column. -->
        <!-- min-h-full, not h-full: with a fixed 100% height the padding box ends
           at the viewport and a long document overflows straight past its own
           bottom padding, leaving the last line jammed against the window edge.
           The generous pb is deliberate on top of that — text should stop well
           short of the frame, not touch it. -->
        <div v-else class="mx-auto min-h-full max-w-3xl px-4 pt-6 pb-24 sm:px-8 sm:pt-8 sm:pb-32">
          <p v-if="notFound" class="text-sm text-fg-subtle">
            “{{ share.selectedPath.value }}” isn’t part of this share.
          </p>
          <template v-else-if="folderMode">
            <!-- No `reschedule` prop: a public share is read-only, so the
               calendar is handed no writer and never constructs one. -->
            <LazyCalendarView
              v-if="folderView === 'calendar'"
              :name="folderTitle"
              :children="datedChildren"
              @select="share.select($event)"
            />
            <FileViewer
              v-else-if="showDefaultPage"
              :file-source="share.fileSource.value"
              :entry="defaultPageEntry"
              @media-error="share.recheckLock()"
            />
            <FolderView
              v-else
              :name="folderTitle"
              :icon="share.selectedFolder.value?.icon ?? share.meta.value?.icon"
              :children="folderChildren ?? []"
              @select="share.select($event)"
            />
          </template>
          <FileViewer
            v-else
            :file-source="share.fileSource.value"
            :entry="share.selectedEntry.value"
            :kind="kind"
            @media-error="share.recheckLock()"
          />
        </div>
      </section>
      <LazyBoardCardDrawer
        v-if="boardFull && openCardEntry"
        :entry="openCardEntry"
        :file-source="share.fileSource.value"
        :title="openCardTitle"
        :editable="false"
        @close="openCardPath = null"
        @open="openCardPage"
        @media-error="share.recheckLock()"
      />
    </div>
  </AppShell>
</template>