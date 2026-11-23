import { usePrismaClient } from "db";
import { createError, defineEventHandler, readBody } from "h3";
import { parseRole, roleChangeRefusal } from "../../../../../utils/acl";
import { requireMemberFromRoute } from "../../../../../utils/workspace";

// Roles this route can hand out. Deliberately not `owner` (ownership never
// changes hands as a side effect of a role picker) and not `admin`: nothing in
// the product mints admins today, and a reachable admin could also use
// better-auth's own /organization/update-member-role, which knows nothing of the
// rules below.
const SETTABLE = new Set(["member", "viewer"]);

function requestedRole(body: { role?: unknown } | null | undefined): string {
  if (typeof body?.role === "string" && SETTABLE.has(body.role)) return body.role;
  throw createError({ statusCode: 400, statusMessage: "role must be member or viewer" });
}

const REFUSALS = {
  not_a_manager: {
    statusCode: 403,
    statusMessage: "Only a workspace owner or admin can change roles",
  },
  own_role: { statusCode: 409, statusMessage: "You can't change your own role" },
  owner_role: { statusCode: 403, statusMessage: "An owner's role can't be changed" },
  peer_admin: { statusCode: 403, statusMessage: "Only an owner can change an admin" },
} as const;

// Change a member's role. COOKIE SESSION ONLY, like member removal: an API key
// is a data-plane credential, and a leaked one must not be able to promote
// itself or demote the people who could revoke it.
//
// Owners and admins can move people between member and viewer; only an owner
// can change an existing admin. Nobody changes an owner's role here, and nobody
// changes their own. Access is evaluated per request, so a demotion narrows the
// member — and every API key they hold — on their very next call.
export default defineEventHandler(async (event) => {
  const { ctx, ws, userId } = await requireMemberFromRoute(event);
  const role = requestedRole(await readBody<{ role?: unknown }>(event));

  const db = usePrismaClient();
  const target = await db.member.findFirst({
    where: { organizationId: ws.organizationId, userId },
  });
  const refusal = roleChangeRefusal(ws.access.role, parseRole(target?.role), userId === ctx.userId);
  if (refusal) throw createError(REFUSALS[refusal]);
  if (!target) throw createError({ statusCode: 404, statusMessage: "Not a workspace member" });

  await db.member.update({ where: { id: target.id }, data: { role } });
  return { ok: true, userId, role };
});