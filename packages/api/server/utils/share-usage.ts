import { createHash } from "node:crypto";
import { usePrismaClient } from "db";
import { getRequestHeader, type H3Event } from "h3";
import { sendEmail } from "./email";
import { entitlementsForWorkspace } from "./plans";

// Public-share usage accounting: views (the published free-tier limit and a
// members-facing feature) and bytes (an unpublished abuse backstop).
//
// Counters are written straight to Postgres rather than buffered in a cache
// server. The API package has no Redis dependency — that lives only in
// packages/workers — and share serving is low-volume by design, already doing a
// share lookup plus a blob fetch plus a decryption per request, so one atomic
// increment is noise against that.
//
// Nothing here may throw into the serving path: a counter failure must never
// stop a client opening a link their supplier shared with them.

/**
 * Bots, crawlers, and the link unfurlers that fetch a URL the moment it is
 * pasted. Slack, iMessage, WhatsApp and friends would otherwise make a view
 * count jump before any human opened the file, and a count members do not trust
 * is worse than none — the free-tier limit rests on this number.
 */
const BOT_UA =
  /bot|crawler|spider|slurp|facebookexternalhit|slackbot|slack-imgproxy|twitterbot|discordbot|telegrambot|whatsapp|linkedinbot|applebot|embedly|quora link preview|redditbot|skypeuripreview|nuzzel|bitlybot|vkshare|preview|scrapy|curl\/|wget\/|python-requests|go-http-client|node-fetch|okhttp|headlesschrome|lighthouse|monitoring|uptime/i;

export function isBotRequest(userAgent: string | undefined): boolean {
  if (!userAgent || userAgent.trim() === "") return true; // no UA at all is not a browser
  return BOT_UA.test(userAgent);
}

