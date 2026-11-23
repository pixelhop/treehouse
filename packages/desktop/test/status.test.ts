import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirStatus } from "cli/src/daemon";
import { saveLinks } from "cli/src/links-store";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { pollDaemonStatus, readLastKnown } from "../src/daemon";
import {
  aggregateState,
  displayPath,
  folderMenu,
  folderTitle,
  hasAuthLoss,
  humanState,
  noticeHeadline,
  noticeLine,
  recentNotices,
  trayGlyph,
  trayIconKind,
  trayTooltip,
} from "../src/status";

const dir = (state: DirStatus["state"], over: Partial<DirStatus> = {}): DirStatus => ({
  root: "/h/Treehouse/Acme",
  workspaceId: "ws_1",
  state,
  degraded: false,
  since: "",
  ...over,
});

describe("aggregateState (attention-first)", () => {
  it("is idle with no folders", () => {
    expect(aggregateState([])).toBe("idle");
  });

  it("auth-lost outranks everything", () => {
    expect(aggregateState([dir("synced"), dir("auth-lost"), dir("transferring")])).toBe(
      "auth-lost",
    );
  });

  it("error outranks transfer and steady states", () => {
    expect(aggregateState([dir("synced"), dir("error")])).toBe("error");
  });

  it("transfer (incl. starting) outranks synced", () => {
    expect(aggregateState([dir("synced"), dir("transferring")])).toBe("transferring");
    expect(aggregateState([dir("synced"), dir("syncing")])).toBe("transferring");
  });

  it("all-paused reports paused", () => {
    expect(aggregateState([dir("paused"), dir("paused")])).toBe("paused");
  });

  it("otherwise reports synced", () => {
    expect(aggregateState([dir("synced"), dir("paused")])).toBe("synced");
  });
});

describe("icon + tooltip mapping", () => {
  it("maps each aggregate to an icon kind", () => {
    expect(trayIconKind("synced")).toBe("ok");
    expect(trayIconKind("transferring")).toBe("sync");
    expect(trayIconKind("error")).toBe("warn");
    expect(trayIconKind("auth-lost")).toBe("warn");
    expect(trayIconKind("idle")).toBe("idle");
  });

  it("gives every icon kind a non-empty, visible tray glyph", () => {
    // The menubar item must never be invisible — each kind maps to a distinct glyph.
    const glyphs = (["ok", "sync", "warn", "idle"] as const).map(trayGlyph);
    for (const g of glyphs) expect(g.length).toBeGreaterThan(0);
    expect(new Set(glyphs).size).toBe(glyphs.length); // distinct per state
  });

  it("summarises each aggregate in the tooltip", () => {
    expect(trayTooltip("synced")).toMatch(/up to date/i);
    expect(trayTooltip("auth-lost")).toMatch(/sign in/i);
    expect(trayTooltip("error")).toMatch(/attention/i);
  });
});

describe("per-folder rendering", () => {
  it("renders the error reason", () => {
    expect(humanState(dir("error", { error: "folder moved?" }))).toBe("Error — folder moved?");
  });

  it("distinguishes reconnecting (degraded) from starting", () => {
    expect(humanState(dir("syncing", { degraded: true }))).toMatch(/reconnect/i);
    expect(humanState(dir("syncing", { degraded: false }))).toMatch(/start/i);
  });

  it("renders auth-lost as sign-in needed", () => {
    expect(humanState(dir("auth-lost"))).toMatch(/sign in/i);
  });

  it("titles a folder by basename + state", () => {
    expect(folderTitle(dir("synced"))).toBe("Acme — Up to date");
  });

  it("detects any auth loss for the re-authenticate action", () => {
    expect(hasAuthLoss([dir("synced"), dir("auth-lost")])).toBe(true);
    expect(hasAuthLoss([dir("synced")])).toBe(false);
  });

  it("degrades an unknown (newer-daemon) state to error rendering", () => {
    // Forward-compat: a state this build doesn't know still renders, never throws.
    expect(humanState(dir("frobnicating" as DirStatus["state"]))).toMatch(/error/i);
    // An unrecognised state is neutral for the aggregate icon (never a false green).
    expect(aggregateState([dir("frobnicating" as DirStatus["state"])])).toBe("idle");
  });
});

