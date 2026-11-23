// The side-panel rule, as plain data.
//
// `usePanels()` holds the reactive state and the persistence; this holds the
// decisions, so the two invariants that keep a phone out of the unreachable
// state it used to boot into can be tested directly:
//
//   1. On a compact screen at most ONE panel is open. Two panels plus a document
//      does not fit in 390px — that is how the document ended up 0px wide.
//   2. A compact toggle never writes the wide (persisted) state. Otherwise
//      opening the tree on a phone would silently rewrite the desktop
//      preference, and — worse — the wide default of "open" would flow back into
//      the next compact visit.

export type Panel = "sidebar" | "details";

export interface PanelState {
  /** Which single panel is overlaid on a compact screen. */
  overlay: Panel | null;
  /** Independent, persisted open/closed for the wide layout. */
  wideSidebar: boolean;
  wideDetails: boolean;
}

/** Which panels are open, for the current width. */
export function openPanels(state: PanelState, compact: boolean) {
  return compact
    ? { sidebar: state.overlay === "sidebar", details: state.overlay === "details" }
    : { sidebar: state.wideSidebar, details: state.wideDetails };
}

/** The state after opening or closing one panel. Pure — callers persist. */
export function setPanel(
  state: PanelState,
  compact: boolean,
  panel: Panel,
  open: boolean,
): PanelState {
  if (compact) {
    // Opening replaces whatever was overlaid; closing only clears the panel the
    // caller named, so "close details" can't close an open sidebar.
    return { ...state, overlay: open ? panel : state.overlay === panel ? null : state.overlay };
  }
  return panel === "sidebar" ? { ...state, wideSidebar: open } : { ...state, wideDetails: open };
}

/** Dismiss any overlay. A no-op while wide, where nothing overlays anything and
 *  the panels are the user's standing choice rather than a transient state. */
export function closeOverlay(state: PanelState, compact: boolean): PanelState {
  return compact ? { ...state, overlay: null } : state;
}