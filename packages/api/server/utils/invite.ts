import { randomBytes } from "node:crypto";

// Helpers for shareable workspace invite links. The token in the link is the
// secret; only its SHA-256 is stored (see device.ts `sha256`). Hashing + the
// app-URL base are shared with the device flow.
export { appUrlBase, sha256 } from "./device";

export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 90;

/** High-entropy opaque token carried in the invite link (256-bit). */
export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}