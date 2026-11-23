import { type Prisma, usePrismaClient } from "db";
import { ACCESS_OPS, type AccessOp } from "shared";
import type { Actor } from "./files";
import { normalizePath, PathError } from "./paths";

// ---------------------------------------------------------------------------
// The access engine. Every surface that reads or writes workspace content asks
// here (via canRead/canWrite/writeRefusal), so the rule lives in one place:
//
//   level(path, subject) = min(grants on the most specific restriction covering
//                              the path — open (write) when there is none,
//                              the subject's role cap,
//                              the scope of the API key they came in on)
//
// Owns the inheritance walk and the sibling-prefix-safe subtree check. The
// evaluators are pure (they take restriction rows, not a request) so the access
// logic is unit-testable in isolation, mirroring shares.ts. Fail closed: any
// ambiguity, bad path, unknown role, or missing subject denies rather than
// defaulting to allow.
// ---------------------------------------------------------------------------

export type AclKind = "file" | "folder";

/** How far a subject may reach a path. Ordered: none < read < write. */
export type AccessLevel = "none" | "read" | "write";

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };
const minLevel = (a: AccessLevel, b: AccessLevel): AccessLevel => (RANK[a] <= RANK[b] ? a : b);
const asLevel = (raw: string): AccessLevel => (raw === "read" || raw === "write" ? raw : "none"); // unknown → none (fail closed)

/**
 * A member's role in a workspace (on its hidden organization). `viewer` reads
 * whatever the grants let them see and writes nothing. Owners and admins manage
 * people; they get NO bypass of a restricted node's grants.
 */
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * better-auth stores a member's roles as a comma-separated list ("admin,member").
 * The highest known role wins. A string with no known role resolves to `viewer`,
 * so an unexpected value can only ever narrow access.
 */
export function parseRole(raw: string | null | undefined): WorkspaceRole {
  let best: WorkspaceRole | null = null;
  for (const part of (raw ?? "").split(",")) {
    const r = part.trim() as WorkspaceRole;
    if (!Object.hasOwn(ROLE_RANK, r)) continue;
    if (!best || ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  }
  return best ?? "viewer";
}

/** Can this role manage people (remove members, change roles)? */
export const canManageMembers = (role: WorkspaceRole): boolean =>
  role === "owner" || role === "admin";

/**
 * Why `caller` can't give someone a new role, or null when they can. Owners and
 * admins move people between member and viewer; only an owner changes an admin,
 * so an admin can't demote a peer. Nobody changes an owner's role, or their own.
 */
export function roleChangeRefusal(
  caller: WorkspaceRole,
  target: WorkspaceRole,
  self: boolean,
): "not_a_manager" | "own_role" | "owner_role" | "peer_admin" | null {
  if (!canManageMembers(caller)) return "not_a_manager";
  if (self) return "own_role";
  if (target === "owner") return "owner_role";
  return target === "admin" && caller !== "owner" ? "peer_admin" : null;
}

/**
 * What an API key is limited to. Stored on the key, fixed at creation, and only
 * ever a cap: `read` makes it read-only, `folder` confines it to one subtree.
 * null `folder` is the whole workspace. A key with no scope is limited only by
 * its owner's access.
 */
export interface KeyScope {
  access: "read" | "write";
  folder: string | null;
}

/**
 * Who is asking. `userId` is the person (for an API key, the key's owner — a
 * key is always evaluated as its creator, so it can never exceed them), `role`
 * their CURRENT role in the workspace, `keyScope` the key's own limits. Built per
 * request by authorizeWorkspace, so demoting a member narrows them and their keys
 * on the very next call.
 */
export interface AccessSubject {
  userId: string;
  role: WorkspaceRole;
  keyScope?: KeyScope | null;
}

/**
 * The scope in a key's metadata: null when it has none (limited only by its
 * owner), "invalid" when it has one that can't be read. Never reads a damaged
 * scope as no scope, which would turn a limited key into a full one.
 */
export function parseKeyScope(raw: unknown): KeyScope | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  const { access, folder } = raw as { access?: unknown; folder?: unknown };
  if (access !== "read" && access !== "write") return "invalid";
  if (folder === undefined || folder === null) return { access, folder: null };
  if (typeof folder !== "string" || !folder) return "invalid";
  const normalized = tryNormalize(folder);
  return normalized === folder ? { access, folder } : "invalid";
}

