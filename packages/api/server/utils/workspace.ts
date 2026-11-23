import { randomUUID } from "node:crypto";
import { usePrismaClient } from "db";
import {
  createError,
  defineEventHandler,
  getQuery,
  getRequestHeaders,
  getRouterParam,
  type H3Event,
} from "h3";
import {
  type AccessSubject,
  anyWriteRefusal,
  canRead,
  type KeyScope,
  liftKeepsWrite,
  listWorkspaceAcls,
  outsideKeyFolder,
  parseKeyScope,
  parseRole,
  workspaceWriteRefusal,
  writeRefusal,
} from "./acl";
import { auth } from "./auth";
import { type Actor, normalizePath, PathError, type Principal, type WriteDenial } from "./files";
import { assertCanCreateWorkspace } from "./limits";
import { billingEnabled } from "./plans";
import { seedWorkspace } from "./seed";

/**
 * Build a web `Headers` object from the event WITHOUT calling `toWebRequest`.
 * `toWebRequest` binds (and effectively locks) the request body stream, so any
 * later `readRawBody`/`readBody` on a PUT/POST hangs. Reading headers directly
 * leaves the body untouched. Use this anywhere better-auth needs `headers`.
 */
export function webHeaders(event: H3Event): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(getRequestHeaders(event))) {
    if (typeof value === "string") headers.set(key, value);
  }
  return headers;
}

// Request principal resolved from the credential (not the route). API-key
// requests carry their workspace scope + actorType in key metadata; cookie
// sessions are humans browsing the web app.
export interface RequestPrincipal {
  userId: string;
  principal: Principal;
  /** Set only for API-key auth — the key is locked to this workspace. */
  keyWorkspaceId?: string;
  /** Set only for API-key auth — the acting key's id and display label, snapshot
   * onto the change feed for attribution. Present for ANY key (human CLI keys
   * included), so they never imply agent-vs-human. */
  keyId?: string;
  keyName?: string | null;
  /** Set only for a key with limits of its own: see KeyScope. */
  keyScope?: KeyScope | null;
}

