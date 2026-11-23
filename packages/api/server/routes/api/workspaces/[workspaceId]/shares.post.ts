import { createError, readBody, setResponseStatus } from "h3";
import { effectiveAcl, listWorkspaceAcls } from "../../../../utils/acl";
import { useFileService } from "../../../../utils/files";
import {
  assertWritable,
  fileRoute,
  requireWorkspaceFromRoute,
  requireWriter,
} from "../../../../utils/workspace";
import { createShare } from "../../../../utils/shares";

// Create a share for a file or folder. Member links reuse existing auth; public
// (and any password-protected) links are a new unauthenticated access surface, so
// per KTD4 they may only be minted from a logged-in cookie session — never via an
// API key, so a leaked agent/CLI key can't open up public access.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  // Publishing a link is a change to who can reach a node; viewers and read-only
  // keys can't.
  requireWriter(access);
  const body = await readBody<{
    path?: string;
    kind?: string;
    access?: string;
    password?: string;
    pinnedVersion?: number;
    pinnedContentHash?: string;
    allowScripts?: boolean;
  }>(event);

  if (
    !body?.path ||
    (body.kind !== "file" && body.kind !== "folder") ||
    (body.access !== "member" && body.access !== "public")
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "path, kind (file|folder) and access (member|public) are required",
    });
  }

  // Validated, not coerced. `body` is a TypeScript shape over untyped JSON, so
  // `allowScripts: "true"` would otherwise sail through: truthy enough to be
  // treated as sensitive below, but stored as false. A capability flag that
  // silently disagrees with what the caller sent is worse than a 400.
  if (body.allowScripts !== undefined && typeof body.allowScripts !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "allowScripts must be a boolean" });
  }

  // Folder shares cannot run scripts, and this is a fail-closed refusal rather
  // than a UI omission. A folder share is the one case where the viewer rewrites
  // references to sibling files, and those URLs carry the share's own token
  // (`/api/share/<token>/file?path=…`). Handing that document script means
  // handing it a bearer token for the whole shared subtree, which it can read
  // straight out of its own DOM and post anywhere. A file share never has the
  // token written into it (`reachesSiblings` is false, so nothing is rewritten).
  if (body.allowScripts && body.kind === "folder") {
    throw createError({
      statusCode: 400,
      statusMessage: "Folder links cannot run scripts: their page URLs carry the share token",
    });
  }

  // A restricted node (or anything under one) can't get a link of any kind. A
  // link is reachable by people the restriction deliberately leaves out — a
  // public one by anyone at all — so allowing it would make the restriction
  // meaningless. Asked before anything else, so the 409 can't disclose a node
  // the caller can't see: they'd get the same answer as for a missing path.
  await assertWritable(ws.id, access, body.path);
  const acls = await listWorkspaceAcls(ws.id);
  if (effectiveAcl(acls, body.path)) {
    throw createError({ statusCode: 409, statusMessage: "Cannot share a restricted item" });
  }

  // Letting a link execute is as sensitive as opening one: it is the difference
  // between a stranger reading bytes and a stranger's browser running them.
  const sensitive = body.access === "public" || !!body.password || !!body.allowScripts;
  if (sensitive && ctx.keyId) {
    throw createError({
      statusCode: 403,
      statusMessage:
        "Public or password-protected links require a logged-in session, not an API key",
    });
  }

  // Derive the pinned content hash server-side from (path, version) — never trust
  // a client-supplied hash, which could point a benignly-labelled share at any
  // other file's bytes in the workspace.
  //
  // When the client DOES send one it is treated as a precondition, not a value:
  // it names the bytes the member was looking at. That matters because a version
  // number is reused when a path is deleted and recreated, so "version 1 of this
  // path" can be different content from the version 1 on their screen — and a
  // pinned link that also executes would then run bytes nobody reviewed. Derived
  // here, compared, and a mismatch is a 409 rather than a silent substitution.
  let pinnedVersion: number | undefined;
  let pinnedContentHash: string | undefined;
  if (typeof body.pinnedVersion === "number") {
    const v = await useFileService().readVersion({
      workspaceId: ws.id,
      path: body.path,
      version: body.pinnedVersion,
      viewer: access,
    });
    if (v.status !== "ok") {
      throw createError({ statusCode: 400, statusMessage: "Pinned version is not available" });
    }
    // A link that will EXECUTE must name its bytes completely: a version alone is
    // not an identity (delete-and-recreate reuses it), so "pin version 1 and run
    // it" could execute content the caller never reviewed.
    if (body.allowScripts === true && !body.pinnedContentHash) {
      throw createError({
        statusCode: 400,
        statusMessage: "A pinned link that runs scripts must name the content it was reviewed at",
      });
    }
    if (typeof body.pinnedContentHash === "string" && body.pinnedContentHash !== v.contentHash) {
      throw createError({
        statusCode: 409,
        statusMessage: "This file changed since you looked at it — review it again",
      });
    }
    pinnedVersion = body.pinnedVersion;
    pinnedContentHash = v.contentHash;
  }

  const share = await createShare({
    workspaceId: ws.id,
    path: body.path,
    kind: body.kind,
    access: body.access,
    password: body.password || undefined,
    pinnedVersion,
    pinnedContentHash,
    allowScripts: body.allowScripts === true,
    createdBy: ctx.userId,
  });

  setResponseStatus(event, 201);
  return { share };
});