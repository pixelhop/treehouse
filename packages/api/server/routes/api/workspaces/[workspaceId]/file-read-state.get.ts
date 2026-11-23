import { usePrismaClient } from "db";
import { createError, getQuery, getRouterParam } from "h3";
import { baseContentType } from "shared";
import { resolveAnchor } from "../../../../utils/anchoring";
import { useFileService } from "../../../../utils/files";
import { normalizePath } from "../../../../utils/paths";
import {
  assertReadable,
  authorizeWorkspace,
  fileRoute,
  requireCookieUser,
} from "../../../../utils/workspace";

// What happened to one file since the caller last looked at it (R11), plus the
// bytes the "changes since you last looked" view diffs against (R12).
//
// Hash-keyed, never version-keyed (KTD7): version numbers reset on move and are
// reused after delete/resurrect, so the recap trigger compares content hashes
// and the track-changes base is located by the stored hash. A stored hash that
// is not in THIS path's current incarnation — the file was deleted or moved
// away and something else was created at the same path — degrades to a first
// visit rather than diffing a stranger's document.
//
// Session-only: agents get no read state (their catch-up is `list_comments`).
// The caller never names a content hash; it is read from their own row.

/** A base bigger than this isn't diffed in the browser — the toggle just hides. */
const MAX_BASE_BYTES = 1024 * 1024;

interface RecapView {
  versions: number;
  newThreads: number;
  replies: number;
  resolved: number;
  reopened: number;
  /** Threads that anchored against the last-seen bytes and no longer do. */
  newlyOutdated: number;
  actors: { principal: string; actorId: string | null; actorLabel: string | null }[];
  since: string | null;
}

const CONTENT_OPS = new Set(["write", "restore", "move"]);

export default fileRoute(async (event) => {
  const ctx = await requireCookieUser(event);
  const workspaceId = getRouterParam(event, "workspaceId");
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: "Missing workspaceId" });
  const ws = await authorizeWorkspace(ctx, workspaceId);
  const db = usePrismaClient();

  const raw = getQuery(event).path;
  if (typeof raw !== "string" || !raw) {
    throw createError({ statusCode: 400, statusMessage: "path is required" });
  }
  const path = normalizePath(raw);
  // Fail-as-404 on a private path, like every other comment-adjacent read.
  await assertReadable(ws.id, ws.access, path);

  const node = await db.fileNode.findUnique({
    where: { workspaceId_path: { workspaceId: ws.id, path } },
    select: { contentHash: true, version: true, contentType: true },
  });
  const row = await db.fileReadState.findUnique({
    where: { userId_workspaceId_path: { userId: ctx.userId, workspaceId: ws.id, path } },
  });

  const none = {
    path,
    firstVisit: true,
    staleBase: false,
    changed: false,
    lastSeenVersion: null as number | null,
    currentVersion: node?.version ?? null,
    base: null as { version: number; text: string } | null,
    recap: null as RecapView | null,
  };
  if (!row || !node) return none;

  // The current incarnation of this path starts after its most recent delete
  // (a move away emits one on the source path). Anything the feed remembers
  // from before that belongs to a different document that merely shares a name.
  const lastDelete = await db.changeEvent.findFirst({
    where: { workspaceId: ws.id, path, op: "delete" },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const incarnationFrom = lastDelete?.seq ?? 0n;

  const changed = node.contentHash !== row.lastSeenContentHash;
  // Locate the last-seen bytes in this incarnation's history. `changed: false`
  // needs no lookup — the hash IS the current node.
  const baseEvent = changed
    ? await db.changeEvent.findFirst({
        where: {
          workspaceId: ws.id,
          path,
          contentHash: row.lastSeenContentHash,
          seq: { gt: incarnationFrom },
        },
        orderBy: { seq: "desc" },
        select: { version: true },
      })
    : null;
  if (changed && !baseEvent) return { ...none, staleBase: true };

  const svc = useFileService();
  const isMarkdown = baseContentType(node.contentType) === "text/markdown";
  let base: { version: number; text: string } | null = null;
  if (changed && isMarkdown) {
    const blob = await svc.readByHash(ws.id, row.lastSeenContentHash);
    if (blob.status === "ok" && blob.body.byteLength <= MAX_BASE_BYTES) {
      base = { version: baseEvent?.version ?? row.lastSeenVersion, text: decode(blob.body) };
    }
  }

  // Everything on this path the caller hasn't seen, comment traffic included —
  // the recap's whole job is to say what happened while they were away.
  const events = await db.changeEvent.findMany({
    where: { workspaceId: ws.id, path, seq: { gt: row.lastSeenSeq } },
    orderBy: { seq: "asc" },
  });

  const actors = new Map<string, RecapView["actors"][number]>();
  const recap: RecapView = {
    versions: 0,
    newThreads: 0,
    replies: 0,
    resolved: 0,
    reopened: 0,
    newlyOutdated: 0,
    actors: [],
    since: events[0]?.createdAt.toISOString() ?? null,
  };
  for (const e of events) {
    if (CONTENT_OPS.has(e.op)) recap.versions += 1;
    else if (e.op === "comment_created") recap.newThreads += 1;
    else if (e.op === "comment_replied") recap.replies += 1;
    else if (e.op === "comment_resolved") recap.resolved += 1;
    else if (e.op === "comment_reopened") recap.reopened += 1;
    else continue;
    const key = `${e.principal}:${e.actorId ?? ""}:${e.actorKeyId ?? ""}`;
    if (!actors.has(key)) {
      actors.set(key, { principal: e.principal, actorId: e.actorId, actorLabel: e.actorLabel });
    }
  }
  recap.actors = [...actors.values()];

  // "Newly outdated" is answerable exactly, because both sides are in hand: a
  // thread that anchored in the bytes they last saw and doesn't in the bytes
  // they're looking at now is one the rewrite pulled the ground out from under.
  if (base) {
    const current = await svc.readByHash(ws.id, node.contentHash);
    if (current.status === "ok") {
      const currentText = decode(current.body);
      const threads = await db.commentThread.findMany({
        where: { workspaceId: ws.id, path, resolvedAt: null },
      });
      for (const t of threads) {
        const anchor = {
          kind: t.anchorKind === "point" ? ("point" as const) : ("range" as const),
          quote: t.quote,
          contextBefore: t.contextBefore,
          contextAfter: t.contextAfter,
          sourceStart: t.sourceStart,
          sourceEnd: t.sourceEnd,
        };
        const then = resolveAnchor(anchor, base.text, row.lastSeenContentHash);
        if (then.status !== "anchored") continue;
        const now = resolveAnchor(anchor, currentText, node.contentHash);
        if (now.status !== "anchored") recap.newlyOutdated += 1;
      }
    }
  }

  return {
    path,
    firstVisit: false,
    staleBase: false,
    changed,
    lastSeenVersion: row.lastSeenVersion,
    currentVersion: node.version,
    base,
    recap,
  };
});

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}