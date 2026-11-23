<script setup lang="ts">
import { Comment, Fragment, Text, type Slot, type VNode } from "vue";
import IconSidebar from "~icons/solar/sidebar-minimalistic-bold-duotone";
import IconMore from "~icons/solar/menu-dots-bold";

// The app's top bar: panel toggle · breadcrumb · view controls · actions.
//
// Four slots, because a 390px bar cannot hold what a 1400px bar can, and
// because not everything in a bar deserves to be in the bar at all:
//
//   #menu     — the view controls (a segmented switcher). Inline in the bar on a
//               wide screen; folded into the "⋯" sheet on a compact one.
//   #actions  — always in the bar. The one primary action, kept to a control or
//               two.
//   #overflow — never in the bar. Menu rows behind "⋯" at EVERY width: the
//               once-in-a-while commands (refresh, download, copy path) that
//               used to spend permanent bar width on themselves.
//   #trailing — the bar's own persistent icon controls (the details toggle),
//               after the "⋯" so the ordering matches the design: primary
//               action | overflow, panel.
//
// There is exactly one "⋯" at any width. On a compact screen it opens a sheet
// holding #menu AND #overflow together, so a phone never gets two of them.
//
// The layout rule that matters: the breadcrumb is the only thing allowed to
// shrink (`min-w-0`), and the actions are `shrink-0`. Previously everything was
// in one unconstrained flex row, so the actions were pushed off the right edge
// of a header that neither wraps nor scrolls — inside an `overflow-hidden`
// parent, which made them unreachable by any gesture. The details toggle was
// one of them, so a phone could not close the panel that was covering its own
// content. Controls yielding space to a breadcrumb is never the right trade.
//
// `sidebarToggle: false` hides the collapse control for surfaces with no sidebar
// to collapse (a single-file public share).
withDefaults(defineProps<{ title?: string; sidebarToggle?: boolean }>(), { sidebarToggle: true });

const slots = useSlots();
const sb = useSidebar();
const compact = useCompactLayout();

const menuOpen = ref(false);

/**
 * Does this slot RENDER anything — not merely, was it passed?
 *
 * Every caller passes these slots unconditionally and hides their contents with
 * `v-if`: there is no view switcher for a plain text file, no Edit button while
 * editing, no folder switcher until the file list has loaded. Asking the easy
 * question (`!!slots.menu`) puts a "⋯" in the bar that opens onto nothing and
 * draws a divider with empty space on both sides. Asking it as a `v-if` on the
 * `<template #menu>` instead is worse: `slots` is mutated in place between
 * renders, so a computed reading `!!slots.menu` never re-evaluates and the
 * control stays missing for the life of the page.
 *
 * Invoking the slot inside a computed is what makes this reactive — the
 * parent's own state is read while the computed is tracking.
 */
function slotHasContent(slot?: Slot): boolean {
  const rendered = (nodes: VNode[] | undefined): boolean =>
    (nodes ?? []).some((n) => {
      if (n.type === Comment) return false; // a v-if that chose nothing
      if (n.type === Fragment) return rendered(n.children as VNode[]);
      if (n.type === Text) return String(n.children).trim() !== "";
      return true;
    });
  return rendered(slot?.());
}

const hasMenu = computed(() => slotHasContent(slots.menu));
const hasOverflow = computed(() => slotHasContent(slots.overflow));
// Fold the view controls into the sheet only on a compact screen — and only
// when there are some, so the "⋯" never opens onto nothing.
const collapseMenu = computed(() => compact.value && hasMenu.value);
const showMore = computed(() => hasOverflow.value || collapseMenu.value);
// A hairline between what acts on the document and the bar's own controls —
// drawn only when there is something on each side of it.
const showDivider = computed(() => {
  const left = (!collapseMenu.value && hasMenu.value) || slotHasContent(slots.actions);
  return left && (showMore.value || slotHasContent(slots.trailing));
});

// Returning to a wide screen inlines the view controls again — leaving the
// sheet open would strand a floating panel duplicating controls now in the bar.
watch(compact, () => {
  menuOpen.value = false;
});
</script>

<template>
  <header class="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2 text-sm sm:px-3">
    <button
      v-if="sidebarToggle"
      type="button"
      :title="sb.open.value ? 'Hide sidebar' : 'Show sidebar'"
      class="grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-2 lg:h-8 lg:w-8"
      @click="sb.toggle()"
    >
      <IconSidebar class="h-4 w-4" />
    </button>

    <!-- The only element permitted to shrink. -->
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      <slot name="breadcrumb">
        <span class="truncate font-medium text-fg">{{ title }}</span>
      </slot>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <!-- Wide: the view controls sit inline, as they always have. -->
      <template v-if="hasMenu && !collapseMenu">
        <slot name="menu" />
      </template>
      <slot name="actions" />
      <span v-if="showDivider" class="mx-1 h-5 w-px shrink-0 bg-border" />
      <button
        v-if="showMore"
        type="button"
        title="More"
        aria-label="More actions"
        aria-haspopup="dialog"
        :aria-expanded="menuOpen"
        class="grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-2 lg:h-8 lg:w-8"
        :class="menuOpen ? 'bg-surface-2 text-fg' : ''"
        @click="menuOpen = !menuOpen"
      >
        <IconMore class="h-4 w-4" />
      </button>
      <slot name="trailing" />
    </div>
  </header>

  <!-- ModalSurface teleports this out of the shell's `overflow-hidden` (which is
       what clipped these controls out of reach to begin with) and supplies the
       keyboard behaviour: Escape, focus trapping, inert background, focus back
       to the "⋯" on close. -->
  <!-- role=dialog, not menu: a `menu` promises menuitem children and arrow-key
       navigation, and this surface has neither — it holds plain buttons, links,
       and (compact) a segmented group, and ModalSurface's keyboard model is Tab
       + Escape. Dialog semantics describe what actually happens. -->
  <ModalSurface
    v-if="showMore && menuOpen"
    role="dialog"
    label="More actions"
    placement="top-bar-menu"
    :scrim="compact"
    panel-class="flex flex-col gap-0.5 rounded-xl p-1.5"
    @close="menuOpen = false"
  >
    <!-- Any activation inside dismisses the menu, as a menu should. -->
    <div class="contents" @click="menuOpen = false">
      <!-- Compact only: the view controls, above the commands they belong with. -->
      <template v-if="collapseMenu">
        <div class="flex flex-wrap items-center gap-2 p-1">
          <slot name="menu" />
        </div>
        <span v-if="hasOverflow" class="mx-1 my-0.5 h-px bg-border" />
      </template>
      <slot name="overflow" />
    </div>
  </ModalSurface>
</template>