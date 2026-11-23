import { usePrismaClient } from "db";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { sha256 } from "../../../../utils/invite";

// Preview an invite link (no auth) so the accept page can render "Join X". The
// token in the URL is the secret, so surfacing the workspace/org name to anyone
// holding it is fine. 404 for an unknown token.
export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, "token");
  if (!token) throw createError({ statusCode: 400, statusMessage: "Missing token" });

  const db = usePrismaClient();
  const invite = await db.workspaceInvite.findUnique({ where: { tokenHash: sha256(token) } });
  if (!invite) throw createError({ statusCode: 404, statusMessage: "Invite not found" });

  const expired = invite.revokedAt != null || invite.expiresAt.getTime() < Date.now();
  const exhausted = invite.maxUses != null && invite.uses >= invite.maxUses;

  // The workspace is the thing being joined; its owning organization is a hidden
  // implementation detail, resolved THROUGH the workspace (never through the
  // invite's denormalized, possibly-stale organizationId). `organizationName` is
  // retained only so an older deployed SPA doesn't break on a missing field.
  const [ws, inviter] = await Promise.all([
    db.workspace.findUnique({
      where: { id: invite.workspaceId },
      // `id` is surfaced so the preview can render an uploaded image icon, whose
      // URL is workspace-scoped. It grants nothing on its own — every workspace
      // route still checks org membership.
      select: {
        id: true,
        name: true,
        icon: true,
        color: true,
        organization: { select: { name: true } },
      },
    }),
    db.user.findUnique({ where: { id: invite.createdBy }, select: { name: true } }),
  ]);

  return {
    valid: !expired && !exhausted && ws != null,
    expired,
    exhausted,
    workspace: ws ? { id: ws.id, name: ws.name, icon: ws.icon, color: ws.color } : null,
    organizationName: ws?.organization.name ?? null,
    inviterName: inviter?.name ?? null,
    // So the accept page can say "you'll join as a viewer" before they commit.
    role: invite.role === "viewer" ? "viewer" : "member",
  };
});