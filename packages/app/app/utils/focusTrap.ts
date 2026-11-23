// Focus-trap arithmetic, separated from the DOM so it can be tested directly.
//
// The DOM half (querying focusable elements, calling .focus()) lives in
// ModalSurface.vue; this decides *which* element should receive focus for a
// given Tab press. Keeping the wrap-around logic here is worth it because that
// is exactly the part that is easy to get subtly wrong — an off-by-one only
// shows up as "Tab escapes the dialog at one specific edge".

/** Elements that can hold focus, in the order a browser would visit them. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Index of the element Tab should move to, wrapping at both ends so focus can
 * never leave the trap.
 *
 * `current` is the index of the focused element within the trap, or -1 when
 * focus is somewhere outside it (which happens if the page moves focus while
 * the modal is open) — from outside, Tab enters at the appropriate end rather
 * than being ignored.
 *
 * Returns null when there is nothing focusable to move to.
 */
export function nextFocusIndex(count: number, current: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}