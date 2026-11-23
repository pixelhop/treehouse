// Workspace tabs — the shared state and the actions on it. The rules are in
// utils/tabs.ts; the strip that draws them is components/WorkspaceTabs.vue.
//
// Two halves, for the same reason useWorkspaceData republishes the workspace
// id: the file tree asks "should this click open a tab?" once per rendered
// folder, so the half it calls (`useWorkspaceTabs`) is a few `useState` reads
// and nothing else. The half that watches the router, listens for keys and
// writes sessionStorage (`useTabsHost`) runs once, from the strip.
//
// Stored per browser tab (sessionStorage), not per browser: two browser windows
// on the same workspace are two different sets of open things, and a shared
// list would have them fighting over it. A reload keeps your tabs; a new
// browser window starts with one.
import {
  isNavigationFailure,
  NavigationFailureType,
  type RouteLocationNormalized,
} from "vue-router";
import { appRouteFor } from "~/utils/markdownRefs";
import { isDesktopShell } from "~/utils/runtimeSurface";
import {
  closeToRight,
  commandTarget,
  createSerialQueue,
  createSwitchClaims,
  EMPTY_TABS,
  keepOnly,
  landOn,
  moveTab,
  openTab,
  ownerCheck,
  parseStoredBlob,
  removeTab,
  repathTabs,
  tabCommand,
  tabLocation,
  type OpenIntent,
  type StoredTabs,
  type TabsState,
} from "~/utils/tabs";
import { ACTIVE_WS_KEY } from "~/utils/workspaceState";

const STORE_KEY = "th:tabs";
const HISTORY_KEY = "th:tabs-history";
const OWNER_KEY = "th:tabs-owner";
/** Set once the signed-in user is known to own the tabs in memory. Until then they are withheld. */
const VERIFIED_KEY = "th:tabs-verified";
const QUICK_OPEN_KEY = "th:tabs-quick-open";
/** The open editor's unsaved state, published by FileEditor for the active tab's dot. */
export const EDITOR_DIRTY_KEY = "th:editor-dirty";
/** Newest change-feed seq, published by the strip so new tabs start "seen". */
const FEED_HEAD_KEY = "th:tabs-feed-head";

const STORAGE_KEY = "th:tabs:v1";
const PREF_KEY = "th:tabs";

