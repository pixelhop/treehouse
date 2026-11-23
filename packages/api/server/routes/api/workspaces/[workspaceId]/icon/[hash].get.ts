import { usePrismaClient } from "db";
import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { uploadedIconHash } from "shared";
import { useBlobStore } from "../../../../../utils/storage";
import { iconBlobKey } from "../../../../../utils/workspaceIcon";

/**
 * Serve a workspace's uploaded icon bytes.
 *
 * Deliberately unauthenticated: the icon is chrome that renders in places where
 * the viewer is not (yet) a member — the invite preview shows the workspace they
 * are being invited to before they can accept. The URL is a capability: it needs
 * both the workspace id and the icon's sha256, and it only ever serves the icon
 * the workspace CURRENTLY wears, so replacing an icon immediately kills the old
 * link. Content-addressed bytes never change, hence the immutable cache.
 */
export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, "workspaceId");
  const hash = getRouterParam(event, "hash");
  if (!workspaceId || !hash) throw createError({ statusCode: 400, statusMessage: "Bad request" });

  const ws = await usePrismaClient().workspace.findUnique({
    where: { id: workspaceId },
    select: { icon: true },
  });
  if (!ws || uploadedIconHash(ws.icon) !== hash) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }

  const blob = await useBlobStore().get(iconBlobKey(workspaceId, hash));
  if (!blob) throw createError({ statusCode: 502, statusMessage: "Icon bytes missing" });

  setResponseHeader(event, "Content-Type", blob.contentType);
  setResponseHeader(event, "Cache-Control", "public, max-age=31536000, immutable");
  return Buffer.from(blob.body);
});