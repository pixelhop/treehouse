import { openUsageReport } from "blob-io/blob-grant";
import { createError, defineEventHandler, sendNoContent } from "h3";
import { useGrantRing } from "../../../utils/blob-worker";
import { readBodyCapped } from "../../../utils/body";
import { countShareBytes } from "../../../utils/share-usage";

/**
 * A sealed report is a few hundred bytes. The cap is generous for that and
 * small enough that an unauthenticated caller cannot make this route buffer
 * anything worth having: the body is read before it can be authenticated.
 */
const MAX_REPORT_BYTES = 4096;

// Service-to-service: the byte Worker reports how many bytes it actually sent
// for a public share link, so the link's byte ceilings keep counting once the
// bytes no longer pass through the API.
//
// No session and no separate secret: the body is a report sealed under the
// same key ring as the grants (a different purpose label, so a grant cannot be
// replayed as a report), which only the API and the Worker hold. A stale report
// is refused. Anything else gets a bare 401.
//
// It needs only the key, not BLOB_WORKER_URL: after the URL is removed to turn
// redirects off, grants already issued keep serving, and reporting, until they
// expire.
export default defineEventHandler(async (event) => {
  const ring = useGrantRing();
  if (!ring) throw createError({ statusCode: 404, statusMessage: "Not found" });
  const body = await readBodyCapped(event, MAX_REPORT_BYTES, () =>
    createError({ statusCode: 413, statusMessage: "Payload Too Large" }),
  );
  const report = openUsageReport(ring, body.toString("utf8").trim(), Math.floor(Date.now() / 1000));
  if (!report) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  await countShareBytes(report.workspaceId, report.bytes);
  return sendNoContent(event, 204);
});