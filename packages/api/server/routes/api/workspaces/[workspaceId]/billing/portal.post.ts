import { usePrismaClient } from "db";
import { createError, defineEventHandler } from "h3";
import { auth } from "../../../../../utils/auth";
import { requireCookieUser, webHeaders } from "../../../../../utils/workspace";

// Open Stripe's billing portal for a workspace. Cookie session only.
//
// Without this there is no way to change a payment method, download an invoice,
// or cancel — which is not merely an inconvenience, it is the sort of thing a
// customer is entitled to be able to do themselves.
//
// Workspace-scoped for the same reason as checkout: organizations are invisible
// machinery, so the app must never hold an org id to manage billing.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const workspaceId = event.context.params?.workspaceId ?? "";

  const db = usePrismaClient();
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  if (!ws) throw createError({ statusCode: 404, statusMessage: "Not found" });

  const membership = await db.member.findFirst({
    where: { organizationId: ws.organizationId, userId: ctx.userId },
    select: { role: true },
  });
  // 404 rather than 403 for a non-member, so this never confirms an id exists.
  if (!membership) throw createError({ statusCode: 404, statusMessage: "Not found" });
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw createError({ statusCode: 403, statusMessage: "Owners and admins only" });
  }

  // The plugin records the customer on the SUBSCRIPTION row; the organization
  // column it also defines stays null in practice. Checking only the org meant
  // this refused every real customer.
  const [org, subscription] = await Promise.all([
    db.organization.findUnique({
      where: { id: ws.organizationId },
      select: { stripeCustomerId: true },
    }),
    db.subscription.findFirst({
      where: { referenceId: ws.organizationId, stripeCustomerId: { not: null } },
      select: { stripeCustomerId: true },
    }),
  ]);
  // Nothing has ever been bought, so Stripe has no customer to show a portal
  // for. A distinct code lets the app offer checkout instead of an error.
  if (!subscription?.stripeCustomerId && !org?.stripeCustomerId) {
    throw createError({
      statusCode: 409,
      statusMessage: "No billing account",
      data: { error: "no_billing_account" },
    });
  }

  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").split(",")[0]!.trim();
  try {
    const result = (await auth.api.createBillingPortal({
      body: {
        referenceId: ws.organizationId,
        returnUrl: `${appUrl}/w/${workspaceId}?billing=1`,
      },
      headers: webHeaders(event),
    })) as { url?: string };
    if (!result?.url) throw new Error("no portal url");
    return { url: result.url };
  } catch (err) {
    console.error(`billing portal failed for workspace ${workspaceId}:`, err);
    throw createError({ statusCode: 502, statusMessage: "Billing portal unavailable" });
  }
});