describe("per-folder menu (U8)", () => {
  const ids = (state: DirStatus["state"]) => folderMenu(dir(state)).actions.map((a) => a.id);

  it("shows where the folder lives, with home collapsed to ~", () => {
    expect(displayPath("/h/Treehouse/Acme", "/h")).toBe("~/Treehouse/Acme");
    expect(displayPath("/h/Treehouse/Acme", "/h/")).toBe("~/Treehouse/Acme");
    expect(displayPath("/Volumes/Big/Acme", "/h")).toBe("/Volumes/Big/Acme");
    expect(folderMenu(dir("synced"), "/h").path).toBe("~/Treehouse/Acme");
  });

  it("offers pause while syncing and resume while paused, never both", () => {
    expect(ids("synced")).toContain("pause");
    expect(ids("synced")).not.toContain("resume");
    expect(ids("paused")).toContain("resume");
    expect(ids("paused")).not.toContain("pause");
  });

  it("offers re-authenticate instead of pause/resume when auth is lost", () => {
    expect(ids("auth-lost")).toContain("reauthenticate");
    expect(ids("auth-lost")).not.toContain("pause");
    expect(ids("auth-lost")).not.toContain("resume");
  });

  it("always offers change-location and unlink, in every state", () => {
    const states: DirStatus["state"][] = [
      "synced",
      "syncing",
      "transferring",
      "paused",
      "error",
      "auth-lost",
    ];
    for (const state of states) {
      // Including `error`: a folder that has gone missing is precisely the one a
      // user wants to relocate. planRelocation refuses with its own explanation
      // if the move isn't safe — hiding the item would replace that with silence.
      expect(ids(state)).toContain("relocate");
      expect(ids(state)).toContain("unlink");
    }
  });

  it("gives every action a distinct id and a non-empty label", () => {
    const actions = folderMenu(dir("synced")).actions;
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    for (const a of actions) expect(a.label.length).toBeGreaterThan(0);
  });
});

describe("daemon-down fallback", () => {
  const freshHome = () => {
    process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-status-"));
  };
  afterEach(() => {
    delete process.env.TREEHOUSE_HOME;
  });

  it("reads last-known state from a folder's state.json", () => {
    const root = mkdtempSync(join(tmpdir(), "th-folder-"));
    mkdirSync(join(root, ".treehouse"), { recursive: true });
    const status: DirStatus = {
      root,
      workspaceId: "ws_9",
      state: "synced",
      degraded: false,
      since: "2026-07-07T00:00:00.000Z",
    };
    writeFileSync(join(root, ".treehouse", "state.json"), JSON.stringify(status));
    expect(readLastKnown({ root, workspaceId: "ws_9" })).toMatchObject({ state: "synced" });
  });

  it("falls back to an error state when no state.json exists", () => {
    const root = mkdtempSync(join(tmpdir(), "th-folder-"));
    expect(readLastKnown({ root, workspaceId: "ws_9" }).state).toBe("error");
    expect(readLastKnown({ root, workspaceId: "ws_9", paused: true }).state).toBe("paused");
  });

  it("pollDaemonStatus reports last-known state when the daemon is down", async () => {
    freshHome();
    const root = mkdtempSync(join(tmpdir(), "th-folder-"));
    mkdirSync(join(root, ".treehouse"), { recursive: true });
    writeFileSync(
      join(root, ".treehouse", "state.json"),
      JSON.stringify({ root, workspaceId: "ws_1", state: "synced", degraded: false, since: "" }),
    );
    saveLinks([{ root, workspaceId: "ws_1" }]);

    const snapshot = await pollDaemonStatus();
    expect(snapshot.running).toBe(false); // no daemon under the test runner
    expect(snapshot.dirs).toHaveLength(1);
    expect(snapshot.dirs[0]?.state).toBe("synced");
  });
});
describe("refused-change notices", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 60 * 60_000).toISOString();
  const notice = (path: string, h = 1) => ({
    path,
    outcome: "reverted" as const,
    reason: "role",
    savedTo: `.treehouse/reverted/${path}`,
    at: hoursAgo(h),
  });

  it("says nothing for a folder with no notices, including an older daemon's status", () => {
    expect(noticeHeadline(dir("synced"), now)).toBeNull();
    expect(noticeHeadline(dir("synced", { notices: [] }), now)).toBeNull();
    expect(folderMenu(dir("synced"), "/h", now).notices).toEqual([]);
  });

  it("counts recent notices, and lets day-old ones go", () => {
    const d = dir("synced", { notices: [notice("a.md"), notice("b.md", 23), notice("c.md", 25)] });
    expect(recentNotices(d, now).map((n) => n.path)).toEqual(["a.md", "b.md"]);
    expect(noticeHeadline(d, now)).toBe("2 changes not synced, view-only access");
    expect(noticeHeadline(dir("synced", { notices: [notice("a.md")] }), now)).toBe(
      "1 change not synced, view-only access",
    );
  });

  it("describes what happened to the user's work", () => {
    expect(noticeLine(notice("a.md"))).toBe("a.md: reverted, your edit is saved");
    expect(noticeLine({ path: "b.md", outcome: "restored", reason: "role", at: "" })).toBe(
      "b.md: restored after delete",
    );
    expect(noticeLine({ path: "c.md", outcome: "kept", reason: "role", at: "" })).toBe(
      "c.md: not uploaded",
    );
  });

  it("the folder menu leads with the headline and caps the list", () => {
    const notices = ["a", "b", "c", "d", "e", "f", "g"].map((n) => notice(`${n}.md`));
    const menu = folderMenu(dir("synced", { notices }), "/h", now);
    expect(menu.notices).toHaveLength(6);
    expect(menu.notices[0]).toBe("7 changes not synced, view-only access");
  });
});