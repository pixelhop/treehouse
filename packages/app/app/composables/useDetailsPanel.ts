// Open/collapsed state for the workspace details panel (the right sidebar).
//
// A view onto `usePanels()`, which owns the rule for both side panels. Shared
// (not local to WorkspaceView) because the page component remounts on every
// file navigation, so component-local state would spring back open each time
// the user opened a different file.
export function useDetailsPanel() {
  const panels = usePanels();
  return {
    open: panels.detailsOpen,
    compact: panels.compact,
    toggle: panels.toggleDetails,
    show: panels.openDetails,
    close: panels.closeOverlay,
  };
}