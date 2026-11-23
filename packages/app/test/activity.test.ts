import { describe, expect, it } from "vite-plus/test";
import { CHANGE_OPS } from "shared";
import {
  actorDisplay,
  actorShortName,
  type ChangeEvent,
  clusterEvents,
  clusterSummary,
  conflictedCopiesFor,
  type FeedEvent,
  fileActivity,
  formatUnread,
  initials,
  isRestorable,
  operationSummary,
  pointInTime,
  groupByDay,
  pathGone,
  relativeTime,
  seedSeq,
  unreadCount,
} from "../app/utils/activity";
import {
  CHANGE_OP_DISPLAY,
  isCommentEvent,
  opClusterLabel,
  opColor,
  opDisplay,
  opLabel,
} from "../app/utils/changeOps";

function ev(partial: Partial<ChangeEvent> & { path: string; createdAt: string }): ChangeEvent {
  return {
    id: partial.createdAt,
    op: "write",
    version: 1,
    principal: "agent",
    ...partial,
  };
}

let seqCounter = 0;
function fe(partial: Partial<FeedEvent> & { createdAt: string }): FeedEvent {
  return {
    id: partial.id ?? `${partial.createdAt}-${seqCounter}`,
    path: partial.path ?? "f.md",
    op: "write",
    version: 1,
    principal: "agent",
    seq: partial.seq ?? ++seqCounter,
    ...partial,
  };
}

describe("fileActivity", () => {
  const changes: ChangeEvent[] = [
    ev({ path: "notes.md", createdAt: "2026-06-06T10:00:00Z", principal: "agent" }),
    ev({ path: "other.md", createdAt: "2026-06-06T11:00:00Z", principal: "human" }),
    ev({ path: "notes.md", createdAt: "2026-06-06T12:00:00Z", principal: "human" }),
  ];

  it("returns only the file's events, newest first (AE4)", () => {
    const result = fileActivity(changes, "notes.md");
    expect(result.map((c) => c.createdAt)).toEqual([
      "2026-06-06T12:00:00Z",
      "2026-06-06T10:00:00Z",
    ]);
    expect(result.map((c) => c.principal)).toEqual(["human", "agent"]);
  });

  it("returns an empty list for a file with no events", () => {
    expect(fileActivity(changes, "missing.md")).toEqual([]);
  });

  it("caps the result at the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ev({ path: "f.md", createdAt: `2026-06-06T10:${String(i).padStart(2, "0")}:00Z` }),
    );
    expect(fileActivity(many, "f.md", 5)).toHaveLength(5);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-06-06T12:00:00Z").getTime();
  it("formats recent timestamps compactly", () => {
    expect(relativeTime("2026-06-06T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-06-06T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-06-06T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-06-04T12:00:00Z", now)).toBe("2d ago");
  });
  it("returns empty string for an invalid timestamp", () => {
    expect(relativeTime("nonsense", now)).toBe("");
  });
});

describe("isRestorable", () => {
  it("is true for write/move/restore events that carry a content pointer", () => {
    expect(
      isRestorable(ev({ path: "a.md", createdAt: "x", op: "write", version: 2, contentHash: "h" })),
    ).toBe(true);
    expect(
      isRestorable(ev({ path: "a.md", createdAt: "x", op: "move", version: 1, contentHash: "h" })),
    ).toBe(true);
    expect(
      isRestorable(
        ev({ path: "a.md", createdAt: "x", op: "restore", version: 3, contentHash: "h" }),
      ),
    ).toBe(true);
  });
  it("is false without a content pointer (pre-feature events, R8)", () => {
    expect(isRestorable(ev({ path: "a.md", createdAt: "x", op: "write", version: 1 }))).toBe(false);
  });
  it("is false for delete/conflict ops", () => {
    expect(
      isRestorable(
        ev({ path: "a.md", createdAt: "x", op: "delete", version: 1, contentHash: "h" }),
      ),
    ).toBe(false);
    expect(
      isRestorable(
        ev({ path: "a.md", createdAt: "x", op: "conflict", version: 1, contentHash: "h" }),
      ),
    ).toBe(false);
    expect(
      isRestorable(
        ev({ path: "a.md", createdAt: "x", op: "access_granted", version: 1, contentHash: "h" }),
      ),
    ).toBe(false);
  });
});

