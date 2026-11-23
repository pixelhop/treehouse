// Per-file activity is a client-side view of the workspace change feed: filter
// the events to one path, newest first, capped for display. (A server-side path
// filter is a noted follow-up if the feed grows large.)
import { carriesContent, isConflictedCopy } from "shared";
import { opClusterLabel } from "./changeOps";

export interface ChangeEvent {
  id: string;
  path: string;
  // A `ChangeOp` (packages/shared). Kept as a string on the wire because a
  // newer server may send an op this build doesn't know: read it through
  // `opDisplay` (utils/changeOps), which narrows it once and falls back safely.
  op: string;
  version: number | null;
  principal: string; // agent | human
  // Attribution + content pointer (present going forward; null on pre-feature
  // events). `actorKeyId` is present for any key, so it never implies "agent".
  actorId?: string | null;
  actorKeyId?: string | null;
  actorLabel?: string | null;
  contentHash?: string | null;
  // The other end of a move: on a move's `delete` the new path, on its `move`
  // the old one. Null for everything else.
  relatedPath?: string | null;
  // The recovery operation (trash restore, point-in-time restore, undo) that
  // made this change, if any. The feed groups an operation's events into one.
  operationId?: string | null;
  createdAt: string; // ISO timestamp
  // Monotonic per-workspace cursor. Present on feed events; optional here so the
  // base type stays usable for callers that haven't surfaced it yet.
  seq?: number | null;
}

// A change event that carries the monotonic `seq` cursor — the reliable order
// for the activity feed (createdAt is not unique across a move's two events).
export interface FeedEvent extends ChangeEvent {
  seq: number;
}

// Order newest-first by `seq` when both events carry it, else by `createdAt`.
// Keeps the per-file history and the workspace feed ordered the same way.
function bySeqDesc(a: ChangeEvent, b: ChangeEvent): number {
  if (a.seq != null && b.seq != null) return b.seq - a.seq;
  return b.createdAt.localeCompare(a.createdAt);
}

/** Recent change events for a single file, newest first, capped at `limit`. */
export function fileActivity<T extends ChangeEvent>(changes: T[], path: string, limit = 50): T[] {
  return changes
    .filter((c) => c.path === path)
    .sort(bySeqDesc)
    .slice(0, limit);
}

/** A version is viewable/restorable only when its event carries a content pointer. */
export function isRestorable(e: ChangeEvent): boolean {
  return e.version != null && !!e.contentHash && carriesContent(e.op);
}

/**
 * Has an event's path gone from the workspace (as this reader sees it)? `paths`
 * holds file paths only, so a folder counts as present while any file sits
 * under it: a folder made shared again is the one event whose path is
 * routinely a folder, and it must not read as deleted.
 */
export function pathGone(paths: string[], path: string): boolean {
  if (paths.includes(path)) return false;
  const prefix = `${path}/`;
  return !paths.some((p) => p.startsWith(prefix));
}

/** Exact timestamp for the hover title / secondary line. */
export function exactTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// The server names a copy "<stem> (conflicted copy — <who> — <iso>)<counter?><ext>".
// Strip that marker segment back out and the result is the original path — which
// is an exact, sibling-prefix-safe and extension-safe way to match copies.
const CONFLICT_MARKER_SEGMENT = / \(conflicted copy — [^)]*\)( \(\d+\))?/;

/** Conflicted copies of `path` among `paths`. */
export function conflictedCopiesFor(paths: string[], path: string): string[] {
  return paths.filter(
    (p) => isConflictedCopy(p) && p.replace(CONFLICT_MARKER_SEGMENT, "") === path,
  );
}

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago", or a date). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// --- Workspace activity feed: clustering, unread, seeding -------------------

/** A recovery operation behind some feed events, as the change feed describes it. */
export interface RecoveryOperationInfo {
  id: string;
  kind: string; // trash | restore | undo
  scopePath: string | null;
  targetAt: string | null;
  targetLabel: string | null;
}

