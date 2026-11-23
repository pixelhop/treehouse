<script setup lang="ts">
import type { VNode } from "vue";
import IconChevron from "~icons/solar/alt-arrow-right-linear";
// Build-time icons (unplugin-icons compiles these to inline SVG components).
// Every name here is a literal, so none of them needs the runtime <Icon>
// component: that one resolves names through the Iconify HTTP API and carries
// per-instance refs, watchers and lifecycle hooks. The row actions render once
// per visible row, so runtime icons meant thousands of network-dependent
// component instances for artwork that never changes.
import IconAddCircle from "~icons/solar/add-circle-linear";
import IconMenuDots from "~icons/solar/menu-dots-bold";
import IconFileText from "~icons/solar/file-text-linear";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import IconPeople from "~icons/solar/users-group-rounded-linear";
import { dropModeAt } from "~/composables/useFileTreeUi";
import { appRouteFor } from "~/utils/markdownRefs";
import { isDesktopShell } from "~/utils/runtimeSurface";
import { openIntent } from "~/utils/tabs";
import { rowMenuOnRightClick, type TreeRowAction } from "~/utils/treeRowMenu";
import type { TreeNode } from "~/utils/treehouse";

// `parent` is the folder path this list renders the children of ("" at the
// root) — it tells the instance whether the shared new-file draft row belongs
// here, and what folder a created file lands in.
//
// `readonly` drops every mutation affordance (row actions, inline rename, the
// new-file row, drag-to-move/reorder) while keeping the rows themselves
// identical. It's what the public share viewer renders: the same tree a member
// sees, minus everything a visitor can't do.
//
// `reorderable` is false while the sidebar is sorted by name or date: the rows
// are not in the shared custom order then, so a drop between two of them has
// no order to write. Dropping onto a folder still moves the file.
//
// `scope` names the tree for the expanded-folder state. It must be passed
// wherever the tree isn't the open workspace's — the public share viewer passes
// its token — both so the two don't share expansion state and so this component
// doesn't reach for the workspace (whose queries need a session a share visitor
// doesn't have).
const props = withDefaults(
  defineProps<{
    nodes: TreeNode[];
    selected: string | null;
    parent?: string;
    readonly?: boolean;
    /** Whether the member can change this node, for a tree with view-only parts. */
    canWrite?: (path: string) => boolean;
    reorderable?: boolean;
    scope?: string;
  }>(),
  { parent: "", readonly: false, reorderable: true, scope: undefined },
);
const emit = defineEmits<{
  manageAccess: [node: { path: string; isDir: boolean }];
  select: [node: { path: string; isDir: boolean }];
  editIcon: [path: string];
  reorder: [orderedPaths: string[]];
  move: [args: { from: string; isDir: boolean; destParent: string }];
  rename: [args: { from: string; isDir: boolean; newName: string }];
  delete: [args: { path: string; isDir: boolean }];
  setPrivate: [args: { path: string; isDir: boolean; makePrivate: boolean }];
  create: [args: { parent: string; name: string }];
  requestMove: [node: { path: string; isDir: boolean; name: string }];
}>();

// Row actions live in one menu (TreeRowMenu), opened three ways: the "⋯" that
// appears on hover (wide), a right-click (wide), and an always-visible "⋯"
// (compact, where there is no hover). On hover a row shows only that "⋯" and,
// for a folder, "New file in this folder" — two small buttons, so even a deeply
// nested row keeps its name readable and clickable.
const compact = useCompactLayout();
const menuNode = ref<TreeNode | null>(null);
const menuSiblings = ref<TreeNode[]>([]);
/** Where a wide menu opens; null opens the compact sheet. */
const menuAt = ref<{ x: number; y: number } | null>(null);

function openMenu(node: TreeNode, siblings: TreeNode[], at: { x: number; y: number } | null) {
  menuNode.value = node;
  menuSiblings.value = siblings;
  menuAt.value = at;
}
/** From a row's "⋯": under the button, right-aligned to it. */
function openMenuFrom(node: TreeNode, siblings: TreeNode[], e: MouseEvent) {
  if (compact.value) return openMenu(node, siblings, null);
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(node, siblings, { x: r.right - 240, y: r.bottom + 4 });
}
function closeMenu() {
  menuNode.value = null;
  menuSiblings.value = [];
}

