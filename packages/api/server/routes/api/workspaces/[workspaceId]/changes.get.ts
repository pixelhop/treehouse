import { createError, getQuery } from "h3";
import { usePrismaClient } from "db";
import { COMMENT_OP_PREFIX } from "shared";
import { listWorkspaceAcls } from "../../../../utils/acl";
import { eventForReader, feedEvent } from "../../../../utils/change-feed";
import { fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// Change feed for a workspace. Two cursoring modes:
//   ?sinceSeq=<int>  — incremental sync cursor: returns events with seq > sinceSeq
//                      (ascending), the reliable monotonic path for the CLI engine.
//   ?since=<ISO>     — legacy/time path (createdAt), used by the web activity panel;
//                      pairs with ?order=desc for newest-first.
// Every response also carries `head` (the workspace's current max seq) so a client
// can positively confirm catch-up. `seq`/`head` are BigInt in Postgres and are
// serialized to JS numbers (safe below 2^53).
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const query = getQuery(event);
  const db = usePrismaClient();

  // Incremental cursor. A distinct param (not a type-sniffed ?since) because
  // Number.parseInt("2026-06-07T…") === 2026 would misroute an ISO date here.
  let sinceSeq: bigint | undefined;
  if (typeof query.sinceSeq === "string") {
    if (!/^\d+$/.test(query.sinceSeq)) {
      throw createError({ statusCode: 400, statusMessage: "Invalid 'sinceSeq' cursor" });
    }
    sinceSeq = BigInt(query.sinceSeq);
  }

  // Legacy time cursor (only consulted when sinceSeq is absent).
  let since: Date | undefined;
  if (typeof query.since === "string") {
    since = new Date(query.since);
    if (Number.isNaN(since.getTime())) {
      throw createError({ statusCode: 400, statusMessage: "Invalid 'since' timestamp" });
    }
  }

  // Use ?? (not ||) so an explicit ?limit=0 is honored rather than falling back.
  const parsed = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : Number.NaN;
  const limit = Math.min(Math.max(Number.isNaN(parsed) ? 200 : parsed, 0), 1000);

  // Default ascending (oldest-first) for incremental/since polling; ?order=desc
  // returns the most recent events (used by the web activity panel).
  const order = query.order === "desc" ? "desc" : "asc";

  // Comment traffic (`comment_*` ops) is opt-in: fielded CLI engines predate
  // these ops and must never receive them, and the activity panel's window must
  // not be crowded out by review chatter unless it asked for it.
  const includeComments = query.includeComments === "1" || query.includeComments === "true";

  // Read head first, then bound the seq page by `seq <= head`. This guarantees
  // head is never less than a returned event's seq even if a new event commits
  // between the two reads (it's simply excluded from this page and picked up on
  // the next poll) — a consistent snapshot without needing a stricter isolation
  // level.
  const headAgg = await db.changeEvent.aggregate({
    where: { workspaceId: ws.id },
    _max: { seq: true },
  });
  const head = headAgg._max.seq ?? 0n;

  const rows =
    sinceSeq !== undefined
      ? await db.changeEvent.findMany({
          where: { workspaceId: ws.id, seq: { gt: sinceSeq, lte: head } },
          orderBy: { seq: "asc" },
          take: limit,
        })
      : await db.changeEvent.findMany({
          // On the windowed/time path the comment exclusion lives in SQL: the
          // History tab and share dialog read the newest-N window, and a burst
          // of comment events must not consume it. (The sinceSeq path instead
          // excludes post-fetch below, so `nextSeq` still advances over scanned
          // comment events and a comment-only window can't stall the cursor.)
          where: {
            workspaceId: ws.id,
            ...(since ? { createdAt: { gt: since } } : {}),
            ...(includeComments ? {} : { NOT: { op: { startsWith: COMMENT_OP_PREFIX } } }),
          },
          orderBy: { createdAt: order },
          take: limit,
        });

  // Per-requester filter: see eventForReader. Excluded rows still count as
  // scanned, so `nextSeq` (below) carries a client past a fully filtered window.
  const acls = await listWorkspaceAcls(ws.id);
  const reader = { acls, access, includeComments, syncing: sinceSeq !== undefined };
  const visible = rows.flatMap((r) => eventForReader(r, reader) ?? []);

  const changes = visible.map((c) => feedEvent(c, acls, access));

  // The recovery operations (trash restore, point-in-time restore, undo) behind
  // any of these events, so the feed can show "restored 42 files" as one entry.
  // Only operations the caller can see an event of, and never their stored
  // counts: those include the runner's private files. A reader counts the
  // events they can see instead.
  const opIds = [...new Set(visible.flatMap((r) => (r.operationId ? [r.operationId] : [])))];
  const operations =
    opIds.length === 0
      ? []
      : await db.recoveryOperation.findMany({
          where: { workspaceId: ws.id, id: { in: opIds } },
          select: { id: true, kind: true, scopePath: true, targetAt: true, targetLabel: true },
        });

  // `nextSeq` is the last *scanned* seq (before the ACL filter above), so an
  // incremental client advances its cursor past a page that is fully filtered
  // out for it — neither livelocking (the CLI re-fetching the same window
  // forever) nor skipping a visible event that sits beyond a truncated page.
  // When the page scanned no rows it is the request cursor, unchanged. Only
  // meaningful on the ascending `?sinceSeq` cursor path: the time/`?order=desc`
  // path scans newest-first, where "last scanned" is the OLDEST row and would
  // mislead a forward cursor — so `nextSeq` is omitted there, not redefined.
  if (sinceSeq !== undefined) {
    const lastScanned = rows.length > 0 ? rows[rows.length - 1]!.seq : sinceSeq;
    return { changes, operations, head: Number(head), nextSeq: Number(lastScanned) };
  }
  return { changes, operations, head: Number(head) };
});