// A run of consecutive events by one actor, rendered as a single (expandable)
// row. A cluster of one event renders as a plain row. Events are newest-first.
export interface EventCluster {
  key: string; // actor identity used for grouping
  principal: string;
  actorId?: string | null;
  actorKeyId?: string | null;
  actorLabel?: string | null;
  events: FeedEvent[];
  headSeq: number; // newest seq in the cluster
  createdAt: string; // newest event's timestamp
  unread: boolean; // sits above the watermark divider
  // Set when the cluster is one recovery operation's events.
  operation?: RecoveryOperationInfo | null;
}

// Default clustering window: consecutive same-actor events within 5 minutes of
// each other collapse into one run. Tunable; see the plan's Open Questions.
const DEFAULT_GAP_MS = 5 * 60 * 1000;

// Grouping identity. Agent events carry the *owner's* actorId, so grouping by
// actorId alone would merge an agent's burst with that same owner's own human
// edits — hiding the agent-vs-human distinction the feed exists to show. Group
// agent events by the acting key instead, and human events by the person and
// the credential they used: a person's synced-folder (CLI or desktop) changes
// are a run of their own, apart from their browser edits, so the entry can
// offer to undo exactly that key's changes. Falls back through ids so the key
// is never null/empty.
function actorKey(e: ChangeEvent): string {
  if (e.principal === "agent") return e.actorKeyId ?? e.actorLabel ?? "agent";
  const person = e.actorId ?? "human";
  return e.actorKeyId ? `${person}#${e.actorKeyId}` : person;
}

function sameLocalDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * Do two adjacent events belong to one run? A recovery operation is one entry
 * however long it ran, and never merges with the same person's ordinary changes
 * either side of it; otherwise it's the same actor, close in time, same day.
 */
function sameRun(prev: FeedEvent, e: FeedEvent, gapMs: number): boolean {
  const opId = e.operationId ?? null;
  const prevOpId = prev.operationId ?? null;
  if (opId !== null || prevOpId !== null) return opId === prevOpId;
  const gap = Math.abs(new Date(prev.createdAt).getTime() - new Date(e.createdAt).getTime());
  return (
    actorKey(prev) === actorKey(e) && gap <= gapMs && sameLocalDay(prev.createdAt, e.createdAt)
  );
}

/**
 * Group a newest-first feed into actor runs. A cluster breaks on actor change,
 * a gap larger than `gapMs`, a local-day boundary, and the watermark divider
 * (so the "new since you were here" line can sit cleanly between clusters).
 */
export function clusterEvents(
  events: FeedEvent[],
  opts: {
    gapMs?: number;
    dividerSeq?: number | null;
    operations?: ReadonlyMap<string, RecoveryOperationInfo>;
  } = {},
): EventCluster[] {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const divider = opts.dividerSeq ?? null;
  const sorted = [...events].sort((a, b) => b.seq - a.seq);
  const clusters: EventCluster[] = [];

  for (const e of sorted) {
    const last = clusters[clusters.length - 1];
    const prev = last?.events[last.events.length - 1];
    const unread = divider != null && e.seq > divider;

    const opId = e.operationId ?? null;
    const joins = !!last && !!prev && last.unread === unread && sameRun(prev, e, gapMs);

    if (joins && last) {
      last.events.push(e);
    } else {
      clusters.push({
        key: actorKey(e),
        principal: e.principal,
        actorId: e.actorId,
        actorKeyId: e.actorKeyId,
        actorLabel: e.actorLabel,
        events: [e],
        headSeq: e.seq,
        createdAt: e.createdAt,
        unread,
        operation: opId ? (opts.operations?.get(opId) ?? null) : null,
      });
    }
  }

  return clusters;
}

/**
 * Logical unread count among `events` (those with `seq > lastSeenSeq`). A move
 * emits two adjacent-seq events sharing a `createdAt`; they count as one change.
 * Returns 0 when the watermark is unset (history is treated as seen).
 */
export function unreadCount(events: FeedEvent[], lastSeenSeq: number | null): number {
  if (lastSeenSeq == null) return 0;
  const unread = events.filter((e) => e.seq > lastSeenSeq).sort((a, b) => a.seq - b.seq);
  let count = 0;
  for (let i = 0; i < unread.length; i++) {
    const e = unread[i]!;
    const next = unread[i + 1];
    if (
      next &&
      e.op === "move" &&
      next.op === "move" &&
      next.seq === e.seq + 1 &&
      next.createdAt === e.createdAt
    ) {
      i++; // pair the move's two events into one logical change
    }
    count++;
  }
  return count;
}

