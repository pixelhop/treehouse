import { usePrismaClient } from "db";
import { createError, defineEventHandler } from "h3";
import { canManageMembers, parseRole } from "../../../../../utils/acl";
import { auth } from "../../../../../utils/auth";
import { requireMemberFromRoute, webHeaders } from "../../../../../utils/workspace";

const isOwner = (role: string) => parseRole(role) === "owner";
const canManage = (role: string) => canManageMembers(parseRole(role));

// Remove someone from a workspace. COOKIE SESSION ONLY: an API key is a
// data-plane credential, and a leaked agent key must not be able to evict the
// people who could revoke it.
//
// Membership of a workspace is membership of its hidden 1:1 organization, so
// removal goes through better-auth rather than deleting the row directly — that
// is what fires the `afterRemoveMember` hook, which revokes the ex-member's
// workspace-scoped API keys so their sync daemon stops (see
// `packages/api/server/utils/auth.ts`). Deleting the member row here would
// leave their keys live.
export default defineEventHandler(async (event) => {
  // 404 unknown workspace / 403 if the caller isn't a member at all.
  const { ctx, ws, userId } = await requireMemberFromRoute(event);
  const db = usePrismaClient();

  const [caller, target] = await Promise.all([
    db.member.findFirst({ where: { organizationId: ws.organizationId, userId: ctx.userId } }),
    db.member.findFirst({ where: { organizationId: ws.organizationId, userId } }),
  ]);
  if (!caller || !canManage(caller.role)) {
    throw createError({
      statusCode: 403,
      statusMessage: "Only a workspace owner or admin can remove members",
    });
  }
  if (!target) throw createError({ statusCode: 404, statusMessage: "Not a workspace member" });

  if (isOwner(target.role)) {
    // An admin must not be able to evict an owner — that would let a lower role
    // take the workspace over.
    if (!isOwner(caller.role)) {
      throw createError({ statusCode: 403, statusMessage: "Only an owner can remove an owner" });
    }
    const owners = await db.member.count({
      where: { organizationId: ws.organizationId, role: "owner" },
    });
    // A workspace with no owner can never be administered again, and nothing
    // else in the product can repair it.
    if (owners <= 1) {
      throw createError({
        statusCode: 409,
        statusMessage: "Can't remove the workspace's last owner",
      });
    }
  }

  // `webHeaders`, never `toWebRequest` — the latter locks the request body
  // stream (harmless on DELETE, but the rule is absolute in this codebase).
  await auth.api.removeMember({
    headers: webHeaders(event),
    body: { memberIdOrEmail: target.id, organizationId: ws.organizationId },
  });

  return { ok: true, removedUserId: userId };
});