function parseMetadata(meta: unknown): Record<string, unknown> {
  if (!meta) return {};
  if (typeof meta === "string") {
    try {
      return JSON.parse(meta) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return meta as Record<string, unknown>;
}

/**
 * Authenticate a request via the `x-api-key` header (agents/CLI) or the session
 * cookie (web app). Throws 401 on any failure — better-auth raises for a
 * present-but-invalid key, so both paths funnel to the same 401.
 */
export async function authenticate(event: H3Event): Promise<RequestPrincipal> {
  const headers = webHeaders(event);
  const apiKey = headers.get("x-api-key");

  if (apiKey) {
    try {
      const verified = await auth.api.verifyApiKey({ body: { key: apiKey } });
      if (!verified.valid || !verified.key) {
        // Carry the plugin's reason code through. better-auth NEVER throws from
        // verifyApiKey — a missing key, an expired key, a usage/rate cap and a
        // failed database call all come back as `valid: false`, so without the
        // code every one of them reaches the CLI as an indistinguishable bare
        // 401 and gets treated as a terminal "your key is revoked". The code is
        // about the credential the caller already holds, so echoing it discloses
        // nothing, and it turns a guessing game into a one-line diagnosis.
        const reason = verified.error?.code ?? "INVALID_API_KEY";
        console.warn(`api key rejected: ${reason}`);
        throw createError({
          statusCode: 401,
          statusMessage: "Unauthorized",
          data: { error: "invalid_api_key", reason },
        });
      }
      const metadata = parseMetadata(verified.key.metadata);
      const actorType = metadata.actorType === "agent" ? "agent" : "human";
      // A scope that can't be read must not fall back to no scope at all.
      const keyScope = parseKeyScope(metadata.scope);
      if (keyScope === "invalid") {
        throw createError({
          statusCode: 401,
          statusMessage: "Unauthorized",
          data: { error: "invalid_api_key", reason: "INVALID_KEY_SCOPE" },
        });
      }
      return {
        // The apikey table stores the owner as `referenceId` (defaults to the
        // creating user's id since we don't configure a custom `references`).
        userId: verified.key.referenceId,
        principal: actorType,
        keyWorkspaceId: typeof metadata.workspaceId === "string" ? metadata.workspaceId : undefined,
        keyId: verified.key.id,
        keyName: verified.key.name,
        keyScope,
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err;
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers });
  } catch {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
  if (!session) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });

  return { userId: session.user.id, principal: "human" };
}

/**
 * Build the change-feed `Actor` from an authenticated principal. The key id +
 * label are carried through so the timeline can name the acting agent; they are
 * undefined for cookie sessions. The agent-vs-human distinction lives in
 * `principal`, never in the presence of the key fields.
 */
/** An actor checked against a real member's access (never "trusted"). */
export type MemberActor = Actor & { access: AccessSubject };

export function actorFor(ctx: RequestPrincipal, access: AccessSubject): MemberActor {
  return {
    principal: ctx.principal,
    actorId: ctx.userId,
    actorKeyId: ctx.keyId,
    actorLabel: ctx.keyName ?? undefined,
    access,
  };
}

/**
 * Authorize access to a specific workspace: the API key (if any) must be scoped
 * to this exact workspace, and the user must be a member of the workspace's org.
 * Returns the workspace with `access` — the subject every content check in this
 * request is evaluated against (the member's CURRENT role, read fresh, so a
 * demotion applies to the next request) — or throws 403/404.
 */
export async function authorizeWorkspace(ctx: RequestPrincipal, workspaceId: string) {
  const db = usePrismaClient();
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw createError({ statusCode: 404, statusMessage: "Workspace not found" });

  if (ctx.keyWorkspaceId && ctx.keyWorkspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: "Key is not scoped to this workspace" });
  }

  const member = await db.member.findFirst({
    where: { organizationId: ws.organizationId, userId: ctx.userId },
  });
  if (!member) throw createError({ statusCode: 403, statusMessage: "Not a workspace member" });

  const access: AccessSubject = {
    userId: ctx.userId,
    role: parseRole(member.role),
    keyScope: ctx.keyScope,
  };
  return Object.assign(ws, { access });
}

/**
 * Throw unless `access` may write every one of `paths`: 404 for a path it can't
 * see (a restricted node is never disclosed), 409 with the denial for one it can
 * see but not write. For routes that change node metadata rather than bytes
 * (folder moves, icons, order, privacy); byte writes are gated inside the file
 * service.
 */
export async function assertWritable(
  workspaceId: string,
  access: AccessSubject,
  ...paths: string[]
): Promise<void> {
  const acls = await listWorkspaceAcls(workspaceId);
  for (const path of paths) {
    const refusal = writeRefusal(acls, path, access);
    if (refusal === "hidden") throw createError({ statusCode: 404, statusMessage: "Not found" });
    if (refusal) throw readOnlyError(refusal);
  }
}

/**
 * Refuse to lift the restriction on `path` if that would lock the caller out: a
 * restriction above it takes over once this one is gone, and "open to everyone"
 * would otherwise report success while hiding the node from the person who did it.
 */
export async function assertLiftKeepsWrite(
  workspaceId: string,
  access: AccessSubject,
  path: string,
): Promise<void> {
  if (!liftKeepsWrite(await listWorkspaceAcls(workspaceId), path, access)) {
    throw createError({ statusCode: 409, statusMessage: "You'd lose access to this" });
  }
}

/** Throw 404 unless `access` may read `path`: a node it can't see stays undisclosed. */
export async function assertReadable(
  workspaceId: string,
  access: AccessSubject,
  path: string,
): Promise<void> {
  if (!canRead(await listWorkspaceAcls(workspaceId), path, access)) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
}

/**
 * Reject anyone who can change nothing here: a viewer, or a read-only key. For
 * changes checked somewhere else against a path, or that have none.
 */
export function requireWriter(access: AccessSubject): void {
  const denial = anyWriteRefusal(access);
  if (denial) throw readOnlyError(denial);
}

