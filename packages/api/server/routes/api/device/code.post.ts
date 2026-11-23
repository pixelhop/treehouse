import { usePrismaClient } from "db";
import { createError, defineEventHandler, getRequestIP } from "h3";
import {
  appUrlBase,
  CODE_TTL_MS,
  codeRateMax,
  newDeviceCode,
  newUserCode,
  pollIntervalS,
  rateLimitOk,
  sha256,
} from "../../../utils/device";

// Start a device authorization (no auth — called by the CLI). Returns the codes
// and the verification URL; the CLI prints/opens it and polls. Rate-limited per
// IP to bound table growth and user_code namespace pressure.
export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";
  if (!rateLimitOk(`device-code:${ip}`, codeRateMax(), 10 * 60_000)) {
    throw createError({ statusCode: 429, statusMessage: "Too many requests" });
  }

  const db = usePrismaClient();
  const deviceCode = newDeviceCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  // Retry on the (rare) user_code unique collision.
  let userCode: string | undefined;
  for (let i = 0; i < 5; i++) {
    const candidate = newUserCode();
    try {
      await db.deviceAuthorization.create({
        data: { deviceCodeHash: sha256(deviceCode), userCode: candidate, expiresAt },
      });
      userCode = candidate;
      break;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue;
      throw err;
    }
  }
  if (!userCode) throw createError({ statusCode: 503, statusMessage: "Could not allocate a code" });

  const base = appUrlBase();
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/link`,
    verification_uri_complete: `${base}/link?code=${encodeURIComponent(userCode)}`,
    expires_in: Math.floor(CODE_TTL_MS / 1000),
    interval: pollIntervalS(),
  };
});