// Reorder by one step among siblings — the tap-reachable half of what
// drag-to-reorder does. Emits the same full sibling order the drop handler does.
// Offered only where dragging isn't.
const menuIndex = computed(() =>
  menuNode.value ? menuSiblings.value.findIndex((n) => n.path === menuNode.value?.path) : -1,
);
const canMoveUp = computed(() => compact.value && props.reorderable && menuIndex.value > 0);
const canMoveDown = computed(
  () =>
    compact.value &&
    props.reorderable &&
    menuIndex.value !== -1 &&
    menuIndex.value < menuSiblings.value.length - 1,
);
function nudge(delta: number) {
  const from = menuIndex.value;
  if (from === -1) return;
  const order = menuSiblings.value.map((n) => n.path);
  const to = from + delta;
  if (to < 0 || to >= order.length) return;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  emit("reorder", order);
}

// Decided once per mounted tree: a FileTree belongs either to the open
// workspace or to one share, never to both in turn.
const ui = useFileTreeUi(props.scope === undefined ? undefined : toRef(() => props.scope ?? ""));

// Inline new-file row. Which folder it's open in is shared state (so only one is
// ever open); the typed name is local to the instance that renders it.
const draftHere = computed(() => ui.draftParent.value === props.parent);
const draftName = ref("");
watch(draftHere, (open) => {
  if (open) draftName.value = "";
});
function commitDraft() {
  // Same re-entry guard as rename: committing clears the shared draft, which
  // unmounts the input and fires @blur → a second commitDraft.
  if (!draftHere.value) return;
  ui.cancelDraft();
  const name = draftName.value.trim();
  if (name) emit("create", { parent: props.parent, name });
}

// Inline rename state is local to this FileTree instance — the node being
// renamed and its input live in the same instance, so a plain ref is enough.
const renamingPath = ref<string | null>(null);
const renameValue = ref("");
function startRename(node: TreeNode) {
  renamingPath.value = node.path;
  renameValue.value = node.name;
}
function commitRename(node: TreeNode) {
  // Guard re-entry: committing with Enter nulls renamingPath, which unmounts the
  // input and fires @blur → a second commitRename. Bail if we're already done.
  if (renamingPath.value !== node.path) return;
  renamingPath.value = null;
  const name = renameValue.value.trim();
  if (name && name !== node.name) {
    emit("rename", { from: node.path, isDir: node.isDir, newName: name });
  }
}
function cancelRename() {
  renamingPath.value = null;
}

// Which row shows its action buttons. Hover and keyboard focus are tracked
// SEPARATELY and OR'd: with one shared value, moving the pointer off a row whose
// action button currently has focus would unmount the focused element and drop
// focus to <body> under the user.
//
// Both refs are local to this FileTree instance rather than living in
// useFileTreeUi. That state is read by every row in the tree, so hover state
// there would invalidate all ~2,400 rows on every pointer move — reintroducing
// the cost this change exists to remove. One instance renders one folder's
// children, and v-memo narrows even that to the rows that actually changed.
const hoveredRow = ref<string | null>(null);
const focusedRow = ref<string | null>(null);

function showActions(node: TreeNode): boolean {
  if (renamingPath.value === node.path) return false;
  return hoveredRow.value === node.path || focusedRow.value === node.path;
}
// Resting the pointer on a file starts loading it, so the click that usually
// follows opens it from cache. The workspace's own tree only: a share has its
// own source.
const prefetch = props.scope === undefined ? usePrefetchFile() : null;
function onRowEnter(node: TreeNode) {
  hoveredRow.value = node.path;
  if (!node.isDir) prefetch?.hover(node.path);
}
function onRowLeave(node: TreeNode) {
  if (hoveredRow.value === node.path) hoveredRow.value = null;
  prefetch?.leave(node.path);
}
function onRowFocusIn(node: TreeNode) {
  focusedRow.value = node.path;
}
// Tabbing from the filename button to the first action button fires focusout on
// the row before focusin. Clearing unconditionally would unmount the button
// being tabbed to, so check where focus actually went instead of relying on the
// ordering of two events that happen to land in the same flush.
function onRowFocusOut(node: TreeNode, e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  const row = e.currentTarget as HTMLElement | null;
  if (next && row?.contains(next)) return;
  if (focusedRow.value === node.path) focusedRow.value = null;
}
function confirmDelete(node: TreeNode) {
  const what = node.isDir ? `folder “${node.name}” and everything in it` : `“${node.name}”`;
  if (window.confirm(`Delete ${what}?`)) emit("delete", { path: node.path, isDir: node.isDir });
}

