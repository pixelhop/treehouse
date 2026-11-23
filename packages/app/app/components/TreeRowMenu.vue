<script setup lang="ts">
import type { Component } from "vue";
import IconAddCircle from "~icons/solar/add-circle-linear";
import IconArrowDown from "~icons/solar/arrow-down-linear";
import IconArrowUp from "~icons/solar/arrow-up-linear";
import IconExternal from "~icons/solar/arrow-right-up-linear";
import IconFolderPath from "~icons/solar/folder-path-connect-linear";
import IconHistory from "~icons/solar/history-linear";
import IconLink from "~icons/solar/link-linear";
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import IconPalette from "~icons/solar/palette-linear";
import IconPen from "~icons/solar/pen-linear";
import IconPeople from "~icons/solar/users-group-rounded-linear";
import IconTab from "~icons/solar/window-frame-linear";
import IconTrash from "~icons/solar/trash-bin-trash-linear";
import IconUnlock from "~icons/solar/lock-keyhole-minimalistic-unlocked-linear";
import { isDesktopShell } from "~/utils/runtimeSurface";
import type { TreeNode } from "~/utils/treehouse";
import { treeRowMenu, type TreeRowAction } from "~/utils/treeRowMenu";

// Everything you can do to one row of the sidebar tree, in one menu. Opened by
// the row's "⋯" or a right-click on a wide screen, and as a sheet from the
// always-visible "⋯" on a compact one. Which actions a row gets is decided in
// utils/treeRowMenu.ts; this only draws them.
//
// It replaced a hover cluster of five icon buttons that sat over the row. In a
// nested folder the row is already narrow, so the cluster covered most of the
// filename and the row could only be clicked by widening the sidebar.

const props = defineProps<{
  node: TreeNode;
  /** Where a wide menu opens; null opens the compact sheet. */
  at: { x: number; y: number } | null;
  editable: boolean;
  canOpenTab: boolean;
  canOpenBrowserTab: boolean;
  canCopyLink: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}>();
const emit = defineEmits<{ close: []; run: [action: TreeRowAction] }>();

const ICONS: Record<TreeRowAction, Component> = {
  openTab: IconTab,
  openBrowserTab: IconExternal,
  copyLink: IconLink,
  newFile: IconAddCircle,
  rename: IconPen,
  move: IconFolderPath,
  editIcon: IconPalette,
  restore: IconHistory,
  moveUp: IconArrowUp,
  moveDown: IconArrowDown,
  access: IconPeople,
  makePrivate: IconLock,
  makeShared: IconUnlock,
  delete: IconTrash,
};

const tabShortcut = isDesktopShell() ? "⌘-click" : "⌘/Ctrl-click";
const groups = computed(() => treeRowMenu({ ...props, tabShortcut }));

/** A menu beside the row on a wide screen; a sheet with a scrim on a compact one. */
const surface = computed(() =>
  props.at
    ? { placement: "point" as const, scrim: false, panelClass: "w-60 rounded-xl p-1.5" }
    : {
        placement: "sheet" as const,
        scrim: true,
        panelClass: "w-full rounded-t-xl p-2 sm:rounded-xl",
      },
);

// Run before closing: reordering reads which row the menu was opened on.
function run(action: TreeRowAction) {
  emit("run", action);
  emit("close");
}
</script>

<template>
  <ModalSurface
    role="menu"
    :label="`Actions for ${node.name}`"
    :placement="surface.placement"
    :at="at ?? undefined"
    :scrim="surface.scrim"
    :panel-class="surface.panelClass"
    @close="emit('close')"
  >
    <!-- The sheet names its row; a menu opened beside the row needn't. ph-mask:
         user-authored name, masked in session replay. -->
    <template v-if="surface.scrim">
      <p class="ph-mask truncate px-2 py-2 text-sm font-medium text-fg">{{ node.name }}</p>
      <hr class="my-1 border-border" />
    </template>

    <template v-for="(group, g) in groups" :key="g">
      <hr v-if="g > 0" class="my-1 border-border" />
      <TreeRowMenuEntry
        v-for="(item, i) in group"
        :key="i"
        :item="item"
        :icon="item.kind === 'action' ? ICONS[item.action] : undefined"
        @run="run"
      />
    </template>
  </ModalSurface>
</template>