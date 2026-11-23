<script setup lang="ts">
import { FOCUSABLE_SELECTOR, nextFocusIndex } from "~/utils/focusTrap";

// The shared behaviour behind every overlay this app puts over the page: the
// move dialog, the top bar's overflow sheet, the file tree's row sheet, the
// breadcrumb's path list.
//
// They all *looked* modal — a full-screen scrim, the page dimmed behind — while
// being invisible to a keyboard: focus stayed on the now-obscured trigger, Tab
// walked the controls behind the scrim, Escape did nothing, and closing left
// focus wherever it had wandered. Screen readers got no dialog boundary at all.
// One primitive fixes it in all four places rather than four near-misses.
//
// Teleported to <body> for two reasons: the app shell is `overflow-hidden`
// (which clipped these panels out of reach in the first place), and `inert` on
// the app root only works if the modal is outside that root.
const props = withDefaults(
  defineProps<{
    /** ARIA role. A menu of actions is a `menu`; anything else is a `dialog`. */
    role?: "dialog" | "menu";
    /** Accessible name. Required — an unnamed dialog is announced as nothing. */
    label: string;
    /** Where the panel sits. Presets, so the callers stay declarative. */
    placement?: "sheet" | "top-right" | "top-left" | "top-bar-menu" | "point";
    /** For `point`: where the panel's top-left corner goes (a context menu's pointer, a button's corner). Kept on screen. */
    at?: { x: number; y: number };
    /** Extra classes for the panel itself. */
    panelClass?: string;
    /** Dim the page behind. Off for lightweight dropdowns. */
    scrim?: boolean;
  }>(),
  { role: "dialog", placement: "sheet", panelClass: "", scrim: true },
);

const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
// The control that was focused when this opened, so focus can go back there on
// close. Without it, dismissing a sheet drops the keyboard user at the top of
// the document.
let returnFocusTo: HTMLElement | null = null;

const focusable = () =>
  panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
    return;
  }
  if (e.key !== "Tab") return;
  const items = focusable();
  const next = nextFocusIndex(
    items.length,
    items.indexOf(document.activeElement as HTMLElement),
    e.shiftKey,
  );
  if (next === null) return;
  e.preventDefault();
  items[next]?.focus();
}

// `inert` on the app root, so everything behind the scrim is unreachable by
// Tab, by click, and by assistive tech — the visual dimming made a promise the
// markup wasn't keeping.
function setBackgroundInert(inert: boolean) {
  const root = document.getElementById("__nuxt");
  if (!root) return;
  if (inert) root.setAttribute("inert", "");
  else root.removeAttribute("inert");
}

onMounted(() => {
  returnFocusTo = document.activeElement as HTMLElement | null;
  setBackgroundInert(true);
  // Focus the panel's first control, falling back to the panel itself (it is
  // tabindex="-1") so the boundary is announced even with nothing focusable.
  nextTick(() => {
    keepOnScreen();
    (focusable()[0] ?? panel.value)?.focus();
  });
  document.addEventListener("keydown", onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown, true);
  setBackgroundInert(false);
  // Restore focus after inert is cleared, or the element won't accept it.
  returnFocusTo?.focus?.();
});

// A `point` panel opens where it was asked to, then shifts left/up just enough
// to stay inside the window — a context menu near the right or bottom edge
// would otherwise open half off screen.
const shift = ref({ x: 0, y: 0 });
function keepOnScreen() {
  if (props.placement !== "point" || !panel.value) return;
  const r = panel.value.getBoundingClientRect();
  const pad = 8;
  shift.value = {
    x: Math.min(0, window.innerWidth - pad - r.right),
    y: Math.min(0, window.innerHeight - pad - r.bottom),
  };
}
const pointStyle = computed(() =>
  props.placement === "point" && props.at
    ? {
        left: `${Math.max(8, props.at.x + shift.value.x)}px`,
        top: `${Math.max(8, props.at.y + shift.value.y)}px`,
      }
    : undefined,
);

const placementClass = computed(
  () =>
    ({
      sheet: "inset-x-0 bottom-0 sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md",
      "top-right": "top-14 right-2 left-2 sm:left-auto sm:w-72",
      "top-left": "top-14 left-2 w-64",
      // The top bar's "⋯" menu: full width on a phone, and on anything wider a
      // narrow menu parked under the "⋯" itself rather than under the details
      // toggle to its right.
      "top-bar-menu": "top-14 right-2 left-2 sm:left-auto sm:right-12 sm:w-56",
      point: "",
    })[props.placement],
);
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50" :class="scrim ? 'bg-black/40' : ''" @click.self="emit('close')">
      <div
        ref="panel"
        :role="role"
        :aria-modal="role === 'dialog' ? 'true' : undefined"
        :aria-label="label"
        tabindex="-1"
        class="absolute max-h-[80dvh] overflow-auto border border-border bg-surface shadow-xl outline-none"
        :class="[placementClass, panelClass]"
        :style="pointStyle"
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>