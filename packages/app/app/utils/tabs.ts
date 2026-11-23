// Workspace tabs: several places in one workspace held open at once, the way
// Notion's desktop app does it. A tab is a slot holding a location; the URL is
// always the ACTIVE tab's location, so links, reloads and sharing keep working
// exactly as they did before tabs existed.
//
// Everything here is pure (no Nuxt, no DOM beyond event shapes) so the rules
// unit test directly. The shared, persisted state lives in
// composables/useWorkspaceTabs.ts and the strip in components/WorkspaceTabs.vue.

/** What a tab points at. Mirrors the three workspace routes. */
export type TabKind = "home" | "path" | "activity";

/** A location a tab can hold, as derived from a workspace route. */
export interface TabLocation {
  kind: TabKind;
  /** Workspace-relative file or folder path; "" for home and activity. */
  path: string;
  /** The route's full path, query and hash included — what switching back restores. */
  href: string;
}

export interface Tab extends TabLocation {
  id: string;
  /** The tab that was active when this one was opened from it, until it is first visited. */
  openerId?: string;
  /**
   * The newest change-feed `seq` the user has seen this tab at. Changes to its
   * path after it light the tab's dot. Null until the feed has loaded once, so
   * a tab opened before then doesn't count the whole feed window as unseen.
   */
  seenSeq: number | null;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export const EMPTY_TABS: TabsState = { tabs: [], activeId: null };

export function newTabId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function sameLocation(a: TabLocation, b: TabLocation): boolean {
  return a.kind === b.kind && a.path === b.path && a.href === b.href;
}

/**
 * Point the active tab at `loc` — the route just changed under it. With no tabs
 * yet (first visit, or a workspace not opened this session) the location
 * becomes the first tab.
 */
export function syncActive(state: TabsState, loc: TabLocation, makeId = newTabId): TabsState {
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (!active) {
    if (state.tabs.length) {
      // An active id that no longer resolves (should not happen, but storage is
      // storage): adopt the first tab rather than growing a second list.
      const [first, ...rest] = state.tabs;
      return { tabs: [{ ...first!, ...loc }, ...rest], activeId: first!.id };
    }
    const tab: Tab = { ...loc, id: makeId(), seenSeq: null };
    return { tabs: [tab], activeId: tab.id };
  }
  if (sameLocation(active, loc)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === active.id ? { ...t, ...loc } : t)),
  };
}

/**
 * Open `loc` in a new tab to the right of the active one — after any tabs
 * already opened from it, so ⌘-clicking three links lays them out in the order
 * they were clicked (the browser convention). Does not activate it.
 */
export function openTab(
  state: TabsState,
  loc: TabLocation,
  seenSeq: number | null,
  makeId = newTabId,
): { state: TabsState; id: string } {
  const from = state.activeId ?? undefined;
  const tab: Tab = { ...loc, id: makeId(), seenSeq, openerId: from };
  const tabs = [...state.tabs];
  let at = tabs.findIndex((t) => t.id === from);
  if (at === -1) at = tabs.length - 1;
  while (tabs[at + 1]?.openerId === from && from !== undefined) at++;
  tabs.splice(at + 1, 0, tab);
  return { state: { ...state, tabs }, id: tab.id };
}

/** Mark a tab as visited: it no longer counts as a child of the tab it was opened from. */
export function visit(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.id === id && t.openerId !== undefined)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id ? { ...t, openerId: undefined } : t)),
  };
}

/**
 * Which tab takes over when `id` closes: the one to its right, else the one to
 * its left (the browser convention). Null when it is the last tab.
 */
export function neighbourOf(state: TabsState, id: string): string | null {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i === -1) return null;
  return state.tabs[i + 1]?.id ?? state.tabs[i - 1]?.id ?? null;
}

/** Remove a tab. Closing the active tab hands activity to its neighbour. */
export function removeTab(state: TabsState, id: string): TabsState {
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (tabs.length === state.tabs.length) return state;
  const activeId = state.activeId === id ? neighbourOf(state, id) : state.activeId;
  return { tabs, activeId };
}

/** Keep only `id`, which becomes active. */
export function keepOnly(state: TabsState, id: string): TabsState {
  const tab = state.tabs.find((t) => t.id === id);
  return tab ? { tabs: [tab], activeId: id } : state;
}

/** Close every tab to the right of `id`. If the active tab was one of them, `id` takes over. */
export function closeToRight(state: TabsState, id: string): TabsState {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i === -1) return state;
  const tabs = state.tabs.slice(0, i + 1);
  const activeId = tabs.some((t) => t.id === state.activeId) ? state.activeId : id;
  return { tabs, activeId };
}

/** Move a tab to a new index (drag to reorder). */
export function moveTab(state: TabsState, id: string, toIndex: number): TabsState {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from === -1) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab!);
  return { ...state, tabs };
}

