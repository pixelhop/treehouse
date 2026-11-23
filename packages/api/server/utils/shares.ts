import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { type Share, usePrismaClient } from "db";
import { normalizePath, PathError } from "./files";

// ---------------------------------------------------------------------------
// Sharing service. Owns the security-load-bearing pieces of the public-link
// boundary: token generation, scrypt password hashing, sibling-prefix-safe
// scope checks, and the token-bound unlock-cookie signature. Kept free of HTTP
// so the scope + password logic is unit-testable in isolation.
// ---------------------------------------------------------------------------

export type ShareKind = "file" | "folder";
export type ShareAccess = "member" | "public";

// A share as exposed to any client. NEVER carries passwordHash — only whether a
// password is required.
export interface ShareView {
  id: string;
  path: string;
  kind: ShareKind;
  access: ShareAccess;
  token: string | null;
  hasPassword: boolean;
  pinnedVersion: number | null;
  pinnedContentHash: string | null;
  /** Whether a shared HTML page may run its own scripts for visitors. */
  allowScripts: boolean;
  createdAt: string;
  /** Deduplicated lifetime views — one per visitor per day, bots excluded. */
  viewCount: number;
  lastViewedAt: string | null;
}

export function toShareView(s: Share): ShareView {
  return {
    id: s.id,
    path: s.path,
    kind: s.kind as ShareKind,
    access: s.access as ShareAccess,
    token: s.token,
    hasPassword: !!s.passwordHash,
    pinnedVersion: s.pinnedVersion,
    pinnedContentHash: s.pinnedContentHash,
    allowScripts: s.allowScripts,
    createdAt: s.createdAt.toISOString(),
    viewCount: s.viewCount,
    lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
  };
}

// ---- Tokens (≥128 bits of entropy, url-safe) ----
export function newShareToken(): string {
  return randomBytes(16).toString("base64url"); // 128 bits, 22 chars
}

// ---- Password hashing (scrypt, salt-prefixed, timing-safe verify) ----
export function hashSharePassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifySharePassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---- Token-bound unlock cookie ----
// Dev fallback keeps local sharing working; production MUST set SHARE_COOKIE_SECRET
// or password gates are forgeable. Fail closed in production rather than silently
// signing unlock cookies with a public key.
const DEV_SHARE_SECRET = "dev-share-cookie-secret-change-me";
const SHARE_COOKIE_SECRET = process.env.SHARE_COOKIE_SECRET ?? DEV_SHARE_SECRET;
if (process.env.NODE_ENV === "production" && SHARE_COOKIE_SECRET === DEV_SHARE_SECRET) {
  throw new Error("SHARE_COOKIE_SECRET must be set in production (it signs share unlock cookies).");
}

/** Cookie name for a share's unlock state — scoped to the exact token. */
export function shareCookieName(token: string): string {
  return `sh_${token}`;
}

/** Signature proving the password was verified for THIS token (HMAC over token). */
export function signShareUnlock(token: string): string {
  return createHmac("sha256", SHARE_COOKIE_SECRET).update(token).digest("hex");
}

export function verifyShareUnlock(token: string, cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  const expected = Buffer.from(signShareUnlock(token), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(cookieValue, "hex");
  } catch {
    return false;
  }
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

// ---- Scope check (sibling-prefix-safe) ----
/**
 * Is `requestedPath` inside `share`'s scope? A file share admits only its exact
 * path; a folder share admits the folder itself or anything under `<path>/`
 * (the trailing slash blocks a `dir` share from leaking `dir2/secret`). Traversal
 * is rejected. Never throws.
 */
export function isWithinShare(share: Pick<Share, "path" | "kind">, requestedPath: string): boolean {
  let normalized: string;
  try {
    normalized = normalizePath(requestedPath);
  } catch (err) {
    if (err instanceof PathError) return false;
    throw err;
  }
  if (share.kind === "file") return normalized === share.path;
  return normalized === share.path || normalized.startsWith(`${share.path}/`);
}

// ---- CRUD ----
export interface CreateShareInput {
  workspaceId: string;
  path: string;
  kind: ShareKind;
  access: ShareAccess;
  password?: string;
  pinnedVersion?: number;
  pinnedContentHash?: string;
  allowScripts?: boolean;
  createdBy: string;
}

export async function createShare(input: CreateShareInput): Promise<ShareView> {
  const db = usePrismaClient();
  const path = normalizePath(input.path);
  const created = await db.share.create({
    data: {
      workspaceId: input.workspaceId,
      path,
      kind: input.kind,
      access: input.access,
      token: input.access === "public" ? newShareToken() : null,
      passwordHash: input.password ? hashSharePassword(input.password) : null,
      pinnedVersion: input.pinnedVersion ?? null,
      pinnedContentHash: input.pinnedContentHash ?? null,
      allowScripts: input.allowScripts ?? false,
      createdBy: input.createdBy,
    },
  });
  return toShareView(created);
}

/** Active (non-revoked) shares for a path, without passwordHash. */
export async function listShares(workspaceId: string, path: string): Promise<ShareView[]> {
  const db = usePrismaClient();
  const shares = await db.share.findMany({
    where: { workspaceId, path: normalizePath(path), revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return shares.map(toShareView);
}

/**
 * Active folder shares on an ANCESTOR of `path` — i.e. shares that cover this
 * path without targeting it directly. A file (or sub-folder) inside a shared
 * folder is reachable through the folder's link, so the UI surfaces these as
 * "shared via a parent folder". Excludes the path's own shares (those come from
 * listShares). Returns newest-first.
 */
export async function listInheritedShares(workspaceId: string, path: string): Promise<ShareView[]> {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
  if (ancestors.length === 0) return [];
  const db = usePrismaClient();
  const shares = await db.share.findMany({
    where: { workspaceId, kind: "folder", path: { in: ancestors }, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return shares.map(toShareView);
}

/** Soft-revoke a share (scoped to the workspace for authz). Returns true if revoked. */
/**
 * Turn script execution on or off for an existing link, without minting a new
 * one. Revoke-and-recreate would change the URL — and the whole reason someone
 * reaches for this is that a link is already with a client who says the deck
 * does not respond. Returns null when no such live share exists in this
 * workspace, so a caller cannot flip a flag on another workspace's link.
 */
export async function setShareScripts(
  workspaceId: string,
  id: string,
  allowScripts: boolean,
): Promise<ShareView | null> {
  const db = usePrismaClient();
  const { count } = await db.share.updateMany({
    where: { id, workspaceId, revokedAt: null },
    data: { allowScripts },
  });
  if (count === 0) return null;
  const share = await db.share.findUnique({ where: { id } });
  return share ? toShareView(share) : null;
}

/** One live share in this workspace, or null. Scoped so a caller can never read
 * or act on another workspace's link. */
export async function getShare(workspaceId: string, id: string): Promise<Share | null> {
  const db = usePrismaClient();
  return db.share.findFirst({ where: { id, workspaceId, revokedAt: null } });
}

export async function revokeShare(workspaceId: string, id: string): Promise<boolean> {
  const db = usePrismaClient();
  const res = await db.share.updateMany({
    where: { id, workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

/** Resolve a public token to its ACTIVE share (or null). Internal — the raw row
 * carries passwordHash for verification and must not be returned to clients. */
export async function resolveShare(token: string): Promise<Share | null> {
  const db = usePrismaClient();
  return db.share.findFirst({ where: { token, revokedAt: null } });
}