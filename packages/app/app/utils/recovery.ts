// Display helpers for the trash and the recovery preview. Pure, so the wording
// is tested without mounting anything.
import {
  type RecoveryOutcome,
  type RecoveryPreview,
  type RecoveryRequest,
  isKeepFile,
  KEEP_FILE,
  RECOVERY_SKIP_TEXT,
  recoveryActionKey,
  type RecoveryAction,
  type RecoverySkip,
  type TrashItem,
} from "shared";

/** How a trash entry reads: a `.keep` placeholder is the (empty) folder it held open. */
export function trashLabel(item: Pick<TrashItem, "path">): { path: string; isFolder: boolean } {
  if (!isKeepFile(item.path)) return { path: item.path, isFolder: false };
  const folder = item.path === KEEP_FILE ? "" : item.path.slice(0, -(KEEP_FILE.length + 1));
  return { path: folder || "Workspace root", isFolder: true };
}

/** The verb for one change: what it will do in a preview, what it did after. */
export function actionLabel(a: RecoveryAction, done = false): string {
  switch (a.kind) {
    case "recreate":
      return done ? "Brought back" : "Bring back";
    case "restore":
      return done ? "Restored an earlier version" : "Restore an earlier version";
    case "delete":
      return done ? "Deleted (it's in the trash)" : "Delete (it goes to the trash)";
    case "move":
      if (a.restoresContent) return done ? "Moved back and restored" : "Move back and restore";
      return done ? "Moved back" : "Move back";
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line per kind of change, for the top of a preview: "Bring back 3 files". */
export function actionCounts(actions: RecoveryAction[]): string[] {
  const count = (kind: RecoveryAction["kind"]) => actions.filter((a) => a.kind === kind).length;
  const lines: [number, (files: string) => string][] = [
    [count("recreate"), (f) => `Bring back ${f}`],
    [count("restore"), (f) => `Restore ${f} to an earlier version`],
    [
      count("move"),
      (f) => `Move ${f} back to where ${f.startsWith("1 ") ? "it was" : "they were"}`,
    ],
    [
      count("delete"),
      (f) => `Delete ${f} (${f.startsWith("1 ") ? "it goes" : "they go"} to the trash)`,
    ],
  ];
  return lines.filter(([n]) => n > 0).map(([n, line]) => line(plural(n, "file")));
}

/** Why a path was left alone, in a sentence fragment. */
export function skipText(s: RecoverySkip): string {
  const base = RECOVERY_SKIP_TEXT[s.reason] ?? "it was left alone";
  return s.detail ? `${base} (${s.detail})` : base;
}

/** The outcome in one line: "Done: 3 changes made. 1 file left alone." */
export function outcomeLine(applied: number, skipped: number): string {
  const left = `${plural(skipped, "file")} left alone.`;
  if (applied === 0) return skipped > 0 ? left : "Nothing was changed.";
  const done = `Done: ${plural(applied, "change")} made.`;
  return skipped > 0 ? `${done} ${left}` : done;
}
/** What the dialog lists: the outcome once applied, the preview before. */
export function shownChanges(
  preview: RecoveryPreview | null,
  outcome: RecoveryOutcome | null,
): { actions: RecoveryAction[]; skipped: RecoverySkip[] } {
  if (outcome) return { actions: outcome.applied, skipped: outcome.skipped };
  if (preview) return { actions: preview.actions, skipped: preview.skipped };
  return { actions: [], skipped: [] };
}

/** The message from a failed API call: the server's reason when it gave one. */
export function errorText(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }; statusMessage?: string; message?: string };
  return err.data?.statusMessage || err.statusMessage || err.message || "Something went wrong.";
}

