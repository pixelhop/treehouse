<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import IconChevron from "~icons/solar/alt-arrow-down-linear";
import { actorShortName, type FeedEvent } from "~/utils/activity";
import { tabView, type Tab, type TabView, type TabViewContext } from "~/utils/tabs";
import { findNode } from "~/utils/treehouse";

// The tab row: its own strip above the top bar, over the document column only.
// The sidebar belongs to the workspace and the top bar to whichever tab is
// active, so neither changes. It stays out of sight until a second tab exists,
// which means someone who never opens one sees exactly the screen they had.
//
// Mounted once by the app layout, so it also hosts the tab machinery (router
// sync, shortcuts, persistence) — see useTabsHost.
const tabs = useTabsHost();
const ws = useWorkspaceData();
const route = useRoute();
const api = useTreehouseApi();
// A background tab's file is warmed when the pointer rests on the tab.
const prefetch = usePrefetchFile();
const editorDirty = useState<boolean>(EDITOR_DIRTY_KEY, () => false);
const session = useAuthClient().useSession();
const userId = computed(() => session.value.data?.user?.id ?? null);

const onWorkspaceRoute = computed(() => !!tabLocation(route));
const state = computed(() => tabs.state.value);
const visible = computed(
  () => tabs.enabled.value && onWorkspaceRoute.value && state.value.tabs.length > 1,
);

// The activity feed, read from the cache the sidebar and workspace view keep
// polling. A disabled observer still receives cache updates, so this adds no
// requests of its own.
const feed = useQuery({
  queryKey: ["activity", "with-comments", ws.workspaceId],
  queryFn: () => api.changesRecentWithComments(ws.workspaceId.value as string, 200),
  enabled: false,
});
const events = computed<FeedEvent[]>(() => feed.data.value?.changes ?? []);
const head = computed(() => feed.data.value?.head ?? null);

// Whatever is on screen counts as seen — in every tab showing it, not just the
// active one; tabs opened before the feed first loaded start from the head
// once it does.
watch(
  [head, () => state.value.activeId, () => route.fullPath],
  ([h]) => {
    // Published even when null: the head belongs to one workspace's feed, and
    // a tab opened before the next workspace's feed loads must start unseen-
    // unknown, not "seen" as of somewhere else's head.
    tabs.feedHead.value = h;
    if (h == null || !tabs.enabled.value) return;
    tabs.markSeen("all-unset", h);
    const active = state.value.tabs.find((t) => t.id === state.value.activeId);
    if (!active) return;
    const same = state.value.tabs.filter((t) => t.kind === active.kind && t.path === active.path);
    tabs.markSeen(
      same.map((t) => t.id),
      h,
    );
  },
  { immediate: true },
);

const { byId: members } = useWorkspaceMembers(ws.workspaceId);
function actorName(e: FeedEvent): string {
  const member = e.actorId ? members.value.get(e.actorId) : undefined;
  return actorShortName(e, userId.value, member?.name ?? null);
}

const entryPaths = computed(() => new Set(ws.entries.value.map((e) => e.path)));

const views = computed(() => {
  const ctx: TabViewContext = {
    activeId: state.value.activeId,
    workspaceName: ws.workspace.value?.name,
    loaded: !ws.loading.value,
    isDir: (path) => !!findNode(ws.tree.value, path)?.isDir,
    isFile: (path) => entryPaths.value.has(path),
    icons: ws.icons.value,
    dirty: editorDirty.value,
    events: events.value,
    userId: userId.value,
  };
  return state.value.tabs.map((tab) => tabView(tab, ctx));
});

// --- overflow ---------------------------------------------------------------
// Tabs shrink to a minimum width; past that the row scrolls, and an "all
// tabs" list appears at the end so nothing is only reachable by scrolling.
const scroller = ref<HTMLElement | null>(null);
const overflowing = ref(false);
function measure() {
  const el = scroller.value;
  overflowing.value = !!el && el.scrollWidth > el.clientWidth + 1;
}
let ro: ResizeObserver | null = null;
watch(scroller, (el) => {
  ro?.disconnect();
  if (!el) return;
  ro = new ResizeObserver(measure);
  ro.observe(el);
  measure();
});
onBeforeUnmount(() => ro?.disconnect());
watch(
  () => [state.value.tabs.length, state.value.activeId],
  () =>
    nextTick(() => {
      measure();
      scroller.value
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }),
);
// A vertical wheel scrolls the row sideways — it has no other axis.
function onWheel(e: WheelEvent) {
  const el = scroller.value;
  if (!el || !overflowing.value || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
}

// --- pointer ----------------------------------------------------------------
function onAuxClick(tab: Tab, e: MouseEvent) {
  if (e.button === 1) void tabs.close(tab.id);
}

const dragId = ref<string | null>(null);
const dropIndex = ref<number | null>(null);
function onDragStart(tab: Tab, e: DragEvent) {
  dragId.value = tab.id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tab.href); // Firefox needs a payload
  }
}
function onDragOver(index: number, e: DragEvent) {
  // Only a drag that started on a tab is ours.
  if (!dragId.value) return;
  e.preventDefault();
  dropIndex.value = index;
}
function onDrop(index: number) {
  if (dragId.value) tabs.move(dragId.value, index);
  onDragEnd();
}
function onDragEnd() {
  dragId.value = null;
  dropIndex.value = null;
}

