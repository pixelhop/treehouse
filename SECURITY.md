# Security Policy

We take the security of Treehouse seriously. Treehouse stores people's files and
exposes an unauthenticated public-share surface, so we appreciate reports that
help us keep it safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues or
pull requests.**

Report privately using **GitHub's private vulnerability reporting**:

1. Go to the [Security tab](https://github.com/pixelhop/treehouse/security) of
   this repository.
2. Click **Report a vulnerability** and fill in the advisory form.

If you cannot use GitHub private reporting, email <info@pixelhop.io> with
enough detail to reproduce the issue.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a proof of concept if possible).
- Affected version / commit and deployment mode (hosted or self-hosted).

## Our commitment (SLA)

- **Acknowledgement** within **3 business days** of your report.
- **Initial assessment** (severity + whether we can reproduce) within **7
  business days**.
- **Regular updates** at least every **7 days** while we work on a fix.
- **Fix / mitigation target**: critical and high-severity issues within **30
  days**; lower-severity issues on a best-effort basis.

We support **coordinated disclosure**: please give us a reasonable window to
ship a fix before public disclosure, and we will credit you (unless you prefer
to remain anonymous). Treehouse currently has no paid bug-bounty program.

## Scope

In scope: the Treehouse source in this repository — the API and MCP server,
the sync CLI, the web app, the desktop app, the blob Worker, and the Docker
image in `deploy/`.

Out of scope: vulnerabilities in third-party dependencies (report those
upstream, though we're glad to know), and issues that require a
already-compromised host or a self-inflicted misconfiguration that our docs warn
against.

## Threat model summary

The most security-sensitive part of Treehouse is the **public share** subsystem
— the only place the API serves data without authentication. Access is granted
on the strength of an unguessable token alone (optionally behind a password
gate), which inverts the normal authenticated model, so every detail is
load-bearing. If you are auditing or contributing near sharing, auth, or
file-serving, these are the controls we rely on (see
`docs/solutions/architecture-patterns/public-share-trust-boundary.md` for the
full write-up):

1. **Token entropy** — share tokens are 128-bit, URL-safe, and unique; the token
   is the bearer credential for a public link.
2. **Password storage** — share passwords are stored salted with scrypt and
   verified in constant time; the hash never leaves the server.
3. **Token-bound unlock cookie** — the unlock cookie is an HMAC over the token
   itself (per-token cookie name), and `SHARE_COOKIE_SECRET` **must** be set in
   production or the module fails closed at load, so password gates can't be
   forged with a public constant.
4. **Scope isolation** — `isWithinShare` admits only a share's exact path (file)
   or its subtree with a trailing-slash prefix (folder), so a `dir` share can't
   read `dir2/secret`.
5. **Brute-force throttle** — unlock attempts are rate-limited per token.
6. **Revocation beats a live cookie** — every public read re-resolves the share
   (`revokedAt: null`), so a revoked link dies immediately even for a visitor
   holding a valid unlock cookie.
7. **Sensitive minting needs a human session** — creating a public or
   password-protected link requires a logged-in cookie session, never an API
   key, so a leaked agent/CLI key can't publish files to the world.
8. **Read-only public routes** — the public surface exposes only read + unlock
   verbs; write/move/delete have no public handler.
9. **Response hardening** — public file responses set `nosniff` and a
   `default-src 'none'; sandbox` CSP, and force everything except an allowlist
   of inert media (png/jpeg/gif/webp/pdf) to download, so a shared `.html`/`.svg`
   cannot run script on the API's cookie-holding origin.
10. **Version permalinks pin to content** — pinned shares serve exact bytes by a
    server-derived `(seq, contentHash)` pointer (never client-supplied), and
    return `410` when the blob is gone rather than falling back to other bytes.

Beyond sharing: authentication is better-auth (email/password + organizations +
API keys); agent/CLI access uses workspace-scoped API keys carrying
`{ workspaceId, actorType }` metadata; and in production the API refuses to boot
without an explicit blob-storage choice, so file bytes are never silently
written to ephemeral disk.

## Supported versions

Treehouse is pre-1.0. Security fixes land on the latest release; we recommend
self-hosters track the most recent tagged version.