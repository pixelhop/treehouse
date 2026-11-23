import { createError, setResponseHeader } from "h3";
import { readPinnedContent } from "../../../../../../utils/comments";
import { fileRoute, requireThreadFromRoute } from "../../../../../../utils/workspace";

// Serve the exact bytes a thread was written against (its content-hash pin),
// immune to version-number reuse after move/delete. Response is hardened like
// the public share route: never sniffed, never scripted, never rendered inline
// on the API origin. 410 when the pinned blob is genuinely gone (terminal —
// content-addressed, so it will not come back under this hash).
export default fileRoute(async (event) => {
  const { ws, threadId, actor } = await requireThreadFromRoute(event);

  const res = await readPinnedContent({
    workspaceId: ws.id,
    actor,
    threadId,
  });
  if (res.status === "not_found") {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  if (res.status === "gone") {
    throw createError({ statusCode: 410, statusMessage: "This version is no longer available" });
  }

  // Threads only exist on markdown files; force the text type rather than
  // trusting the stored one, so this endpoint can never serve live HTML.
  setResponseHeader(event, "Content-Type", "text/markdown; charset=utf-8");
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
  setResponseHeader(event, "Content-Security-Policy", "default-src 'none'; sandbox");
  const safeName = (res.path.split("/").pop() || "file").replace(/[\r\n"]/g, "");
  setResponseHeader(event, "Content-Disposition", `attachment; filename="${safeName}"`);
  setResponseHeader(event, "X-Treehouse-Pinned-Version", String(res.pinnedVersion));
  return Buffer.from(res.body);
});