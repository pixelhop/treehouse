import {
  assertInKeyFolder,
  assertReadable,
  fileRoute,
  requirePathQuery,
  requireWorkspaceFromRoute,
} from "../../../../utils/workspace";
import { listInheritedShares, listShares } from "../../../../utils/shares";
import { effectiveAcl, listWorkspaceAcls, outsideKeyFolder } from "../../../../utils/acl";

// List active shares for a path (?path=). `shares` are this path's own shares;
// `inherited` are folder shares on an ancestor that already cover this path
// (so the UI can offer the parent folder's link to it). A restricted path drops
// out of every folder share, so it inherits none — the panel must not offer a
// link that would not open. Returns share views without passwordHash. Any
// workspace member (cookie or key) may list.
export default fileRoute(async (event) => {
  const { ws, access } = await requireWorkspaceFromRoute(event);
  const path = requirePathQuery(event);
  assertInKeyFolder(access, path);
  // A path the caller can't see has no shares they may know about.
  await assertReadable(ws.id, access, path);
  const [shares, inherited, acls] = await Promise.all([
    listShares(ws.id, path),
    listInheritedShares(ws.id, path),
    listWorkspaceAcls(ws.id),
  ]);
  // A key can't be handed a folder link wider than its folder: the token would
  // open everything beside it, with no key at all.
  const reachable = inherited.filter((s) => outsideKeyFolder(access, s.path) === null);
  return { shares, inherited: effectiveAcl(acls, path) ? [] : reachable };
});