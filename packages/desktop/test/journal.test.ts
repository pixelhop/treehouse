import { describe, expect, it } from "vite-plus/test";
import {
  boundJournal,
  buildEntry,
  createJournal,
  formatEntry,
  type JournalIo,
  redact,
  shortId,
  summarize,
} from "../src/onboarding/journal";
import type { OnboardingContext, OnboardingState, Step } from "../src/onboarding/machine";

// The journal exists because a failed onboarding used to leave nothing behind: the
// run died at the device grant, stderr was empty, and the resume record was deleted
// on the way out. These tests pin the three properties that make it trustworthy —
// it records the failure, it never records a secret, and it never breaks the flow.

const state = (step: Step, ctx: Partial<OnboardingContext> = {}): OnboardingState => ({
  step,
  ctx: { appOrigin: "https://treehouse.example", ...ctx },
});

function memoryIo(): JournalIo & { text: () => string; lines: () => string[] } {
  let text = "";
  return {
    read: () => text,
    write: (t) => {
      text = t;
    },
    text: () => text,
    lines: () => text.split("\n").filter((l) => l.length > 0),
  };
}

const parsed = (io: { lines: () => string[] }): Record<string, unknown>[] =>
  io.lines().map((l) => JSON.parse(l) as Record<string, unknown>);

