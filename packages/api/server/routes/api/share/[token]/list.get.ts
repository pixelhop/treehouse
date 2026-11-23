import { usePrismaClient } from "db";
import { createError } from "h3";
import { effectiveAcl, listWorkspaceAcls } from "../../../../utils/acl";
import { useFileService } from "../../../../utils/files";
import { assertUnlocked, requirePublicShare } from "../../../../utils/public-share";
import { countShareView } from "../../../../utils/share-usage";
import { fileRoute } from "../../../../utils/workspace";

// List a shared folder's subtree read-only, without login. Scope is the share's
// own prefix, so every returned entry is in-scope by construction.
//
// `icons`/`orders` are the same path→value maps the authenticated listing
// returns, so the public viewer renders the same tree the workspace does
// (custom icons, manual sibling order). They are filtered to the share's own
// subtree and to non-private nodes — a public link must never enumerate a path
// outside what it shares, and node metadata is a path listing.
export default fileRoute(async (event) => {
  const { token, share } = await requirePublicShare(event);
  assertUnlocked(event, token, share);
  // Counted only once the unlock gate has passed: a visitor still facing the
  // password prompt has not seen anything. Deduplicated per visitor per day, so
  // a folder portal that then fetches twenty files is still one view.
  await countShareView(event, share);
  if (share.kind !== "folder") {
    throw createError({ statusCode: 400, statusMessage: "Not a folder share" });
  }

  // Drop any entry that has since been made private — a share never enumerates a
  // now-private node (re-checked per request, like the file-serving route).
  //
  // `.keep` placeholders stay in: they are how an empty folder exists at all, and
  // without them the viewer cannot show (or deep-link to) an empty sub-folder
  // the member can see. The viewer builds its tree from them, exactly as the
  // workspace tree does, and never shows them as files.
  const acls = await listWorkspaceAcls(share.workspaceId);
  const entries = (await useFileService().list(share.workspaceId, share.path, "trusted")).filter(
    (e) => !effectiveAcl(acls, e.path),
  );

  // Prefix-match in the database, then re-check the boundary in code: a raw
  // `startsWith` on the share path would also match a sibling folder whose name
  // merely begins with it ("notes-private" for a share of "notes").
  const inShare = (path: string) =>
    !share.path || path === share.path || path.startsWith(`${share.path}/`);
  const metas = await usePrismaClient().nodeMeta.findMany({
    where: { workspaceId: share.workspaceId, path: { startsWith: share.path } },
    select: { path: true, icon: true, order: true },
  });
  const icons: Record<string, string> = {};
  const orders: Record<string, number> = {};
  for (const m of metas) {
    if (!inShare(m.path) || effectiveAcl(acls, m.path)) continue;
    if (m.icon) icons[m.path] = m.icon;
    if (m.order != null) orders[m.path] = m.order;
  }

  return {
    path: share.path,
    entries: entries.map((e) => ({
      path: e.path,
      size: e.size,
      contentType: e.contentType,
      version: e.version,
    })),
    icons,
    orders,
  };
});