/**
 * A subject, or `"trusted"` for internal callers (share serving, seeding) that
 * must bypass member access. Explicit rather than `undefined`, so forgetting to
 * pass a subject is a type error, never a silent bypass.
 */
export type Viewer = AccessSubject | "trusted";

/** One grant on a restriction. `user` names a member; `everyone` covers the rest. */
export interface GrantRow {
  subject: string; // user | everyone
  userId: string | null;
  level: string; // none | read | write
}

/**
 * A restriction on a file or folder, with its grants — a stored NodeAcl row, or
 * a test fixture. A restriction with no grants admits nobody.
 */
export interface AclRow {
  path: string;
  kind: string;
  grants: GrantRow[];
}

// Covers without normalizing `normalized` again (callers normalize once).
function coversNormalized(acl: Pick<AclRow, "path" | "kind">, normalized: string): boolean {
  if (acl.kind === "file") return normalized === acl.path;
  return normalized === acl.path || normalized.startsWith(`${acl.path}/`);
}

function tryNormalize(path: string): string | null {
  try {
    return normalizePath(path);
  } catch (err) {
    if (err instanceof PathError) return null;
    throw err;
  }
}

/**
 * Does `acl` govern `requestedPath`? A file ACL admits only its exact path; a
 * folder ACL admits the folder itself or anything under `<path>/` (the trailing
 * slash blocks a `dir` ACL from matching the sibling `dir2/secret`). Traversal
 * is rejected. Never throws — returns false on bad input, the same posture as
 * isWithinShare in shares.ts.
 */
export function aclCovers(acl: Pick<AclRow, "path" | "kind">, requestedPath: string): boolean {
  const normalized = tryNormalize(requestedPath);
  return normalized !== null && coversNormalized(acl, normalized);
}

/**
 * The restriction governing `path`, or null when none does (→ open to every
 * member). The most specific match wins — the longest covering path — so a
 * restriction on a descendant replaces, rather than adds to, an ancestor's.
 */
export function effectiveAcl<T extends Pick<AclRow, "path" | "kind">>(
  acls: T[],
  path: string,
): T | null {
  const normalized = tryNormalize(path);
  if (normalized === null) return null;
  let best: T | null = null;
  for (const acl of acls) {
    if (!coversNormalized(acl, normalized)) continue;
    if (!best || acl.path.length > best.path.length) best = acl;
  }
  return best;
}

/**
 * A member's level on one restriction: their own grant, else the everyone
 * grant, else none. A user grant beats the everyone grant, so "everyone: read,
 * Bob: none" keeps Bob out.
 */
export function grantLevel(acl: Pick<AclRow, "grants">, userId: string): AccessLevel {
  let everyone: AccessLevel = "none";
  for (const g of acl.grants) {
    if (g.subject === "user" && g.userId === userId) return asLevel(g.level);
    if (g.subject === "everyone") everyone = asLevel(g.level);
  }
  return everyone;
}

/** The ceiling a role puts on every path: viewers read, everyone else may write. */
export const roleCap = (role: WorkspaceRole): AccessLevel => (role === "viewer" ? "read" : "write");

const inKeyFolder = (folder: string | null, normalized: string): boolean =>
  folder === null || normalized === folder || normalized.startsWith(`${folder}/`);

/** The ceiling a key puts on a path: outside its folder, nothing; else its access. */
function keyCap(scope: KeyScope | null | undefined, normalized: string): AccessLevel {
  if (!scope) return "write";
  return inKeyFolder(scope.folder, normalized) ? scope.access : "none";
}

/**
 * The folder a key is confined to, when `path` is outside it, else null. Asked
 * before anything else about a path: the answer depends only on the key, which
 * its holder already knows, so it says nothing about whether the path exists.
 */
export function outsideKeyFolder(subject: Viewer | null | undefined, path: string): string | null {
  if (!subject || subject === "trusted") return null;
  const folder = subject.keyScope?.folder ?? null;
  if (folder === null) return null;
  const normalized = tryNormalize(path);
  return normalized !== null && inKeyFolder(folder, normalized) ? null : folder;
}

/**
 * The path a change-feed event has for `subject`, or null if it shouldn't be told
 * about it. Everything is in reach unless a key is confined to a folder. Then
 * only the folder's own events are, plus access changes ABOVE it: privacy set on
 * `clients` takes `clients/acme` with it, and a key on that folder has to hear so.
 * Those are narrowed to the folder, which is all it may know about, and all a
 * sync client should remove.
 */