/**
 * Follow a move or rename: every tab on `from`, or inside it when it is a
 * folder, now points at the matching path under `to`. `hrefFor` builds the URL
 * for a path; the old query (a pinned version, say) is dropped with the old path.
 */
export function repathTabs(
  state: TabsState,
  from: string,
  to: string,
  hrefFor: (path: string) => string,
): TabsState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.kind !== "path") return t;
    if (t.path !== from && !t.path.startsWith(`${from}/`)) return t;
    changed = true;
    const path = to + t.path.slice(from.length);
    return { ...t, path, href: hrefFor(path) };
  });
  return changed ? { ...state, tabs } : state;
}

/** The minimal change-feed event shape the tab dot reads. */
export interface TabFeedEvent {
  path: string;
  seq: number;
  principal: string;
  actorId?: string | null;
}

function isUnder(tab: Tab, path: string, isDir: boolean): boolean {
  return isDir ? path.startsWith(`${tab.path}/`) : path === tab.path;
}

/** A person's own edit — not an agent acting for them. */
function ownEdit(e: TabFeedEvent, userId: string | null): boolean {
  return e.principal !== "agent" && !!userId && e.actorId === userId;
}

/**
 * Has something changed under this tab since it was last seen, and by whom?
 * "agent" or "human" decides the dot's colour; the newest change wins. A
 * person's own edits never count (they made them, they don't need telling),
 * but their agents' do. Folder tabs light up for changes anywhere inside.
 */
export function changeMark(
  tab: Tab,
  events: readonly TabFeedEvent[],
  opts: { isDir: boolean; userId: string | null },
): "agent" | "human" | null {
  if (tab.kind !== "path" || tab.seenSeq == null) return null;
  const seen = tab.seenSeq;
  const unseen = events.filter(
    (e) => e.seq > seen && isUnder(tab, e.path, opts.isDir) && !ownEdit(e, opts.userId),
  );
  if (!unseen.length) return null;
  const newest = unseen.reduce((a, b) => (b.seq > a.seq ? b : a));
  return newest.principal === "agent" ? "agent" : "human";
}

/** How a click asked to open a link: in the current tab, or in a new one. */
export type OpenIntent = "here" | "background" | "foreground";

/**
 * Read a click's modifiers the way a browser reads them for its own tabs:
 * ⌘/Ctrl-click or a middle click opens in the background, adding Shift brings
 * the new tab to the front.
 */
export function openIntent(
  e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey">,
): OpenIntent {
  if (e.button === 1) return e.shiftKey ? "foreground" : "background";
  if (e.button !== 0) return "here";
  if (e.metaKey || e.ctrlKey) return e.shiftKey ? "foreground" : "background";
  return "here";
}

export type TabCommand =
  | { type: "new" }
  | { type: "close" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "last" };

type KeyInput = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** A keydown as one string: its exact modifiers, then its physical key ("alt+shift+BracketLeft"). */
function chord(e: KeyInput): string {
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.metaKey && "meta", e.shiftKey && "shift"];
  return [...mods.filter(Boolean), e.code.replace(/^Digit/, "")].join("+");
}

const EVERYWHERE: Record<string, TabCommand> = {
  "alt+KeyT": { type: "new" },
  "alt+KeyW": { type: "close" },
  "alt+shift+BracketLeft": { type: "prev" },
  "alt+shift+BracketRight": { type: "next" },
};

const DESKTOP_ONLY: Record<string, TabCommand> = {
  "meta+KeyT": { type: "new" },
  "meta+shift+BracketLeft": { type: "prev" },
  "meta+shift+BracketRight": { type: "next" },
  "ctrl+Tab": { type: "next" },
  "ctrl+shift+Tab": { type: "prev" },
};

/**
 * Map a keydown to a tab command.
 *
 * Everywhere: ⌥T new, ⌥W close, ⌥⇧[ / ⌥⇧] previous/next, ⌥1–8 jump, ⌥9 last.
 * A browser keeps ⌘T, ⌘W, ⌘1–9 and Ctrl-Tab for its own tabs and never lets a
 * page have them, so the web needs keys it can actually receive. Matched on
 * `code`, not `key`, because ⌥ turns letters into symbols on a Mac.
 *
 * The desktop shell additionally takes the familiar ⌘T, ⌘⇧[ / ⌘⇧], Ctrl-Tab
 * and ⌘1–9. Not ⌘W: the shell's own menu owns it (it closes the window), and a
 * menu accelerator fires before the page sees the key.
 */
export function tabCommand(e: KeyInput, opts: { desktop: boolean }): TabCommand | null {
  const c = chord(e);
  const digit = /^(alt|meta)\+([1-9])$/.exec(c);
  if (digit && (digit[1] === "alt" || opts.desktop)) {
    const n = Number(digit[2]);
    return n === 9 ? { type: "last" } : { type: "goto", index: n - 1 };
  }
  return EVERYWHERE[c] ?? (opts.desktop ? DESKTOP_ONLY[c] : undefined) ?? null;
}

