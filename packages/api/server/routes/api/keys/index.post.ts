import { defineEventHandler, type H3Event, readBody } from "h3";
import { auth } from "../../../utils/auth";
import {
  keyScopeFrom,
  mintWorkspaceKey,
  requireCookieUser,
  webHeaders,
} from "../../../utils/workspace";

/** A key reaching every workspace its owner is in, authorized per request. */
function mintUserKey(
  event: H3Event,
  name: string | undefined,
  actorType: string,
  scope: ReturnType<typeof keyScopeFrom>,
) {
  return auth.api.createApiKey({
    headers: webHeaders(event),
    body: {
      name: name ?? "treehouse-key",
      metadata: { actorType, ...(scope ? { scope } : {}) },
    },
  });
}

// Mint an API key, tagged with actorType so the change feed attributes its
// writes correctly. With `workspaceId` the key is locked to that one workspace
// (membership-checked); without it the key is user-scoped and reaches every
// workspace the user is a member of (authorized per request) — the multi-
// workspace agent mode. Cookie session only (an API key must not mint more
// keys). `access` and `folder` limit it further, on top of whatever its owner can
// do at the time of each request. The plaintext key is returned once.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  const body = await readBody<{
    name?: string;
    actorType?: string;
    workspaceId?: string;
    access?: string;
    folder?: string;
  }>(event);
  const actorType = body?.actorType === "agent" ? "agent" : "human";
  const scope = keyScopeFrom(body);

  if (body?.workspaceId) {
    const created = await mintWorkspaceKey(event, ctx, {
      name: body.name,
      actorType,
      workspaceId: body.workspaceId,
      scope,
    });
    return {
      id: created.id,
      key: created.key,
      name: created.name,
      actorType,
      workspaceId: body.workspaceId,
      scope: scope ?? null,
    };
  }

  const created = await mintUserKey(event, body?.name, actorType, scope);
  return { id: created.id, key: created.key, name: created.name, actorType, scope: scope ?? null };
});