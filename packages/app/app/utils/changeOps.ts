// How each change-feed op reads in the activity feed and the per-file History
// tab. One entry per op in the shared `ChangeOp` union, so a new server op is a
// typecheck failure here until it says how to show itself (its icon lives in
// OpGlyph.vue's matching `Record<ChangeOp, …>`, since icon imports only resolve
// inside Nuxt).
//
// The wire `op` stays a string: a newer server can send one this build has
// never heard of. `opDisplay` is the single place it is narrowed, and an
// unknown op falls back to a neutral "changed" rather than the raw op name.
import { type ChangeOp, isChangeOp, isCommentOp } from "shared";

export type OpTone = "muted" | "accent" | "success" | "warning" | "danger";

/** What kind of change an op is: to a file's bytes, its review thread, or who can see it. */
export type OpGroup = "file" | "comment" | "access";

export interface OpDisplay {
  /** Verb for a single event: "<actor> wrote". */
  label: string;
  /** Verb phrase for a same-op run of `n` events. Defaults to "<label> n files". */
  cluster?: (n: number) => string;
  tone: OpTone;
  group: OpGroup;
  /** Changes the file's bytes or removes it, so a reader of that file is told. */
  changesContent: boolean;
  /** The path no longer exists afterwards (an editor open on it has lost its file). */
  removesPath: boolean;
  /** The path is a conflicted copy: its link, and a standalone entry, read as warning. */
  flagsPath: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const file = { group: "file", flagsPath: false, removesPath: false } as const;
const comment = {
  group: "comment",
  changesContent: false,
  removesPath: false,
  flagsPath: false,
} as const;
const access = {
  group: "access",
  changesContent: false,
  removesPath: false,
  flagsPath: false,
} as const;

export const CHANGE_OP_DISPLAY: Record<ChangeOp, OpDisplay> = {
  write: { ...file, label: "wrote", tone: "muted", changesContent: true },
  move: { ...file, label: "moved", tone: "muted", changesContent: true },
  restore: { ...file, label: "restored", tone: "success", changesContent: true },
  delete: { ...file, label: "deleted", tone: "danger", changesContent: true, removesPath: true },
  // A conflict event sits on the conflicted copy, not the file being edited.
  conflict: { ...file, label: "conflict", tone: "warning", changesContent: false, flagsPath: true },

  // Review chatter is its own kind of change — coloured so a burst of comments
  // reads as conversation rather than as edits. The unit is the comment, not the
  // file, so a run gets its own plural-aware phrasing.
  comment_created: {
    ...comment,
    label: "commented",
    tone: "accent",
    cluster: (n) => `left ${plural(n, "comment", "comments")}`,
  },
  comment_replied: {
    ...comment,
    label: "replied",
    tone: "accent",
    cluster: (n) => `posted ${plural(n, "reply", "replies")}`,
  },
  comment_resolved: {
    ...comment,
    label: "resolved a comment",
    tone: "success",
    cluster: (n) => `resolved ${plural(n, "comment", "comments")}`,
  },
  comment_reopened: {
    ...comment,
    label: "reopened a comment",
    tone: "warning",
    cluster: (n) => `reopened ${plural(n, "comment", "comments")}`,
  },

  // Visibility changes. The server sends `access_revoked` only to members who
  // can't see the item now and `access_granted` only to members who can, so the
  // tone is from the reader's side: something left your view (warning), something
  // arrived in it (success). The path may be a folder.
  access_revoked: {
    ...access,
    label: "restricted",
    tone: "warning",
    cluster: (n) => `restricted ${plural(n, "item", "items")}`,
  },
  access_granted: {
    ...access,
    label: "made shared",
    tone: "success",
    cluster: (n) => `shared ${plural(n, "item", "items")}`,
  },
  // Only owners and admins see this: someone took over what nobody could reach.
  access_claimed: {
    ...access,
    label: "claimed",
    tone: "warning",
    cluster: (n) => `claimed ${plural(n, "item", "items")}`,
  },
};

/** For an op this build doesn't know. Neutral, never the raw op name. */
function fallback(op: string): OpDisplay {
  return {
    label: "changed",
    tone: "muted",
    // A future comment op is still comment traffic (the server filters on the
    // same prefix), so a reader refreshes its threads rather than its bytes.
    group: isCommentOp(op) ? "comment" : "file",
    changesContent: false,
    removesPath: false,
    flagsPath: false,
  };
}

/** The display entry for a wire op, falling back safely for an unknown one. */
export function opDisplay(op: string): OpDisplay {
  return isChangeOp(op) ? CHANGE_OP_DISPLAY[op] : fallback(op);
}

const TONE_CLASS: Record<OpTone, string> = {
  muted: "text-fg-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** Single-event verb for an op ("wrote", "restricted", "changed" if unknown). */
export function opLabel(op: string): string {
  return opDisplay(op).label;
}

/** Semantic text-colour class for an op — conflict/delete/restore stand out. */
export function opColor(op: string): string {
  return TONE_CLASS[opDisplay(op).tone];
}

/** Is this op comment traffic (its version says when it happened, not what it made)? */
export function isCommentEvent(op: string): boolean {
  return opDisplay(op).group === "comment";
}

/** Phrase for a run of `n` events that all share `op`, e.g. "wrote 14 files". */
export function opClusterLabel(op: string, n: number): string {
  const d = opDisplay(op);
  return d.cluster ? d.cluster(n) : `${d.label} ${plural(n, "file", "files")}`;
}