import { createError, getRouterParam, readBody } from "h3";
import { getShare, setShareScripts } from "../../../../../utils/shares";
import {
  assertInKeyFolder,
  fileRoute,
  requireWorkspaceFromRoute,
  requireWriter,
} from "../../../../../utils/workspace";

// Change what an existing link is allowed to do, without minting a new one:
// whether a shared HTML page may run its own scripts. Only that.
//
// It deliberately does NOT pin. Enabling scripts on a live link authorizes
// whatever the file becomes, and the tempting answer — "pin it to what I am
// looking at, here, now" — turns one boolean into a distributed-systems problem:
// which bytes did the caller actually see, what if they changed mid-click, what
// may a machine credential do with it. A pinned link is made at creation, where
// the person IS looking at the file and the question has an honest answer.
//
// It exists rather than making people revoke and re-create because the URL is
// the thing being edited around — someone reaches for this when a link is
// already with a client who reports that the deck does not respond to the arrow
// keys, and handing them a different URL to re-send is a worse answer.
//
// Enabling execution is gated like minting a public link (KTD4): a logged-in
// cookie session only, never an API key. A leaked agent or CLI key must not be
// able to turn a quiet public link into one that runs code in a visitor's
// browser. Turning it OFF is deliberately ungated — taking a capability away is
// always safe, and a key that can revoke should be able to defuse too.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  requireWriter(access);
  const shareId = getRouterParam(event, "shareId");
  if (!shareId) throw createError({ statusCode: 400, statusMessage: "Missing shareId" });

  const body = await readBody<{ allowScripts?: boolean }>(event);
  if (typeof body?.allowScripts !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "allowScripts (boolean) is required" });
  }

  // An API key may only ever take capability AWAY here (KTD4): a leaked agent or
  // CLI key must be able to defuse a link, and nothing else.
  if (ctx.keyId && body.allowScripts) {
    throw createError({
      statusCode: 403,
      statusMessage: "Letting a link run scripts requires a logged-in session, not an API key",
    });
  }

  const share = await getShare(ws.id, shareId);
  if (!share) throw createError({ statusCode: 404, statusMessage: "Share not found" });
  assertInKeyFolder(access, share.path);

  // Same fail-closed rule as creation: a folder share's rendered page carries
  // this link's own token in every rewritten reference, so it must never
  // execute. See shares.post.ts for the reasoning in full.
  if (body.allowScripts && share.kind === "folder") {
    throw createError({
      statusCode: 400,
      statusMessage: "Folder links cannot run scripts: their page URLs carry the share token",
    });
  }

  const updated = await setShareScripts(ws.id, shareId, body.allowScripts);
  if (!updated) throw createError({ statusCode: 404, statusMessage: "Share not found" });
  return { share: updated };
});