/** Reject anyone who can't change the workspace itself: see workspaceWriteRefusal. */
export function requireWorkspaceWriter(access: AccessSubject): void {
  const denial = workspaceWriteRefusal(access);
  if (denial) throw readOnlyError(denial);
}

/** Reject a path outside a key's folder, whether or not it exists: see outsideKeyFolder. */
export function assertInKeyFolder(access: AccessSubject, path: string): void {
  const folder = outsideKeyFolder(access, path);
  if (folder !== null) throw readOnlyError({ error: "outside_key_folder", folder });
}

const DENIAL_MESSAGES = {
  role: "You have view-only access to this workspace",
  grant: "You have view-only access to this item",
  key: "This API key is read-only",
} as const;

/**
 * The HTTP form of a change the caller can see but not make. 409, never 403:
 * fielded sync clients treat any 403 as "signed out" and stop syncing the whole
 * folder. Distinct from the 412 version conflict by its `error` code.
 */
export function readOnlyError(denial: WriteDenial) {
  const statusMessage =
    denial.error === "read_only"
      ? DENIAL_MESSAGES[denial.reason]
      : `Outside this key's folder (${denial.folder})`;
  return createError({ statusCode: 409, statusMessage, data: denial });
}

/**
 * The limits a key-minting request asks for, or undefined for none. Only ever
 * narrowing, so a bad value is a 400 rather than a key that does more than was
 * asked. A folder needs a workspace: paths mean nothing across workspaces.
 */
export function keyScopeFrom(
  body: { access?: unknown; folder?: unknown; workspaceId?: unknown } | null | undefined,
): KeyScope | undefined {
  const access = requestedKeyAccess(body?.access);
  const folder = requestedKeyFolder(body?.folder);
  if (folder && !body?.workspaceId) {
    throw createError({ statusCode: 400, statusMessage: "A folder needs a workspaceId" });
  }
  return folder || access === "read" ? { access, folder } : undefined;
}

function requestedKeyAccess(access: unknown = "write"): KeyScope["access"] {
  if (access === "read" || access === "write") return access;
  throw createError({ statusCode: 400, statusMessage: "access must be read or write" });
}

function requestedKeyFolder(folder: unknown): string | null {
  if (folder === undefined || folder === null || folder === "") return null;
  if (typeof folder !== "string") {
    throw createError({ statusCode: 400, statusMessage: "folder must be a path" });
  }
  try {
    return normalizePath(folder);
  } catch (err) {
    if (err instanceof PathError) {
      throw createError({ statusCode: 400, statusMessage: err.message });
    }
    throw err;
  }
}

/**
 * Mint a workspace-scoped API key for the authenticated cookie user. Validates
 * membership of the target workspace (via authorizeWorkspace) and stamps the
 * key's metadata with `{ workspaceId, actorType }` so it is locked to that one
 * workspace. The owner (referenceId) is derived from the session header by
 * better-auth, so the key belongs to the approving user. Shared by POST /api/keys
 * and the device-code approval endpoint.
 */
export async function mintWorkspaceKey(
  event: H3Event,
  ctx: RequestPrincipal,
  args: { name?: string; actorType: Principal; workspaceId: string; scope?: KeyScope },
): Promise<{ id: string; key: string; name: string | null }> {
  const ws = await authorizeWorkspace(ctx, args.workspaceId);
  // A folder the creator can't see stays not-found here too.
  if (args.scope?.folder) await assertReadable(ws.id, ws.access, args.scope.folder);
  const created = await auth.api.createApiKey({
    headers: webHeaders(event),
    body: {
      name: args.name ?? "treehouse-cli",
      metadata: {
        workspaceId: args.workspaceId,
        actorType: args.actorType,
        ...(args.scope ? { scope: args.scope } : {}),
      },
    },
  });
  return { id: created.id, key: created.key, name: created.name };
}

/**
 * Revoke every workspace-scoped API key a user holds for a given org's
 * workspaces. Called when a member is removed (or leaves): an ex-member's
 * folders must stop syncing — their daemon then lands in the CLI's `auth-lost`
 * state on the next poll. Keys are matched by `referenceId` (owner) + the
 * `workspaceId` stamped in their JSON metadata. Returns the number revoked.
 */