/** Resolve next/prev/goto/last to a tab id, wrapping at the ends for next/prev. */
export function commandTarget(state: TabsState, cmd: TabCommand): string | null {
  const n = state.tabs.length;
  if (!n) return null;
  const i = Math.max(
    0,
    state.tabs.findIndex((t) => t.id === state.activeId),
  );
  switch (cmd.type) {
    case "next":
      return state.tabs[(i + 1) % n]!.id;
    case "prev":
      return state.tabs[(i - 1 + n) % n]!.id;
    case "goto":
      return state.tabs[cmd.index]?.id ?? null;
    case "last":
      return state.tabs[n - 1]!.id;
    default:
      return null;
  }
}

const KINDS = new Set<unknown>(["home", "path", "activity"]);
const optional = (v: unknown, type: "string" | "number") => v == null || typeof v === type;

/** One stored tab, checked field by field. Only in-app hrefs are accepted. */
export function isStoredTab(v: unknown): v is Tab {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  const href = typeof t.href === "string" ? t.href : "";
  return (
    typeof t.id === "string" &&
    typeof t.path === "string" &&
    href.startsWith("/w/") &&
    KINDS.has(t.kind) &&
    optional(t.seenSeq, "number") &&
    optional(t.openerId, "string")
  );
}

/**
 * Validate what came back out of sessionStorage. Anything malformed is dropped
 * rather than trusted: a bad tab is a lost tab, never a crash on load.
 */
export function parseStoredTabs(raw: unknown): Record<string, TabsState> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, TabsState> = {};
  for (const [ws, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Partial<TabsState> | null;
    if (!v || !Array.isArray(v.tabs)) continue;
    const tabs = v.tabs.filter(isStoredTab);
    if (!tabs.length) continue;
    const activeId = tabs.some((t) => t.id === v.activeId) ? (v.activeId as string) : tabs[0]!.id;
    out[ws] = { tabs, activeId };
  }
  return out;
}
const ROUTE_KINDS: Record<string, TabKind> = {
  "w-workspaceId": "home",
  "w-workspaceId-path": "path",
  "w-workspaceId-activity": "activity",
};

function joinParam(p: unknown): string {
  if (Array.isArray(p)) return p.join("/");
  return typeof p === "string" ? p : "";
}

/** The tab location a route stands for, or null off the three workspace routes. */
export function tabLocation(route: {
  name?: unknown;
  params: Record<string, unknown>;
  fullPath: string;
}): { workspaceId: string; loc: TabLocation } | null {
  const workspaceId = route.params.workspaceId;
  const kind = ROUTE_KINDS[typeof route.name === "string" ? route.name : ""];
  if (typeof workspaceId !== "string" || !workspaceId || !kind) return null;
  const path = kind === "path" ? joinParam(route.params.path) : "";
  // `/w/<id>/` matches the catch-all with an empty path: that is home.
  const resolved = kind === "path" && !path ? "home" : kind;
  return { workspaceId, loc: { kind: resolved, path, href: route.fullPath } };
}

/** What a tab is called in the row. */
export function tabLabel(tab: TabLocation, workspaceName: string | null | undefined): string {
  if (tab.kind === "home") return workspaceName || "Home";
  if (tab.kind === "activity") return "Activity";
  return tab.path.slice(tab.path.lastIndexOf("/") + 1);
}

/**
 * Settle a navigation that just landed: decide which tab it belongs to, then
 * point that tab at where it landed. A tab switch names its tab (`pending`);
 * a back/forward names the tab that owned the history entry (`historyOwner`);
 * anything else stays in the active tab. Either way, only a tab that still
 * exists can claim it.
 */
export function landOn(
  state: TabsState,
  loc: TabLocation,
  claim: { pending: string | null; historyOwner: string | null },
): TabsState {
  const claimant = [claim.pending, claim.historyOwner].find(
    (id) => !!id && state.tabs.some((t) => t.id === id),
  );
  const activated = claimant ? { ...state, activeId: claimant } : state;
  const synced = syncActive(activated, loc);
  return activated.activeId ? visit(synced, activated.activeId) : synced;
}

/**
 * The newest change per file, newest first, for files that still exist — what
 * a new tab offers before anything is typed. `events` arrives newest-first.
 */
export function recentlyChanged<E extends { path: string }>(
  events: readonly E[],
  exists: (path: string) => boolean,
  limit: number,
): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const e of events) {
    if (out.length >= limit) break;
    if (seen.has(e.path) || !exists(e.path)) continue;
    seen.add(e.path);
    out.push(e);
  }
  return out;
}

