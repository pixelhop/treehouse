import { usePrismaClient } from "db";
import { createError, defineEventHandler, readBody } from "h3";
import {
  appUrlBase,
  INVITE_DEFAULT_DAYS,
  INVITE_MAX_DAYS,
  newInviteToken,
  sha256,
} from "../../../utils/invite";
import { assertCanAddMember } from "../../../utils/limits";
import { authorizeWorkspace, requireCookieUser, requireWriter } from "../../../utils/workspace";

/** The role a link joins with, or a 400. */
function inviteRole(requested: string | null | undefined): "member" | "viewer" {
  const role = requested ?? "member";
  if (role !== "member" && role !== "viewer") {
    throw createError({ statusCode: 400, statusMessage: "role must be member or viewer" });
  }
  return role;
}

/** How long a link lasts and how many times it works, within the limits. */
function inviteTerms(body: { expiresInDays?: number; maxUses?: number | null }) {
  const days = Math.min(
    Math.max(Math.floor(Number(body.expiresInDays) || INVITE_DEFAULT_DAYS), 1),
    INVITE_MAX_DAYS,
  );
  const maxUses =
    body.maxUses === null || body.maxUses === undefined
      ? null
      : Math.max(1, Math.floor(Number(body.maxUses)));
  return { days, maxUses };
}

// Create a shareable invite link for a workspace (COOKIE SESSION ONLY). The
// caller must be a member of the workspace's org, and not a viewer (bringing
// people in is a decision for the people who can change the workspace). The link
// carries the role its users join with: `member` (default) or `viewer`. Returns
// the link exactly once — only the token's hash is stored. Whoever opens the
// link (while logged in) joins the workspace's org and gains access.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const body = await readBody<{
    workspaceId?: string;
    expiresInDays?: number;
    maxUses?: number | null;
    role?: string;
  }>(event);
  if (!body?.workspaceId) {
    throw createError({ statusCode: 400, statusMessage: "workspaceId is required" });
  }

  // 403/404 unless the caller is a member of the workspace's org.
  const ws = await authorizeWorkspace(ctx, body.workspaceId);
  requireWriter(ws.access);
  const role = inviteRole(body.role);

  // Minting a link is the moment someone tries to grow the team, so the member
  // limit surfaces here rather than only at accept time — the person who can
  // act on it is the one holding the invite dialog.
  await assertCanAddMember(ws.organizationId);

  const { days, maxUses } = inviteTerms(body);
  const token = newInviteToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000);
  await usePrismaClient().workspaceInvite.create({
    data: {
      tokenHash: sha256(token),
      organizationId: ws.organizationId,
      workspaceId: ws.id,
      role,
      createdBy: ctx.userId,
      expiresAt,
      maxUses,
    },
  });

  return {
    token,
    url: `${appUrlBase()}/invite/${token}`,
    expiresAt: expiresAt.toISOString(),
    maxUses,
    role,
  };
});