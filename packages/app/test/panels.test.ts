import { describe, expect, it } from "vite-plus/test";
import { closeOverlay, openPanels, setPanel, type PanelState } from "../app/utils/panels";

// Both panels open by default, which is the wide layout's behaviour and the
// starting point that used to leak onto phones.
const fresh: PanelState = { overlay: null, wideSidebar: true, wideDetails: true };

const WIDE = false;
const COMPACT = true;

describe("openPanels", () => {
  it("reports the persisted state on a wide screen", () => {
    expect(openPanels(fresh, WIDE)).toEqual({ sidebar: true, details: true });
    expect(openPanels({ ...fresh, wideDetails: false }, WIDE)).toEqual({
      sidebar: true,
      details: false,
    });
  });

  it("starts with nothing open on a compact screen, whatever the wide state says", () => {
    // The regression this guards: a phone booting with a 272px sidebar and a
    // 320px details panel, leaving the document 0px wide.
    expect(openPanels(fresh, COMPACT)).toEqual({ sidebar: false, details: false });
  });

  it("reports only the overlaid panel on a compact screen", () => {
    expect(openPanels({ ...fresh, overlay: "sidebar" }, COMPACT)).toEqual({
      sidebar: true,
      details: false,
    });
    expect(openPanels({ ...fresh, overlay: "details" }, COMPACT)).toEqual({
      sidebar: false,
      details: true,
    });
  });
});

describe("setPanel on a compact screen", () => {
  it("never leaves both panels open", () => {
    let s = setPanel(fresh, COMPACT, "sidebar", true);
    expect(openPanels(s, COMPACT)).toEqual({ sidebar: true, details: false });

    s = setPanel(s, COMPACT, "details", true);
    expect(openPanels(s, COMPACT)).toEqual({ sidebar: false, details: true });
  });

  it("does not touch the persisted wide state", () => {
    // Otherwise opening the tree on a phone rewrites the desktop preference —
    // and the wide default of "open" flows back into the next compact visit.
    const s = setPanel(setPanel(fresh, COMPACT, "sidebar", true), COMPACT, "details", true);
    expect(s.wideSidebar).toBe(true);
    expect(s.wideDetails).toBe(true);
  });

  it("closing a panel only closes the one named", () => {
    const s = setPanel(fresh, COMPACT, "sidebar", true);
    // "Close details" while the sidebar is overlaid must not close the sidebar.
    expect(openPanels(setPanel(s, COMPACT, "details", false), COMPACT).sidebar).toBe(true);
    expect(openPanels(setPanel(s, COMPACT, "sidebar", false), COMPACT).sidebar).toBe(false);
  });
});

describe("setPanel on a wide screen", () => {
  it("keeps the two panels independent", () => {
    const s = setPanel(fresh, WIDE, "sidebar", false);
    expect(openPanels(s, WIDE)).toEqual({ sidebar: false, details: true });
    expect(openPanels(setPanel(s, WIDE, "details", false), WIDE)).toEqual({
      sidebar: false,
      details: false,
    });
  });

  it("leaves the compact overlay alone", () => {
    expect(setPanel({ ...fresh, overlay: "details" }, WIDE, "sidebar", false).overlay).toBe(
      "details",
    );
  });
});

describe("closeOverlay", () => {
  it("dismisses the overlaid panel on a compact screen", () => {
    expect(closeOverlay({ ...fresh, overlay: "sidebar" }, COMPACT).overlay).toBeNull();
  });

  it("is a no-op while wide, where the panels are a standing choice", () => {
    const wide = { ...fresh, overlay: null };
    expect(closeOverlay(wide, WIDE)).toEqual(wide);
    // Selecting a file calls this; on desktop it must not collapse the tree.
    expect(openPanels(closeOverlay(wide, WIDE), WIDE)).toEqual({ sidebar: true, details: true });
  });
});

describe("crossing the breakpoint", () => {
  it("restores the wide layout untouched after using panels on a phone", () => {
    // Rotate a tablet, use the sidebar, rotate back.
    const used = setPanel(fresh, COMPACT, "sidebar", true);
    const backToWide = { ...used, overlay: null };
    expect(openPanels(backToWide, WIDE)).toEqual({ sidebar: true, details: true });
  });
});