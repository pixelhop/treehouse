import { randomUUID } from "node:crypto";
import { usePrismaClient } from "db";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { sha256 } from "../../../../utils/invite";
import { assertCanAddMember } from "../../../../utils/limits";
import { requireCookieUser } from "../../../../utils/workspace";
import { syncSeatsForOrg } from "../../../../utils/billing-events";

/** Prisma's unique-constraint violation. Matched structurally rather than by
 * importing the error class, so this doesn't depend on the client's runtime shape. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

// Accept an invite link (COOKIE SESSION ONLY). Adds the logged-in user as a
// member of the WORKSPACE's current org (which is what grants workspace access).
// Idempotent for someone who's already a member, and consumes one "use" only
// when a new membership is actually created.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const token = getRouterParam(event, "token");
  if (!token) throw createError({ statusCode: 400, statusMessage: "Missing token" });

  const db = usePrismaClient();
  const invite = await db.workspaceInvite.findUnique({ where: { tokenHash: sha256(token) } });
  if (!invite) throw createError({ statusCode: 404, statusMessage: "Invite not found" });

  // Resolve the org through the WORKSPACE, never through the invite's own
  // (denormalized, display-only) organizationId. A workspace can be re-parented
  // onto a different organization — the one-org-per-workspace migration does
  // exactly that — which would leave an old link joining a stale org and
  // granting the wrong access. Going via the workspace makes that impossible.
  const ws = await db.workspace.findUnique({
    where: { id: invite.workspaceId },
    select: { organizationId: true },
  });
  if (!ws) throw createError({ statusCode: 404, statusMessage: "Invite not found" });
  const organizationId = ws.organizationId;

  // Membership check FIRST, above revocation/expiry: an existing member of the
  // workspace's org is idempotently "already in" regardless of the invite's
  // freshness — so a returning member re-clicking an old (expired/revoked/exhausted)
  // link gets the app offer, not the "unavailable" dead end. This consumes no use.
  const existing = await db.member.findFirst({
    where: { organizationId, userId: ctx.userId },
  });
  if (existing) {
    return {
      ok: true,
      alreadyMember: true,
      workspaceId: invite.workspaceId,
      organizationId,
    };
  }

  // A NEW membership must pass the freshness gates.
  if (invite.revokedAt != null) {
    throw createError({ statusCode: 409, statusMessage: "Invite revoked" });
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    throw createError({ statusCode: 410, statusMessage: "Invite expired" });
  }

  // Plan gate before the use is claimed: a rejected accept must not burn one
  // of a limited-use invite's uses.
  //
  // Against the WORKSPACE's current org, never the invite's stored one. The
  // invite's copy can be stale — a workspace can be moved onto a different
  // organization, which is exactly what the one-org-per-workspace migration
  // did — and the membership below is created in `organizationId`. Checking a
  // different org's capacity than the one being joined would either refuse a
  // valid accept or let one past the real limit.
  await assertCanAddMember(organizationId);

  // Claim a use atomically — guards maxUses against concurrent accepts.
  const claim = await db.workspaceInvite.updateMany({
    where: {
      id: invite.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(invite.maxUses != null ? { uses: { lt: invite.maxUses } } : {}),
    },
    data: { uses: { increment: 1 } },
  });
  if (claim.count !== 1) {
    throw createError({ statusCode: 409, statusMessage: "Invite is no longer usable" });
  }
  try {
    await db.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId: ctx.userId,
        role: invite.role,
      },
    });
  } catch (e) {
    // A concurrent accept won the race between our membership check and this
    // insert. The DB's unique(organizationId, userId) is what actually makes the
    // two mutually exclusive; this branch just reports the same idempotent
    // "already a member" answer the pre-check would have given a moment later.
    if (!isUniqueViolation(e)) throw e;
    // Give back the use we claimed: no NEW membership came of it, and the route's
    // contract is that a use is consumed only when one is actually created.
    await db.workspaceInvite.updateMany({
      where: { id: invite.id, uses: { gt: 0 } },
      data: { uses: { decrement: 1 } },
    });
    return {
      ok: true,
      alreadyMember: true,
      workspaceId: invite.workspaceId,
      organizationId,
    };
  }

  // A new member is a new seat. This route writes the `member` row straight
  // through Prisma, so better-auth's `afterAcceptInvitation` hook — the thing
  // the Stripe plugin uses to keep the seat quantity honest — never fires here.
  // Without this, a workspace could invite a team and stay billed for one seat,
  // while REMOVING someone (which does go through better-auth) would suddenly
  // correct the quantity upward and multiply the bill.
  //
  // Deliberately after the membership is committed and never awaited into the
  // response's success: Stripe being slow or down must not cost someone their
  // invite. Drift is logged and reconciliation repairs it.
  await syncSeatsForOrg(organizationId);

  return {
    ok: true,
    alreadyMember: false,
    workspaceId: invite.workspaceId,
    organizationId,
  };
});