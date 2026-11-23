import { usePrismaClient } from "db";
import { createError, defineEventHandler, getQuery } from "h3";
import { decryptSecret, pollIntervalS, sha256 } from "../../../utils/device";

// Poll a device authorization (no cookie — called by the CLI with its
// device_code). Enforces expiry + slow-down, and delivers the minted key
// exactly once via an atomic approved->consumed transition.
export default defineEventHandler(async (event) => {
  const deviceCode = getQuery(event).device_code;
  if (typeof deviceCode !== "string" || deviceCode.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "device_code required" });
  }

  const db = usePrismaClient();
  const row = await db.deviceAuthorization.findUnique({
    where: { deviceCodeHash: sha256(deviceCode) },
  });
  // Constant shape for unknown codes — don't confirm existence.
  if (!row) throw createError({ statusCode: 404, statusMessage: "invalid_grant" });

  const now = Date.now();
  if (row.status === "expired" || row.expiresAt.getTime() < now) {
    if (row.status !== "expired") {
      await db.deviceAuthorization.update({ where: { id: row.id }, data: { status: "expired" } });
    }
    throw createError({ statusCode: 410, statusMessage: "expired_token" });
  }

  // Slow-down: reject polls faster than the interval, then stamp the poll time.
  if (row.lastPolledAt && now - row.lastPolledAt.getTime() < pollIntervalS() * 1000) {
    throw createError({ statusCode: 429, statusMessage: "slow_down" });
  }
  await db.deviceAuthorization.update({
    where: { id: row.id },
    data: { lastPolledAt: new Date(now) },
  });

  if (row.status === "denied")
    throw createError({ statusCode: 403, statusMessage: "access_denied" });
  if (row.status === "consumed") {
    throw createError({ statusCode: 410, statusMessage: "already_consumed" });
  }
  if (row.status === "pending") return { status: "pending" };

  // status === "approved": deliver exactly once. The atomic guard ensures only
  // one concurrent poll wins; it also nulls the ciphertext in the same write.
  const consumed = await db.deviceAuthorization.updateMany({
    where: { id: row.id, status: "approved" },
    data: { status: "consumed", apiKeyCiphertext: null },
  });
  if (consumed.count !== 1)
    throw createError({ statusCode: 410, statusMessage: "already_consumed" });
  if (!row.apiKeyCiphertext) {
    throw createError({ statusCode: 500, statusMessage: "approval missing key material" });
  }

  return {
    status: "approved",
    api_key: decryptSecret(row.apiKeyCiphertext),
    // The minted key's id — the revocation handle sign-out needs (the key secret
    // alone can't be revoked). Additive: older CLIs ignore the unknown field.
    api_key_id: row.apiKeyId,
    workspace_id: row.workspaceId,
    api_base: process.env.BETTER_AUTH_URL ?? "",
  };
});