function onDragStart(node: TreeNode, e: DragEvent) {
  if (props.readonly) return;
  ui.startDrag(node);
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", node.path); // Firefox needs payload
  }
}
// Only a drag that started in the tree is ours. Anything else — an OS file drag
// in particular — must bubble to the surrounding UploadDropZone untouched, or it
// never gets the preventDefault that lets the drop land.
function onDragOver(node: TreeNode, e: DragEvent) {
  if (props.readonly || !ui.drag.value) return;
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const mode = dropModeAt(node.isDir, (e.clientY - rect.top) / rect.height, props.reorderable);
  // Only allow the drop (preventDefault) on valid targets, so the cursor shows
  // "allowed" only where a drop will actually do something.
  if (ui.canDrop(node, mode, props.reorderable)) e.preventDefault();
  ui.setDrop(node, mode, props.reorderable);
}
function onDrop(node: TreeNode, nodes: TreeNode[], e: DragEvent) {
  if (props.readonly || !ui.drag.value) return;
  e.stopPropagation();
  const d = ui.drag.value;
  const t = ui.dropTarget.value;
  // Validate while the drag is still live (canDrop reads ui.drag), then act,
  // then clear — clearing first would make canDrop see a null drag and bail.
  if (!d || !t || t.path !== node.path || !ui.canDrop(node, t.mode, props.reorderable)) {
    ui.endDrag();
    return;
  }
  const destParent = t.mode === "into" ? node.path : ui.parentOf(node.path);
  if (t.mode !== "into" && destParent === d.parent) {
    // Same folder → reorder display order (d is a sibling in this list).
    const order = nodes.filter((n) => n.path !== d.path).map((n) => n.path);
    const at = order.indexOf(node.path) + (t.mode === "after" ? 1 : 0);
    order.splice(at, 0, d.path);
    emit("reorder", order);
  } else {
    // Different folder (or dropped onto a folder) → real move.
    emit("move", { from: d.path, isDir: d.isDir, destParent });
  }
  ui.endDrag();
}

// Indicator helpers — read the shared drop target.
function lineAt(node: TreeNode, edge: "before" | "after"): boolean {
  const t = ui.dropTarget.value;
  return !!t && t.path === node.path && t.mode === edge;
}
function isInto(node: TreeNode): boolean {
  const t = ui.dropTarget.value;
  return !!t && t.path === node.path && t.mode === "into";
}
function isDragged(node: TreeNode): boolean {
  return ui.drag.value?.path === node.path;
}

// The selected row is a solid accent fill, so the subtle greys every row's
// controls use would vanish into it. Keyed off the row's `data-selected` (the
// row is the `group`) rather than a per-element ternary, so each control needs
// only this one class. Its own hover keeps the accent foreground — a danger-red
// or fg-green hover would be unreadable on the fill.
const ON_SELECTED =
  "group-data-[selected]:text-accent-fg/75 group-data-[selected]:hover:text-accent-fg";

// A folder on the path to the open file. Its name is set a little stronger, so
// the trail down to the selected row reads at a glance in a long expanded tree.
function isAncestor(node: TreeNode): boolean {
  return node.isDir && !!props.selected?.startsWith(`${node.path}/`);
}

// Tabs: ⌘/Ctrl-click or a middle click opens the row in a new tab, and the row
// menu offers the same. Only the open workspace's tree — a share's tree has no
// tabs to open into. `openPath` answers false whenever tabs are off, and the
// click then does what it always did.
const tabs = props.readonly || props.scope !== undefined ? null : useWorkspaceTabs();
const rowReadonly = (node: TreeNode) => props.readonly || props.canWrite?.(node.path) === false;
const inDesktopShell = isDesktopShell();

// A right-click opens the row menu wherever it has something to offer (see
// rowMenuOnRightClick); elsewhere the browser's own menu shows.
function onRowContextMenu(node: TreeNode, nodes: TreeNode[], e: MouseEvent) {
  const offered = rowMenuOnRightClick({
    compact: compact.value,
    renaming: renamingPath.value === node.path,
    rowReadonly: rowReadonly(node),
    workspaceTree: !!tabs,
  });
  if (!offered) return;
  e.preventDefault();
  openMenu(node, nodes, { x: e.clientX, y: e.clientY });
}