// --- menus --------------------------------------------------------------------
const menu = ref<{ view: TabView; at: { x: number; y: number } } | null>(null);
function openMenu(view: TabView, e: MouseEvent) {
  menu.value = { view, at: { x: e.clientX, y: e.clientY } };
}

const allMenu = ref<{ x: number; y: number } | null>(null);
function openAll(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  allMenu.value = { x: r.right - 256, y: r.bottom + 4 };
}

// --- new tab ----------------------------------------------------------------
const quickAt = ref<{ x: number; y: number }>({ x: 0, y: 0 });
function openQuick(e?: MouseEvent) {
  const btn = e?.currentTarget as HTMLElement | undefined;
  const r = btn?.getBoundingClientRect() ?? scroller.value?.getBoundingClientRect();
  quickAt.value = r
    ? { x: r.left, y: r.bottom + 4 }
    : { x: Math.max(8, window.innerWidth / 2 - 208), y: 64 };
  tabs.quickOpen.value = true;
}
// ⌥T arrives as state, not a click; place it under the row (or, with the row
// hidden, near the top of the window).
watch(
  () => tabs.quickOpen.value,
  (open) => {
    if (open && quickAt.value.x === 0 && quickAt.value.y === 0) openQuick();
  },
);
const showQuick = computed(
  () => tabs.quickOpen.value && tabs.enabled.value && onWorkspaceRoute.value,
);
function closeQuick() {
  tabs.quickOpen.value = false;
  quickAt.value = { x: 0, y: 0 };
}
function openFromQuick(path: string) {
  closeQuick();
  tabs.openPath(path, "foreground");
}
</script>

<template>
  <div
    v-if="visible"
    class="relative flex h-9 shrink-0 items-end border-b border-border bg-app pl-1.5"
    data-testid="workspace-tabs"
  >
    <div
      ref="scroller"
      role="tablist"
      aria-label="Open tabs"
      class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      @wheel="onWheel"
    >
      <WorkspaceTab
        v-for="(view, i) in views"
        :key="view.tab.id"
        :view="view"
        :dragging="dragId === view.tab.id"
        :drop-target="dropIndex === i && dragId !== view.tab.id"
        @close="tabs.close(view.tab.id)"
        @click="tabs.switchTo(view.tab.id)"
        @keydown.enter.self.prevent="tabs.switchTo(view.tab.id)"
        @keydown.space.self.prevent="tabs.switchTo(view.tab.id)"
        @mousedown.middle.prevent
        @auxclick="onAuxClick(view.tab, $event)"
        @contextmenu.prevent="openMenu(view, $event)"
        @dragstart="onDragStart(view.tab, $event)"
        @dragover="onDragOver(i, $event)"
        @drop.prevent="onDrop(i)"
        @dragend="onDragEnd()"
        @pointerenter="prefetch.hover(view.tab.path)"
        @pointerleave="prefetch.leave(view.tab.path)"
      />
      <!-- Inside the scroller, so it sits right after the last tab; sticky, so
           it stays in reach once the row overflows. -->
      <button
        type="button"
        title="New tab (⌥T)"
        aria-label="New tab"
        class="sticky right-0 mb-px ml-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-app text-fg-muted transition hover:bg-surface-2 hover:text-fg"
        :class="overflowing ? 'shadow-[-14px_0_10px_-4px_var(--color-app)]' : ''"
        @click="openQuick($event)"
      >
        <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" aria-hidden="true">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <button
      v-if="overflowing"
      type="button"
      title="All tabs"
      class="mr-1.5 mb-px flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-fg/5 px-2 text-xs font-semibold text-fg-muted transition hover:bg-fg/10 hover:text-fg"
      @click="openAll($event)"
    >
      {{ state.tabs.length }}
      <IconChevron class="h-3.5 w-3.5" />
    </button>
  </div>

  <TabContextMenu v-if="menu" :view="menu.view" :at="menu.at" @close="menu = null" />
  <AllTabsMenu
    v-if="allMenu"
    :views="views"
    :at="allMenu"
    @pick="tabs.switchTo($event)"
    @close="allMenu = null"
  />
  <TabQuickOpen
    v-if="showQuick"
    :tree="ws.tree.value"
    :icons="ws.icons.value"
    :events="events"
    :existing="entryPaths"
    :actor-name="actorName"
    :at="quickAt"
    @open="openFromQuick"
    @close="closeQuick"
  />
</template>