describe("pathGone", () => {
  const paths = ["journal/today.md", "notes.md", "journal-old.md"];
  it("is false for a file that still exists", () => {
    expect(pathGone(paths, "notes.md")).toBe(false);
  });
  it("is false for a folder that still holds a file (e.g. one made shared again)", () => {
    expect(pathGone(paths, "journal")).toBe(false);
  });
  it("is true for a removed file, and doesn't match a sibling-prefix file as a folder", () => {
    expect(pathGone(paths, "salary.md")).toBe(true);
    expect(pathGone(paths, "journal-old")).toBe(true);
  });
});

describe("conflictedCopiesFor", () => {
  const paths = [
    "report.md",
    "report (conflicted copy — agent — 2026-06-06T10:00:00.000Z).md",
    "report (conflicted copy — human — 2026-06-06T11:00:00.000Z) (2).md",
    "report2.md",
    "report2 (conflicted copy — agent — 2026-06-06T10:00:00.000Z).md",
    "notes",
    "notes (conflicted copy — agent — 2026-06-06T10:00:00.000Z)",
  ];

  it("matches only copies of the given file, not sibling-prefix files", () => {
    const copies = conflictedCopiesFor(paths, "report.md");
    expect(copies).toHaveLength(2);
    expect(copies.every((c) => c.startsWith("report ("))).toBe(true);
    // report2's copy must not be attributed to report.md
    expect(copies.some((c) => c.startsWith("report2"))).toBe(false);
  });

  it("handles extensionless files", () => {
    expect(conflictedCopiesFor(paths, "notes")).toEqual([
      "notes (conflicted copy — agent — 2026-06-06T10:00:00.000Z)",
    ]);
  });

  it("returns nothing when there are no copies", () => {
    expect(conflictedCopiesFor(["a.md", "b.md"], "a.md")).toEqual([]);
  });

  it("does not attribute an extensioned sibling's copy to an extensionless file", () => {
    const mixed = [
      "a",
      "a (conflicted copy — agent — 2026-06-06T10:00:00.000Z).md", // belongs to a.md
    ];
    expect(conflictedCopiesFor(mixed, "a")).toEqual([]);
    expect(conflictedCopiesFor(mixed, "a.md")).toEqual([
      "a (conflicted copy — agent — 2026-06-06T10:00:00.000Z).md",
    ]);
  });
});

describe("fileActivity ordering (R20)", () => {
  it("orders by seq desc when events carry seq, even with equal createdAt", () => {
    const t = "2026-06-06T10:00:00Z";
    const changes = [
      fe({ path: "m.md", createdAt: t, seq: 1 }),
      fe({ path: "m.md", createdAt: t, seq: 2 }),
    ];
    expect(fileActivity(changes, "m.md").map((c) => c.seq)).toEqual([2, 1]);
  });
});