/** Badge display for an unread count: "" when zero, "99+" when above 99. */
export function formatUnread(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

/**
 * The seq to seed a fresh watermark to: the newest event's `seq`, so existing
 * history counts as already seen. Null when there is no history to seed from.
 */
export function seedSeq(events: FeedEvent[]): number | null {
  if (events.length === 0) return null;
  return events.reduce((max, e) => (e.seq > max ? e.seq : max), events[0]!.seq);
}

// --- Actor display (shared by the feed and per-file history) ----------------
// Op labels, colours and icons live in utils/changeOps (and OpGlyph.vue).

/** Up to two uppercase initials for an avatar chip. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export interface ActorDisplay {
  name: string;
  isAgent: boolean;
  agentLabel: string | null;
  resolved: boolean; // whether `memberName` resolved a real org member
}

/**
 * Resolve an event's actor for display. `memberName` is the org-member name for
 * `actorId` (the caller resolves it), or null. Falls back to agent/human so a
 * row never renders an empty or "null" actor (R22).
 */
export function actorDisplay(e: ChangeEvent, memberName: string | null): ActorDisplay {
  const isAgent = e.principal === "agent";
  return {
    name: memberName ?? (isAgent ? "agent" : "human"),
    isAgent,
    agentLabel: isAgent ? (e.actorLabel ?? null) : null,
    resolved: !!memberName,
  };
}

/**
 * A short name for who made a change, for a one-line mention: the agent's own
 * label, "You" for the person looking, else the member's name.
 */
export function actorShortName(
  e: Pick<ChangeEvent, "principal" | "actorId" | "actorLabel">,
  userId: string | null,
  memberName: string | null,
): string {
  if (e.principal === "agent") return e.actorLabel ?? "Agent";
  if (userId && e.actorId === userId) return "You";
  return memberName ?? "Someone";
}

/** The `delete` a move leaves at its old path: half of one change, not a deletion. */
function isMoveDeparture(e: ChangeEvent): boolean {
  return e.op === "delete" && !!e.relatedPath;
}

/** One-line summary for a multi-event cluster, e.g. "wrote 14 files" or, for a
 *  mixed-operation burst, "made 11 changes". */
export function clusterSummary(cluster: EventCluster): string {
  if (cluster.operation) return operationSummary(cluster.operation, cluster.events);
  // A move's two events (the delete it leaves behind, and its arrival) are one
  // change, so a rename doesn't read as two.
  const events = cluster.events.filter((e) => !isMoveDeparture(e));
  const n = events.length;
  const ops = new Set(events.map((e) => e.op));
  if (ops.size === 1) return opClusterLabel(events[0]!.op, n);
  return `made ${n} changes`;
}
/** "3:04 pm" today, else "28 Oct, 3:04 pm" (with the year when it isn't this one). */
export function pointInTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "an earlier point";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an earlier point";
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameLocalDay(iso, now.toISOString())) return time;
  const date = d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

/**
 * The feed line for a recovery operation: "restored 42 files from the trash",
 * "restored 12 files in Notes to 3:04 pm", "undid 17 changes by Claude Code".
 * Counts the events this reader can see (a move's two events are one change),
 * never the operation's own total, which includes the runner's private files.
 */
export function operationSummary(op: RecoveryOperationInfo, events: ChangeEvent[]): string {
  const n = events.filter((e) => !isMoveDeparture(e)).length;
  const files = n === 1 ? "1 file" : `${n} files`;
  switch (op.kind) {
    case "trash":
      return `restored ${files} from the trash`;
    case "restore":
      return `restored ${files}${op.scopePath ? ` in ${op.scopePath}` : ""} to ${pointInTime(op.targetAt)}`;
    case "undo":
      return `undid ${n === 1 ? "1 change" : `${n} changes`} by ${op.targetLabel ?? "an agent"}`;
    default:
      return `made ${n === 1 ? "1 change" : `${n} changes`}`;
  }
}
/** "Today", "Yesterday", or a short date: the heading over a day's entries. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Split a newest-first list into consecutive day buckets. */
export function groupByDay<T>(
  items: T[],
  dateOf: (item: T) => string,
  now: Date = new Date(),
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(dateOf(item), now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}