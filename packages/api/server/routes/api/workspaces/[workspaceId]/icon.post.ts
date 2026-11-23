import { createError, defineEventHandler, getHeader } from "h3";
import { readBodyCapped } from "../../../../utils/body";
import { requireWorkspaceFromRoute, requireWorkspaceWriter } from "../../../../utils/workspace";
import { MAX_ICON_BYTES, setUploadedWorkspaceIcon } from "../../../../utils/workspaceIcon";

function tooLarge() {
  return createError({
    statusCode: 413,
    statusMessage: `Image too large (max ${Math.round(MAX_ICON_BYTES / 1024)}KB)`,
  });
}

// Upload a logo/icon image for a workspace. Raw image bytes as the body (same
// shape as the file PUT), authorized like every other workspace route. The
// stored format is sniffed from the bytes, so the declared Content-Type is
// advisory only. Returns the updated workspace, whose `icon` now reads
// `upload:<sha256>`.
export default defineEventHandler(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  requireWorkspaceWriter(access);

  // Reject an oversized upload before reading a byte when the client declares
  // its size; the capped read is the backstop for chunked/undeclared bodies.
  const declared = getHeader(event, "content-length");
  if (declared) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > MAX_ICON_BYTES) throw tooLarge();
  }

  const bytes = await readBodyCapped(event, MAX_ICON_BYTES, tooLarge);
  return setUploadedWorkspaceIcon(ws.id, new Uint8Array(bytes));
});