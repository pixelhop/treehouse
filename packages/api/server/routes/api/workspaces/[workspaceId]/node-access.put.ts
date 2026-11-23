import { usePrismaClient } from "db";
import { createError, readBody } from "h3";
import { clearNodePrivate, type GrantRow, grantLevel, setNodeAccess } from "../../../../utils/acl";
import {
  actorFor,
  assertLiftKeepsWrite,
  assertWritable,
  fileRoute,
  nodePathFrom,
  requireCookieWorkspaceFromRoute,
  requireWriter,
} from "../../../../utils/workspace";

const MAX_GRANTS = 500;
const LEVELS = new Set(["read", "write"]);
// `none` for one person is an exclusion from an everyone grant.
const MEMBER_LEVELS = new Set(["none", ...LEVELS]);

function bad(statusMessage: string) {
  return createError({ statusCode: 400, statusMessage });
}

/** One grant from the request: a userId at a real level. */
function memberGrant(raw: { userId?: unknown; level?: unknown }): GrantRow {
  if (typeof raw?.userId !== "string" || !MEMBER_LEVELS.has(raw.level as string)) {
    throw bad("Each grant needs a userId and a level of none, read or write");
  }
  return { subject: "user", userId: raw.userId, level: raw.level as string };
}

function everyoneGrant(level: unknown): GrantRow[] {
  if (level === undefined || level === "none") return [];
  if (!LEVELS.has(level as string)) throw bad("everyone must be none, read or write");
  return [{ subject: "everyone", userId: null, level: level as string }];
}

/** Each person once, and only people in this workspace. */
async function assertMembers(organizationId: string, grants: GrantRow[]): Promise<void> {
  const ids = grants.map((g) => g.userId as string);
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw bad("Each person can only be listed once");
  const members = await usePrismaClient().member.count({
    where: { organizationId, userId: { in: [...unique] } },
  });
  if (members !== unique.size) throw bad("Everyone listed must be a member of this workspace");
}

/** The grants a request asks for, or a 400. */
async function grantsFrom(
  organizationId: string,
  body: { grants?: unknown; everyone?: unknown },
): Promise<GrantRow[]> {
  const raw = Array.isArray(body.grants) ? body.grants : [];
  if (raw.length > MAX_GRANTS) throw bad("Too many people");
  const grants = raw.map(memberGrant);
  await assertMembers(organizationId, grants);
  return [...grants, ...everyoneGrant(body.everyone)];
}

/** The caller has to stay an editor. An orphan is what this avoids. */
function assertKeepsWrite(grants: GrantRow[], userId: string): void {
  if (grantLevel({ grants }, userId) !== "write") {
    throw createError({ statusCode: 409, statusMessage: "You'd lose access to this" });
  }
}

// Set exactly who can reach a file or folder, or lift that with `restricted:
// false`. COOKIE SESSION ONLY: who may see what is a person's decision, as with
// public links, so a leaked key can't widen or narrow it.
//
// The caller must be able to write the node, and has to stay an editor of it, so
// nobody locks themselves out by accident. An orphan is the failure this avoids.
export default fileRoute(async (event) => {
  const { ctx, ws } = await requireCookieWorkspaceFromRoute(event);
  requireWriter(ws.access);
  const body = (await readBody<Record<string, unknown>>(event)) ?? {};
  const path = nodePathFrom(body);
  await assertWritable(ws.id, ws.access, path);
  const actor = actorFor(ctx, ws.access);

  if (body.restricted === false) {
    await assertLiftKeepsWrite(ws.id, ws.access, path);
    await clearNodePrivate(ws.id, path, actor);
    return { path, restricted: false };
  }

  const grants = await grantsFrom(ws.organizationId, body);
  assertKeepsWrite(grants, ctx.userId);
  const kind = body.kind === "file" ? "file" : "folder";
  await setNodeAccess({ workspaceId: ws.id, path, kind, grants, actor });
  return { path, restricted: true };
});