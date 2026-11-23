import { usePrismaClient } from "db";
import { createError, getRouterParam, readBody } from "h3";
import { normalizePath } from "../../../../utils/paths";
import {
  assertReadable,
  authorizeWorkspace,
  fileRoute,
  requireCookieUser,
} from "../../../../utils/workspace";

// Mark this file as seen at the version the caller is looking at (KTD7). The
// body names the path and the version that was ON SCREEN; the seq and content
// hash are looked up from that version's own event and written in one
// statement, so the row describes a snapshot the caller demonstrably saw and no
// route ever accepts a hash from a client.
//
// An earlier version of this route resolved "latest" here and claimed the row
// could therefore never describe a version the caller had not seen. That was
// backwards: with the file open at v1, a write landing as v2 raises a
// non-blocking banner, and a reader who navigates away without reloading gets
// v2 recorded for them — silently swallowing the recap for the one case R11
// exists to cover. A version we cannot place in this incarnation still falls
// back to current, which over-reports rather than under-reports.
//
// Advance is monotonic on `lastSeenSeq` ONLY. Version numbers legitimately
// reset to 1 on move/resurrect, so a version-monotonic guard would wedge the
// recap on exactly the files it matters most for.
//
// Cookie-session only, like the workspace watermark: an agent key advancing a
// human's "seen" state has no use case and silently corrupts their recap.
export default fileRoute(async (event) => {
  const ctx = await requireCookieUser(event);
  const workspaceId = getRouterParam(event, "workspaceId");
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: "Missing workspaceId" });
  const ws = await authorizeWorkspace(ctx, workspaceId);
  const db = usePrismaClient();

  const body = await readBody<{ path?: unknown; version?: unknown }>(event);
  if (typeof body?.path !== "string" || !body.path) {
    throw createError({ statusCode: 400, statusMessage: "path is required" });
  }
  // The version the caller actually had ON SCREEN. Resolving "latest" here
  // instead was a real bug: with the file open at v1, an agent writing v2 raises
  // a non-blocking banner, and a reader who navigates away without reloading
  // never saw v2 — but the watermark recorded it, so the next visit reported
  // nothing changed and swallowed the recap for exactly the case R11 exists for.
  const viewed =
    typeof body.version === "number" && Number.isInteger(body.version) && body.version > 0
      ? body.version
      : null;
  const path = normalizePath(body.path);
  await assertReadable(ws.id, ws.access, path);

  // A deleted file has no snapshot to record; leaving the old row alone keeps
  // the recap honest if the path is recreated (the hash-keyed base makes a
  // stale row safe — it degrades to a first visit).
  const node = await db.fileNode.findUnique({
    where: { workspaceId_path: { workspaceId: ws.id, path } },
    select: { contentHash: true, version: true },
  });
  if (!node) throw createError({ statusCode: 404, statusMessage: "Not found" });

  // The feed position for THIS path — what "since you last looked" is measured
  // from. Path-scoped, so unrelated workspace traffic never marks this file read.
  // Anything before the path's most recent delete belongs to a different
  // document that merely shares the name (the GET route reasons the same way).
  const lastDelete = await db.changeEvent.findFirst({
    where: { workspaceId: ws.id, path, op: "delete" },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const incarnationFrom = lastDelete?.seq ?? 0n;

  // A stated version is honoured only if this incarnation actually has it: the
  // hash and the feed position both come from that version's own event, so the
  // row describes a snapshot the caller demonstrably saw. A version we can't
  // place (pruned history, or a client claiming one that never existed here)
  // falls back to current rather than inventing a position.
  const viewedEvent =
    viewed !== null && viewed <= node.version
      ? await db.changeEvent.findFirst({
          where: {
            workspaceId: ws.id,
            path,
            version: viewed,
            seq: { gt: incarnationFrom },
            contentHash: { not: null },
          },
          orderBy: { seq: "desc" },
          select: { seq: true, contentHash: true },
        })
      : null;

  const latest = await db.changeEvent.findFirst({
    where: { workspaceId: ws.id, path },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const seq = viewedEvent?.seq ?? latest?.seq ?? 0n;
  const snapshot = {
    lastSeenSeq: seq,
    lastSeenVersion: viewedEvent ? viewed! : node.version,
    lastSeenContentHash: viewedEvent?.contentHash ?? node.contentHash,
  };

  // One conditional UPDATE that only ever raises the seq, so a stale tab can't
  // pull the watermark back; the version/hash ride along in the same statement.
  const raised = await db.fileReadState.updateMany({
    where: { userId: ctx.userId, workspaceId: ws.id, path, lastSeenSeq: { lt: seq } },
    data: snapshot,
  });
  if (raised.count > 0) {
    return { lastSeenSeq: Number(seq), lastSeenVersion: snapshot.lastSeenVersion };
  }

  // Nothing raised: either there's no row yet, or the stored seq already meets
  // this one (nothing has happened here since) — create, else leave it alone.
  const stored = await db.fileReadState.upsert({
    where: { userId_workspaceId_path: { userId: ctx.userId, workspaceId: ws.id, path } },
    create: { userId: ctx.userId, workspaceId: ws.id, path, ...snapshot },
    update: {},
  });
  return { lastSeenSeq: Number(stored.lastSeenSeq), lastSeenVersion: stored.lastSeenVersion };
});