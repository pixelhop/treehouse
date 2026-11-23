---
title: "Public share trust boundary (unauthenticated read surface)"
date: 2026-06-09
category: docs/solutions/architecture-patterns/
module: "packages/api/server/utils/shares.ts"
problem_type: architecture_pattern
component: authentication
severity: high
applies_when:
  - "exposing an unauthenticated public read surface from an otherwise authed API"
  - "adding share links, tokens, or password-protected public access"
  - "scoping access to a subtree/path prefix without leaking siblings"
  - "needing revocation to beat a previously-issued unlock cookie or session"
  - "serving user-uploaded bytes from an API origin (XSS / content-sniffing risk)"
related_components:
  - "packages/api/server/utils/public-share.ts"
  - "packages/api/server/routes/api/share/[token]/file.get.ts"
  - "packages/api/server/routes/api/share/[token]/unlock.post.ts"
  - "packages/api/server/routes/api/workspaces/[workspaceId]/shares.post.ts"
  - "packages/db/prisma/schema.prisma"
tags:
  - public-sharing
  - trust-boundary
  - unauthenticated-access
  - share-tokens
  - password-protection
  - revocation
  - response-hardening
  - fail-closed
---

# Public share trust boundary (unauthenticated read surface)

## Context

The sharing subsystem (`packages/api/server/utils/shares.ts`, `public-share.ts`, and
the `server/routes/api/share/[token]/*` routes) adds Treehouse's **only unauthenticated
read surface**. Everywhere else, a request must pass `authenticate()` — a cookie session
or an `apiKey`. A public share deliberately does not: it grants read access on the
strength of an unguessable token alone, optionally behind a password gate.

That inversion of the normal auth model is exactly why the boundary must be written down.
Once a link can be opened by anyone on the internet with no login, every detail becomes
load-bearing: token entropy is the _only_ secret, the scope check is the _only_ thing
keeping a file link from reading its siblings, and the response headers are the _only_
thing stopping a shared `.html`/`.svg` from running script on the API's cookie-holding
origin. `shares.ts` is kept HTTP-free so the scope and password logic stay
unit-testable in isolation (`packages/api/test/shares.test.ts`). The durable backing is
the `Share` Postgres model (`packages/db/prisma/schema.prisma`): `token @unique`,
`passwordHash`, `pinnedVersion`/`pinnedContentHash`, `createdBy`, and a soft-delete
`revokedAt`.

## Guidance

Ten controls make up the boundary. Preserve every one when touching sharing.

**1. Token entropy — 128 bits, url-safe.** The token _is_ the bearer credential for a
public link; weak tokens are guessable.

```ts
// shares.ts
export function newShareToken(): string {
  return randomBytes(16).toString("base64url"); // 128 bits, 22 chars
}
```

`token` is `@unique` and minted only for `access === "public"`; member links carry `null`.

**2. scrypt passwords, timing-safe verify, hash never leaves the server.** Passwords are
stored salted (`salt:hash` hex) and compared in constant time so verification can't be
timing-probed.

```ts
// shares.ts — verifySharePassword
const expected = Buffer.from(hashHex, "hex"); // salt:hash stored hex
const actual = scryptSync(password, salt, expected.length);
return expected.length === actual.length && timingSafeEqual(expected, actual);
```

`toShareView()` projects `hasPassword: !!s.passwordHash` instead of the hash, and
`resolveShare()` is internal-only precisely because its raw row carries `passwordHash`
and must not be returned to clients. `meta.get.ts` returns only `hasPassword`.

**3. Token-bound HMAC unlock cookie + `SHARE_COOKIE_SECRET` fail-closed in prod.** The
unlock cookie is an HMAC _over the token itself_, so it proves "the password was verified
for THIS token" and can't be replayed against another share. In production the signing
key must be set or password gates would be forgeable with a public constant — so the
module fails closed at load.

```ts
// shares.ts
const SHARE_COOKIE_SECRET = process.env.SHARE_COOKIE_SECRET ?? DEV_SHARE_SECRET;
if (process.env.NODE_ENV === "production" && SHARE_COOKIE_SECRET === DEV_SHARE_SECRET) {
  throw new Error("SHARE_COOKIE_SECRET must be set in production (it signs share unlock cookies).");
}
export function shareCookieName(token: string): string {
  return `sh_${token}`;
}
export function signShareUnlock(token: string): string {
  return createHmac("sha256", SHARE_COOKIE_SECRET).update(token).digest("hex");
}
```

The cookie name is per-token (`sh_<token>`), so an unlock for one share isn't even
_named_ the same as another's; `verifyShareUnlock` compares with `timingSafeEqual`.

**4. `isWithinShare` is sibling-prefix-safe.** A file share admits only its exact path; a
folder share admits the folder or anything under `"<path>/"`. The trailing slash is the
load-bearing detail — without it, a share of `dir` would match `dir2/secret`.

```ts
// shares.ts
if (share.kind === "file") return normalized === share.path;
return normalized === share.path || normalized.startsWith(`${share.path}/`);
```