describe("journal — recording transitions", () => {
  it("records a step sequence in order with non-decreasing timestamps", () => {
    const io = memoryIo();
    let clock = 1_000;
    const journal = createJournal({ io, now: () => (clock += 1_000) });

    journal.record("start", state("signin"));
    journal.record("step", state("workspace"));
    journal.record("step", state("folder", { workspaceName: "Design" }));
    journal.record("step", state("grant", { folderRoot: "/Users/me/Treehouse/Design" }));

    const entries = parsed(io);
    expect(entries.map((e) => e.step)).toEqual(["signin", "workspace", "folder", "grant"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const times = entries.map((e) => Date.parse(e.t as string));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Each transition names the step it came from, so the trail reconstructs the path.
    expect(entries[2]?.prev).toBe("workspace");
  });

  it("keeps timestamps monotonic when the wall clock jumps backwards", () => {
    const io = memoryIo();
    const stamps = [5_000, 1_000, 6_000];
    let i = 0;
    const journal = createJournal({ io, now: () => stamps[i++] ?? 0 });

    journal.record("step", state("workspace"));
    journal.record("step", state("folder"));
    journal.record("step", state("grant"));

    const times = parsed(io).map((e) => Date.parse(e.t as string));
    expect(times[1]).toBeGreaterThanOrEqual(times[0] as number);
    expect(times[2]).toBeGreaterThanOrEqual(times[1] as number);
  });

  it("records WHICH step failed and WHY (the 2026-07-30 grant failure)", () => {
    const io = memoryIo();
    const journal = createJournal({ io });

    journal.record("step", state("grant", { folderRoot: "/Users/me/Treehouse/Design" }));
    journal.record(
      "step",
      state("error", {
        folderRoot: "/Users/me/Treehouse/Design",
        error: "Device grant failed: fetch failed",
        recoverTo: "grant",
      }),
    );

    const last = parsed(io).at(-1);
    expect(last?.step).toBe("error");
    // "error" alone is what we had before, and it was useless.
    expect(last?.failedAt).toBe("grant");
    expect(last?.error).toContain("Device grant failed");
  });

  it("a new run's start entry does not inherit the previous run's step", () => {
    // Regression (PR #46 review). `prev` lives on the createJournal() closure and
    // was carried across every record, including "start". run.ts shares ONE journal
    // between resume and re-authenticate, so a re-auth begun right after a cancel
    // reported the dead run's last step as its predecessor — the trail then read as
    // one continuous flow when it was two independent ones.
    const io = memoryIo();
    const journal = createJournal({ io });

    journal.record("start", state("signin"));
    journal.record("step", state("workspace"));
    journal.record("outcome", state("workspace"), "superseded by another flow");
    // A brand new, unrelated flow.
    journal.record("start", state("grant"), "re-authenticate");

    const startLines = io.lines().filter((l) => l.includes("start"));
    expect(startLines).toHaveLength(2);
    // The second start must not claim to have come from anywhere.
    expect(startLines[1]).not.toContain("workspace");
  });

  it("records an outcome note so an abandoned run is distinguishable from a finished one", () => {
    const io = memoryIo();
    const journal = createJournal({ io });
    journal.record("outcome", state("error", { recoverTo: "grant" }), "abandoned");
    expect(parsed(io).at(-1)?.note).toBe("abandoned");
    expect(parsed(io).at(-1)?.kind).toBe("outcome");
  });
});

describe("journal — redaction (never write a secret)", () => {
  it("never writes a keyId or an invite token verbatim", () => {
    const io = memoryIo();
    const journal = createJournal({ io });
    const keyId = "th_key_9f3ac21d7b6e4c8fa0d51e2b3c4d5e6f";
    const inviteToken = "inv_8c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";

    journal.record("step", state("starting", { keyId, inviteToken, workspaceId: "ws_abc123" }));

    const out = io.text();
    expect(out).not.toContain(keyId);
    expect(out).not.toContain(inviteToken);
    // Presence is recorded (that IS the diagnostic) — the value is not.
    expect(out).toContain("inviteToken");
    expect(JSON.parse(io.lines()[0] as string).ctx.inviteToken).toBe("present");
  });

  it("scrubs token-shaped values smuggled in through an error message", () => {
    const io = memoryIo();
    const journal = createJournal({ io });
    const secret = "eyJhbGciOiJIUzI1NiJ9aBcD1234567890xyz";

    journal.record(
      "step",
      state("error", {
        error: `POST /api/device/approve failed: token=${secret} (cookie: sess_9988aabbccddeeff0011)`,
        recoverTo: "grant",
      }),
    );

    const out = io.text();
    expect(out).not.toContain(secret);
    expect(out).not.toContain("sess_9988aabbccddeeff0011");
    // Still legible as a diagnostic.
    expect(out).toContain("/api/device/approve");
  });

  it("redacts device/user codes, bearer headers and opaque runs", () => {
    expect(redact("user code WDJB-MJHT expired")).toBe("user code [redacted] expired");
    expect(redact("retried with Bearer sk_live_ab12cd34ef56")).toBe(
      "retried with Bearer [redacted]",
    );
    // A sensitive KEY redacts its value whatever the value looks like.
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redact("id a1b2c3d4e5f6a7b8c9d0e1f2")).toBe("id [redacted]");
    // Prose is left alone — an over-eager redactor makes the journal useless.
    expect(redact("That doesn't look like a Treehouse server.")).toBe(
      "That doesn't look like a Treehouse server.",
    );
  });

  it("redacts QUOTED-key JSON pairs, not just bare key=value", () => {
    // Regression (PR #46 review). PAIR's separator required `[=:]` immediately
    // after the key name, so the key's own closing quote broke every match:
    // `{"password":"1234"}` fell through to OPAQUE_RUN, which only catches runs
    // of 20+ mixed alphanumerics — so a short or purely-numeric secret inside a
    // serialized error body was written verbatim. Server errors quote JSON far
    // more often than they emit bare `token=abc`, so this was the common case.
    expect(redact('{"password":"1234","token":"abc"}')).toBe(
      '{"password":"[redacted]","token":"[redacted]"}',
    );
    expect(redact('{"keyId": "abc"}')).toBe('{"keyId": "[redacted]"}');
    expect(redact('server said {"secret":"swordfish"}')).not.toContain("swordfish");
    // The unquoted forms that already worked must keep working.
    expect(redact("token=abc123")).toBe("token=[redacted]");
    expect(redact("code: hunter2")).toBe("code: [redacted]");
    // And a non-sensitive key keeps its value — redacting everything would make
    // the journal useless for the folder-name bugs it exists to diagnose.
    expect(redact('{"folderName":"Documents"}')).toBe('{"folderName":"Documents"}');
  });

  it("shortens identifiers instead of writing them whole, and drops short ones", () => {
    expect(shortId("9f3ac21d7b6e4c8fa0d51e2b")).toBe("9f3ac21d…");
    expect(shortId("WDJB-MJHT")).toBe("[redacted]");
    expect(shortId(undefined)).toBeUndefined();
  });

  it("summarizes the context from an allow list, so a new secret field can't leak", () => {
    const keys = Object.keys(
      summarize({
        appOrigin: "https://treehouse.example",
        apiOrigin: "https://api.treehouse.example",
        workspaceId: "ws_1234567890abcdef",
        workspaceName: "Design",
        folderRoot: "/Users/me/Treehouse/Design",
        keyId: "th_key_1234567890abcdef",
        inviteToken: "inv_1234567890abcdef",
        forceGrant: true,
      }),
    );
    expect(keys.sort()).toEqual(
      [
        "apiOrigin",
        "appOrigin",
        "folderRoot",
        "forceGrant",
        "inviteToken",
        "keyId",
        "workspaceId",
        "workspaceName",
      ].sort(),
    );
  });

  it("keeps every entry on one line, so a multi-line error can't corrupt the trail", () => {
    const io = memoryIo();
    const journal = createJournal({ io });
    journal.record("step", state("error", { error: "line one\nline two\nline three" }));
    expect(io.lines()).toHaveLength(1);
  });
});

describe("boundJournal — bounded growth", () => {
  it("drops the OLDEST entries when the cap is exceeded", () => {
    const io = memoryIo();
    const journal = createJournal({ io, maxBytes: 600 });

    for (let i = 0; i < 60; i += 1) {
      journal.record("step", state("grant", { workspaceName: `Run ${i}` }));
    }

    const out = io.text();
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(600);
    expect(out).toContain("Run 59"); // newest survives
    expect(out).not.toContain("Run 0"); // oldest dropped
    // Every surviving line is still a whole, parseable entry.
    expect(() => parsed(io)).not.toThrow();
  });

  it("appends without dropping while under the cap", () => {
    const out = boundJournal("a\n", "b\n", 1024);
    expect(out).toBe("a\nb\n");
  });

  it("adds the missing newline when the existing file was truncated mid-line", () => {
    expect(boundJournal("a", "b\n", 1024)).toBe("a\nb\n");
  });

  it("keeps the newest entry even when it alone exceeds the cap", () => {
    const out = boundJournal("old\n", `${"x".repeat(100)}\n`, 20);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(20);
    expect(out).not.toContain("old");
  });
});

describe("journal — never a new failure mode", () => {
  it("degrades silently when the journal path is unwritable", () => {
    const journal = createJournal({
      io: {
        read: () => "",
        write: () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
      },
    });
    expect(() => journal.record("step", state("grant"))).not.toThrow();
  });

  it("degrades silently when the existing journal is unreadable", () => {
    let written: string | null = null;
    const journal = createJournal({
      io: {
        read: () => {
          throw new Error("EIO");
        },
        write: (t) => {
          written = t;
        },
      },
    });
    expect(() => journal.record("step", state("grant"))).not.toThrow();
    expect(written).toBeNull(); // the write never happened, but nothing propagated
  });

  it("keeps recording after a transient write failure", () => {
    let fail = true;
    let text = "";
    const journal = createJournal({
      io: {
        read: () => text,
        write: (t) => {
          if (fail) throw new Error("ENOSPC");
          text = t;
        },
      },
    });
    journal.record("step", state("folder"));
    fail = false;
    journal.record("step", state("grant"));
    expect(text).toContain('"step":"grant"');
  });
});

describe("buildEntry / formatEntry", () => {
  it("omits prev when the step did not change", () => {
    const entry = buildEntry({ kind: "step", state: state("grant"), at: 0, seq: 1, prev: "grant" });
    expect(entry.prev).toBeUndefined();
  });

  it("records a failure with no message rather than dropping it", () => {
    const entry = buildEntry({
      kind: "step",
      state: state("error", { recoverTo: "signin" }),
      at: 0,
      seq: 1,
    });
    expect(entry.error).toBe("(no message)");
    expect(JSON.parse(formatEntry(entry)).failedAt).toBe("signin");
  });
});