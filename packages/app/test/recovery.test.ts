import { describe, expect, it } from "vite-plus/test";
import {
  actionCounts,
  actionLabel,
  confirmRequest,
  createLatest,
  deletedByLabel,
  dialogNotices,
  errorText,
  outcomeLine,
  settled,
  justBefore,
  restoreCopy,
  restoreRequest,
  shownChanges,
  timePresets,
  toLocalInput,
  skipText,
  trashLabel,
} from "../app/utils/recovery";

describe("trash labels", () => {
  it("shows a .keep placeholder as the empty folder it held open", () => {
    expect(trashLabel({ path: "Notes/drafts/.keep" })).toEqual({
      path: "Notes/drafts",
      isFolder: true,
    });
    expect(trashLabel({ path: ".keep" })).toEqual({ path: "Workspace root", isFolder: true });
    expect(trashLabel({ path: "Notes/keep.md" })).toEqual({
      path: "Notes/keep.md",
      isFolder: false,
    });
  });
});

describe("recovery preview wording", () => {
  it("names each change", () => {
    expect(actionLabel({ kind: "recreate", path: "a", size: 1 })).toBe("Bring back");
    expect(actionLabel({ kind: "recreate", path: "a", size: 1 }, true)).toBe("Brought back");
    expect(
      actionLabel({ kind: "move", from: "b", path: "a", size: 1, restoresContent: true }),
    ).toBe("Move back and restore");
  });

  it("counts changes by kind, skipping kinds that don't occur", () => {
    expect(
      actionCounts([
        { kind: "recreate", path: "a", size: 1 },
        { kind: "recreate", path: "b", size: 1 },
        { kind: "delete", path: "c", size: 1, version: 2 },
      ]),
    ).toEqual(["Bring back 2 files", "Delete 1 file (it goes to the trash)"]);
  });

  it("explains a skip, with its detail", () => {
    expect(skipText({ path: "a", reason: "edited_later", detail: "by Sam" })).toBe(
      "someone else changed it afterwards (by Sam)",
    );
  });

  it("summarises the outcome", () => {
    expect(outcomeLine(3, 0)).toBe("Done: 3 changes made.");
    expect(outcomeLine(0, 1)).toBe("1 file left alone.");
    expect(outcomeLine(0, 0)).toBe("Nothing was changed.");
    expect(outcomeLine(2, 1)).toBe("Done: 2 changes made. 1 file left alone.");
  });
});
describe("recovery dialog helpers", () => {
  const preview = {
    actions: [{ kind: "recreate" as const, path: "a", size: 1 }],
    skipped: [],
    previewHead: 1,
    tooLarge: false,
  };
  it("lists the outcome once applied, else the preview", () => {
    expect(shownChanges(null, null)).toEqual({ actions: [], skipped: [] });
    expect(shownChanges(preview, null).actions).toHaveLength(1);
    const outcome = {
      operationId: "o",
      applied: [],
      skipped: [{ path: "a", reason: "changed" as const }],
    };
    expect(shownChanges(preview, outcome)).toEqual({ actions: [], skipped: outcome.skipped });
  });

  it("prefers the server's reason for an error", () => {
    expect(errorText({ data: { statusMessage: "At most 5000 paths at a time" } })).toBe(
      "At most 5000 paths at a time",
    );
    expect(errorText(new Error("offline"))).toBe("offline");
    expect(errorText({})).toBe("Something went wrong.");
  });

  it("names who deleted a file", () => {
    expect(
      deletedByLabel({ principal: "agent", actorId: "u1", actorLabel: "Claude Code" }, "u1", "Sam"),
    ).toBe("Claude Code");
    expect(
      deletedByLabel({ principal: "human", actorId: "u1", actorLabel: null }, "u1", "Sam"),
    ).toBe("you");
    expect(
      deletedByLabel({ principal: "human", actorId: "u2", actorLabel: null }, "u1", "Ali"),
    ).toBe("Ali");
    expect(
      deletedByLabel({ principal: "human", actorId: null, actorLabel: null }, "u1", null),
    ).toBe("someone");
  });
});
describe("dialogNotices", () => {
  it("orders error, then size warning, then nothing-to-do", () => {
    expect(dialogNotices({ error: null, tooLarge: false, nothingToDo: false })).toEqual([]);
    expect(
      dialogNotices({ error: "Boom", tooLarge: true, nothingToDo: true }).map((n) => n.tone),
    ).toEqual(["danger", "warning", "muted"]);
  });
});
describe("latest-only responses", () => {
  it("drops a slow preview for a request since replaced, even when it arrives last", async () => {
    const latest = createLatest();
    let resolveA!: (v: string) => void;
    const a = new Promise<string>((r) => (resolveA = r));
    const shown: string[] = [];
    const show = async (p: Promise<string>) => {
      const current = latest.next();
      const res = await settled(p);
      if (current() && res.ok) shown.push(res.value);
    };
    const first = show(a);
    await show(Promise.resolve("b"));
    resolveA("a");
    await first;
    expect(shown).toEqual(["b"]);
  });

  it("checks against what is current now, without starting anything", () => {
    const latest = createLatest();
    latest.next();
    const confirmCheck = latest.now();
    expect(confirmCheck()).toBe(true);
    latest.next();
    expect(confirmCheck()).toBe(false);
  });

  it("turns a rejection into a value", async () => {
    expect(await settled(Promise.reject(new Error("no")))).toMatchObject({ ok: false });
    expect(await settled(Promise.resolve(1))).toEqual({ ok: true, value: 1 });
  });
});
describe("confirming a preview", () => {
  it("holds the apply to the previewed changes and head", () => {
    const preview = {
      actions: [{ kind: "recreate" as const, path: "a.md", size: 1 }],
      skipped: [{ path: "b.md", reason: "file_limit" as const }],
      previewHead: 42,
      tooLarge: false,
    };
    expect(confirmRequest({ kind: "trash", paths: ["a.md", "b.md"] }, preview)).toEqual({
      kind: "trash",
      paths: ["a.md", "b.md"],
      previewHead: 42,
      approved: ['["recreate",null,"a.md"]'],
    });
  });
});