describe("clusterEvents (R5, R6, R21, R22)", () => {
  const base = "2026-06-06T10:00:00Z";
  function at(minute: number): string {
    return `2026-06-06T10:${String(minute).padStart(2, "0")}:00Z`;
  }

  it("collapses a same-actor burst into one cluster (R5, R6)", () => {
    const events = Array.from({ length: 14 }, (_, i) =>
      fe({ createdAt: at(i % 5), seq: i + 1, actorId: "agent-1", actorLabel: "claude-bot" }),
    );
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.events).toHaveLength(14);
    expect(clusters[0]!.headSeq).toBe(14);
  });

  it("keeps a single foreign-actor edit visible between two bursts (R21)", () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) =>
        fe({ createdAt: at(0), seq: i + 1, actorId: "agent-1" }),
      ),
      fe({ createdAt: at(0), seq: 9, actorId: "human-1", principal: "human" }),
      ...Array.from({ length: 5 }, (_, i) =>
        fe({ createdAt: at(0), seq: 10 + i, actorId: "agent-1" }),
      ),
    ];
    const clusters = clusterEvents(events); // newest-first
    expect(clusters.map((c) => c.events.length)).toEqual([5, 1, 8]);
    expect(clusters[1]!.principal).toBe("human");
  });

  it("breaks a cluster at a local-day boundary (R21)", () => {
    const events = [
      fe({ createdAt: "2026-06-06T12:00:00Z", seq: 1, actorId: "agent-1" }),
      fe({ createdAt: "2026-06-07T12:00:00Z", seq: 2, actorId: "agent-1" }),
    ];
    // Large gap window so only the day boundary can split the run.
    expect(clusterEvents(events, { gapMs: 1000 * 60 * 60 * 48 })).toHaveLength(2);
  });

  it("breaks a cluster when the gap between events exceeds the window (R21)", () => {
    const events = [
      fe({ createdAt: "2026-06-06T10:00:00Z", seq: 1, actorId: "agent-1" }),
      fe({ createdAt: "2026-06-06T10:10:00Z", seq: 2, actorId: "agent-1" }),
    ];
    // Same actor and day, 10 min apart — exceeds the default 5-min window.
    expect(clusterEvents(events)).toHaveLength(2);
  });

  it("groups null-id events by principal when no actor id is present (R22)", () => {
    const events = [
      fe({ createdAt: base, seq: 1, actorId: null, actorKeyId: null, principal: "human" }),
      fe({ createdAt: base, seq: 2, actorId: null, actorKeyId: null, principal: "human" }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe("human");
  });

  it("separates an agent's burst from its owner's own human edits (R7)", () => {
    // The agent key is owned by the human, so agent events carry the owner's
    // actorId — they must still cluster apart from the owner's human edits.
    const events = [
      fe({ createdAt: base, seq: 1, actorId: "u1", principal: "human" }),
      fe({
        createdAt: base,
        seq: 2,
        actorId: "u1",
        principal: "agent",
        actorKeyId: "key-1",
        actorLabel: "claude-code",
      }),
      fe({
        createdAt: base,
        seq: 3,
        actorId: "u1",
        principal: "agent",
        actorKeyId: "key-1",
        actorLabel: "claude-code",
      }),
    ];
    const clusters = clusterEvents(events); // newest-first: agent(3,2), human(1)
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.principal).toBe("agent");
    expect(clusters[0]!.events).toHaveLength(2);
    expect(clusters[1]!.principal).toBe("human");
  });

  it("splits a person's run by credential, so each key's entry can undo just that key", () => {
    const events = [
      fe({ createdAt: at(0), seq: 1, actorId: "sam", principal: "human", actorKeyId: "cli" }),
      fe({ createdAt: at(1), seq: 2, actorId: "sam", principal: "human", actorKeyId: null }),
      fe({ createdAt: at(2), seq: 3, actorId: "sam", principal: "human", actorKeyId: "desk" }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters.map((c) => c.actorKeyId)).toEqual(["desk", null, "cli"]);
    expect(clusters.every((c) => c.events.length === 1)).toBe(true);
  });

  it("breaks a cluster at the watermark divider (R21)", () => {
    const events = Array.from({ length: 4 }, (_, i) =>
      fe({ createdAt: base, seq: i + 1, actorId: "agent-1" }),
    );
    const clusters = clusterEvents(events, { dividerSeq: 2 });
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.unread).toBe(true); // seq 4,3
    expect(clusters[1]!.unread).toBe(false); // seq 2,1
  });

  it("groups null-label events by a stable key, never 'null' (R22)", () => {
    const events = [
      fe({ createdAt: base, seq: 1, actorId: "h1", actorLabel: null, principal: "human" }),
      fe({ createdAt: base, seq: 2, actorId: "h1", actorLabel: null, principal: "human" }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe("h1");
  });
});

describe("unreadCount + formatUnread (R17, R18)", () => {
  const base = "2026-06-06T10:00:00Z";

  it("counts a move's two events as one logical change (R18)", () => {
    const events = [
      fe({ createdAt: base, seq: 5, op: "move", path: "a.md" }),
      fe({ createdAt: base, seq: 6, op: "move", path: "b.md" }),
      fe({ createdAt: "2026-06-06T10:01:00Z", seq: 7, op: "write" }),
    ];
    expect(unreadCount(events, 4)).toBe(2);
  });

  it("only counts events above the watermark", () => {
    const events = Array.from({ length: 5 }, (_, i) => fe({ createdAt: base, seq: i + 1 }));
    expect(unreadCount(events, 3)).toBe(2);
  });

  it("returns 0 when the watermark is unset (history is seen) (R17)", () => {
    const events = [fe({ createdAt: base, seq: 1 })];
    expect(unreadCount(events, null)).toBe(0);
  });

  it("formats the badge: empty, plain, and capped", () => {
    expect(formatUnread(0)).toBe("");
    expect(formatUnread(5)).toBe("5");
    expect(formatUnread(99)).toBe("99");
    expect(formatUnread(150)).toBe("99+");
  });
});

describe("seedSeq (R17)", () => {
  it("returns the newest seq", () => {
    expect(
      seedSeq([
        fe({ createdAt: "x", seq: 3 }),
        fe({ createdAt: "y", seq: 7 }),
        fe({ createdAt: "z", seq: 5 }),
      ]),
    ).toBe(7);
  });
  it("returns null for empty history", () => {
    expect(seedSeq([])).toBeNull();
  });
});

describe("actorDisplay + initials (R7, R22)", () => {
  it("uses the resolved member name when present", () => {
    const d = actorDisplay(ev({ path: "a", createdAt: "x", principal: "human" }), "Joseph Maxted");
    expect(d).toMatchObject({ name: "Joseph Maxted", isAgent: false, resolved: true });
  });
  it("falls back to agent/human and surfaces the agent label, never null (R22)", () => {
    const agent = actorDisplay(
      ev({ path: "a", createdAt: "x", principal: "agent", actorLabel: "claude-bot" }),
      null,
    );
    expect(agent).toMatchObject({
      name: "agent",
      isAgent: true,
      agentLabel: "claude-bot",
      resolved: false,
    });
    const human = actorDisplay(
      ev({ path: "a", createdAt: "x", principal: "human", actorLabel: null }),
      null,
    );
    expect(human.name).toBe("human");
    expect(human.agentLabel).toBeNull();
  });
  it("builds up to two initials", () => {
    expect(initials("Joseph Maxted")).toBe("JM");
    expect(initials("agent")).toBe("A");
  });
});

describe("opColor (R13)", () => {
  it("colours high-stakes ops distinctly and writes/moves neutrally", () => {
    expect(opColor("conflict")).toContain("warning");
    expect(opColor("delete")).toContain("danger");
    expect(opColor("restore")).toContain("success");
    expect(opColor("write")).toContain("fg-muted");
    expect(opColor("move")).toContain("fg-muted");
  });
  it("colours comment traffic as conversation, resolution as success", () => {
    expect(opColor("comment_created")).toContain("accent");
    expect(opColor("comment_replied")).toContain("accent");
    expect(opColor("comment_resolved")).toContain("success");
    expect(opColor("comment_reopened")).toContain("warning");
  });
});

describe("op display table", () => {
  it("has an entry for every op the server writes, and nothing else", () => {
    expect(Object.keys(CHANGE_OP_DISPLAY).sort()).toEqual([...CHANGE_OPS].sort());
  });
  it("gives every op a human label and a colour", () => {
    for (const op of CHANGE_OPS) {
      const label = opLabel(op);
      expect(label, op).not.toBe("");
      expect(label, op).not.toContain("_");
      expect(opColor(op), op).toMatch(/^text-/);
    }
  });
  it("labels visibility changes for what they did", () => {
    expect(opLabel("access_revoked")).toBe("restricted");
    expect(opLabel("access_granted")).toBe("made shared");
    expect(opColor("access_revoked")).toContain("warning");
    expect(opColor("access_granted")).toContain("success");
    expect(opClusterLabel("access_revoked", 2)).toBe("restricted 2 items");
    expect(opLabel("access_claimed")).toBe("claimed");
    expect(opClusterLabel("access_granted", 1)).toBe("shared 1 item");
  });
  it("never treats a visibility change as a content change or a comment", () => {
    for (const op of ["access_revoked", "access_granted"]) {
      expect(opDisplay(op).changesContent, op).toBe(false);
      expect(isCommentEvent(op), op).toBe(false);
    }
  });
  it("falls back to a neutral label for an op from a newer server", () => {
    expect(opLabel("shelved")).toBe("changed");
    expect(opColor("shelved")).toContain("fg-muted");
    expect(opDisplay("shelved").changesContent).toBe(false);
    expect(opClusterLabel("shelved", 3)).toBe("changed 3 files");
  });
  it("still reads an unknown comment_* op as comment traffic", () => {
    expect(isCommentEvent("comment_pinned")).toBe(true);
    expect(isCommentEvent("comment_created")).toBe(true);
    expect(isCommentEvent("write")).toBe(false);
  });
  it("flags only conflicted copies' paths", () => {
    const flagged = CHANGE_OPS.filter((op) => opDisplay(op).flagsPath);
    expect(flagged).toEqual(["conflict"]);
  });
});

describe("clusterSummary (R5)", () => {
  const base = "2026-06-06T10:00:00Z";
  it("summarizes a single-op burst with a count", () => {
    const [cluster] = clusterEvents(
      Array.from({ length: 14 }, (_, i) => fe({ createdAt: base, seq: i + 1, actorId: "a1" })),
    );
    expect(clusterSummary(cluster!)).toBe("wrote 14 files");
  });
  it("summarizes a mixed-op burst generically", () => {
    const [cluster] = clusterEvents([
      fe({ createdAt: base, seq: 1, actorId: "a1", op: "write" }),
      fe({ createdAt: base, seq: 2, actorId: "a1", op: "delete" }),
      fe({ createdAt: base, seq: 3, actorId: "a1", op: "write" }),
    ]);
    expect(clusterSummary(cluster!)).toBe("made 3 changes");
  });
  it("phrases a comment burst by comments, not files", () => {
    const [cluster] = clusterEvents([
      fe({ createdAt: base, seq: 1, actorId: "a1", op: "comment_created" }),
      fe({ createdAt: base, seq: 2, actorId: "a1", op: "comment_created" }),
    ]);
    expect(clusterSummary(cluster!)).toBe("left 2 comments");
  });
  it("phrases a run of access changes in words, never the raw op", () => {
    const [cluster] = clusterEvents([
      fe({ createdAt: base, seq: 1, actorId: "a1", op: "access_granted", version: null }),
      fe({ createdAt: base, seq: 2, actorId: "a1", op: "access_granted", version: null }),
    ]);
    expect(clusterSummary(cluster!)).toBe("shared 2 items");
  });
});
describe("actorShortName", () => {
  const base = {
    id: "e",
    path: "a.md",
    op: "write",
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
  };
  it("names agents by their label, the viewer as You, and members by name", () => {
    expect(actorShortName({ ...base, principal: "agent", actorLabel: "Claude" }, "me", null)).toBe(
      "Claude",
    );
    expect(actorShortName({ ...base, principal: "agent", actorId: "me" }, "me", null)).toBe(
      "Agent",
    );
    expect(actorShortName({ ...base, principal: "human", actorId: "me" }, "me", "Zef")).toBe("You");
    expect(actorShortName({ ...base, principal: "human", actorId: "sam" }, "me", "Sam")).toBe(
      "Sam",
    );
    expect(actorShortName({ ...base, principal: "human", actorId: "x" }, "me", null)).toBe(
      "Someone",
    );
  });
});
describe("recovery operations in the feed", () => {
  const op = (kind: string, extra: Record<string, string | null> = {}) => ({
    id: "op1",
    kind,
    scopePath: null,
    targetAt: null,
    targetLabel: null,
    ...extra,
  });

  it("groups an operation's events into one cluster, apart from ordinary changes", () => {
    const events = [
      fe({ createdAt: "2026-06-06T10:00:00Z", seq: 1, principal: "human", actorId: "u1" }),
      fe({
        createdAt: "2026-06-06T10:01:00Z",
        seq: 2,
        principal: "human",
        actorId: "u1",
        op: "restore",
        operationId: "op1",
      }),
      // Long-running: well past the usual 5-minute window, still one entry.
      fe({
        createdAt: "2026-06-06T10:30:00Z",
        seq: 3,
        principal: "human",
        actorId: "u1",
        op: "restore",
        operationId: "op1",
      }),
      fe({ createdAt: "2026-06-06T10:31:00Z", seq: 4, principal: "human", actorId: "u1" }),
    ];
    const clusters = clusterEvents(events, { operations: new Map([["op1", op("trash")]]) });
    expect(clusters.map((c) => c.events.map((e) => e.seq))).toEqual([[4], [3, 2], [1]]);
    expect(clusters[1]!.operation?.kind).toBe("trash");
    expect(clusterSummary(clusters[1]!)).toBe("restored 2 files from the trash");
  });

  it("labels each kind, counting a move as one change", () => {
    const moved = [
      fe({ createdAt: "2026-06-06T10:00:00Z", op: "delete", path: "b.md", relatedPath: "a.md" }),
      fe({ createdAt: "2026-06-06T10:00:00Z", op: "move", path: "a.md", relatedPath: "b.md" }),
      fe({ createdAt: "2026-06-06T10:00:00Z", op: "restore", path: "c.md" }),
    ];
    expect(operationSummary(op("undo", { targetLabel: "Claude Code" }), moved)).toBe(
      "undid 2 changes by Claude Code",
    );
    expect(operationSummary(op("trash"), moved.slice(2))).toBe("restored 1 file from the trash");
    expect(
      operationSummary(
        op("restore", { scopePath: "Notes", targetAt: "2020-01-02T15:04:00Z" }),
        moved,
      ),
    ).toMatch(/^restored 2 files in Notes to .*2020/);
  });

  it("shows a point in time as a time today, else with its date", () => {
    const now = new Date("2026-06-06T18:00:00");
    expect(pointInTime(new Date("2026-06-06T15:04:00").toISOString(), now)).not.toMatch(/Jun/);
    expect(pointInTime(new Date("2026-06-01T15:04:00").toISOString(), now)).toMatch(/Jun/);
    expect(pointInTime(null, now)).toBe("an earlier point");
  });
});
describe("groupByDay", () => {
  it("buckets a newest-first list by local day", () => {
    const now = new Date("2026-06-06T18:00:00");
    const at = (d: string) => ({ at: new Date(d).toISOString() });
    const groups = groupByDay(
      [
        at("2026-06-06T10:00:00"),
        at("2026-06-06T09:00:00"),
        at("2026-06-05T09:00:00"),
        at("2026-06-01T09:00:00"),
      ],
      (x) => x.at,
      now,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      [expect.stringMatching(/Jun/), 1],
    ]);
  });
});
describe("cluster counts", () => {
  it("counts a rename as one change", () => {
    const events = [
      fe({
        createdAt: "2026-06-06T10:00:00Z",
        seq: 1,
        op: "delete",
        path: "a.md",
        relatedPath: "b.md",
      }),
      fe({
        createdAt: "2026-06-06T10:00:00Z",
        seq: 2,
        op: "move",
        path: "b.md",
        relatedPath: "a.md",
      }),
      fe({ createdAt: "2026-06-06T10:00:01Z", seq: 3, op: "write", path: "c.md" }),
    ];
    expect(clusterSummary(clusterEvents(events)[0]!)).toBe("made 2 changes");
  });
});