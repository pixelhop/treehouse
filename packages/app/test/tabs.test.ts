import { describe, expect, it } from "vite-plus/test";
import {
  changeMark,
  closeToRight,
  commandTarget,
  createSerialQueue,
  createSwitchClaims,
  EMPTY_TABS,
  isStoredTab,
  keepOnly,
  landOn,
  moveTab,
  neighbourOf,
  openIntent,
  openTab,
  ownerCheck,
  parseStoredBlob,
  parseStoredTabs,
  recentlyChanged,
  removeTab,
  repathTabs,
  syncActive,
  tabCommand,
  tabLabel,
  tabLocation,
  tabView,
  visit,
  type Tab,
  type TabLocation,
  type TabsState,
} from "../app/utils/tabs";

const at = (path: string): TabLocation => ({ kind: "path", path, href: `/w/ws/${path}` });
const home: TabLocation = { kind: "home", path: "", href: "/w/ws" };

let n = 0;
const ids = () => `t${++n}`;

function three(): TabsState {
  n = 0;
  let s = syncActive(EMPTY_TABS, at("a.md"), ids);
  s = openTab(s, at("b.md"), 0, ids).state;
  s = { ...s, activeId: "t2" };
  s = openTab(s, at("c.md"), 0, ids).state;
  return { ...s, activeId: "t1" };
}
const paths = (s: TabsState) => s.tabs.map((t) => t.path);

describe("syncActive", () => {
  it("makes the first location the first tab", () => {
    n = 0;
    const s = syncActive(EMPTY_TABS, home, ids);
    expect(s.tabs).toEqual([{ ...home, id: "t1", seenSeq: null }]);
    expect(s.activeId).toBe("t1");
  });

  it("moves the active tab, leaving the others where they were", () => {
    const s = syncActive(three(), at("z.md"));
    expect(paths(s)).toEqual(["z.md", "b.md", "c.md"]);
    expect(s.activeId).toBe("t1");
  });

  it("returns the same state when nothing moved, so watchers don't churn", () => {
    const s = three();
    expect(syncActive(s, at("a.md"))).toBe(s);
  });
});