The requested path runs through `normalizePath` first and returns `false` (never throws)
on traversal. `file.get.ts` enforces it on the `?path=` of a folder share.

**5. Per-token brute-force throttle on unlock.** A weak password's only barrier is rate
limiting; the throttle is keyed per token (the better-auth apikey limiter is globally
disabled, so there's nothing to reuse).

```ts
// unlock.post.ts
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
if (active && active.count >= MAX_ATTEMPTS)
  throw createError({ statusCode: 429, statusMessage: "Too many attempts — try again later" });
```

A wrong password increments; a correct one clears the counter and sets the cookie.

**6. Revocation beats a live cookie — re-resolve every request.** Every public read
re-resolves the share by token filtering `revokedAt: null`, so a revoked link dies
immediately even if the visitor still holds a valid unlock cookie. `resolveShare` is the
single chokepoint; the cookie is never consulted as a substitute for re-resolution.

This control is what constrains **caching** on `file.get.ts`. The route answers
conditional requests (`ETag` + `If-None-Match` → 304) so a repeat view skips the blob
fetch and decryption, but the directive is `private, max-age=0, must-revalidate` and
must stay that way:

```ts
// file.get.ts — AFTER requirePublicShare, assertUnlocked, isWithinShare, and the
// privacy re-check. Hoisting this above them would let a revoked or newly-private
// link keep answering to anyone holding a validator.
setResponseHeader(event, "Cache-Control", "private, max-age=0, must-revalidate");
if (getRequestHeader(event, "if-none-match") === etag) return sendNoContent(event, 304);
```

`public` would hand a shared cache or CDN the right to keep serving a revoked link
until its TTL expired — and a public link is precisely the high-fanout case a CDN would
hold longest. The saving here is deliberately the _blob read_, not the request: every
view still reaches the handler and re-resolves the share. A pinned permalink validates
on its content pointer (immutable); a live share validates on the node's version.

**7. Public/password creation requires a human cookie session (KTD4).** A public or
password-protected link is a brand-new unauthenticated surface, so it may only be minted
from a logged-in session — never an API key — so a leaked agent/CLI key can't open public
access.

```ts
// shares.post.ts
const sensitive = body.access === "public" || !!body.password;
if (sensitive && ctx.keyId) {
  throw createError({
    statusCode: 403,
    statusMessage: "Public or password-protected links require a logged-in session, not an API key",
  });
}
```

Member links (and `shares.get` listing / revoke) remain available to keys, preserving
agent parity for the non-sensitive operations.

**8. Method-specific public routes are read-only.** The public surface is only
`file.get`, `list.get`, `meta.get`, and `unlock.post`. There is no public write/move/delete
route — write verbs are rejected at the routing layer because no handler exists.

**9. Public-response hardening against same-origin script execution.** A public link
served on the API origin must never render as live content: responses set `nosniff` + a
`default-src 'none'; sandbox` CSP, and only an allowlist of inert media renders inline —
everything else (notably `text/html` and `image/svg+xml`, which run script) is forced to
download.

```ts
// file.get.ts
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
setResponseHeader(event, "X-Content-Type-Options", "nosniff");
setResponseHeader(event, "Content-Security-Policy", "default-src 'none'; sandbox");
const inline = INLINE_SAFE.has(baseContentType(contentType));
setResponseHeader(
  event,
  "Content-Disposition",
  inline ? "inline" : `attachment; filename="${safeName}"`,
);
```

The filename is stripped of `\r\n"` to keep the header well-formed and prevent header
injection.

**10. Version permalinks pin to seq + contentHash, derived server-side.** A pinned share
serves the _exact bytes_ by content pointer, and the hash is derived on the server from
`(path, version)` — never trusted from the client, which could otherwise point a
benign-looking share at any other file's bytes.

```ts
// shares.post.ts
const v = await useFileService().readVersion({
  workspaceId: ws.id,
  path: body.path,
  version: body.pinnedVersion,
});
pinnedContentHash = v.contentHash; // server-derived from (path, version), not client-supplied
```

At read time a pinned share serves by hash and returns **410** (not a silent fallback)
when the blob is gone.

## Why This Matters

Each control maps to a concrete attack or failure mode:

- **Scope escape** — without the trailing-slash prefix check (4), a `dir` folder share leaks `dir2/secret`.
- **Cross-share cookie reuse** — without HMAC-over-token + per-token cookie name (3), an unlock cookie for one share could unlock a _different_ password share.
- **Forgeable password gates** — without the prod fail-closed secret (3), unlock cookies would be signed with a public dev constant and anyone could forge `sh_<token>`.
- **Brute force** — without the throttle (5), a weak share password is enumerable at full speed.
- **Stale-cookie-after-revoke** — without re-resolving every request (6), a revoked link keeps serving to anyone holding the unlock cookie.
- **Leaked-key public minting** — without KTD4 (7), a stolen agent/CLI key could silently publish workspace files to the world.
- **Same-origin script execution** — without response hardening (9), a shared `.html`/`.svg` executes on the API origin (XSS against the API session). MIME sniffing would defeat a naive content-type, hence `nosniff`.
- **passwordHash leak** — without the `toShareView` omission (2), every list/meta response hands out the offline-crackable hash.
- **Version-number-reuse mismatch** — pinning by version number alone is ambiguous after delete/resurrect; a server-derived `contentHash` (10) guarantees the permalink serves the bytes that existed at share time, and a client-supplied hash could redirect the link to unrelated bytes.

## When to Apply

Re-read this before:

- Adding a new share **kind** (e.g. a wildcard/glob share) or any new `share/[token]/*` route — recheck `isWithinShare` and that the route stays read-only.
- Adding a **search or enumeration surface** — anything that returns a set of paths rather than one requested path. The authenticated path uses `canRead(acls, path, actorId)` ("may THIS user read it"); the public path uses `!effectiveAcl(acls, path)` ("is it private to anyone") **plus** the share prefix scope. They are not interchangeable, and an enumeration surface leaks a whole tree rather than one file when the wrong one is used. `packages/api/server/utils/search.ts` is the authenticated implementation and deliberately has no prefix parameter, so it must not be reused for a share-scoped search.
- Changing **cookies or CORS** — the unlock cookie is `SameSite=None; Secure` for the cross-site Cloudflare→Railway call; touching `COOKIE_DOMAIN`, `crossSubDomainCookies`, or CORS credentials can silently break or over-broaden it (see the deploy gotchas doc below).
- Touching the **public viewer** or what content types render inline — any change to `INLINE_SAFE` / `Content-Disposition` is a direct XSS lever.
- **Prod deploy** of the share surface — confirm `SHARE_COOKIE_SECRET`, R2 wiring, and migrations (see Deploy gotchas).
- Adding fields to the `Share` model or `ShareView` — verify nothing new leaks `passwordHash` or a client-trusted pointer.

## Examples

**Do — fail closed when the secret is missing (don't silently sign with a public key):**

```ts
// DO (shares.ts)
const SHARE_COOKIE_SECRET = process.env.SHARE_COOKIE_SECRET ?? DEV_SHARE_SECRET;
if (process.env.NODE_ENV === "production" && SHARE_COOKIE_SECRET === DEV_SHARE_SECRET)
  throw new Error("SHARE_COOKIE_SECRET must be set in production ...");

// DON'T
const SECRET = process.env.SHARE_COOKIE_SECRET || "dev-secret"; // forgeable in prod
```

**Do — allowlist inert media inline, force everything else to download:**

```ts
// DO (file.get.ts): default to attachment; only known-inert types render inline
const inline = INLINE_SAFE.has(baseContentType(contentType)); // png/jpeg/gif/webp/pdf only
setResponseHeader(
  event,
  "Content-Disposition",
  inline ? "inline" : `attachment; filename="${safeName}"`,
);

// DON'T
setResponseHeader(event, "Content-Disposition", "inline"); // a shared .html/.svg runs script on the API origin
```

## Deploy gotchas

- **`SHARE_COOKIE_SECRET` must be set in prod.** The module throws at load if it's absent under `NODE_ENV=production`, so share creation _and_ unlock fail closed. As of this writing the var is **not yet in the Railway/Cloudflare deploy notes** — add it to the API service or the share surface is dead on arrival.
- **R2 must be wired for permalink/restore durability.** Pinned-version permalinks serve historical bytes by `contentHash` and return **410** when the blob is missing. Without `R2_*` env vars, `useBlobStore()` silently falls back to ephemeral disk (`BLOB_DIR`) wiped each deploy, so old pinned versions 410 after a redeploy. R2 bucket `treehouse-blobs` must be live.
- **Cross-origin cookie wiring.** The unlock cookie is set `httpOnly; secure; sameSite=None; path=/` because the Cloudflare viewer calls the Railway API cross-site. This needs HTTPS end-to-end, credentialed `fetch` from the viewer, CORS that echoes the specific viewer origin with `Access-Control-Allow-Credentials: true`, or the cookie is dropped and password shares re-prompt forever. Substrate is documented in the deploy gotchas doc.
- **`prisma migrate deploy` before serving.** The `Share` table must exist before the share routes go live; these Treehouse models are hand-maintained, so the migration must actually be applied (never `auth:generate`).
- **`BLOB_KEK` must be set in prod, and a shared link cannot outlive it.** File bytes are encrypted at rest under a per-workspace key wrapped by this master key, and the API refuses to boot in production without it. A public link serves nothing if the key is lost, and deleting a workspace crypto-shreds its key — so every link into it dies irrecoverably, not just the workspace UI. See "Encryption at rest" in README.md.

## Related

- [Railway + Cloudflare deploy gotchas](../developer-experience/railway-cloudflare-deploy-gotchas-2026-06-08.md) — cross-origin credentialed cookies + `SameSite=None` (the unlock cookie & minting-gate session ride this machinery) and R2/blob persistence (where served public bytes live). Link there rather than re-deriving the substrate.
- Plan: `docs/plans/2026-06-08-003-feat-file-folder-sharing-plan.md` (KTD1–KTD7, the security rationale).
- Shared file service (single write path, version reads, blob store): `packages/api/server/utils/files.ts`.