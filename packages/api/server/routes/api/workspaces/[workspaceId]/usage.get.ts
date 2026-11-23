import { useFileService } from "../../../../utils/files";
import { fileCountStatus, limitsForWorkspace, quotaStatus } from "../../../../utils/quota";
import { billingForWorkspace } from "../../../../utils/billing-summary";
import { shareLimitState } from "../../../../utils/share-usage";
import { fileRoute, requireWorkspaceFromRoute } from "../../../../utils/workspace";

// Current usage for a workspace against its plan's limits: bytes, live file
// count, and the per-file ceiling. `limitBytes`/`limitFiles` (and their
// `remaining` counterparts) are null when unlimited; `warning` flags that usage
// has reached the warn ratio of a set limit. Both figures come from Postgres —
// never the blob store, which can degrade to ephemeral disk.
export default fileRoute(async (event) => {
  const { ctx, ws } = await requireWorkspaceFromRoute(event);
  const svc = useFileService();
  const limits = await limitsForWorkspace(ws.id);
  const [usedBytes, usedFiles, shares, billing] = await Promise.all([
    svc.usage(ws.id),
    svc.fileCount(ws.id),
    shareLimitState(ws.id),
    billingForWorkspace(ws.id, ctx.userId),
  ]);
  return {
    ...quotaStatus({ usedBytes, limitBytes: limits.storageBytes }),
    ...fileCountStatus({ usedFiles, limitFiles: limits.files }),
    maxFileBytes: limits.maxFileBytes,
    // Share traffic against the published view limit, so the app can show
    // views-remaining on each link and warn before anything goes dark.
    shareViews: shares.usage.monthViews,
    shareViewLimit: shares.viewLimit,
    shareViewsRemaining: shares.viewsRemaining,
    shareWarning: shares.warning,
    sharesPaused: shares.paused,
    // The plan itself. Sent alongside usage because they are always rendered
    // together, so splitting them would mean two requests and two caches that
    // could disagree.
    billing,
  };
});