export async function revokeWorkspaceKeysForMember(
  userId: string,
  organizationId: string,
): Promise<number> {
  const db = usePrismaClient();
  const workspaces = await db.workspace.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const wsIds = new Set(workspaces.map((w) => w.id));
  if (wsIds.size === 0) return 0;

  // metadata is stored as a JSON string, so it can't be filtered in SQL — pull
  // the user's keys and match the stamped workspaceId in app code.
  const keys = await db.apikey.findMany({
    where: { referenceId: userId },
    select: { id: true, metadata: true },
  });
  const revokeIds = keys
    .filter((k) => {
      const ws = parseMetadata(k.metadata).workspaceId;
      return typeof ws === "string" && wsIds.has(ws);
    })
    .map((k) => k.id);
  if (revokeIds.length === 0) return 0;

  await db.apikey.deleteMany({ where: { id: { in: revokeIds } } });
  return revokeIds.length;
}

/** Authenticate + authorize the `[workspaceId]` route param in one step. */
export async function requireWorkspaceFromRoute(event: H3Event) {
  const ctx = await authenticate(event);
  const workspaceId = getRouterParam(event, "workspaceId");
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: "Missing workspaceId" });
  const ws = await authorizeWorkspace(ctx, workspaceId);
  return { ctx, ws, workspaceId, access: ws.access };
}

/** The `[workspaceId]` route for a comment thread: the actor plus its `threadId`. */
export async function requireThreadFromRoute(event: H3Event) {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const threadId = getRouterParam(event, "threadId");
  if (!threadId) throw createError({ statusCode: 400, statusMessage: "Missing threadId" });
  return { ws, threadId, actor: actorFor(ctx, access) };
}

/**
 * The `[workspaceId]` route for a cookie session only, for what a key has no
 * business doing: people management, and a human's own "seen" state.
 */
export async function requireCookieWorkspaceFromRoute(event: H3Event) {
  const ctx = await requireCookieUser(event);
  const workspaceId = getRouterParam(event, "workspaceId");
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: "Missing workspaceId" });
  return { ctx, ws: await authorizeWorkspace(ctx, workspaceId) };
}

/** A cookie-only route on one member: the workspace, plus the `[userId]` it names. */
export async function requireMemberFromRoute(event: H3Event) {
  const { ctx, ws } = await requireCookieWorkspaceFromRoute(event);
  const userId = getRouterParam(event, "userId");
  if (!userId) throw createError({ statusCode: 400, statusMessage: "Missing userId" });
  return { ctx, ws, userId };
}

/** The `{ path }` of a node-metadata request, validated. */
export function nodePathFrom(body: { path?: unknown } | null | undefined): string {
  const path = typeof body?.path === "string" ? body.path.trim() : "";
  if (!path) throw createError({ statusCode: 400, statusMessage: "path is required" });
  if (path.length > NODE_PATH_MAX) {
    throw createError({ statusCode: 400, statusMessage: "path too long" });
  }
  return path;
}

export const NODE_ICON_MAX = 64;
export const NODE_PATH_MAX = 1024;

/**
 * Set a file/folder's icon. Clearing the icon keeps the row if it still carries
 * other metadata (e.g. a custom order); otherwise the now-empty row is removed.
 */
export async function setNodeIcon(workspaceId: string, path: string, icon: string | null) {
  const db = usePrismaClient();
  if (icon) {
    await db.nodeMeta.upsert({
      where: { workspaceId_path: { workspaceId, path } },
      create: { workspaceId, path, icon },
      update: { icon },
    });
    return;
  }
  // Clearing the icon: drop the row if it carried nothing else, otherwise just
  // null the icon — a single write either way.
  const existing = await db.nodeMeta.findUnique({
    where: { workspaceId_path: { workspaceId, path } },
    select: { id: true, order: true },
  });
  if (!existing) return;
  if (existing.order === null) await db.nodeMeta.delete({ where: { id: existing.id } });
  else await db.nodeMeta.update({ where: { id: existing.id }, data: { icon: null } });
}