/** "you", or the agent's key name, or the member's name, for "Deleted by …". */
export function deletedByLabel(
  item: Pick<TrashItem, "principal" | "actorId" | "actorLabel">,
  userId: string | null,
  memberName: string | null,
): string {
  if (item.principal === "agent") return item.actorLabel ?? "an agent";
  if (userId && item.actorId === userId) return "you";
  return memberName ?? "someone";
}
/** The messages above a recovery preview, most important first. */
export function dialogNotices(state: {
  error: string | null;
  tooLarge: boolean;
  nothingToDo: boolean;
}): { tone: "danger" | "warning" | "muted"; text: string }[] {
  const notices: { tone: "danger" | "warning" | "muted"; text: string }[] = [];
  if (state.error) notices.push({ tone: "danger", text: state.error });
  if (state.tooLarge) {
    notices.push({
      tone: "warning",
      text: "That's more changes than one restore can make. Try one folder at a time.",
    });
  }
  if (state.nothingToDo) {
    notices.push({ tone: "muted", text: "Nothing to do: everything is already as it was." });
  }
  return notices;
}

/**
 * Tells whether a piece of async work is still the latest: `next()` starts
 * one (making all earlier ones stale), `now()` checks against whatever is
 * current already. Each returns a check to call when the work finishes, so a
 * slow response for something since replaced is dropped instead of shown.
 */
export function createLatest(): { next: () => () => boolean; now: () => () => boolean } {
  let current = 0;
  const check = (mine: number) => () => mine === current;
  return { next: () => check(++current), now: () => check(current) };
}

/** A promise's outcome as a value, so one check covers success and failure. */
export async function settled<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The apply request for a preview: the same request, held to the changes the
 * preview listed and to nothing that changed after it.
 */
export function confirmRequest(
  request: RecoveryRequest,
  preview: RecoveryPreview,
): RecoveryRequest {
  return {
    ...request,
    previewHead: preview.previewHead,
    approved: preview.actions.map(recoveryActionKey),
  };
}

/** A Date as a `datetime-local` input value, in local time to the second. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The moment just before a run of changes: one millisecond before the oldest,
 * so restoring to it undoes the whole run and nothing earlier.
 */
export function justBefore(events: { createdAt: string }[]): Date | null {
  const times = events.map((e) => new Date(e.createdAt).getTime()).filter((t) => !Number.isNaN(t));
  return times.length ? new Date(Math.min(...times) - 1) : null;
}

/** Quick picks for "restore to": label and the moment it means. */
export function timePresets(now: Date = new Date()): { label: string; at: Date }[] {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return [
    { label: "15 minutes ago", at: ago(15 * 60_000) },
    { label: "An hour ago", at: ago(60 * 60_000) },
    { label: "Start of today", at: startOfToday },
    { label: "A day ago", at: ago(24 * 60 * 60_000) },
    { label: "A week ago", at: ago(7 * 24 * 60 * 60_000) },
  ];
}
/** What the restore dialog is for: a folder or workspace, or one key's changes. */
export type RestoreMode =
  | { kind: "restore"; path: string | null }
  | { kind: "undo"; keyId: string; label: string };

/** The restore dialog's wording for each mode. */
export function restoreCopy(mode: RestoreMode): {
  heading: string;
  subtitle: string;
  blurb: string;
  confirmTitle: (at: string) => string;
  doneTitle: string;
} {
  if (mode.kind === "undo") {
    return {
      heading: `Undo changes by ${mode.label}`,
      subtitle: "Since this moment",
      blurb: `Every file ${mode.label} changed after this moment goes back to how it was just before its first change. Files someone else has changed since are left alone and listed, so nobody's work is lost.`,
      confirmTitle: (at) => `Undo ${mode.label}'s changes since ${at}?`,
      doneTitle: `Undid ${mode.label}'s changes`,
    };
  }
  const target = mode.path || "the whole workspace";
  return {
    heading: "Restore to an earlier time",
    subtitle: mode.path || "Whole workspace",
    blurb: `Everything in ${mode.path ? "this folder" : "the workspace"} that you can see goes back to how it was at this moment. You'll see every change before anything happens, and you can undo it the same way.`,
    confirmTitle: (at) => `Restore ${target} to ${at}?`,
    doneTitle: `Restored ${target}`,
  };
}

/** The recovery request for a mode at a moment. */
export function restoreRequest(mode: RestoreMode, at: Date): RecoveryRequest {
  return mode.kind === "undo"
    ? { kind: "undo", keyId: mode.keyId, since: at.toISOString() }
    : { kind: "restore", path: mode.path, at: at.toISOString() };
}