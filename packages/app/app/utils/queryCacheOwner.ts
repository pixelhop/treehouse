// Whose data a tab's query cache may hold. The cache keeps what one person may
// see (their file list, file contents, tags) and queries are keyed by workspace,
// not by user, so it must never outlive that person's session in this tab.

export type CacheStep =
  /** The session isn't known: a request in flight, or one that failed. */
  | "wait"
  /** The cache is already this person's. */
  | "keep"
  /** Someone else (or no one) is signed in now. */
  | "switch";

export interface SessionIdentity {
  pending: boolean;
  failed: boolean;
  userId: string | null;
}

/** The parts of a better-auth session that say who is signed in. */
export function sessionIdentity(session: {
  isPending: boolean;
  error?: unknown;
  data?: { user?: { id?: string } } | null;
}): SessionIdentity {
  return {
    pending: session.isPending,
    failed: Boolean(session.error),
    userId: session.data?.user?.id ?? null,
  };
}

/**
 * What to do with a tab's cache, given who it holds data for. A session request
 * that failed says nothing about who is signed in, so a network blip isn't
 * treated as signing out. Compares against this tab's own record, never shared
 * storage: another tab can switch users while this one still holds the old data.
 */
export function cacheStep(session: SessionIdentity, heldBy: string | null): CacheStep {
  if (session.pending || session.failed) return "wait";
  return session.userId === heldBy ? "keep" : "switch";
}