/**
 * Persist a custom sibling display order for one folder: each path gets its
 * index in the list. Shared across the workspace (humans + agents).
 */
export async function setNodeOrder(workspaceId: string, orderedPaths: string[]) {
  const db = usePrismaClient();
  await db.$transaction(
    orderedPaths.map((path, order) =>
      db.nodeMeta.upsert({
        where: { workspaceId_path: { workspaceId, path } },
        create: { workspaceId, path, order },
        update: { order },
      }),
    ),
  );
}

/** The user's last-seen change-feed seq for a workspace (null if never set). */
export async function getReadState(workspaceId: string, userId: string): Promise<bigint | null> {
  const row = await usePrismaClient().workspaceReadState.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  return row?.lastSeenSeq ?? null;
}

/**
 * Advance a user's last-seen seq for a workspace. Monotonic: a request that
 * would lower an existing watermark is a no-op (so a stale tab or a "mark all
 * seen" race can never un-see events). Returns the effective stored seq.
 */
export async function advanceReadState(
  workspaceId: string,
  userId: string,
  lastSeenSeq: bigint,
): Promise<bigint> {
  const db = usePrismaClient();
  // Atomic monotonic advance: one conditional UPDATE that only ever raises the
  // seq, so two concurrent writers can't let a lower value clobber a higher one.
  const raised = await db.workspaceReadState.updateMany({
    where: { userId, workspaceId, lastSeenSeq: { lt: lastSeenSeq } },
    data: { lastSeenSeq },
  });
  if (raised.count > 0) return lastSeenSeq; // the row was raised to the incoming value
  // Nothing raised: either no row exists yet, or the stored seq already meets or
  // exceeds the incoming one. upsert returns the created/existing row, so no
  // extra read is needed — create if missing; leave a higher value untouched.
  const row = await db.workspaceReadState.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    create: { userId, workspaceId, lastSeenSeq },
    update: {},
  });
  return row.lastSeenSeq;
}

/**
 * Every workspace the user can reach, oldest first. Access is membership of the
 * workspace's owning organization, so this is one relation-filtered query rather
 * than "the workspaces of whichever org the session happens to have active".
 * Each workspace now owns exactly one (hidden) organization — see
 * `createWorkspaceWithOrg` — so this is effectively "the user's workspaces".
 */
export async function workspacesForUser(userId: string) {
  return usePrismaClient().workspace.findMany({
    where: { organization: { members: { some: { userId } } } },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Create a workspace together with its own hidden organization ("shadow org")
 * and make `userId` its owner. Organizations are an implementation detail: they
 * exist only to carry a workspace's member list, roles, and better-auth's
 * removal hooks. Every creation site (REST, MCP, signup) funnels through here so
 * the 1:1 invariant cannot drift.
 */
export async function createWorkspaceWithOrg(args: {
  userId: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  /**
   * Creating this workspace on a paid plan. Skips the free-workspace allowance
   * (they are buying, not consuming it) and marks the workspace as awaiting
   * payment, so an abandoned checkout does not quietly hand out a free one.
   */
  intendsToPay?: boolean;
}) {
  const db = usePrismaClient();
  // Plan gate before anything is written. This helper is the single funnel for
  // REST, MCP and the signup hook, which is exactly why the cap lives here
  // rather than at one route: a workspace mints its own organization through
  // Prisma, so better-auth's org-creation hook never fires.
  await assertCanCreateWorkspace(args.userId, args.intendsToPay === true);
  const name = args.name.trim() || "Workspace";
  // One transaction for the three rows: a failure part-way must not strand an
  // orphan shadow org (or an owner membership pointing at nothing) — that would
  // break the 1:1 invariant every read path now assumes. Seeding stays OUTSIDE
  // the transaction: it writes file bytes to the blob store, which can't roll
  // back with the database — and an unseeded-but-consistent workspace is fine
  // (the setup card still offers the agent hand-off).
  const ws = await db.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        id: randomUUID(),
        name,
        slug: shadowOrgSlug(name),
        // Start every new workspace explicitly on the free tier.
        //
        // Without this it has no subscription AND no assigned plan, so it falls
        // through to the deployment fallback — which is `legacy`, i.e.
        // UNLIMITED. That fallback exists to grandfather organizations that
        // predate billing, and it cannot tell those apart from one created a
        // second ago. The effect was that the free tier applied to nobody who
        // signed up after launch, and the free-workspace cap counted zero.
        //
        // Stamping it here makes "every workspace is on a plan" true rather
        // than aspirational, and leaves the fallback meaning only what it was
        // written for: organizations with no plan recorded because none existed.
        //
        // Conditional on billing being switched on, because limits must stay
        // dormant otherwise: a self-hosted or unbilled deployment gets no plan
        // stamp and so stays unlimited, exactly as before.
        // `awaitingPayment` marks a workspace created past the free allowance
        // on the promise of a subscription. It stays on the free tier's limits
        // but is held read-only until a plan is actually bought, so abandoning
        // checkout cannot be used to mint unlimited free workspaces.
        metadata: billingEnabled()
          ? JSON.stringify({
              plan: "seedling",
              ...(args.intendsToPay ? { awaitingPayment: true } : {}),
            })
          : undefined,
      },
    });
    await tx.member.create({
      data: { id: randomUUID(), organizationId: org.id, userId: args.userId, role: "owner" },
    });
    return tx.workspace.create({
      data: {
        organizationId: org.id,
        name,
        icon: args.icon ?? null,
        color: args.color ?? null,
      },
    });
  });
  await seedWorkspace(ws.id);
  return ws;
}