describe("restore-to time helpers", () => {
  it("formats a local datetime input value to the second", () => {
    expect(toLocalInput(new Date(2026, 9, 29, 9, 5, 7))).toBe("2026-10-29T09:05:07");
  });

  it("puts 'restore to before this' a millisecond before the earliest change", () => {
    expect(
      justBefore([
        { createdAt: "2026-10-29T10:00:05.000Z" },
        { createdAt: "2026-10-29T10:00:01.500Z" },
      ])?.toISOString(),
    ).toBe("2026-10-29T10:00:01.499Z");
    expect(justBefore([])).toBeNull();
  });

  it("offers presets in the past, newest first", () => {
    const now = new Date(2026, 9, 29, 15, 0, 0);
    const presets = timePresets(now);
    expect(presets.map((p) => p.label)).toContain("Start of today");
    expect(presets.every((p) => p.at.getTime() < now.getTime())).toBe(true);
    expect(presets.find((p) => p.label === "Start of today")?.at.getHours()).toBe(0);
  });
});
describe("restore dialog modes", () => {
  const at = new Date("2026-10-29T15:00:00.000Z");
  it("restores a folder or the workspace", () => {
    expect(restoreRequest({ kind: "restore", path: "Notes" }, at)).toEqual({
      kind: "restore",
      path: "Notes",
      at: "2026-10-29T15:00:00.000Z",
    });
    expect(restoreCopy({ kind: "restore", path: null }).doneTitle).toBe(
      "Restored the whole workspace",
    );
    expect(restoreCopy({ kind: "restore", path: "Notes" }).confirmTitle("15:00")).toBe(
      "Restore Notes to 15:00?",
    );
  });

  it("undoes one key's changes", () => {
    const mode = { kind: "undo" as const, keyId: "k1", label: "Claude Code" };
    expect(restoreRequest(mode, at)).toEqual({
      kind: "undo",
      keyId: "k1",
      since: "2026-10-29T15:00:00.000Z",
    });
    expect(restoreCopy(mode).heading).toBe("Undo changes by Claude Code");
    expect(restoreCopy(mode).doneTitle).toBe("Undid Claude Code's changes");
  });
});