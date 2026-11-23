import type { ChangeEvent } from "db";
import { isCommentOp } from "shared";
import {
  type AccessSubject,
  type AclRow,
  canManageMembers,
  canRead,
  lostAccessTo,
  pathInKeyReach,
  readsInside,
} from "./acl";

/** What decides which events one reader gets. */
export interface FeedReader {
  acls: AclRow[];
  access: AccessSubject;
  includeComments: boolean;
  /** Reading the incremental cursor: a sync client, which acts on what it's sent. */
  syncing: boolean;
}

/**
 * A revocation, as this reader should get it, or null.
 *
 * Withheld from anyone it isn't news to (see lostAccessTo). A sync client deletes
 * the whole subtree it's told about, so one who can still read something inside
 * gets told to re-sync instead, which removes exactly what's now out of reach and
 * leaves the rest and its unsynced edits alone. `origin` is the event's own path,
 * before any narrowing to a key's folder.
 */
function revocationFor<T extends { op: string; path: string; privateTo: string | null }>(
  event: T,
  origin: string,
  reader: FeedReader,
): T | null {
  const { acls, access, syncing } = reader;
  if (!lostAccessTo(acls, event.path, access, origin, event.privateTo)) return null;
  return syncing && readsInside(acls, event.path, access)
    ? { ...event, op: "access_granted" }
    : event;
}

/**
 * `event` as this reader may see it, or null if they may not.
 *
 * Nothing outside a key's folder reaches it, not even a revocation, which would
 * name a node it was never able to see. Comment traffic is opt-in, and excluded
 * here rather than in SQL on the cursor path so excluded rows still count as
 * scanned. `access_granted` skips the person who changed it: they already have the
 * files, and it would read to their CLI as a stale delete. `access_claimed` is an
 * audit entry for the people who run the workspace, on the activity path only: a
 * sync client would read an op it doesn't know as a deletion.
 */
export function eventForReader(event: ChangeEvent, reader: FeedReader): ChangeEvent | null {
  const { acls, access, includeComments, syncing } = reader;
  const path = pathInKeyReach(access, event);
  if (path === null) return null;
  if (!includeComments && isCommentOp(event.op)) return null;
  const scoped = { ...event, path };
  if (event.op === "access_revoked") return revocationFor(scoped, event.path, reader);
  if (event.op === "access_claimed") {
    return !syncing && canManageMembers(access.role) ? scoped : null;
  }
  const notOwnGrant = event.op !== "access_granted" || event.actorId !== access.userId;
  return notOwnGrant && canRead(acls, path, access) ? scoped : null;
}

/**
 * One change event as the feed sends it to `access`.
 *
 * - `seq` is a number: BigInt isn't JSON-serializable, and it stays well below
 *   2^53.
 * - A move's other end (`relatedPath`) is withheld when the reader can't see
 *   it, so a file moved into someone's private folder never names its new home
 *   on the delete event it leaves behind.
 * - `privateTo` is the server's own bookkeeping and isn't sent.
 */
export function feedEvent(event: ChangeEvent, acls: AclRow[], access: AccessSubject) {
  const { privateTo: _privateTo, ...rest } = event;
  const related = rest.relatedPath;
  return {
    ...rest,
    relatedPath: related && canRead(acls, related, access) ? related : null,
    seq: Number(rest.seq),
  };
}