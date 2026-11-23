import type { Share } from "db";
import { usePrismaClient } from "db";
import { defineEventHandler, getCookie } from "h3";
import { effectiveAcl, listWorkspaceAcls } from "../../../../utils/acl";
import { requirePublicShare } from "../../../../utils/public-share";
import { countShareView } from "../../../../utils/share-usage";
import { shareCookieName, verifyShareUnlock } from "../../../../utils/shares";

// Public share metadata — enough for the viewer to render the gate/header and
// dress itself in the workspace's theme, never any content. `unlocked` reports
// whether this request already holds a valid unlock cookie, so the viewer can
// skip the password gate (and the probe-401) without fetching content.
//
// The workspace's identity (name, icon, colour, theme) and the shared node's own
// icon are the share's branding, and are deliberately served BEFORE the password
// gate so a locked link already looks like the workspace it came from. That does
// mean the workspace NAME is visible to anyone holding the link — the same
// exposure the shared folder's own name already carries. Nothing here names
// another path, another member, or any file content.
//
// `file` (a file share's size/type/version, which the viewer needs to pick a
// renderer without first downloading the bytes) IS gated: it describes the
// shared content, so a locked share withholds it until the password lands. The
// viewer refetches this route after unlocking.
export default defineEventHandler(async (event) => {
  const { token, share } = await requirePublicShare(event);
  const unlocked =
    !share.passwordHash || verifyShareUnlock(token, getCookie(event, shareCookieName(token)));

  // Metadata is the first thing the viewer fetches, so this is where an open
  // link registers its view. A still-locked link counts nothing.
  if (unlocked) await countShareView(event, share);

  // A node made private after the link was minted stops being described here,
  // exactly as it stops being served (see file.get.ts).
  const describeFile = share.kind === "file" && unlocked;
  const db = usePrismaClient();
  const [workspace, ownMeta, acls] = await Promise.all([
    db.workspace.findUnique({
      where: { id: share.workspaceId },
      // `id` is here so an uploaded image icon can be rendered: its bytes URL
      // is workspace-scoped. The id grants nothing on its own — every workspace
      // route still checks membership, and the icon route only ever serves the
      // workspace's CURRENT icon.
      select: { id: true, name: true, icon: true, color: true, theme: true, themeCss: true },
    }),
    db.nodeMeta.findFirst({
      where: { workspaceId: share.workspaceId, path: share.path },
      select: { icon: true },
    }),
    describeFile ? listWorkspaceAcls(share.workspaceId) : [],
  ]);

  const file =
    describeFile && !effectiveAcl(acls, share.path) ? await describeSharedFile(share) : null;

  return {
    kind: share.kind,
    name: share.path.split("/").pop() ?? share.path,
    icon: ownMeta?.icon ?? null,
    workspace: {
      id: workspace?.id ?? null,
      name: workspace?.name ?? "",
      icon: workspace?.icon ?? null,
      color: workspace?.color ?? null,
    },
    theme: workspace?.theme ?? null,
    themeCss: workspace?.themeCss ?? null,
    hasPassword: !!share.passwordHash,
    pinnedVersion: share.pinnedVersion,
    // Whether a shared HTML page may run its own scripts. Decided by the member
    // who minted the link, not by the visitor: a stranger holding a URL has no
    // way to judge what is in the file, so they are never asked. Safe to serve
    // before the password gate — it describes the link's capability, not its
    // content, and the sandbox that contains the page is the app's either way.
    allowScripts: share.allowScripts,
    unlocked,
    file,
  };
});

/**
 * Describe the bytes a file share serves, so the viewer can pick a renderer
 * without downloading them first.
 *
 * A PINNED share addresses its bytes by content hash, not by path: the file
 * route serves them even after the path is deleted or replaced (see
 * file.get.ts). So the live node at that path describes the wrong thing — it is
 * absent after a delete, and after a delete-and-recreate it describes the
 * REPLACEMENT while the link still serves the original. Match on the content
 * hash instead (preferring the node still at the shared path, since identical
 * bytes can live under two names), and when no node carries those bytes any
 * more report the type as unknown: `viewerKind` then picks the renderer from
 * the file extension, which is enough to render a permalink whose source file
 * is long gone.
 */
async function describeSharedFile(share: Share) {
  const db = usePrismaClient();
  const select = { path: true, size: true, contentType: true, version: true } as const;

  if (!share.pinnedContentHash) {
    return db.fileNode.findUnique({
      where: { workspaceId_path: { workspaceId: share.workspaceId, path: share.path } },
      select,
    });
  }

  const carriers = await db.fileNode.findMany({
    where: { workspaceId: share.workspaceId, contentHash: share.pinnedContentHash },
    select,
  });
  const node = carriers.find((c) => c.path === share.path) ?? carriers[0];
  return {
    path: share.path,
    // 0 renders as "unknown size" rather than a wrong one (see BinaryViewer).
    size: node?.size ?? 0,
    contentType: node?.contentType ?? "",
    version: share.pinnedVersion ?? node?.version ?? 1,
  };
}