const ROW_ACTIONS: Record<TreeRowAction, (node: TreeNode) => void> = {
  openTab: (n) => void tabs?.openPath(n.path, "background"),
  openBrowserTab: (n) => openInBrowserTab(n),
  copyLink: (n) => void copyNodeLink(n),
  newFile: (n) => ui.startDraft(n.path),
  rename: (n) => startRename(n),
  move: (n) => emit("requestMove", { path: n.path, isDir: n.isDir, name: n.name }),
  editIcon: (n) => emit("editIcon", n.path),
  restore: (n) => restoreTo.open(n.path),
  moveUp: () => nudge(-1),
  moveDown: () => nudge(1),
  access: (n) => emit("manageAccess", { path: n.path, isDir: n.isDir }),
  makePrivate: (n) => emit("setPrivate", { path: n.path, isDir: n.isDir, makePrivate: true }),
  makeShared: (n) => emit("setPrivate", { path: n.path, isDir: n.isDir, makePrivate: false }),
  delete: (n) => confirmDelete(n),
};

function openInBrowserTab(node: TreeNode) {
  const id = tabs?.workspaceId.value;
  if (id) window.open(appRouteFor(id, node.path), "_blank", "noopener");
}
async function copyNodeLink(node: TreeNode) {
  const id = tabs?.workspaceId.value;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(new URL(appRouteFor(id, node.path), location.origin).href);
  } catch {
    // clipboard refused — nothing useful to say about it here
  }
}
function onNameAuxClick(node: TreeNode, e: MouseEvent) {
  if (e.button === 1) tabs?.openPath(node.path, openIntent(e));
}

function onNameClick(node: TreeNode, e: MouseEvent) {
  if (tabs?.openPath(node.path, openIntent(e))) return;
  emit("select", { path: node.path, isDir: node.isDir });
  if (node.isDir && !ui.isExpanded(node.path)) ui.toggle(node.path);
}

// "Restore to an earlier time…" in a folder's row menu.
const restoreTo = useRestoreTo();
</script>

