import { readBody } from "h3";
import { previewOf } from "../../../../../utils/recovery";
import { planFromBody } from "../../../../../utils/recovery-request";
import {
  fileRoute,
  requireWorkspaceFromRoute,
  requireWriter,
} from "../../../../../utils/workspace";

// What a recovery (trash restore, point-in-time restore, undo) would change,
// without changing anything. Body: { kind, ... } — see recovery-request.ts.
export default fileRoute(async (event) => {
  const { ctx, ws, access } = await requireWorkspaceFromRoute(event);
  requireWriter(access);
  const { plan } = await planFromBody(ws.id, ctx, access, await readBody(event));
  return previewOf(plan);
});