/** The one signal a tab carries: unsaved edits, or a change since it was last seen. */
export type TabSignal = "dirty" | "agent" | "human";

/** Everything the row needs to draw one tab, worked out once per render. */
export interface TabView {
  tab: Tab;
  active: boolean;
  label: string;
  tooltip: string;
  /** The file or folder is no longer in the workspace. */
  gone: boolean;
  isDir: boolean;
  /** A custom icon set on the node, if any. */
  icon: string | null;
  signal: TabSignal | null;
}
/** What the row knows about the workspace while drawing its tabs. */
export interface TabViewContext {
  activeId: string | null;
  workspaceName: string | null | undefined;
  /** Whether the file list has loaded — until then nothing can be "gone". */
  loaded: boolean;
  isDir: (path: string) => boolean;
  isFile: (path: string) => boolean;
  icons: Record<string, string>;
  /** The open editor holds unsaved edits (they can only be in the active tab). */
  dirty: boolean;
  events: readonly TabFeedEvent[];
  userId: string | null;
}

/** Work out how one tab should be drawn. */
export function tabView(tab: Tab, ctx: TabViewContext): TabView {
  const active = tab.id === ctx.activeId;
  const isPath = tab.kind === "path";
  const isDir = isPath && ctx.isDir(tab.path);
  const gone = isPath && ctx.loaded && !isDir && !ctx.isFile(tab.path);
  const label = tabLabel(tab, ctx.workspaceName);
  let signal: TabSignal | null = null;
  if (!active) signal = changeMark(tab, ctx.events, { isDir, userId: ctx.userId });
  else if (ctx.dirty) signal = "dirty";
  return {
    tab,
    active,
    label,
    tooltip: isPath ? `${tab.path}${gone ? " (no longer here)" : ""}` : label,
    gone,
    isDir,
    icon: ctx.icons[tab.path] ?? null,
    signal,
  };
}
/**
 * The tab switch in flight, tied to the navigation that carries it.
 *
 * A switch is a navigation, and navigations can overlap: click tab B, then tab
 * C before B has landed (the auth middleware awaits a session check on every
 * one), and the router cancels B. If B's cancellation cleared C's claim, C
 * would land as an ordinary navigation — dragging C's page into the tab you
 * started on. B and C can even share a URL (a duplicated tab), so a claim is
 * identified by a token of its own, and each switch releases only its own
 * claim once its navigation has settled.
 */
export function createSwitchClaims() {
  let claims: { token: number; id: string; fullPath: string }[] = [];
  let next = 0;
  return {
    /** Claim the next navigation to `fullPath` for tab `id`. Returns the claim's token. */
    claim(id: string, fullPath: string): number {
      next += 1;
      claims.push({ token: next, id, fullPath });
      return next;
    },
    /** Whether a switch is still waiting for its navigation to land. */
    pending(): boolean {
      return claims.length > 0;
    },
    /** The switch that made a claim has settled, landed or not: drop that claim only. */
    release(token: number) {
      claims = claims.filter((c) => c.token !== token);
    },
    /**
     * A navigation to `fullPath` landed. Every pending claim is settled by it —
     * the newest either was this navigation or was overtaken by it — and the
     * newest claim's tab is returned when it was this one.
     */
    landed(fullPath: string): string | null {
      const newest = claims.at(-1);
      claims = [];
      return newest?.fullPath === fullPath ? newest.id : null;
    },
  };
}
/** Everything the tabs keep in sessionStorage. */
export interface StoredTabs {
  /** The user whose tabs these are. Anything stored without one is discarded on sign-in. */
  owner: string | null;
  byWs: Record<string, TabsState>;
  /** Browser-history position → the tab that owned that entry. */
  history: Record<string, string>;
}

/** Read the stored blob back, keeping only what is well-formed. */
export function parseStoredBlob(raw: unknown): StoredTabs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hist = r.history && typeof r.history === "object" ? r.history : {};
  return {
    owner: typeof r.owner === "string" ? r.owner : null,
    byWs: parseStoredTabs(r.byWs),
    history: Object.fromEntries(
      Object.entries(hist as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>,
  };
}
/**
 * What to do with the tabs in memory, given who is signed in. Stored tabs are
 * held back until the session says whose they may be ("wait"), shown only to
 * the person who opened them ("keep"), and dropped for anyone else, including
 * no one ("reset").
 */
export function ownerCheck(
  pending: boolean,
  userId: string | null,
  owner: string | null,
): "wait" | "keep" | "reset" {
  if (pending) return "wait";
  return userId !== null && userId === owner ? "keep" : "reset";
}
/**
 * Run async jobs one after another, each starting once the one before has
 * settled (succeeded or failed). Closing tabs navigates, and two closes in
 * quick succession must not interleave: the second would remove the tab the
 * first is still navigating to.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}