<template>
  <ul class="space-y-0.5">
    <!-- v-memo skips re-rendering rows whose inputs did not change. Several
         shared refs (drop target, drag, draft parent) are read by every row, so
         without it a single drag move re-renders the whole expanded tree.

         The dependency list must be complete or rows go stale. Note that this
         <li> ENCLOSES the recursive <FileTree> for this node's children, and a
         memo hit reuses that whole subtree without patching it — so anything the
         children consume has to appear here as a WHOLE VALUE, not as a
         row-local comparison. `selected === node.path` would be false both
         before and after selection moves between two files inside a nested
         folder, so the child would never receive the new value and the old
         highlight would never clear. -->
    <li
      v-for="node in nodes"
      :key="node.path"
      v-memo="[
        node,
        node.children,
        nodes,
        selected,
        showActions(node),
        ui.isExpanded(node.path),
        ui.draftParent.value,
        readonly,
        reorderable,
        compact,
        lineAt(node, 'before'),
        lineAt(node, 'after'),
        isInto(node),
        isDragged(node),
        renamingPath === node.path && renameValue,
      ]"
    >
      <div
        class="group relative flex min-h-11 items-center gap-0.5 rounded-md pr-1 transition lg:min-h-0"
        :class="[
          isInto(node)
            ? 'bg-accent/15 ring-2 ring-accent ring-inset'
            : selected === node.path
              ? 'bg-accent text-accent-fg'
              : 'hover:bg-fg/5 focus-within:bg-fg/5',
          isDragged(node) ? 'opacity-40' : '',
        ]"
        :data-tree-path="node.path"
        :data-selected="selected === node.path || undefined"
        :draggable="!rowReadonly(node)"
        @pointerenter="onRowEnter(node)"
        @pointerleave="onRowLeave(node)"
        @focusin="onRowFocusIn(node)"
        @focusout="onRowFocusOut(node, $event)"
        @dragstart.stop="onDragStart(node, $event)"
        @dragover="onDragOver(node, $event)"
        @drop="onDrop(node, nodes, $event)"
        @dragend="ui.endDrag()"
        @contextmenu="onRowContextMenu(node, nodes, $event)"
      >
        <!-- insertion-point indicator (drop line + leading dot) -->
        <div
          v-if="lineAt(node, 'before')"
          class="pointer-events-none absolute inset-x-1 -top-[3px] z-10 h-0.5 rounded-full bg-accent"
        >
          <span class="absolute top-1/2 -left-1 h-2 w-2 -translate-y-1/2 rounded-full bg-accent" />
        </div>
        <div
          v-if="lineAt(node, 'after')"
          class="pointer-events-none absolute inset-x-1 -bottom-[3px] z-10 h-0.5 rounded-full bg-accent"
        >
          <span class="absolute top-1/2 -left-1 h-2 w-2 -translate-y-1/2 rounded-full bg-accent" />
        </div>

        <button
          v-if="node.isDir"
          type="button"
          :title="ui.isExpanded(node.path) ? 'Collapse' : 'Expand'"
          class="grid h-9 w-9 shrink-0 place-items-center rounded text-fg-subtle transition hover:text-fg lg:h-auto lg:w-auto lg:p-1"
          :class="ON_SELECTED"
          @click="ui.toggle(node.path)"
        >
          <IconChevron
            class="h-3.5 w-3.5 transition-transform"
            :class="ui.isExpanded(node.path) ? 'rotate-90' : ''"
          />
        </button>
        <span v-else class="w-9 shrink-0 lg:w-[22px]" />

        <template v-if="renamingPath === node.path">
          <span class="grid shrink-0 place-items-center px-1 text-fg-subtle" :class="ON_SELECTED">
            <NodeIcon :icon="node.icon" :is-dir="node.isDir" class="h-4 w-4" />
          </span>
          <input
            v-model="renameValue"
            type="text"
            class="min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 py-0.5 text-sm text-fg outline-none"
            @keydown.enter.prevent="commitRename(node)"
            @keydown.esc.prevent="cancelRename()"
            @blur="commitRename(node)"
            @click.stop
            @vue:mounted="(vnode: VNode) => (vnode.el as HTMLInputElement).select()"
          />
        </template>
        <!-- The icon sits inside the name's button, so the whole row opens the
             file. Changing the icon lives in the row menu. -->
        <button
          v-else
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-1 text-left text-sm transition lg:py-1"
          :class="
            selected === node.path
              ? 'font-medium text-accent-fg'
              : isAncestor(node)
                ? 'font-medium text-fg'
                : node.isDir
                  ? 'text-fg-muted'
                  : 'text-fg'
          "
          @click="onNameClick(node, $event)"
          @mousedown.middle="tabs?.enabled.value && $event.preventDefault()"
          @auxclick="onNameAuxClick(node, $event)"
        >
          <NodeIcon
            :icon="node.icon"
            :is-dir="node.isDir"
            class="h-4 w-4 shrink-0 text-fg-subtle"
            :class="ON_SELECTED"
          />
          <span class="ph-mask truncate">{{ node.name }}</span>
          <IconLock
            v-if="node.private"
            title="Private — only you and your agents can see this"
            class="h-3.5 w-3.5 shrink-0 text-fg-subtle"
            :class="ON_SELECTED"
          />
          <IconPeople
            v-else-if="node.restricted"
            title="Only the people it's shared with can see this"
            class="h-3.5 w-3.5 shrink-0 text-fg-subtle"
            :class="ON_SELECTED"
          />
          <!-- New to you. An open folder shows it on whatever inside is new
               instead, so the dots lead down to the file. -->
          <span
            v-if="
              node.unseen && selected !== node.path && !(node.isDir && ui.isExpanded(node.path))
            "
            :title="node.isDir ? 'Something in here is new to you' : 'New since you last looked'"
            class="mr-1 ml-auto h-2 w-2 shrink-0 rounded-full bg-accent"
          >
            <span class="sr-only">New</span>
          </span>
          <span
            v-if="node.conflicted"
            title="Conflicted copy — both versions kept; resolve manually"
            class="ml-auto text-warning"
            >⚠</span
          >
        </button>

        <!-- Compact: an always-visible menu button. Sits in the flow rather than
             over the row, so it never covers the filename it belongs to. -->
        <button
          v-if="!rowReadonly(node) && compact && renamingPath !== node.path"
          type="button"
          :title="`Actions for ${node.name}`"
          class="grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-subtle transition hover:bg-surface hover:text-fg group-data-[selected]:hover:bg-accent-fg/15"
          :class="ON_SELECTED"
          @click.stop="openMenu(node, nodes, null)"
        >
          <IconMenuDots class="h-4 w-4" />
        </button>

        <!-- Wide: two small buttons over the end of the row — new file (folders)
             and the row menu — mounted only for the row under the pointer or
             holding focus. Absolutely positioned so they reserve no layout
             space, with a short fade so the name runs under them. It used to be
             five buttons, which in a nested folder covered most of the name. -->
        <div
          v-if="!rowReadonly(node) && !compact && showActions(node)"
          class="absolute inset-y-0 right-0.5 flex items-center gap-px rounded-r-md bg-gradient-to-l from-70% to-transparent pl-5"
          :class="
            isInto(node)
              ? 'from-[color-mix(in_oklab,var(--color-accent)_15%,var(--color-surface))]'
              : selected === node.path
                ? 'from-accent'
                : 'from-[color-mix(in_srgb,var(--color-fg)_5%,var(--color-surface-2))]'
          "
        >
          <button
            v-if="node.isDir"
            type="button"
            title="New file in this folder"
            class="grid h-6 w-6 place-items-center rounded text-fg-subtle transition hover:bg-fg/10 hover:text-fg group-data-[selected]:hover:bg-accent-fg/15"
            :class="ON_SELECTED"
            @click.stop="ui.startDraft(node.path)"
          >
            <IconAddCircle class="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            :title="`More actions for ${node.name}`"
            aria-haspopup="menu"
            class="grid h-6 w-6 place-items-center rounded text-fg-subtle transition hover:bg-fg/10 hover:text-fg group-data-[selected]:hover:bg-accent-fg/15"
            :class="ON_SELECTED"
            @click.stop="openMenuFrom(node, nodes, $event)"
          >
            <IconMenuDots class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <!-- An empty folder still renders its (otherwise absent) child list while
           its new-file row is open, so the row appears inside the folder. -->
      <div
        v-if="
          node.isDir &&
          (node.children.length || ui.draftParent.value === node.path) &&
          ui.isExpanded(node.path)
        "
        class="ml-[11px] border-l border-border pl-1"
      >
        <FileTree
          :nodes="node.children"
          :selected="selected"
          :parent="node.path"
          :readonly="readonly"
          :can-write="canWrite"
          :reorderable="reorderable"
          :scope="scope"
          @select="emit('select', $event)"
          @edit-icon="emit('editIcon', $event)"
          @reorder="emit('reorder', $event)"
          @move="emit('move', $event)"
          @rename="emit('rename', $event)"
          @delete="emit('delete', $event)"
          @set-private="emit('setPrivate', $event)"
          @manage-access="emit('manageAccess', $event)"
          @create="emit('create', $event)"
          @request-move="emit('requestMove', $event)"
        />
      </div>
    </li>

    <!-- Inline new-file row for this folder. Named without an extension, the
         file becomes markdown (see withDefaultExtension). -->
    <li
      v-if="draftHere && !readonly && (canWrite?.(parent) ?? true)"
      class="flex items-center gap-0.5 pr-1"
    >
      <span class="w-[22px] shrink-0" />
      <span class="grid shrink-0 place-items-center p-1.5 text-fg-subtle">
        <IconFileText class="h-4 w-4" />
      </span>
      <input
        v-model="draftName"
        type="text"
        aria-label="New file name"
        placeholder="name.md"
        class="min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 py-0.5 text-sm text-fg outline-none"
        @keydown.enter.prevent="commitDraft()"
        @keydown.esc.prevent="ui.cancelDraft()"
        @blur="commitDraft()"
        @click.stop
        @vue:mounted="(vnode: VNode) => (vnode.el as HTMLInputElement).focus()"
      />
    </li>
  </ul>

  <TreeRowMenu
    v-if="menuNode"
    :node="menuNode"
    :at="menuAt"
    :editable="!rowReadonly(menuNode)"
    :can-open-tab="!!tabs?.canOpen.value"
    :can-open-browser-tab="!!tabs && !inDesktopShell && !compact"
    :can-copy-link="!!tabs"
    :can-move-up="canMoveUp"
    :can-move-down="canMoveDown"
    @run="ROW_ACTIONS[$event](menuNode)"
    @close="closeMenu()"
  />
</template>