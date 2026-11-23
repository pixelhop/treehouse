import { usePrismaClient } from "db";
import { createError, defineEventHandler, readBody } from "h3";
import { auth } from "../../../utils/auth";
import { approveRateMax, encryptSecret, rateLimitOk } from "../../../utils/device";
import {
  keyScopeFrom,
  mintWorkspaceKey,
  requireCookieUser,
  webHeaders,
} from "../../../utils/workspace";

// Approve a device authorization (COOKIE SESSION ONLY — called by the web app
// after the user picks a workspace). Binds the grant to the logged-in user,
// mints a workspace-scoped key, and stores it AEAD-encrypted for the one poll
// that will consume it. The key is never returned to the browser.
export default defineEventHandler(async (event) => {
  const ctx = await requireCookieUser(event);
  if (!rateLimitOk(`device-approve:${ctx.userId}`, approveRateMax(), 15 * 60_000)) {
    throw createError({ statusCode: 429, statusMessage: "Too many approvals" });
  }

  const body = await readBody<{
    user_code?: string;
    workspaceId?: string;
    actorType?: string;
    keyName?: string;
    access?: string;
    folder?: string;
  }>(event);
  // Guard the runtime types, not just presence: a malformed body with a truthy
  // non-string (e.g. `{ user_code: 123 }`) would 500 on `.trim()` instead of
  // returning the 400 this check exists to produce.
  if (
    typeof body?.user_code !== "string" ||
    typeof body?.workspaceId !== "string" ||
    !body.user_code.trim() ||
    !body.workspaceId
  ) {
    throw createError({ statusCode: 400, statusMessage: "user_code and workspaceId are required" });
  }
  const userCode = body.user_code.trim().toUpperCase();
  const actorType = body.actorType === "agent" ? "agent" : "human";
  // The approving client names its key (e.g. "Treehouse Desktop") so app-minted
  // keys are labelled honestly in the key-management UI; falls back to the CLI
  // default when omitted.
  // Guard the type, not just null: a malformed request with a non-string
  // keyName (e.g. a number) would make `?.trim()` throw a 500.
  const keyName = typeof body.keyName === "string" ? body.keyName.trim() || undefined : undefined;

  const db = usePrismaClient();
  const row = await db.deviceAuthorization.findUnique({ where: { userCode } });
  if (!row) throw createError({ statusCode: 404, statusMessage: "Unknown or expired code" });
  if (row.status !== "pending") {
    throw createError({ statusCode: 409, statusMessage: "Code already used" });
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw createError({ statusCode: 410, statusMessage: "Code expired" });
  }

  // Membership-checked mint (403/404 for a non-member workspace).
  const minted = await mintWorkspaceKey(event, ctx, {
    name: keyName,
    actorType,
    workspaceId: body.workspaceId,
    scope: keyScopeFrom(body),
  });

  // Claim the grant atomically; a racing approve loses here.
  const claimed = await db.deviceAuthorization.updateMany({
    where: { id: row.id, status: "pending" },
    data: {
      status: "approved",
      userId: ctx.userId,
      workspaceId: body.workspaceId,
      actorType,
      apiKeyId: minted.id,
      apiKeyCiphertext: encryptSecret(minted.key),
    },
  });
  if (claimed.count !== 1) {
    // We lost the race — revoke the key we just minted so it doesn't linger as
    // an active, untracked orphan.
    await auth.api
      .deleteApiKey({ headers: webHeaders(event), body: { keyId: minted.id } })
      .catch(() => {});
    throw createError({ statusCode: 409, statusMessage: "Code already used" });
  }

  return { ok: true };
});