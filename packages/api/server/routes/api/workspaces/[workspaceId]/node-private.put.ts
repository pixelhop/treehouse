import { createError, readBody } from "h3";
import { clearNodePrivate, isSharedBeyond, setNodePrivate } from "../../../../utils/acl";
import {
  actorFor,
  assertLiftKeepsWrite,
  assertWritable,
  fileRoute,
  nodePathFrom,
  requireWorkspaceFromRoute,
} from "../../../../utils/workspace";

// Mark or unmark a file/folder as private to the caller. Marking restricts the
// node to {caller at write} and applies to its subtree by inheritance; unmarking
// lifts the node's restriction. Either way the caller must be able to write the
// node: a viewer gets 409 read_only, and a restricted node they hold no grant on
// reads as 404 so it stays undiscoverable. Marking always keeps the caller in,
// so nobody can lock themselves out by accident.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  const body = await readBody<{ path?: string; kind?: string; private?: boolean }>(event);
  const path = nodePathFrom(body);
  const kind = body?.kind === "file" ? "file" : "folder";
  const makePrivate = body?.private !== false; // default true

  await assertWritable(ws.id, access, path);
  if (await isSharedBeyond(ws.id, path, ctx.userId)) {
    throw createError({ statusCode: 409, statusMessage: "This is shared with specific people" });
  }
  if (makePrivate) {
    await setNodePrivate({
      workspaceId: ws.id,
      path,
      kind,
      ownerId: ctx.userId,
      actor: actorFor(ctx, access),
    });
    return { path, private: true };
  }

  await assertLiftKeepsWrite(ws.id, access, path);
  await clearNodePrivate(ws.id, path, actorFor(ctx, access));
  return { path, private: false };
});