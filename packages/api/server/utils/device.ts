import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

// Helpers for the device-authorization (RFC 8628 adapted) onboarding flow:
// code generation, device_code hashing, AEAD encryption of the minted key at
// rest, and a tiny in-memory rate limiter.

export const CODE_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_S = 5;

// Rate-limit ceilings (env-overridable so integration tests against a long-lived
// dev server don't exhaust the bucket across runs).
//
// Every folder the desktop app connects costs one code and one approval. The old
// ceilings (5 codes per IP / 10 min, 10 approvals per user / 15 min) were hit by
// ordinary use once onboarding started offering the account's other workspaces
// right after the first: a sixth workspace in a row failed with "could not start
// device grant: 429". The code limit is also per IP, so a team setting up together
// behind one office NAT shared five codes between them. 30 keeps brute-forcing a
// user code (32^8 space, single use, 10-minute expiry) out of reach while leaving
// real onboarding well clear of it.
export const codeRateMax = (): number => Number(process.env.DEVICE_CODE_MAX ?? 30);
export const approveRateMax = (): number => Number(process.env.DEVICE_APPROVE_MAX ?? 30);
/** Min seconds between polls (slow-down); overridable to 0 in tests. */
export const pollIntervalS = (): number =>
  Number(process.env.DEVICE_POLL_INTERVAL_S ?? POLL_INTERVAL_S);

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** High-entropy opaque code the CLI polls with (256-bit). */
export function newDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

// Unambiguous alphabet (no 0/O/1/I); 8 chars ≈ 40 bits — short for humans to
// type, mitigated by the 10-min expiry + approve rate-limit + single use.
const USER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newUserCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_ALPHABET[bytes[i] % USER_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// scrypt is deliberately slow (~100ms) — fine once, but ruinous if re-derived on
// every encrypt/decrypt (it'd block the event loop under concurrent polling).
// The secret is high-entropy (not a user password), so a single derivation is
// safe to cache for the process lifetime.
let cachedKey: Buffer | undefined;
function encKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.DEVICE_KEY_ENC_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("DEVICE_KEY_ENC_KEY or BETTER_AUTH_SECRET must be set for the device flow");
  }
  cachedKey = scryptSync(secret, "treehouse-device-key-v1", 32);
  return cachedKey;
}

/** AEAD-encrypt the minted key for at-rest storage (iv.tag.ciphertext, base64). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const [ivB, tagB, ctB] = blob.split(".");
  if (!ivB || !tagB || !ctB) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

// Sliding-window in-memory rate limiter. Sufficient for a single-instance API;
// move to Redis if the API is ever horizontally scaled.
const buckets = new Map<string, number[]>();
let lastSweep = 0;

// Drop buckets whose hits have all aged out, so the Map can't grow unbounded as
// new IPs/users connect over a long-lived process. Runs at most once per window.
function sweepBuckets(now: number, windowMs: number): void {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [k, ts] of buckets) {
    if (ts.every((t) => now - t >= windowMs)) buckets.delete(k);
  }
}

export function rateLimitOk(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  sweepBuckets(now, windowMs);
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

/** Reset the rate-limit state (tests). */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

export function appUrlBase(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").split(",")[0].trim().replace(/\/+$/, "");
}