/**
 * `organization.slug` is UNIQUE (and nullable) in the schema. Shadow orgs are
 * never addressed by slug, but two users can easily name a workspace the same
 * thing — so derive a readable stem and append random entropy rather than
 * risking a unique-constraint failure on creation.
 */
function shadowOrgSlug(name: string): string {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
  return `${stem}-${randomUUID().slice(0, 8)}`;
}

/**
 * The current user's workspace for session-authed routes (web app, key
 * management): the oldest workspace they are a member of. If they somehow have
 * none (a user row created outside the signup hook), one is provisioned.
 */
export async function currentWorkspaceForUser(ctx: RequestPrincipal) {
  const [oldest] = await workspacesForUser(ctx.userId);
  if (oldest) return oldest;
  // A workspace isn't something a limited key can make, here or over MCP.
  if (ctx.keyScope) throw createError({ statusCode: 404, statusMessage: "No workspace" });
  return createWorkspaceWithOrg({ userId: ctx.userId, name: "My Workspace" });
}

/**
 * Require a logged-in COOKIE session and reject API-key auth. Key management
 * (create/list/revoke) must not be reachable with a workspace-scoped data key —
 * otherwise a leaked agent/CLI key could mint or revoke the owner's credentials.
 */
export async function requireCookieUser(event: H3Event): Promise<RequestPrincipal> {
  const headers = webHeaders(event);
  if (headers.get("x-api-key")) {
    throw createError({
      statusCode: 403,
      statusMessage: "Key management requires a logged-in session, not an API key",
    });
  }
  const session = await auth.api.getSession({ headers }).catch(() => null);
  if (!session) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  return { userId: session.user.id, principal: "human" };
}

/**
 * Wrap a route handler so domain PathErrors become 400s in one place instead of
 * a try/catch repeated in every file route.
 */
/** The `?path=` query parameter a per-file route requires, or a 400. */
export function requirePathQuery(event: H3Event): string {
  const path = getQuery(event).path;
  if (typeof path !== "string" || !path) {
    throw createError({ statusCode: 400, statusMessage: "path is required" });
  }
  return path;
}

export function fileRoute<T>(handler: (event: H3Event) => Promise<T>) {
  return defineEventHandler(async (event) => {
    try {
      return await handler(event);
    } catch (err) {
      if (err instanceof PathError) {
        throw createError({ statusCode: 400, statusMessage: err.message });
      }
      throw err;
    }
  });
}