export function pathInKeyReach(
  subject: AccessSubject,
  event: { path: string; op: string },
): string | null {
  const folder = outsideKeyFolder(subject, event.path);
  if (folder === null) return event.path;
  const accessChange = (ACCESS_OPS as readonly string[]).includes(event.op);
  return accessChange && folder.startsWith(`${event.path}/`) ? folder : null;
}

/**
 * The single access decision: min(the grants' level for the person, their
 * role's cap, their key's cap). Open by default (no restriction → write). Fail
 * closed: a path that won't normalize, or a missing subject, is `none`.
 * "trusted" (an internal caller) is `write` on any path that normalizes.
 */
export function accessLevel(
  acls: AclRow[],
  path: string,
  subject: Viewer | null | undefined,
): AccessLevel {
  if (subject === "trusted") return tryNormalize(path) === null ? "none" : "write";
  if (!subject?.userId) return "none";
  const normalized = tryNormalize(path);
  if (normalized === null) return "none";
  const acl = effectiveAcl(acls, normalized);
  const node = acl ? grantLevel(acl, subject.userId) : "write";
  return minLevel(minLevel(node, roleCap(subject.role)), keyCap(subject.keyScope, normalized));
}

export function canRead(acls: AclRow[], path: string, subject: Viewer | null | undefined): boolean {
  return accessLevel(acls, path, subject) !== "none";
}

export function canWrite(
  acls: AclRow[],
  path: string,
  subject: Viewer | null | undefined,
): boolean {
  return accessLevel(acls, path, subject) === "write";
}

/**
 * A change the subject may see but not make. Distinct from a version conflict
 * (412) and from not-found (a hidden path): routes answer 409 with this as the
 * body, never 403 — fielded sync clients read any 403 as "signed out".
 */
export type WriteDenial =
  | { error: "read_only"; reason: "role" | "grant" | "key" }
  | { error: "outside_key_folder"; folder: string };

/** Would `subject` still be able to write `path` with its own restriction gone? */
export function liftKeepsWrite(acls: AclRow[], path: string, subject: Viewer): boolean {
  const normalized = tryNormalize(path);
  return canWrite(
    acls.filter((a) => a.path !== normalized),
    path,
    subject,
  );
}

/**
 * Would putting a file back at `path` leave it restricted to different people
 * than `grants` (encoded)? What applies there is a file restriction travelling with
 * it from `from`, else whatever covers `path`. Recovery can't reconcile the two:
 * replacing it would let people back in and shut others out as a side effect of a
 * restore, and keeping it would show old content to people who weren't on it then.
 */
export function restrictionDiffers(
  acls: AclRow[],
  path: string,
  grants: string | null | undefined,
  from = path,
): boolean {
  const carried = acls.find((a) => a.path === from && a.kind === "file");
  const applies = carried ?? effectiveAcl(acls, path);
  return !!applies && !!grants && encodeGrants(applies) !== grants;
}

/**
 * Who a restriction on `path` is news to. The answer can't be every member who
 * can't read it now: a restriction inside a folder they never saw would name that
 * hidden child. So it's whoever could read it before: put back the grants `before`
 * this change (see restrictionBefore), or take the restriction away when it had
 * none, or when the event predates recording them. `restrictionAt` is where it
 * sits, when that's above `path`, as it is for a key confined to a folder inside it.
 */
export function lostAccessTo(
  acls: AclRow[],
  path: string,
  subject: AccessSubject,
  restrictionAt = path,
  before: string | null = null,
): boolean {
  if (!effectiveAcl(acls, path) || canRead(acls, path, subject)) return false;
  const others = acls.filter((a) => a.path !== restrictionAt);
  // Its row may be gone, if this was a lift. `path` is at or under restrictionAt, so
  // a folder covers it whichever kind this was.
  const was = { path: restrictionAt, kind: "folder" };
  return canRead(
    before ? [...others, { ...was, grants: decodeGrants(before) }] : others,
    path,
    subject,
  );
}

/** Can `subject` still read something inside `path`, through a restriction of its own? */
export function readsInside(acls: AclRow[], path: string, subject: AccessSubject): boolean {
  return acls.some((a) => a.path.startsWith(`${path}/`) && canRead(acls, a.path, subject));
}

