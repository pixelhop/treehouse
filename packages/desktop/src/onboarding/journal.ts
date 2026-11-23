import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, ensureAppDir } from "cli/src/paths";
import type { OnboardingContext, OnboardingState, Step } from "./machine";

// Onboarding diagnostics (R12). An abandoned or failed onboarding used to leave NO
// trail at all: on 2026-07-30 a run died at the device-grant step with empty stderr,
// and `resumeOnboarding` CLEARS the resume record on the way out — so the only
// evidence left was which files happened to exist on disk. This journal is that
// missing evidence: an append-only log of every step transition and every failure
// reason, written beside onboarding.json under `appDir()` (which honours
// TREEHOUSE_HOME, so dev runs stay isolated).
//
// Three properties are non-negotiable, and each is a pure function below so it can
// be tested without touching disk:
//
//  1. NEVER write secrets. The flow handles session cookies, device codes and a
//     minted key; the context carries a keyId and an invite token. Ids are
//     shortened, the invite token is recorded only as "present", and every emitted
//     string goes through `redact()` as a second line of defence.
//  2. Bounded. Onboarding can be retried indefinitely, so the file is capped and
//     the OLDEST entries are dropped (`boundJournal`).
//  3. Silent on failure. A journal that can't be written must never break the thing
//     it exists to diagnose — every write is wrapped and swallowed.

/** Max journal size on disk. Roughly a few hundred entries — several full runs. */
export const DEFAULT_MAX_BYTES = 64 * 1024;

/** Longest single free-text value written (error messages can be arbitrary). */
const MAX_TEXT = 400;

export type JournalKind =
  /** A driver was constructed and is about to run from this step. */
  | "start"
  /** A machine transition (the `onTransition` hook). */
  | "step"
  /** How the run ended: completed, abandoned, superseded. */
  | "outcome";

export interface JournalEntry {
  /** Epoch ms, clamped to be non-decreasing within a process. */
  at: number;
  /** Per-process sequence number — ordering survives a clock that jumps. */
  seq: number;
  kind: JournalKind;
  step: Step;
  /** The step this transition came from, when it differs. */
  prev?: Step;
  /** Free-text note (outcomes, re-auth marker). */
  note?: string;
  /** For the error step: which step actually failed (ctx.recoverTo). */
  failedAt?: Step;
  /** For the error step: the failure message. */
  error?: string;
  /** Redacted, allow-listed snapshot of the onboarding context. */
  ctx: Record<string, string>;
}

export const journalPath = (): string => join(appDir(), "onboarding-journal.log");

// ── Pure: redaction ─────────────────────────────────────────────────────────

/** Key names whose VALUE must never be written, whatever it looks like. */
const SENSITIVE_KEY = /key|token|secret|passw|pwd|cookie|session|auth|credential|code|bearer/i;
/** `Authorization: Bearer <...>` in any error message that quotes a request. */
const BEARER = /\bbearer\s+[^\s"',;]+/gi;
/** `token=abc`, `"keyId": "abc"`, `code: abc` — key/value pairs of any shape. */
const PAIR = /\b([A-Za-z][\w.-]*)("?\s*[=:]\s*"?)([^\s"',;&}]+)("?)/g;
/** Device/user codes are short and dashed — the length rule below misses them. */
const DEVICE_CODE = /\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/g;
/** Anything long, opaque and mixed-case-alphanumeric: keys, JWT parts, cookies. */
const OPAQUE_RUN = /[A-Za-z0-9_-]{20,}/g;

const REDACTED = "[redacted]";

const looksOpaque = (s: string): boolean => /[0-9]/.test(s) && /[A-Za-z]/.test(s);

/**
 * Scrub anything token-shaped out of free text, flatten it to one line (the
 * journal is line-oriented — `boundJournal` splits on newlines) and cap its
 * length so one enormous error can't consume the whole file.
 *
 * Deliberately aggressive: a diagnostic that occasionally redacts a long folder
 * name is fine, a diagnostic that occasionally writes a credential is not.
 */
export function redact(text: string, maxLength = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const scrubbed = flat
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(PAIR, (whole, key: string, sep: string, value: string, quote: string) =>
      SENSITIVE_KEY.test(key) ? `${key}${sep}${REDACTED}${quote}` : whole,
    )
    .replace(DEVICE_CODE, REDACTED)
    .replace(OPAQUE_RUN, (run) => (looksOpaque(run) ? REDACTED : run));
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}

/**
 * Identifiers (workspace id, key id) are useful for correlation — finding the
 * orphaned key a failed grant left behind needs a handle on it — but they are
 * never written whole. Anything too short to truncate meaningfully (a device code
 * is 8-9 characters) is dropped entirely rather than guessed at.
 */
export function shortId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.length < 12 ? REDACTED : `${id.slice(0, 8)}…`;
}

/**
 * Allow-listed context snapshot. An allow list, not a deny list: a field added to
 * `OnboardingContext` later is invisible here until someone decides it is safe,
 * which is the right default for a file that must never carry a secret.
 */
export function summarize(ctx: OnboardingContext): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | undefined): void => {
    if (v) out[k] = v;
  };
  put("appOrigin", ctx.appOrigin);
  put("apiOrigin", ctx.apiOrigin);
  put("workspaceId", shortId(ctx.workspaceId));
  put("workspaceName", ctx.workspaceName);
  put("folderRoot", ctx.folderRoot);
  put("folderWarning", ctx.folderWarning);
  // The key id identifies the key, shortened; the invite token IS a credential, so
  // only its presence is recorded.
  put("keyId", shortId(ctx.keyId));
  if (ctx.inviteToken) out.inviteToken = "present";
  if (ctx.forceGrant) out.forceGrant = "true";
  return out;
}