describe("opening and closing", () => {
  it("opens new tabs to the right of the active one, without activating them", () => {
    n = 0;
    let s = syncActive(EMPTY_TABS, at("a.md"), ids);
    s = syncActive(openTab(s, at("z.md"), 0, ids).state, at("a.md"));
    s = visit({ ...s, activeId: "t2" }, "t2");
    s = { ...s, activeId: "t1" };
    const opened = openTab(s, at("new.md"), 5, ids);
    expect(paths(opened.state)).toEqual(["a.md", "new.md", "z.md"]);
    expect(opened.state.activeId).toBe("t1");
    expect(opened.state.tabs[1]!.seenSeq).toBe(5);
  });

  it("lays several background tabs out in the order they were opened", () => {
    n = 0;
    let s = syncActive(EMPTY_TABS, at("a.md"), ids);
    for (const p of ["b.md", "c.md", "d.md"]) s = openTab(s, at(p), 0, ids).state;
    expect(paths(s)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    // Once a child has been visited it is an ordinary tab, and the next one
    // opened from the original tab goes after the remaining children.
    s = visit(s, "t2");
    expect(paths(openTab(s, at("e.md"), 0, ids).state)).toEqual([
      "a.md",
      "e.md",
      "b.md",
      "c.md",
      "d.md",
    ]);
  });

  it("hands a closed active tab's place to its right neighbour, else its left", () => {
    const s = three();
    expect(neighbourOf(s, "t1")).toBe("t2");
    expect(neighbourOf(s, "t3")).toBe("t2");
    expect(removeTab(s, "t1").activeId).toBe("t2");
    expect(removeTab({ ...s, activeId: "t3" }, "t3").activeId).toBe("t2");
    expect(neighbourOf(keepOnly(s, "t1"), "t1")).toBeNull();
  });

  it("keeps the active tab when closing a background one", () => {
    const s = removeTab(three(), "t3");
    expect(paths(s)).toEqual(["a.md", "b.md"]);
    expect(s.activeId).toBe("t1");
  });

  it("closes to the right, moving activity onto the kept tab if it was closed", () => {
    const s = closeToRight({ ...three(), activeId: "t3" }, "t1");
    expect(paths(s)).toEqual(["a.md"]);
    expect(s.activeId).toBe("t1");
  });

  it("reorders", () => {
    expect(paths(moveTab(three(), "t1", 2))).toEqual(["b.md", "c.md", "a.md"]);
    expect(paths(moveTab(three(), "t3", 0))).toEqual(["c.md", "a.md", "b.md"]);
  });
});

describe("repathTabs", () => {
  const href = (p: string) => `/w/ws/${p}`;

  it("follows a renamed file and everything inside a moved folder", () => {
    n = 0;
    let s = syncActive(EMPTY_TABS, at("Docs/x.md"), ids);
    s = openTab(s, at("Docs"), 0, ids).state;
    s = openTab(s, at("Docs-old/y.md"), 0, ids).state;
    s = repathTabs(s, "Docs", "Archive/Docs", href);
    expect(paths(s)).toEqual(["Archive/Docs/x.md", "Archive/Docs", "Docs-old/y.md"]);
    expect(s.tabs[0]!.href).toBe("/w/ws/Archive/Docs/x.md");
  });

  it("leaves untouched state alone", () => {
    const s = three();
    expect(repathTabs(s, "nope.md", "x.md", href)).toBe(s);
  });
});

describe("changeMark", () => {
  const tab: Tab = { ...at("Plans/q4.md"), id: "t", seenSeq: 10 };
  const ev = (path: string, seq: number, principal = "agent", actorId: string | null = "me") => ({
    path,
    seq,
    principal,
    actorId,
  });

  it("is quiet until something changed after the tab was last seen", () => {
    expect(changeMark(tab, [ev("Plans/q4.md", 10)], { isDir: false, userId: "me" })).toBeNull();
    expect(changeMark(tab, [ev("Plans/q4.md", 11)], { isDir: false, userId: "me" })).toBe("agent");
  });

  it("ignores the person's own edits but not their agents'", () => {
    const opts = { isDir: false, userId: "me" };
    expect(changeMark(tab, [ev("Plans/q4.md", 11, "human", "me")], opts)).toBeNull();
    expect(changeMark(tab, [ev("Plans/q4.md", 11, "human", "sam")], opts)).toBe("human");
  });

  it("takes the newest change's colour", () => {
    const events = [ev("Plans/q4.md", 12, "human", "sam"), ev("Plans/q4.md", 11, "agent")];
    expect(changeMark(tab, events, { isDir: false, userId: "me" })).toBe("human");
  });

  it("lights a folder tab for changes inside it, never for a sibling sharing its prefix", () => {
    const folder: Tab = { ...at("Plans"), id: "f", seenSeq: 0 };
    const opts = { isDir: true, userId: "me" };
    expect(changeMark(folder, [ev("Plans-2025/x.md", 1)], opts)).toBeNull();
    expect(changeMark(folder, [ev("Plans/x.md", 1)], opts)).toBe("agent");
  });

  it("never marks a tab that has not been seen yet", () => {
    expect(
      changeMark({ ...tab, seenSeq: null }, [ev("Plans/q4.md", 99)], {
        isDir: false,
        userId: "me",
      }),
    ).toBeNull();
  });
});

describe("openIntent", () => {
  const click = (o: Partial<MouseEvent>) =>
    openIntent({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, ...o });

  it("reads clicks the way a browser does", () => {
    expect(click({})).toBe("here");
    expect(click({ shiftKey: true })).toBe("here");
    expect(click({ metaKey: true })).toBe("background");
    expect(click({ ctrlKey: true })).toBe("background");
    expect(click({ metaKey: true, shiftKey: true })).toBe("foreground");
    expect(click({ button: 1 })).toBe("background");
    expect(click({ button: 2, metaKey: true })).toBe("here");
  });
});

describe("tabCommand", () => {
  const key = (o: Partial<KeyboardEvent>) => ({
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...o,
  });

  it("takes ⌥ shortcuts everywhere", () => {
    for (const desktop of [false, true]) {
      expect(tabCommand(key({ altKey: true, code: "KeyT" }), { desktop })).toEqual({
        type: "new",
      });
      expect(tabCommand(key({ altKey: true, code: "KeyW" }), { desktop })).toEqual({
        type: "close",
      });
      expect(
        tabCommand(key({ altKey: true, shiftKey: true, code: "BracketRight" }), { desktop }),
      ).toEqual({ type: "next" });
      expect(tabCommand(key({ altKey: true, code: "Digit2" }), { desktop })).toEqual({
        type: "goto",
        index: 1,
      });
      expect(tabCommand(key({ altKey: true, code: "Digit9" }), { desktop })).toEqual({
        type: "last",
      });
    }
  });

  it("leaves the browser's own ⌘ shortcuts to the browser on the web", () => {
    expect(tabCommand(key({ metaKey: true, code: "KeyT" }), { desktop: false })).toBeNull();
    expect(tabCommand(key({ ctrlKey: true, code: "Tab" }), { desktop: false })).toBeNull();
  });

  it("adds the familiar ones in the desktop app, but never ⌘W", () => {
    const desktop = { desktop: true };
    expect(tabCommand(key({ metaKey: true, code: "KeyT" }), desktop)).toEqual({ type: "new" });
    expect(tabCommand(key({ metaKey: true, code: "KeyW" }), desktop)).toBeNull();
    expect(tabCommand(key({ ctrlKey: true, code: "Tab", shiftKey: true }), desktop)).toEqual({
      type: "prev",
    });
    expect(tabCommand(key({ metaKey: true, code: "Digit1" }), desktop)).toEqual({
      type: "goto",
      index: 0,
    });
  });

  it("does not steal ordinary typing or editor shortcuts", () => {
    expect(tabCommand(key({ code: "KeyT" }), { desktop: true })).toBeNull();
    expect(tabCommand(key({ metaKey: true, code: "KeyS" }), { desktop: true })).toBeNull();
    expect(
      tabCommand(key({ metaKey: true, altKey: true, code: "KeyT" }), { desktop: true }),
    ).toBeNull();
  });
});

describe("commandTarget", () => {
  it("wraps next/prev and resolves jumps", () => {
    const s = three();
    expect(commandTarget(s, { type: "next" })).toBe("t2");
    expect(commandTarget(s, { type: "prev" })).toBe("t3");
    expect(commandTarget(s, { type: "goto", index: 2 })).toBe("t3");
    expect(commandTarget(s, { type: "goto", index: 7 })).toBeNull();
    expect(commandTarget(s, { type: "last" })).toBe("t3");
  });
});

describe("parseStoredTabs", () => {
  it("keeps valid workspaces and drops anything malformed", () => {
    const good = three();
    const parsed = parseStoredTabs({
      ws: good,
      junk: { tabs: "nope" },
      mixed: {
        tabs: [good.tabs[0], { id: "x", href: "javascript:alert(1)", path: "", kind: "path" }],
        activeId: "gone",
      },
    });
    expect(parsed.ws).toEqual(good);
    expect(parsed.junk).toBeUndefined();
    expect(parsed.mixed!.tabs).toHaveLength(1);
    expect(parsed.mixed!.activeId).toBe(good.tabs[0]!.id);
  });

  it("survives garbage", () => {
    expect(parseStoredTabs(null)).toEqual({});
    expect(parseStoredTabs("x")).toEqual({});
  });
});
describe("tabLocation", () => {
  const route = (name: string, params: Record<string, unknown>, fullPath = "/w/ws/x") => ({
    name,
    params: { workspaceId: "ws", ...params },
    fullPath,
  });

  it("maps the three workspace routes and nothing else", () => {
    expect(tabLocation(route("w-workspaceId", {}, "/w/ws"))?.loc).toEqual(home);
    expect(tabLocation(route("w-workspaceId-activity", {}, "/w/ws/activity"))?.loc.kind).toBe(
      "activity",
    );
    expect(
      tabLocation(route("w-workspaceId-path", { path: ["Docs", "a.md"] }, "/w/ws/Docs/a.md"))?.loc,
    ).toEqual({ kind: "path", path: "Docs/a.md", href: "/w/ws/Docs/a.md" });
    expect(tabLocation({ name: "dashboard", params: {}, fullPath: "/dashboard" })).toBeNull();
  });

  it("treats the catch-all with no path as home", () => {
    expect(tabLocation(route("w-workspaceId-path", { path: [] }, "/w/ws/"))?.loc.kind).toBe("home");
  });
});

describe("tabLabel", () => {
  it("names each kind", () => {
    expect(tabLabel(home, "Acme")).toBe("Acme");
    expect(tabLabel(home, null)).toBe("Home");
    expect(tabLabel({ kind: "activity", path: "", href: "" }, "Acme")).toBe("Activity");
    expect(tabLabel(at("Docs/plan.md"), "Acme")).toBe("plan.md");
  });
});

describe("landOn", () => {
  it("keeps an ordinary navigation in the active tab", () => {
    const s = landOn(three(), at("z.md"), { pending: null, historyOwner: null });
    expect(s.activeId).toBe("t1");
    expect(s.tabs[0]!.path).toBe("z.md");
  });

  it("hands a tab switch, or a back/forward, to the tab that claimed it", () => {
    const switched = landOn(three(), at("c.md"), { pending: "t3", historyOwner: null });
    expect(switched.activeId).toBe("t3");
    expect(paths(switched)).toEqual(["a.md", "b.md", "c.md"]);
    const popped = landOn(three(), at("b2.md"), { pending: null, historyOwner: "t2" });
    expect(popped.activeId).toBe("t2");
    expect(paths(popped)).toEqual(["a.md", "b2.md", "c.md"]);
  });

  it("ignores a claim from a tab that has since closed", () => {
    const s = landOn(three(), at("z.md"), { pending: null, historyOwner: "gone" });
    expect(s.activeId).toBe("t1");
    expect(s.tabs[0]!.path).toBe("z.md");
  });
});

describe("recentlyChanged", () => {
  it("keeps the newest change per existing file, up to the limit", () => {
    const events = [{ path: "a" }, { path: "b" }, { path: "a" }, { path: "gone" }, { path: "c" }];
    const exists = (p: string) => p !== "gone";
    expect(recentlyChanged(events, exists, 5).map((e) => e.path)).toEqual(["a", "b", "c"]);
    expect(recentlyChanged(events, exists, 2).map((e) => e.path)).toEqual(["a", "b"]);
  });
});

describe("isStoredTab", () => {
  it("accepts a well-formed tab and rejects off-app hrefs and bad fields", () => {
    const tab = { ...at("a.md"), id: "t", seenSeq: 3 };
    expect(isStoredTab(tab)).toBe(true);
    expect(isStoredTab({ ...tab, seenSeq: null, openerId: "x" })).toBe(true);
    expect(isStoredTab({ ...tab, href: "https://evil.example/w/" })).toBe(false);
    expect(isStoredTab({ ...tab, kind: "share" })).toBe(false);
    expect(isStoredTab({ ...tab, openerId: 4 })).toBe(false);
    expect(isStoredTab(null)).toBe(false);
  });
});
describe("tabView", () => {
  const ctx = {
    activeId: "t1",
    workspaceName: "Acme",
    loaded: true,
    isDir: (p: string) => p === "Docs",
    isFile: (p: string) => p === "a.md",
    icons: { "a.md": "📄" },
    dirty: false,
    events: [{ path: "Docs/x.md", seq: 9, principal: "agent" }],
    userId: "me",
  };
  const tab = (loc: TabLocation, id: string): Tab => ({ ...loc, id, seenSeq: 1 });

  it("draws the active tab with its unsaved dot, and nothing else", () => {
    const v = tabView(tab(at("a.md"), "t1"), { ...ctx, dirty: true });
    expect(v).toMatchObject({ active: true, label: "a.md", signal: "dirty", icon: "📄" });
    expect(tabView(tab(at("a.md"), "t1"), ctx).signal).toBeNull();
  });

  it("marks background changes, folders and missing files", () => {
    expect(tabView(tab(at("Docs"), "t2"), ctx)).toMatchObject({ isDir: true, signal: "agent" });
    const gone = tabView(tab(at("old.md"), "t3"), ctx);
    expect(gone.gone).toBe(true);
    expect(gone.tooltip).toBe("old.md (no longer here)");
    expect(tabView(tab(at("old.md"), "t3"), { ...ctx, loaded: false }).gone).toBe(false);
    expect(tabView(tab(home, "t4"), ctx)).toMatchObject({ label: "Acme", tooltip: "Acme" });
  });
});
describe("createSwitchClaims", () => {
  it("keeps a newer switch when an older, overtaken navigation is refused", () => {
    const claims = createSwitchClaims();
    const b = claims.claim("B", "/w/ws/b.md");
    claims.claim("C", "/w/ws/c.md");
    // B's navigation is cancelled by C's, and B's switch releases its claim...
    claims.release(b);
    // ...so C still lands as a switch to C.
    expect(claims.landed("/w/ws/c.md")).toBe("C");
  });

  it("tells two switches to the same URL apart", () => {
    // Duplicated tabs: B and C both point at the same file.
    const claims = createSwitchClaims();
    const b = claims.claim("B", "/w/ws/same.md");
    claims.claim("C", "/w/ws/same.md");
    claims.release(b);
    expect(claims.landed("/w/ws/same.md")).toBe("C");
  });

  it("drops a refused switch's claim", () => {
    const claims = createSwitchClaims();
    claims.release(claims.claim("B", "/w/ws/b.md"));
    expect(claims.landed("/w/ws/b.md")).toBeNull();
  });

  it("lets an ordinary navigation that overtook a switch settle it without claiming it", () => {
    const claims = createSwitchClaims();
    const b = claims.claim("B", "/w/ws/b.md");
    expect(claims.landed("/w/ws/other.md")).toBeNull();
    claims.release(b);
    expect(claims.landed("/w/ws/b.md")).toBeNull();
  });
});
describe("parseStoredBlob", () => {
  it("reads the owner, tabs and history, dropping malformed history entries", () => {
    const blob = parseStoredBlob({
      owner: "me",
      byWs: { ws: three() },
      history: { 1: "t1", 2: 7 },
    });
    expect(blob.owner).toBe("me");
    expect(blob.byWs.ws).toEqual(three());
    expect(blob.history).toEqual({ 1: "t1" });
  });

  it("treats anything unowned or unreadable as empty and ownerless", () => {
    expect(parseStoredBlob(null)).toEqual({ owner: null, byWs: {}, history: {} });
    expect(parseStoredBlob({ byWs: { ws: three() } }).owner).toBeNull();
  });
});
describe("ownerCheck", () => {
  it("withholds tabs until the session has loaded", () => {
    expect(ownerCheck(true, null, "alice")).toBe("wait");
    expect(ownerCheck(true, "bob", "alice")).toBe("wait");
  });

  it("keeps tabs only for the person who opened them", () => {
    expect(ownerCheck(false, "alice", "alice")).toBe("keep");
    expect(ownerCheck(false, "bob", "alice")).toBe("reset");
    expect(ownerCheck(false, "alice", null)).toBe("reset");
    expect(ownerCheck(false, null, "alice")).toBe("reset");
  });
});

describe("createSwitchClaims pending", () => {
  it("reports a switch in flight until it lands or is released", () => {
    const claims = createSwitchClaims();
    expect(claims.pending()).toBe(false);
    const b = claims.claim("B", "/w/ws/b.md");
    expect(claims.pending()).toBe(true);
    claims.release(b);
    expect(claims.pending()).toBe(false);
    claims.claim("C", "/w/ws/c.md");
    claims.landed("/w/ws/c.md");
    expect(claims.pending()).toBe(false);
  });
});
describe("createSerialQueue", () => {
  it("starts each job only after the previous one has settled, even when it fails", async () => {
    const enqueue = createSerialQueue();
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueue(
      () =>
        new Promise<void>((resolve) => {
          log.push("first:start");
          releaseFirst = () => {
            log.push("first:end");
            resolve();
          };
        }),
    );
    const second = enqueue(async () => {
      log.push("second");
      throw new Error("refused");
    });
    const third = enqueue(async () => {
      log.push("third");
    });
    await Promise.resolve();
    expect(log).toEqual(["first:start"]);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow("refused");
    await third;
    expect(log).toEqual(["first:start", "first:end", "second", "third"]);
  });
});