/**
 * Why a write would be refused, or null when it is allowed.
 *  - "hidden": the subject can't read the path. Surfaces as not-found, so a
 *    restricted node's existence is never disclosed.
 *  - a denial otherwise. Most fundamental reason first: a viewer is told about
 *    their role even on a read-only key, since a new key wouldn't help them.
 *
 * Outside a key's folder comes first of all. It depends only on the key, so
 * answering it can't reveal that a restricted node exists.
 */
export function writeRefusal(
  acls: AclRow[],
  path: string,
  subject: Viewer | null | undefined,
): WriteDenial | "hidden" | null {
  const folder = outsideKeyFolder(subject, path);
  if (folder !== null) return { error: "outside_key_folder", folder };
  const level = accessLevel(acls, path, subject);
  if (level === "write") return null;
  if (level === "none" || !subject || subject === "trusted") return "hidden";
  if (subject.role === "viewer") return { error: "read_only", reason: "role" };
  const acl = effectiveAcl(acls, path);
  const reason = acl && grantLevel(acl, subject.userId) !== "write" ? "grant" : "key";
  return { error: "read_only", reason };
}

/** Why `subject` can change nothing in this workspace, or null if it can change something. */
export function anyWriteRefusal(subject: AccessSubject): WriteDenial | null {
  if (subject.role === "viewer") return { error: "read_only", reason: "role" };
  return subject.keyScope?.access === "read" ? { error: "read_only", reason: "key" } : null;
}

/**
 * Why `subject` can't change the workspace itself (its name, its appearance), or
 * null. A key confined to a folder can't: those aren't in its folder.
 */
export function workspaceWriteRefusal(subject: AccessSubject): WriteDenial | null {
  const folder = subject.keyScope?.folder ?? null;
  if (folder !== null) return { error: "outside_key_folder", folder };
  return anyWriteRefusal(subject);
}

/**
 * A restriction's grants as one string, for the change feed's `privateTo` and for
 * recovery, which have to remember who a node was limited to after the
 * restriction itself has moved on. "" is unrestricted. The one-person shape stays
 * a bare user id, which is what older events hold. Anything else is JSON, and a
 * restriction with no grants is "[]": it admits nobody, so it must not read as "".
 */
export function encodeGrants(acl: Pick<AclRow, "grants"> | null | undefined): string {
  if (!acl) return "";
  const [only, ...rest] = acl.grants;
  if (only && rest.length === 0 && only.subject === "user" && only.level === "write") {
    return only.userId ?? "";
  }
  const key = (g: GrantRow) => `${g.subject}:${g.userId}`;
  return JSON.stringify([...acl.grants].sort((a, b) => key(a).localeCompare(key(b))));
}