// ── Pure: entry construction + formatting ───────────────────────────────────

export interface JournalInput {
  kind: JournalKind;
  state: OnboardingState;
  at: number;
  seq: number;
  prev?: Step;
  note?: string;
}

export function buildEntry(input: JournalInput): JournalEntry {
  const { state } = input;
  const entry: JournalEntry = {
    at: input.at,
    seq: input.seq,
    kind: input.kind,
    step: state.step,
    ctx: summarize(state.ctx),
  };
  if (input.prev && input.prev !== state.step) entry.prev = input.prev;
  if (input.note) entry.note = input.note;
  // The failure the whole file exists for: WHICH step died and WHY. `recoverTo`
  // names the failing step — "error" alone would have been useless on 2026-07-30.
  if (state.step === "error") {
    if (state.ctx.recoverTo) entry.failedAt = state.ctx.recoverTo;
    entry.error = state.ctx.error ?? "(no message)";
  }
  return entry;
}

/**
 * One JSON object per line. Every string value passes through `redact()` here —
 * `buildEntry` already shortens the known identifiers, so this is the choke point
 * that catches a token smuggled in through an error message or a folder name.
 */
export function formatEntry(entry: JournalEntry): string {
  const ctx: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.ctx)) ctx[k] = redact(v);
  const line = {
    t: new Date(entry.at).toISOString(),
    seq: entry.seq,
    kind: entry.kind,
    step: entry.step,
    ...(entry.prev ? { prev: entry.prev } : {}),
    ...(entry.failedAt ? { failedAt: entry.failedAt } : {}),
    ...(entry.error ? { error: redact(entry.error) } : {}),
    ...(entry.note ? { note: redact(entry.note) } : {}),
    ctx,
  };
  return `${JSON.stringify(line)}\n`;
}

// ── Pure: bounding ──────────────────────────────────────────────────────────

/**
 * Append `addition` to `existing`, dropping whole entries from the FRONT until the
 * result fits `maxBytes`. Oldest-first: the entries nearest the failure are the
 * ones worth keeping, and an unbounded file across many retried onboardings is a
 * bug of its own.
 */
export function boundJournal(
  existing: string,
  addition: string,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  const base = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const combined = base + addition;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;

  const lines = combined.split("\n").filter((l) => l.length > 0);
  const size = (ls: string[]): number => Buffer.byteLength(`${ls.join("\n")}\n`);
  while (lines.length > 1 && size(lines) > maxBytes) lines.shift();
  if (size(lines) <= maxBytes) return `${lines.join("\n")}\n`;

  // One entry alone exceeds the whole cap. Keep its head rather than losing the
  // newest event entirely, shrinking by character so a multi-byte codepoint can't
  // be split and push the result back over the limit.
  let head = (lines[lines.length - 1] ?? "").slice(0, Math.max(0, maxBytes - 1));
  while (head.length > 0 && Buffer.byteLength(head) + 1 > maxBytes) head = head.slice(0, -1);
  return `${head}\n`;
}

// ── Wiring (injected in tests) ──────────────────────────────────────────────

/** The journal's only contact with the outside world. Injected so every decision
 * above stays testable, and so a test never writes to a real app dir. */
export interface JournalIo {
  /** Current contents, or "" when missing/unreadable. */
  read(): string;
  write(text: string): void;
}

/** Reads/writes `<appDir>/onboarding-journal.log`, atomically (a crash mid-write
 * must not truncate the trail of the crash it is recording). */
export function fileJournalIo(): JournalIo {
  return {
    read(): string {
      try {
        return readFileSync(journalPath(), "utf8");
      } catch {
        return "";
      }
    },
    write(text: string): void {
      ensureAppDir();
      const path = journalPath();
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export interface OnboardingJournal {
  record(kind: JournalKind, state: OnboardingState, note?: string): void;
}

export interface JournalOptions {
  io?: JournalIo;
  now?: () => number;
  maxBytes?: number;
}

/**
 * Create a journal. Every `record` is wrapped: an unwritable path, a full disk or
 * a read-only app dir degrades to silence. Diagnostics must never become a new
 * failure mode for the thing they diagnose.
 */
export function createJournal(opts: JournalOptions = {}): OnboardingJournal {
  const io = opts.io ?? fileJournalIo();
  const now = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let seq = 0;
  let last = 0;
  let prev: Step | undefined;

  return {
    record(kind, state, note) {
      try {
        // Clamp: a wall-clock adjustment mid-onboarding must not make the trail
        // read as though it ran backwards. `seq` is the real ordering.
        const at = Math.max(now(), last);
        last = at;
        seq += 1;
        // A `"start"` entry begins a NEW flow, so it has no predecessor — pass
        // undefined rather than whatever the last run happened to leave behind.
        // `run.ts` shares one journal between `resumeOnboardingInner` and
        // `reauthenticateInner`, so a re-auth started straight after a cancel used
        // to inherit the dead run's last step and read as a continuation of it.
        // That is precisely the kind of false trail this file exists not to leave.
        const line = formatEntry(
          buildEntry({ kind, state, at, seq, prev: kind === "start" ? undefined : prev, note }),
        );
        prev = state.step;
        io.write(boundJournal(io.read(), line, maxBytes));
      } catch {
        // Never propagate — see the header note.
      }
    },
  };
}