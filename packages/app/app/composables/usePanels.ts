// The app shell has two side panels: the workspace sidebar (left) and the file
// details panel (right). This composable owns the rule for both, because the
// rule differs by screen width and because the two panels have to know about
// each other.
//
// Wide (>= 1024px): independent, persisted, laid out BESIDE the document —
// exactly what the app has always done.
//
// Compact (< 1024px): they overlay the document, and
//   - only one can be open at a time (there is not room to read behind two), and
//   - they start CLOSED, and open/closed is not persisted.
//
// That second rule is the important one. The wide default is "open", and while
// the two panels each owned their own persisted boolean, a phone inherited it:
// a 390px screen booted with a 272px sidebar and a 320px details panel, leaving
// the document 0px wide and the only control that could close them rendered off
// the right edge of a header that doesn't scroll. Compact state being separate,
// closed, and ephemeral is what makes that unreachable state unreachable.
//
// The decisions themselves live in utils/panels.ts so they can be tested without
// a Nuxt runtime; this holds the reactive state and the persistence.
//
// `useSidebar()` and `useDetailsPanel()` are thin views onto this — call sites
// keep their existing shape, but there is one owner of the behaviour.
import { closeOverlay, openPanels, setPanel, type Panel, type PanelState } from "~/utils/panels";

/** Below this width the panels overlay instead of taking layout space. Matches
 *  Tailwind's `lg`, so the template breakpoints and this logic can't drift. */
export const COMPACT_QUERY = "(max-width: 1023.98px)";

/** True when the shell should use overlay panels. */
export function useCompactLayout(): Ref<boolean> {
  return useMediaQuery(COMPACT_QUERY);
}

function readPersisted(key: string, fallback: boolean): boolean {
  if (!import.meta.client) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === "1";
  } catch {
    // storage disabled — behave as if nothing were remembered
    return fallback;
  }
}

function persist(key: string, value: boolean) {
  if (!import.meta.client) return;
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // storage disabled or full — the in-memory state still holds for the session
  }
}

export function usePanels() {
  const compact = useCompactLayout();

  // Seeded from localStorage in the initializer (client-only SPA) so there's no
  // open→restored layout shift on load.
  const state = useState<PanelState>("th:panels", () => ({
    overlay: null,
    wideSidebar: readPersisted("th:sb-open", true),
    wideDetails: readPersisted("th:details-open", true),
  }));

  // Crossing back to a wide screen (rotating a tablet, resizing a window) drops
  // any overlay, so the panels return to their own persisted layout state rather
  // than a stale overlay flag deciding it for them.
  if (import.meta.client) {
    watch(compact, (isCompact) => {
      if (!isCompact) state.value = { ...state.value, overlay: null };
    });
  }

  const open = computed(() => openPanels(state.value, compact.value));
  const sidebarOpen = computed(() => open.value.sidebar);
  const detailsOpen = computed(() => open.value.details);

  function set(panel: Panel, isOpen: boolean) {
    state.value = setPanel(state.value, compact.value, panel, isOpen);
    // Only the wide layout's choice is remembered — see the header comment.
    if (!compact.value) {
      persist(panel === "sidebar" ? "th:sb-open" : "th:details-open", isOpen);
    }
  }

  return {
    compact,
    sidebarOpen,
    detailsOpen,
    toggleSidebar: () => set("sidebar", !sidebarOpen.value),
    toggleDetails: () => set("details", !detailsOpen.value),
    openDetails: () => set("details", true),
    closeOverlay: () => {
      state.value = closeOverlay(state.value, compact.value);
    },
  };
}