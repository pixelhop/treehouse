import { createError, defineEventHandler, readBody } from "h3";
import { auth } from "../../../../../utils/auth";
import { planSlugFromSubscription } from "../../../../../utils/billing";
import { sidekickCheckoutMetadata } from "../../../../../utils/sidekick";
import { requireCookieUser, webHeaders } from "../../../../../utils/workspace";
import { usePrismaClient } from "db";

// Start a Stripe checkout for a workspace's plan. Cookie session only.
//
// Workspace-scoped on purpose. Organizations are invisible machinery — one per
// workspace, never shown to a user — so the app must never need to hold an org
// id to buy something. This route resolves it, which keeps the "the workspace is
// the only container" rule intact on the billing path too.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const workspaceId = event.context.params?.workspaceId ?? "";
  const body = ((await readBody(event)) ?? {}) as { plan?: unknown; annual?: unknown };

  const plan = typeof body.plan === "string" ? body.plan : "";
  if (!planSlugFromSubscription(plan)) {
    throw createError({ statusCode: 400, statusMessage: "Unknown plan" });
  }

  const db = usePrismaClient();
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  // 404 rather than 403 for a workspace the caller cannot see, so this route
  // never confirms that an id exists.
  if (!ws) throw createError({ statusCode: 404, statusMessage: "Not found" });

  const membership = await db.member.findFirst({
    where: { organizationId: ws.organizationId, userId: ctx.userId },
    select: { role: true },
  });
  if (!membership) throw createError({ statusCode: 404, statusMessage: "Not found" });
  // Buying is an owner/admin action: a regular member can use the workspace but
  // must not be able to change what it costs. The plugin re-checks this in
  // authorizeReference; checking here too means a plain member gets a clean 403
  // rather than the plugin's generic refusal.
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw createError({ statusCode: 403, statusMessage: "Owners and admins only" });
  }

  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").split(",")[0]!.trim();
  const slug = planSlugFromSubscription(plan)!;

  // Buy a seat for everyone who is ALREADY here.
  //
  // The plans are sold per member and the Stripe quantity tracks the member
  // list, but the plugin's checkout defaults that quantity to 1 unless it is
  // told otherwise — it only derives seats from membership when the call
  // declares `customerType: "organization"`, which this route deliberately does
  // not send (existing subscriptions live on a user-scoped Stripe customer, and
  // switching now would look for them under a new org customer and sell a
  // second subscription to someone who already pays).
  //
  // So a five-person workspace was quoted one seat at checkout, charged for
  // one, and then corrected to five by the hourly reconcile — arriving as a
  // prorated charge nobody had been shown. Counting here means the price on
  // Stripe's page is the price of this workspace.
  //
  // Still no seat FLOOR: this is the real count, from one. The paid tiers are a
  // CAPACITY upgrade as much as a team one — someone alone with 150,000 files
  // needs Forest and has nobody to fill four extra seats with, and a minimum
  // would charge them for the privilege of not having a team.
  const seats = Math.max(
    1,
    await db.member.count({ where: { organizationId: ws.organizationId } }),
  );

  try {
    const result = (await auth.api.upgradeSubscription({
      body: {
        // Plan names carry the interval ("grove-annual"); see billing.ts.
        plan: body.annual === true ? `${slug}-annual` : slug,
        referenceId: ws.organizationId,
        seats,
        successUrl: `${appUrl}/w/${workspaceId}?upgraded=1`,
        cancelUrl: `${appUrl}/w/${workspaceId}`,
        // Credits the affiliate who referred this visitor, if any. See sidekick.ts.
        metadata: sidekickCheckoutMetadata(event),
      },
      headers: webHeaders(event),
    })) as { url?: string };
    if (!result?.url) {
      throw createError({ statusCode: 502, statusMessage: "Checkout unavailable" });
    }
    return { url: result.url };
  } catch (err) {
    // Billing being unreachable must read as "try again", not as a broken app.
    console.error(`checkout failed for workspace ${workspaceId}:`, err);
    throw createError({ statusCode: 502, statusMessage: "Checkout unavailable" });
  }
});