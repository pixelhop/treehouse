import { createError, defineEventHandler, readBody } from "h3";
import {
  assertWritable,
  NODE_PATH_MAX,
  requireWorkspaceFromRoute,
  setNodeOrder,
} from "../../../../utils/workspace";

// Persist a custom display order for the children of one folder. Body carries
// the full ordered list of sibling paths; each gets its index as `order`.
export default defineEventHandler(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const body = await readBody<{ paths?: unknown }>(event);
  const paths = Array.isArray(body?.paths) ? body.paths : null;
  if (!paths) throw createError({ statusCode: 400, statusMessage: "paths[] is required" });
  // A single folder's child list won't be huge; cap keeps the per-path upsert
  // transaction bounded.
  if (paths.length > 1000) throw createError({ statusCode: 400, statusMessage: "too many paths" });

  const clean = paths.filter(
    (p): p is string => typeof p === "string" && !!p && p.length <= NODE_PATH_MAX,
  );
  if (clean.length !== paths.length)
    throw createError({ statusCode: 400, statusMessage: "invalid path in list" });
  // Duplicate paths would upsert the same row twice in one transaction (deadlock
  // / constraint risk) and are never a legitimate sibling list.
  if (new Set(clean).size !== clean.length)
    throw createError({ statusCode: 400, statusMessage: "duplicate paths are not allowed" });

  // Reordering rewrites each listed node's shared display metadata, so it takes
  // write access to every one of them (and never touches a node the caller
  // can't see).
  await assertWritable(ws.id, access, ...clean);
  await setNodeOrder(ws.id, clean);
  return { ok: true, count: clean.length };
});