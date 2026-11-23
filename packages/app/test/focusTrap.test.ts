import { describe, expect, it } from "vite-plus/test";
import { nextFocusIndex } from "../app/utils/focusTrap";

// The arithmetic behind ModalSurface's focus trap. An off-by-one here shows up
// as "Tab escapes the dialog at one specific edge", which is exactly the kind of
// thing that survives a manual click-through.
describe("nextFocusIndex", () => {
  it("advances through the trap", () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 1, false)).toBe(2);
  });

  it("wraps forward off the last element", () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
  });

  it("wraps backward off the first element", () => {
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });

  it("steps backward in the middle", () => {
    expect(nextFocusIndex(3, 2, true)).toBe(1);
  });

  it("enters at the near end when focus is outside the trap", () => {
    // -1 = focus escaped (the page moved it while the modal was open). Tab must
    // pull it back in rather than doing nothing.
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it("handles a single focusable element by staying on it", () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
  });

  it("reports nothing to focus for an empty trap", () => {
    expect(nextFocusIndex(0, -1, false)).toBeNull();
    expect(nextFocusIndex(0, 0, true)).toBeNull();
  });
});