/** The grants `encodeGrants` wrote. Unreadable means nobody: it fails closed. */
export function decodeGrants(encoded: string): GrantRow[] {
  if (!encoded.startsWith("[")) {
    return encoded ? [{ subject: "user", userId: encoded, level: "write" }] : [];
  }
  try {
    const grants = JSON.parse(encoded) as unknown;
    return Array.isArray(grants) ? (grants as GrantRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * The restrictions `subject` may know about, with who's on them and how far
 * `subject` itself reaches: only those it can read, so a list of grantees is never
 * how someone learns a node exists.
 */
export function restrictionsFor(acls: AclRow[], subject: AccessSubject) {
  return acls
    .filter((a) => canRead(acls, a.path, subject))
    .map((a) => ({
      path: a.path,
      kind: a.kind,
      level: accessLevel(acls, a.path, subject),
      grants: a.grants,
    }));
}

/** Is this restriction exactly "private to `userId`" — only them, at write? */
export function isPrivateTo(acl: Pick<AclRow, "grants">, userId: string): boolean {
  return (
    acl.grants.length === 1 &&
    acl.grants[0]!.subject === "user" &&
    acl.grants[0]!.userId === userId &&
    acl.grants[0]!.level === "write"
  );
}

/** The columns the evaluators need, for reading restrictions inside a transaction. */
export const ACL_SELECT = {
  path: true,
  kind: true,
  grants: { select: { subject: true, userId: true, level: true } },
} as const;

/** All ACL rows for a workspace — the input to the pure evaluators above. */
export async function listWorkspaceAcls(workspaceId: string): Promise<AclRow[]> {
  const db = usePrismaClient();
  return db.nodeAcl.findMany({ where: { workspaceId }, select: ACL_SELECT });
}

/**
 * Is `path` limited to people other than just `userId`, by its own restriction or
 * a folder's? The Private toggle is about the caller alone, so here it would
 * quietly drop them, or open it to everyone.
 */
export async function isSharedBeyond(
  workspaceId: string,
  path: string,
  userId: string,
): Promise<boolean> {
  const acl = effectiveAcl(await listWorkspaceAcls(workspaceId), path);
  return acl !== null && !isPrivateTo(acl, userId);
}

/** The explicit ACL row on exactly `path` (not an ancestor), or null. */
export async function getNodeAcl(workspaceId: string, path: string): Promise<AclRow | null> {
  const db = usePrismaClient();
  return db.nodeAcl.findUnique({
    where: { workspaceId_path: { workspaceId, path: normalizePath(path) } },
    select: ACL_SELECT,
  });
}

type Tx = Prisma.TransactionClient;

async function recordAccessEvent(
  tx: Tx,
  workspaceId: string,
  path: string,
  op: AccessOp,
  actor: Actor,
  before?: string,
): Promise<void> {
  await tx.changeEvent.create({
    data: {
      workspaceId,
      path,
      op,
      privateTo: before,
      principal: actor.principal,
      actorId: actor.actorId,
      actorKeyId: actor.actorKeyId,
      actorLabel: actor.actorLabel,
      operationId: actor.operationId,
    },
  });
}

/**
 * Record that `path` is now limited to `grants`. Who loses and who gains sight of
 * it differ per member, so both signals are recorded and the change feed gives each
 * client the one that applies. `access_granted` comes last and carries the new
 * grants: recovery replays these in order, and that's who it was limited to from
 * here on.
 */
export async function recordAccessChange(
  tx: Tx,
  args: { workspaceId: string; path: string; actor: Actor; before: string; grants: GrantRow[] },
): Promise<void> {
  const { workspaceId, path, actor, before, grants } = args;
  await recordAccessEvent(tx, workspaceId, path, "access_revoked", actor, before);
  await recordAccessEvent(tx, workspaceId, path, "access_granted", actor, encodeGrants({ grants }));
}

/**
 * Who could reach `path` before a change, for its `access_revoked` event: the only
 * way to tell a former grantee from someone who never had it, once the grants have
 * moved on. The effective restriction, so a folder above it counts, whatever that
 * folder goes on to allow. Recovery reads `privateTo` on file events only, so this
 * can't touch it.
 */
async function restrictionBefore(tx: Tx, workspaceId: string, path: string): Promise<string> {
  const acls = await tx.nodeAcl.findMany({ where: { workspaceId }, select: ACL_SELECT });
  return encodeGrants(effectiveAcl(acls, path));
}

/**
 * Replace the restriction on `path` with exactly `grants` (creating it if
 * needed), inside `tx`. The one place restriction rows are written, so private
 * and per-member sharing can't drift.
 */
async function putRestriction(
  tx: Tx,
  args: { workspaceId: string; path: string; kind: AclKind; grants: GrantRow[] },
): Promise<void> {
  const acl = await tx.nodeAcl.upsert({
    where: { workspaceId_path: { workspaceId: args.workspaceId, path: args.path } },
    create: { workspaceId: args.workspaceId, path: args.path, kind: args.kind },
    // ownerId is deprecated; null it so a rolled-back instance can't keep
    // honouring a stale single owner once the grants have moved on.
    update: { kind: args.kind, ownerId: null },
    select: { id: true },
  });
  await tx.nodeGrant.deleteMany({ where: { aclId: acl.id } });
  if (args.grants.length > 0) {
    await tx.nodeGrant.createMany({
      data: args.grants.map((g) => ({
        aclId: acl.id,
        workspaceId: args.workspaceId,
        subject: g.subject,
        userId: g.subject === "user" ? g.userId : null,
        level: g.level,
      })),
    });
  }
}

/**
 * Add a brand-new restriction, inside `tx`, and return it. Unlike
 * putRestriction this never replaces one: a restriction already on `path` is a
 * unique violation, for callers that must not write over someone else's privacy.
 */
export async function createRestriction(
  tx: Tx,
  args: { workspaceId: string; path: string; kind: AclKind; grants: GrantRow[] },
): Promise<AclRow> {
  const { workspaceId, path, kind, grants } = args;
  const acl = await tx.nodeAcl.create({
    data: { workspaceId, path, kind },
    select: { id: true },
  });
  await tx.nodeGrant.createMany({
    data: grants.map((g) => ({ aclId: acl.id, workspaceId, ...g })),
  });
  return { path, kind, grants };
}

/**
 * Set exactly who may reach a node.
 */
export async function setNodeAccess(args: {
  workspaceId: string;
  path: string;
  kind: AclKind;
  grants: GrantRow[];
  actor: Actor;
}): Promise<void> {
  const { workspaceId, actor, grants, kind } = args;
  const path = normalizePath(args.path);
  await usePrismaClient().$transaction(async (tx) => {
    const before = await restrictionBefore(tx, workspaceId, path);
    await putRestriction(tx, { workspaceId, path, kind, grants });
    await recordAccessChange(tx, { workspaceId, path, actor, before, grants });
  });
}

/**
 * Restrictions no current member can reach: every grantee has left, and anyone
 * still here is excluded or has nothing to go on. Only those still holding files,
 * since one left behind on a deleted file hides nothing. Pure over the rows, so the
 * rule is testable.
 */
export function orphanedRestrictions<T extends AclRow>(acls: T[], memberIds: Set<string>): T[] {
  const members = [...memberIds];
  return acls.filter((a) => members.every((id) => grantLevel(a, id) === "none"));
}

/** A workspace's orphaned restrictions that still hold files. By name only. */
export async function listOrphans(workspaceId: string, memberIds: Set<string>) {
  const db = usePrismaClient();
  const acls = await listWorkspaceAcls(workspaceId);
  const orphans: { path: string; kind: string }[] = [];
  for (const { path, kind } of orphanedRestrictions(acls, memberIds)) {
    const held = await db.fileNode.count({
      where: { workspaceId, OR: [{ path }, { path: { startsWith: `${path}/` } }] },
    });
    if (held > 0) orphans.push({ path, kind });
  }
  return orphans;
}

/**
 * Take over an orphaned restriction: `actor` becomes its only editor, in one
 * transaction with the audit entry, so a claim can't happen unrecorded. Returns
 * false if it's gone or no longer orphaned, so a grantee who rejoined keeps it.
 */
export async function claimOrphan(args: {
  workspaceId: string;
  organizationId: string;
  path: string;
  userId: string;
  actor: Actor;
}): Promise<boolean> {
  const { workspaceId, organizationId, userId, actor } = args;
  const path = normalizePath(args.path);
  return usePrismaClient().$transaction(async (tx) => {
    const acl = await tx.nodeAcl.findUnique({
      where: { workspaceId_path: { workspaceId, path } },
      select: ACL_SELECT,
    });
    if (!acl) return false;
    // Inside the transaction, right before the change: someone who has just
    // rejoined keeps what's theirs.
    const members = await tx.member.findMany({
      where: { organizationId },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    if (orphanedRestrictions([acl], memberIds).length === 0) return false;
    await putRestriction(tx, {
      workspaceId,
      path,
      kind: acl.kind as AclKind,
      grants: [{ subject: "user", userId, level: "write" }],
    });
    await recordAccessEvent(tx, workspaceId, path, "access_claimed", actor);
    return true;
  });
}

/**
 * Mark a node private to `ownerId`: a restriction whose only grant is them at
 * write (idempotent). When `actor` is supplied, also record an `access_revoked`
 * change event on the path: members who lose visibility read it from the change
 * feed (see changes.get.ts) and their CLI removes the local copy safely, rather
 * than the next full sync mistaking the now-hidden node for a deletion.
 */
export async function setNodePrivate(args: {
  workspaceId: string;
  path: string;
  kind: AclKind;
  ownerId: string;
  actor?: Actor;
}): Promise<void> {
  const db = usePrismaClient();
  const path = normalizePath(args.path);
  const actor = args.actor;
  // One transaction so a member never ends up private with no revocation signal
  // on the feed (or vice versa) — the two must commit together.
  await db.$transaction(async (tx) => {
    const before = await restrictionBefore(tx, args.workspaceId, path);
    await putRestriction(tx, {
      workspaceId: args.workspaceId,
      path,
      kind: args.kind,
      grants: [{ subject: "user", userId: args.ownerId, level: "write" }],
    });
    if (actor) await recordAccessEvent(tx, args.workspaceId, path, "access_revoked", actor, before);
  });
}

/**
 * Lift the restriction on `path` (unmark private). Returns true if one was
 * removed (its grants go with it). When `actor` is supplied and a restriction
 * was actually cleared, records both signals in the same transaction: members who
 * just regained access read `access_granted` from the change feed (see
 * changes.get.ts) and their CLI pulls the now-visible subtree, instead of waiting
 * for the next periodic full reconcile. Lifting one inside a restricted folder
 * also takes it from anyone it had let in, and they read `access_revoked`. Revoked
 * first: recovery replays these in order, and the last one says it's open here.
 */
export async function clearNodePrivate(
  workspaceId: string,
  path: string,
  actor?: Actor,
): Promise<boolean> {
  const db = usePrismaClient();
  const normalized = normalizePath(path);
  return db.$transaction(async (tx) => {
    const before = await restrictionBefore(tx, workspaceId, normalized);
    const res = await tx.nodeAcl.deleteMany({ where: { workspaceId, path: normalized } });
    if (res.count === 0) return false;
    if (actor) {
      await recordAccessEvent(tx, workspaceId, normalized, "access_revoked", actor, before);
      await recordAccessEvent(tx, workspaceId, normalized, "access_granted", actor);
    }
    return true;
  });
}

/**
 * Move the restriction on exactly `from` (if any) to `to`, grants included,
 * replacing whatever restriction `to` had. Re-pathing the row keeps its grants
 * attached by id, so nothing is copied and nothing can be dropped in between.
 */
export async function rePathRestriction(
  tx: Tx,
  workspaceId: string,
  from: string,
  to: string,
): Promise<void> {
  const acl = await tx.nodeAcl.findUnique({
    where: { workspaceId_path: { workspaceId, path: from } },
    select: { id: true },
  });
  if (!acl) return;
  await tx.nodeAcl.deleteMany({ where: { workspaceId, path: to } });
  await tx.nodeAcl.update({ where: { id: acl.id }, data: { path: to } });
}

/**
 * Give `copyPath` the same restriction as the file restriction on exactly
 * `path`, inside `tx`. A conflicted copy of a restricted FILE lands at a sibling
 * path the file-level restriction wouldn't cover, so without this it would
 * leak. Folder restrictions already cover the copy (same subtree). Create-only:
 * a restriction left at `copyPath` by a deleted file is a name collision, and
 * the caller moves on to the next name rather than rewrite someone's privacy.
 */
export async function copyFileRestriction(
  tx: Tx,
  workspaceId: string,
  acl: AclRow,
  copyPath: string,
): Promise<void> {
  await createRestriction(tx, { workspaceId, path: copyPath, kind: "file", grants: acl.grants });
}

/**
 * Re-path explicit folder ACLs when a folder is moved or renamed. The UI
 * decomposes a folder move into per-file content moves; FileService.move carries
 * a file's own ACL along, but a folder's ACL row sits on a virtual folder path
 * that no file move ever touches. Without this it orphans at the old path and the
 * moved subtree silently inherits all-members access (a privacy leak). Re-paths
 * every folder-kind ACL on `from` or under `from/` to the new prefix, plus all
 * node_meta (icons/order) under the prefix, in one transaction.
 */
export async function moveFolderMetadata(
  workspaceId: string,
  fromRaw: string,
  toRaw: string,
): Promise<void> {
  const db = usePrismaClient();
  const from = normalizePath(fromRaw);
  const to = normalizePath(toRaw);
  if (from === to) return;
  const underPrefix = { OR: [{ path: from }, { path: { startsWith: `${from}/` } }] };
  const rePath = (p: string) => (p === from ? to : `${to}${p.slice(from.length)}`);
  await db.$transaction(async (tx) => {
    // Folder-kind ACLs only — file-kind ACLs ride along with their file in
    // FileService.move, so re-pathing them here would double-handle.
    const acls = await tx.nodeAcl.findMany({
      where: { workspaceId, kind: "folder", ...underPrefix },
      select: { path: true },
    });
    for (const acl of acls) await rePathRestriction(tx, workspaceId, acl.path, rePath(acl.path));
    const metas = await tx.nodeMeta.findMany({ where: { workspaceId, ...underPrefix } });
    for (const meta of metas) {
      await tx.nodeMeta.delete({ where: { workspaceId_path: { workspaceId, path: meta.path } } });
      await tx.nodeMeta.upsert({
        where: { workspaceId_path: { workspaceId, path: rePath(meta.path) } },
        create: { workspaceId, path: rePath(meta.path), icon: meta.icon, order: meta.order },
        update: { icon: meta.icon, order: meta.order },
      });
    }
  });
}