function readStorage(): StoredTabs {
  if (!import.meta.client) return parseStoredBlob(null);
  try {
    return parseStoredBlob(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return parseStoredBlob(null);
  }
}

/** The personal choice, if one was made: `th:tabs` = "1" (on) or "0" (off). */
function readPreference(): boolean | null {
  if (!import.meta.client) return null;
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

/**
 * Are tabs on for this person, here?
 *
 * On by default. `NUXT_PUBLIC_TABS` can still change the rollout: `off` hides
 * them (and the toggle), `opt-in` starts them off with the toggle offered.
 * Everyone else gets them on, with a toggle in the account menu to turn them
 * off. A personal choice (localStorage `th:tabs` = "1" or "0") wins over the
 * default, and "1" still works on a deployment that hides them, so they can be
 * tried from devtools anywhere. Never on a compact screen: a phone has no room
 * for a second row, and nothing to ⌘-click with.
 */
export function useTabsEnabled() {
  const mode = String(useRuntimeConfig().public.tabs ?? "on");
  const preference = useState<boolean | null>("th:tabs-pref", readPreference);
  const compact = useCompactLayout();
  const on = computed(() =>
    mode === "off" ? preference.value === true : (preference.value ?? mode !== "opt-in"),
  );
  const enabled = computed(() => !compact.value && on.value);
  /** Whether to offer the account-menu toggle. */
  const canToggle = computed(() => mode !== "off" || preference.value === true);
  function setOn(value: boolean) {
    preference.value = value;
    try {
      localStorage.setItem(PREF_KEY, value ? "1" : "0");
    } catch {
      // storage disabled — the choice still holds for this page
    }
  }
  return { enabled, canToggle, on, setOn };
}

// Claimed just before a tab switch navigates, settled by the router hook once
// that navigation lands or is refused: it is how the hook tells "the active tab
// moved" from "the user switched tabs". Module scope because there is one router.
const switches = createSwitchClaims();
// Every tab operation that navigates — switching, opening in front, closing —
// runs one at a time, each starting once the one before has settled. Two that
// overlap can otherwise act on a tab the other is still navigating to or away
// from (close a tab while a switch to it is landing; close two in a row).
const tabOps = createSerialQueue();

export function useWorkspaceTabs() {
  const { enabled } = useTabsEnabled();
  const router = useRouter();
  const store = useState<Record<string, TabsState>>(STORE_KEY, () => readStorage().byWs);
  const history = useState<Record<string, string>>(HISTORY_KEY, () => readStorage().history);
  const owner = useState<string | null>(OWNER_KEY, () => readStorage().owner);
  const workspaceId = useState<string | null>(ACTIVE_WS_KEY, () => null);
  const quickOpen = useState<boolean>(QUICK_OPEN_KEY, () => false);
  const feedHead = useState<number | null>(FEED_HEAD_KEY, () => null);
  const verified = useState<boolean>(VERIFIED_KEY, () => false);

  // Nothing is shown — or opened — until the host has checked that these tabs
  // belong to whoever is signed in: restored tabs can name a private file.
  const state = computed<TabsState>(() =>
    verified.value && workspaceId.value
      ? (store.value[workspaceId.value] ?? EMPTY_TABS)
      : EMPTY_TABS,
  );

  // Tabs open only from inside a workspace view, where the active tab is the
  // current page. Elsewhere (the dashboard's sidebar, say) there is no active
  // tab to open beside, and the row isn't on screen to show what was opened.
  const canOpen = computed(
    () => enabled.value && !!state.value.activeId && !!tabLocation(router.currentRoute.value),
  );

  function update(fn: (s: TabsState) => TabsState, id = workspaceId.value) {
    if (!id) return;
    store.value = { ...store.value, [id]: fn(store.value[id] ?? EMPTY_TABS) };
  }

  /**
   * Navigate to a tab and make it the active one. Resolves false if the
   * navigation was refused. Runs inside the tab-operation queue — callers
   * outside it use `switchTo`.
   */
  async function goTo(id: string): Promise<boolean> {
    const tab = state.value.tabs.find((t) => t.id === id);
    if (!tab) return false;
    // Already here — unless another switch is still on its way, in which case
    // picking this tab again has to win over it, so navigate back.
    if (id === state.value.activeId && !switches.pending()) return true;
    const claim = switches.claim(id, router.resolve(tab.href).fullPath);
    const failure = await router.push(tab.href);
    switches.release(claim);
    // A duplicate (two tabs on the same place) still switches: the URL is
    // already right, only the active slot changes.
    if (isNavigationFailure(failure, NavigationFailureType.duplicated)) {
      update((s) => ({ ...s, activeId: id }));
      return true;
    }
    return !failure;
  }

  /** Make a tab the active one, once any tab operation already under way has settled. */
  function switchTo(id: string): Promise<boolean> {
    return tabOps(() => goTo(id));
  }

  /**
   * Open an in-app href in a new tab. Returns false when tabs are off (or the
   * href isn't a workspace page), so the caller falls back to what it did before.
   */
  function openHref(href: string, intent: OpenIntent): boolean {
    if (!enabled.value || intent === "here") return false;
    if (!canOpen.value) return false;
    const target = tabLocation(router.resolve(href));
    if (!target || target.workspaceId !== workspaceId.value) return false;
    let id = "";
    update((s) => {
      const opened = openTab(s, target.loc, feedHead.value);
      id = opened.id;
      return opened.state;
    });
    if (intent === "foreground") void switchTo(id);
    return true;
  }

  function openPath(path: string, intent: OpenIntent): boolean {
    const ws = workspaceId.value;
    if (!ws) return false;
    return openHref(appRouteFor(ws, path), intent);
  }

  /** Close a tab. Closing the active one navigates to its neighbour first, and stays open if that's refused (unsaved edits). */
  const exists = (id: string) => state.value.tabs.some((t) => t.id === id);

  function close(id: string) {
    return tabOps(async () => {
      const s = state.value;
      if (s.tabs.length <= 1 || !exists(id)) return;
      if (id === s.activeId) {
        const next = removeTab(s, id).activeId;
        if (!next || !(await goTo(next))) return;
      }
      update((cur) => removeTab(cur, id));
    });
  }

  function closeOthers(id: string) {
    return tabOps(async () => {
      if (!exists(id) || !(await goTo(id))) return;
      update((s) => keepOnly(s, id));
    });
  }

  function closeRight(id: string) {
    return tabOps(async () => {
      const s = state.value;
      const i = s.tabs.findIndex((t) => t.id === id);
      const activeIndex = s.tabs.findIndex((t) => t.id === s.activeId);
      if (i === -1 || (activeIndex > i && !(await goTo(id)))) return;
      update((cur) => closeToRight(cur, id));
    });
  }

  function duplicate(id: string) {
    const tab = state.value.tabs.find((t) => t.id === id);
    if (!tab) return;
    update((s) => {
      // Open beside the original, not beside whichever tab happens to be active.
      const opened = openTab({ ...s, activeId: id }, tab, tab.seenSeq);
      return { ...opened.state, activeId: s.activeId };
    });
  }

  function move(id: string, toIndex: number) {
    update((s) => moveTab(s, id, toIndex));
  }

  /**
   * Follow an in-app move or rename, so tabs on the old path don't go stale.
   * Takes the workspace the move ran in: it may no longer be the open one by
   * the time a long folder move finishes.
   */
  function repath(ws: string, from: string, to: string) {
    update((s) => repathTabs(s, from, to, (p) => appRouteFor(ws, p)), ws);
  }

  /** Drop every tab, in memory and in storage — on sign-out, so none outlives the session. */
  function forget() {
    store.value = {};
    history.value = {};
    owner.value = null;
    verified.value = false;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage disabled — there is nothing stored to remove
    }
  }

  function markSeen(ids: string[] | "all-unset", seq: number) {
    update((s) => ({
      ...s,
      tabs: s.tabs.map((t) =>
        (ids === "all-unset" ? t.seenSeq == null : ids.includes(t.id)) && t.seenSeq !== seq
          ? { ...t, seenSeq: seq }
          : t,
      ),
    }));
  }

  return {
    enabled,
    canOpen,
    state,
    workspaceId,
    verified,
    quickOpen,
    feedHead,
    switchTo,
    openHref,
    openPath,
    close,
    closeOthers,
    closeRight,
    duplicate,
    move,
    repath,
    markSeen,
    forget,
  };
}

/**
 * The once-per-app half: keep the active tab in step with the router, map
 * back/forward onto tabs, persist, and take the keyboard shortcuts. Called from
 * WorkspaceTabs.vue, which the app layout mounts once.
 */
export function useTabsHost() {
  const tabs = useWorkspaceTabs();
  const router = useRouter();
  const route = useRoute();
  const store = useState<Record<string, TabsState>>(STORE_KEY);
  // Which tab each browser-history entry belongs to, keyed by vue-router's
  // `history.state.position`. It is what makes Back after a tab switch return
  // to the tab you came from, rather than dragging that tab's page into this
  // one and leaving two tabs on it.
  const history = useState<Record<string, string>>(HISTORY_KEY, () => readStorage().history);

  function positionNow(): string | null {
    const pos = (window.history.state as { position?: unknown } | null)?.position;
    return typeof pos === "number" ? String(pos) : null;
  }

  function sync(to: RouteLocationNormalized, popped: boolean) {
    const target = tabLocation(to);
    if (!target) return;
    const pending = switches.landed(to.fullPath);
    const pos = positionNow();
    const historyOwner = popped && pos ? (history.value[pos] ?? null) : null;
    const before = store.value[target.workspaceId] ?? EMPTY_TABS;
    const s = landOn(before, target.loc, { pending, historyOwner });
    store.value = { ...store.value, [target.workspaceId]: s };
    if (!popped && pos && s.activeId) history.value = { ...history.value, [pos]: s.activeId };
  }

  // A popstate is the browser's back/forward. vue-router's own listener was
  // registered first and has already started the navigation; recording the
  // position it is heading to lets the hook below recognise that navigation
  // when it lands — and only that one, so a pop the router refused (and undid)
  // can't leave a stale flag that misreads the next ordinary click.
  let poppedTo: string | null = null;
  const onPop = () => {
    poppedTo = positionNow();
  };

  let removeHook: (() => void) | null = null;
  onMounted(() => {
    window.addEventListener("popstate", onPop);
    removeHook = router.afterEach((to, _from, failure) => {
      const popped = poppedTo !== null && poppedTo === positionNow();
      poppedTo = null;
      if (!tabs.enabled.value || !tabs.verified.value) return;
      // A refused navigation's claim is released by the switch that made it.
      if (failure && !isNavigationFailure(failure, NavigationFailureType.duplicated)) return;
      sync(to, popped);
    });
  });
  onBeforeUnmount(() => {
    window.removeEventListener("popstate", onPop);
    removeHook?.();
  });

  // Tabs belong to the person who opened them. Restored tabs stay withheld
  // until the session confirms whose they are: a background tab can name a
  // private file, and on a reload the session takes a moment to load. Signing
  // out, or someone else signing in within the same browser tab, starts from
  // nothing.
  const owner = useState<string | null>(OWNER_KEY, () => readStorage().owner);
  const session = useAuthClient().useSession();
  watch(
    () => [session.value.isPending, session.value.data?.user?.id ?? null] as const,
    ([pending, userId]) => {
      const verdict = ownerCheck(pending, userId, owner.value);
      if (verdict === "wait") return;
      if (verdict === "reset") {
        store.value = {};
        history.value = {};
        owner.value = userId;
      }
      tabs.verified.value = userId !== null;
    },
    { immediate: true },
  );

  // The route the app is already on when tabs become usable (first load, the
  // account-menu toggle, the session confirming the owner) never passes
  // through afterEach, so adopt it directly.
  watch(
    [tabs.enabled, tabs.verified],
    ([on, ok]) => {
      if (on && ok) sync(route as RouteLocationNormalized, false);
    },
    { immediate: true },
  );

  watch(
    [store, history, owner],
    ([byWs, hist, who]) => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ owner: who, byWs, history: hist }));
      } catch {
        // storage full or disabled — tabs still work, they just won't survive a reload
      }
    },
    { deep: true },
  );

  const desktop = isDesktopShell();
  function onKeydown(e: KeyboardEvent) {
    if (!tabs.enabled.value || !tabs.verified.value) return;
    if (!tabLocation(route as RouteLocationNormalized)) return;
    const cmd = tabCommand(e, { desktop });
    if (!cmd) return;
    e.preventDefault();
    const s = tabs.state.value;
    if (cmd.type === "new") {
      tabs.quickOpen.value = true;
    } else if (cmd.type === "close") {
      if (s.activeId) void tabs.close(s.activeId);
    } else {
      const id = commandTarget(s, cmd);
      if (id) void tabs.switchTo(id);
    }
  }
  onMounted(() => window.addEventListener("keydown", onKeydown));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

  return tabs;
}