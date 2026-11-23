// Collapsible + drag-to-resize state for the app-shell sidebar.
//
// Open/closed lives in `usePanels()`, which owns the rule for both side panels
// (they are mutually exclusive and start closed on a compact screen). Width is
// this composable's own business: it only applies to the wide layout, where the
// sidebar is a resizable column rather than a fixed-width overlay.
const MIN = 200;
const MAX = 480;

const clamp = (w: number) => Math.min(MAX, Math.max(MIN, w));

export function useSidebar() {
  const panels = usePanels();

  const width = useState<number>("th:sb-width", () => {
    if (import.meta.client) {
      const w = Number(localStorage.getItem("th:sb-width"));
      if (w) return clamp(w);
    }
    return 272;
  });

  function setWidth(w: number) {
    width.value = clamp(w);
    if (import.meta.client) localStorage.setItem("th:sb-width", String(width.value));
  }

  return {
    open: panels.sidebarOpen,
    compact: panels.compact,
    width,
    min: MIN,
    max: MAX,
    setWidth,
    toggle: panels.toggleSidebar,
    close: panels.closeOverlay,
  };
}