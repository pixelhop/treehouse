// ---------------------------------------------------------------------------
// Change-feed ops. Every ChangeEvent row the API writes carries one of these as
// its `op`, and every reader (the web app's feed and history, the sync CLI)
// branches on it. The union lives here so the writers are typed against the
// same list the readers handle: adding an op is one entry below, and the app's
// display table (a `Record<ChangeOp, …>`) then fails the typecheck until it
// says how to show it.
//
// The column itself is a plain string, and a newer server can send an op an
// older client has never heard of, so readers narrow with `isChangeOp` and
// keep a fallback rather than trusting the wire.
// ---------------------------------------------------------------------------

/** Ops that change a file's bytes or location. */
export const FILE_OPS = ["write", "move", "delete", "conflict", "restore"] as const;

/** Review traffic on a file. Opt-in on the feed (`includeComments`). */
export const COMMENT_OPS = [
  "comment_created",
  "comment_replied",
  "comment_resolved",
  "comment_reopened",
] as const;

/**
 * Visibility changes on a file or folder (the path of its restriction).
 * `access_revoked`: who can see it narrowed; delivered only to members who could
 * see it before and can't now. `access_granted`: it widened; delivered to members
 * who can, not the person who changed it. `access_claimed`: an owner took over a restricted node
 * no remaining member could reach. An audit entry for the activity feed, never
 * sent to sync clients, which would read an op they don't know as a deletion.
 */
export const ACCESS_OPS = ["access_revoked", "access_granted", "access_claimed"] as const;

export type FileOp = (typeof FILE_OPS)[number];
export type CommentOp = (typeof COMMENT_OPS)[number];
export type AccessOp = (typeof ACCESS_OPS)[number];
export type ChangeOp = FileOp | CommentOp | AccessOp;

export const CHANGE_OPS: readonly ChangeOp[] = [...FILE_OPS, ...COMMENT_OPS, ...ACCESS_OPS];

const KNOWN = new Set<string>(CHANGE_OPS);

/** Narrow a wire `op` to a known ChangeOp. False for an op from a newer server. */
export function isChangeOp(op: string): op is ChangeOp {
  return KNOWN.has(op);
}

/**
 * Every comment op starts with this. The server filters on the prefix (not the
 * list above) so a comment op added later is still withheld from clients that
 * never opted into comment traffic, fielded CLIs included.
 */
export const COMMENT_OP_PREFIX = "comment_";

/** Is this op comment traffic? Prefix-based, so it also covers future comment ops. */
export function isCommentOp(op: string): boolean {
  return op.startsWith(COMMENT_OP_PREFIX);
}

/**
 * Ops whose event carries a content pointer (`contentHash`) for its version, so
 * that version's bytes can be read back and restored. delete and conflict
 * events point at nothing.
 */
export const CONTENT_POINTER_OPS = [
  "write",
  "move",
  "restore",
] as const satisfies readonly FileOp[];

/** Does an event with this op point at a readable version of the file? */
export function carriesContent(op: string): boolean {
  return (CONTENT_POINTER_OPS as readonly string[]).includes(op);
}