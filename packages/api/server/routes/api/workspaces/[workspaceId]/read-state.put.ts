import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import {
  advanceReadState,
  authorizeWorkspace,
  requireCookieUser,
} from "../../../../utils/workspace";

// Advance the caller's last-seen position in this workspace's change feed
// (monotonic — see advanceReadState). Cookie-session only and rejects API-key
// auth: advancing a human's "seen" state has no agent use case, and an agent
// key writing it would silently corrupt the human's unread state. The watermark
// is keyed on the session user + route workspace; the body sets only the seq.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const workspaceId = getRouterParam(event, "workspaceId");
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: "Missing workspaceId" });
  await authorizeWorkspace(ctx, workspaceId);

  const body = await readBody<{ lastSeenSeq?: unknown }>(event);
  const raw = body?.lastSeenSeq;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > Number.MAX_SAFE_INTEGER
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "lastSeenSeq must be a non-negative integer",
    });
  }

  const stored = await advanceReadState(workspaceId, ctx.userId, BigInt(raw));
  return { lastSeenSeq: Number(stored) };
});