/** UTC bucket keys. Both periods live in one table, keyed by `kind`. */
export function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}
export function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Client IP, honouring the proxy header Railway sets in front of the API. */
function clientIp(event: H3Event): string {
  const forwarded = getRequestHeader(event, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return event.node.req.socket.remoteAddress ?? "unknown";
}

/**
 * A per-visitor-per-day pseudonym: salted hash of IP + user-agent, with the day
 * mixed in so it rotates every 24h on its own.
 *
 * Deliberately not a cookie. Nothing durable about the visitor is stored, there
 * is no consent banner to show, and the value is useless the day after it was
 * minted — which is the right posture for a product that sells not putting
 * client files in someone else's box.
 */
export function visitorHash(event: H3Event, day = dayKey()): string {
  const salt = process.env.SHARE_VIEW_SALT ?? process.env.BETTER_AUTH_SECRET ?? "treehouse";
  const ua = getRequestHeader(event, "user-agent") ?? "";
  return createHash("sha256")
    .update(`${salt}:${day}:${clientIp(event)}:${ua}`)
    .digest("hex");
}

/** Prisma's unique-constraint violation — here it means "already counted". */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

async function bumpPeriod(
  workspaceId: string,
  kind: "month" | "day",
  period: string,
  views: number,
  bytes: number,
): Promise<void> {
  const db = usePrismaClient();
  await db.shareUsage.upsert({
    where: { workspaceId_kind_period: { workspaceId, kind, period } },
    create: { workspaceId, kind, period, views, bytes: BigInt(bytes) },
    update: { views: { increment: views }, bytes: { increment: BigInt(bytes) } },
  });
}

/**
 * Record one visit to a share link.
 *
 * A view is one visitor opening a link, deduplicated per visitor per link per
 * day — NOT one HTTP request. A folder portal that pulls twenty images is one
 * view; counting requests would make the number arbitrary. The unique
 * constraint on the ledger is what decides: an insert that lands is the first
 * view today, a unique violation is a repeat.
 *
 * Returns true when this request counted as a new view.
 */
export async function countShareView(
  event: H3Event,
  share: { id: string; workspaceId: string },
): Promise<boolean> {
  if (isBotRequest(getRequestHeader(event, "user-agent"))) return false;

  const now = new Date();
  const day = dayKey(now);
  const db = usePrismaClient();

  try {
    await db.shareViewDay.create({
      data: {
        shareId: share.id,
        workspaceId: share.workspaceId,
        visitorHash: visitorHash(event, day),
        day,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return false; // already counted today
    console.error("share view dedup insert failed:", err);
    return false;
  }

  try {
    await Promise.all([
      db.share.update({
        where: { id: share.id },
        data: { viewCount: { increment: 1 }, lastViewedAt: now },
      }),
      bumpPeriod(share.workspaceId, "month", monthKey(now), 1, 0),
      bumpPeriod(share.workspaceId, "day", day, 1, 0),
    ]);
  } catch (err) {
    // The ledger row is already in; losing the aggregate is a reporting gap, not
    // a reason to fail the visitor's request.
    console.error("share view counter update failed:", err);
  }

  // Thresholds only move on a counted view, so this is the one place worth
  // re-testing them. Latched inside, so it mails the owner once per month.
  await notifyShareLimit(share.workspaceId, await shareLimitState(share.workspaceId));
  return true;
}

/**
 * Record bytes actually written to a visitor.
 *
 * Called after a body is served, so the 304 path costs nothing in this column
 * while still registering as a view.
 */
export async function countShareBytes(workspaceId: string, bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const now = new Date();
  try {
    await Promise.all([
      bumpPeriod(workspaceId, "month", monthKey(now), 0, bytes),
      bumpPeriod(workspaceId, "day", dayKey(now), 0, bytes),
    ]);
  } catch (err) {
    console.error("share byte counter update failed:", err);
  }
}

export interface ShareUsageSnapshot {
  monthViews: number;
  monthBytes: number;
  dayBytes: number;
}

/** Current-period usage for a workspace. Zeroes when nothing has been served. */
export async function shareUsageFor(workspaceId: string): Promise<ShareUsageSnapshot> {
  const now = new Date();
  const db = usePrismaClient();
  const rows = await db.shareUsage.findMany({
    where: {
      workspaceId,
      OR: [
        { kind: "month", period: monthKey(now) },
        { kind: "day", period: dayKey(now) },
      ],
    },
    select: { kind: true, views: true, bytes: true },
  });
  const month = rows.find((r) => r.kind === "month");
  const day = rows.find((r) => r.kind === "day");
  return {
    monthViews: month?.views ?? 0,
    // Number is safe here: these are byte counts under a few TB, far inside
    // Number.MAX_SAFE_INTEGER, and JSON cannot carry a BigInt.
    monthBytes: Number(month?.bytes ?? 0n),
    dayBytes: Number(day?.bytes ?? 0n),
  };
}
// ---------------------------------------------------------------------------
// Ceilings
//
// Three limits, with different jobs. Monthly views is the published free-tier
// limit and the intended upgrade trigger. Monthly and daily bytes are unpublished
// abuse backstops — views bound the common case, but one visit to a folder portal
// can pull many files, so bytes bound the shape views cannot express. The daily
// one exists because a monthly ceiling gives no protection in the first hour.
//
// Paid tiers carry no ceilings at all (see plans.ts): a paying customer whose
// client portal goes dark costs far more than the bandwidth.
// ---------------------------------------------------------------------------

/** Fraction of the view limit at which the owner is warned. */
const WARN_RATIO = 0.8;

export type ShareLimitReason = "views" | "month_bytes" | "day_bytes";

export interface ShareLimitState {
  paused: boolean;
  reason: ShareLimitReason | null;
  usage: ShareUsageSnapshot;
  viewLimit: number | null;
  /** Views left this month; null when uncapped. */
  viewsRemaining: number | null;
  /** True once usage reaches the warn ratio of the view limit. */
  warning: boolean;
}

export async function shareLimitState(workspaceId: string): Promise<ShareLimitState> {
  const plan = await entitlementsForWorkspace(workspaceId);
  const uncapped =
    plan.shareViewsPerMonth == null &&
    plan.shareBytesPerMonth == null &&
    plan.shareBytesPerDay == null;

  // Skip the usage read entirely on an uncapped plan — which is every plan
  // except the free tier, and every deployment with billing off.
  if (uncapped) {
    return {
      paused: false,
      reason: null,
      usage: { monthViews: 0, monthBytes: 0, dayBytes: 0 },
      viewLimit: null,
      viewsRemaining: null,
      warning: false,
    };
  }

  // Fail OPEN on a usage-read failure. This runs inside requirePublicShare, so
  // letting it throw would turn a transient database blip into a 500 on every
  // public link a customer has ever sent a client — a metering outage taking
  // down content delivery, which is the exact inversion of what the ceiling is
  // for. Serving a few uncounted views is the cheaper mistake by far.
  let usage: ShareUsageSnapshot;
  try {
    usage = await shareUsageFor(workspaceId);
  } catch (err) {
    console.error(`share usage read failed for ${workspaceId}; serving unpaused:`, err);
    return {
      paused: false,
      reason: null,
      usage: { monthViews: 0, monthBytes: 0, dayBytes: 0 },
      viewLimit: plan.shareViewsPerMonth,
      viewsRemaining: null,
      warning: false,
    };
  }
  const viewLimit = plan.shareViewsPerMonth;

  // Read-then-serve, not an atomic reservation: concurrent first-time visitors
  // arriving within the same instant can each pass this check and each be
  // served, overshooting the ceiling by roughly the number of requests in
  // flight. Accepted deliberately — this is an abuse ceiling, not an accounting
  // boundary, the byte ceilings below bound the cost of any overshoot, and
  // serialising public reads to make it exact would cost far more than the
  // handful of extra views it prevents.
  let reason: ShareLimitReason | null = null;
  if (viewLimit != null && usage.monthViews >= viewLimit) reason = "views";
  else if (plan.shareBytesPerMonth != null && usage.monthBytes >= plan.shareBytesPerMonth)
    reason = "month_bytes";
  else if (plan.shareBytesPerDay != null && usage.dayBytes >= plan.shareBytesPerDay)
    reason = "day_bytes";

  return {
    paused: reason !== null,
    reason,
    usage,
    viewLimit,
    viewsRemaining: viewLimit == null ? null : Math.max(0, viewLimit - usage.monthViews),
    warning: viewLimit != null && usage.monthViews / viewLimit >= WARN_RATIO,
  };
}

/** The workspace owner's email, for the notifications below. */
async function ownerEmailFor(workspaceId: string): Promise<{ email: string; name: string } | null> {
  const db = usePrismaClient();
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, organizationId: true },
  });
  if (!ws) return null;
  const owner = await db.member.findFirst({
    where: { organizationId: ws.organizationId, role: "owner" },
    select: { user: { select: { email: true, name: true } } },
  });
  return owner?.user ? { email: owner.user.email, name: ws.name } : null;
}

/**
 * Notify the owner once when a ceiling is approached, and once when it is hit.
 *
 * The latch columns matter: a paused link is re-tested on every visit, so
 * without them a circulating link would mail the owner hundreds of times.
 *
 * The upgrade pressure belongs here, in the owner's inbox — never on the page
 * their client is looking at.
 */
export async function notifyShareLimit(workspaceId: string, state: ShareLimitState): Promise<void> {
  if (!state.warning && !state.paused) return;
  const field = state.paused ? "pausedAt" : "warnedAt";
  const db = usePrismaClient();
  const period = monthKey();

  try {
    // Latch first: claim the notification with a conditional update so two
    // concurrent requests cannot both send.
    const claimed = await db.shareUsage.updateMany({
      where: { workspaceId, kind: "month", period, [field]: null },
      data: { [field]: new Date() },
    });
    if (claimed.count !== 1) return;

    const owner = await ownerEmailFor(workspaceId);
    if (!owner) return;

    const subject = state.paused
      ? `Your Treehouse share links are paused (${owner.name})`
      : `Your Treehouse share links are close to the monthly limit (${owner.name})`;
    const body = state.paused
      ? `Share links in "${owner.name}" have reached this month's limit of ${state.viewLimit} views, so they are temporarily unavailable to the people you sent them to.\n\nUpgrading restores every link immediately.`
      : `Share links in "${owner.name}" have had ${state.usage.monthViews} of ${state.viewLimit} views this month.\n\nYour work is getting read. Upgrading removes the limit before your links go dark.`;

    await sendEmail({
      to: owner.email,
      subject,
      text: body,
      html: `<p>${body.replace(/\n\n/g, "</p><p>")}</p>`,
    });
  } catch (err) {
    // A failed notification must never break serving.
    console.error("share limit notification failed:", err);
  }
}