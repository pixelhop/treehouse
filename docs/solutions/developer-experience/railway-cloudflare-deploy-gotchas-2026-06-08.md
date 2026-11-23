---
title: "Deploying the Treehouse monorepo to Railway + Cloudflare: gotchas runbook"
date: 2026-06-08
category: developer-experience
module: deployment
problem_type: developer_experience
component: development_workflow
severity: high
applies_when:
  - "Deploying a split architecture: Nuxt SPA (ssr:false) to Cloudflare Workers + Nitro/Node services to Railway"
  - "Provisioning Railway and/or Cloudflare via their MCP servers"
  - "Wiring Cloudflare R2 (S3 API) blob storage to a Railway-hosted service"
  - "Sharing better-auth sessions across subdomains (cross-subdomain cookies + credentialed CORS)"
  - "Connecting to Railway Postgres/Redis over the private (IPv6) network"
tags:
  - railway
  - cloudflare-workers
  - r2
  - pnpm-lockfile
  - cross-subdomain-cookies
  - prisma-migrate
  - mcp
  - deployment
---

# Deploying the Treehouse monorepo to Railway + Cloudflare

> For the clean, linear step-by-step, see the repo's [`DEPLOYMENT.md`](../../../DEPLOYMENT.md). **This** doc captures the failures behind those steps — the gotchas that don't show up until you actually deploy.

## Context

Treehouse is a pnpm monorepo with a **split deployment** boundary. Each package has exactly one home, and the wiring between them is where the failure modes live.

| Concern                             | Package            | Host                       | Runtime                   |
| ----------------------------------- | ------------------ | -------------------------- | ------------------------- |
| Front-end (Nuxt 4 SPA, `ssr:false`) | `packages/app`     | **Cloudflare Workers**     | Workers (`nodejs_compat`) |
| API + better-auth + MCP server      | `packages/api`     | **Railway**                | Node                      |
| BullMQ background worker            | `packages/workers` | **Railway**                | Node (long-lived)         |
| Database                            | —                  | **Railway PostgreSQL**     | managed                   |
| BullMQ broker                       | —                  | **Railway Redis**          | managed                   |
| File bytes (blob store)             | —                  | **Cloudflare R2** (S3 API) | object storage            |

It was provisioned through the **Railway MCP** and **Cloudflare MCP** rather than by hand — mostly a win, but it introduces MCP-specific traps (staged-not-committed deploys, masked domains, OAuth scopes that can't mint R2 credentials).

Three cross-cutting facts drive most of the gotchas:

- The app is **SSR-disabled**, so `NUXT_PUBLIC_API_URL` is **baked at build time**, not read at runtime.
- App and API live on **different subdomains** (cross-subdomain cookies) — or worse, different registrable domains, which changes `SameSite` requirements.
- The blob store **silently degrades** to local disk when R2 env vars are missing — and Railway disk is ephemeral.

---

## Guidance — ordered runbook

### 0. Pre-flight: refresh the lockfile

Railway's Railpack builder runs `pnpm install --frozen-lockfile`. A drifted lockfile fails the build before anything else runs. Local dev installs are **not** frozen, so this is invisible until you deploy.

```bash
pnpm install --lockfile-only   # regenerate from current package.json files
git add pnpm-lock.yaml && git commit -m "chore: refresh pnpm-lock.yaml"
```

Prevention: run a frozen install in CI so drift is caught on PR — `pnpm install --frozen-lockfile`.

### 1. Create the Railway project (via MCP) and click Deploy once

The Railway MCP `create-project` / `railway-agent` tools **stage** services and config — they do **not** commit the first deploy. Right after creating the project you'll see `get-status → services: []` and per-service deploy errors `"Service Instance not found"`. This is expected: go to the **Railway dashboard and click "Deploy" once** to commit the initial batch. **After that first manual deploy, pushes to `main` auto-deploy.**

### 2. Set build / pre-deploy / start commands DIRECTLY on each service

Do **not** rely on `railway.json` config-as-code — the MCP agent mis-maps it to `build.nixpacksConfigPath`, silently producing a broken build. Set these on the service directly.

**API service:**

```bash
# Build
pnpm install --frozen-lockfile && pnpm --filter db run prisma:generate && pnpm --filter api run build
# Pre-deploy (idempotent, once per deploy)
pnpm --filter db run prisma:migrate:deploy
# Start
node packages/api/.output/server/index.mjs
```

**Workers service** (analogous, no migrate — the API owns migrations):

```bash
pnpm install --frozen-lockfile && pnpm --filter db run prisma:generate && pnpm --filter workers run build
node packages/workers/.output/server/index.mjs
```

### 3. Provision Postgres + Redis, and fix the Redis IPv6 URL

Railway's private network is **IPv6-only**, and ioredis won't resolve it unless you allow IPv6 — append `?family=0`:

```bash
DATABASE_URL=${{Postgres.DATABASE_URL}}
NITRO_REDIS_URL=${{Redis.REDIS_URL}}?family=0
```

Without `?family=0`, the worker fails to connect to Redis and jobs never process.

### 4. Wire DNS for the Railway custom domain (Cloudflare DNS, grey cloud)

The Railway MCP **masks real hostnames** (`<hasDomain>` placeholders) and the agent may hallucinate one. Read the **actual** values from the Railway dashboard: the real `*.up.railway.app` URL, the custom-domain **CNAME target**, and the `_railway-verify` **TXT** record. Create them in **Cloudflare DNS as DNS-only (grey cloud, proxy OFF)** so Railway can verify ownership and issue TLS — proxying (orange cloud) breaks verification + cert issuance.

```text
CNAME  treehouse-api               <hash>.up.railway.app     DNS only
TXT    _railway-verify.treehouse-api   railway-verify=<token>    DNS only
```

### 5. Create the R2 bucket + S3 credentials in the Cloudflare dashboard

The Cloudflare **MCP/OAuth token cannot mint account-level API tokens** — attempting it returns `9109 Unauthorized`. Create the S3 credentials by hand: **R2 → Manage R2 API Tokens → Create API Token → Object Read & Write**. Then map:

- `R2_ACCESS_KEY_ID` = the token's **ID**
- `R2_SECRET_ACCESS_KEY` = **SHA-256 of the token value** (shown as the secret access key)
- `R2_ENDPOINT` = `https://<account_id>.r2.cloudflarestorage.com`
- `R2_BUCKET` = your bucket name

### 6. Put the R2 vars on the Railway services — NOT in local `.env`

`useBlobStore()` **silently falls back to a local filesystem driver (`BLOB_DIR`)** when any R2 var is absent. On Railway that disk is **ephemeral** — every redeploy wipes uploaded files. Set all four `R2_*` vars on the Railway API service, then **verify the R2 bucket is non-empty after a test upload**. If files only ever land on the Railway disk, you have the silent-fallback bug and will lose data on the next deploy.

### 7. Build + deploy the Nuxt SPA with the API URL baked in

Because the app is `ssr:false`, `NUXT_PUBLIC_API_URL` is compiled into the client bundle at **build time** — a Worker runtime variable will **not** reach the browser.

```bash
NUXT_PUBLIC_API_URL=https://api.trytree.house pnpm --filter app build
pnpm --filter app exec wrangler deploy
```

Then attach the Worker's custom domain via the Cloudflare Workers domains API/dashboard (auto-creates the DNS + cert) so the app serves from your domain rather than `*.workers.dev`.

### 8. Configure cross-subdomain session cookies + credentialed CORS

**Subdomains of one registrable domain** (`app.example.com` + `api.example.com`) are **same-site**, so `SameSite=Lax` works. Scope the cookie to the parent:

```bash
COOKIE_DOMAIN=.example.com
APP_URL=https://app.example.com   # every front-end origin (prod + previews), comma-separated
```

```ts
// packages/api/server/utils/auth.ts
advanced: { crossSubDomainCookies: { enabled: true, domain: ".example.com" } }
```

CORS must **echo the specific Origin** (never `*`) with credentials:

```ts
"Access-Control-Allow-Origin": origin,        // e.g. https://app.example.com
"Access-Control-Allow-Credentials": "true",
```

**Different registrable domains** (`*.workers.dev` + `*.up.railway.app`) are **cross-site** — `SameSite=Lax` drops the cookie; you'd need `SameSite=None; Secure`. This is the single biggest reason to put both behind subdomains of one domain before going to production.

### 9. Migrations on every deploy

Run `prisma migrate deploy` as the **pre-deploy command** (step 2). It's idempotent and runs once per deploy. Don't put it in the build step (build can run where the DB is unreachable) or the start command (would run per-instance on every restart).

---

## Why This Matters

| Gotcha                                 | Cost if unknown                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Stale `pnpm-lock.yaml`                 | **Every Railway build fails** (`ERR_PNPM_OUTDATED_LOCKFILE`); green locally, red in Railpack.            |
| MCP stages but doesn't commit          | You wait on a deploy that never starts (`services: []`) and assume the MCP is broken.                    |
| `railway.json` → `nixpacksConfigPath`  | Build silently uses the wrong config → broken builds that look like flaky infra.                         |
| Masked/hallucinated domains            | DNS points at a non-existent host → cert never issues, custom domain never goes live.                    |
| Proxied (orange-cloud) DNS for Railway | Railway can't verify the domain or issue TLS → permanent "pending".                                      |
| R2 token via MCP (`9109`)              | Time lost scripting credential creation the OAuth scope can never perform.                               |
| R2 vars only in local `.env`           | Silent fallback to ephemeral disk → **uploaded files lost on every redeploy** (data loss, not an error). |
| `NUXT_PUBLIC_API_URL` as a runtime var | SPA calls the wrong/empty API URL → app loads but **all data calls fail**, looks like a CORS bug.        |
| Wrong cookie / CORS / SameSite         | **Auth silently broken**: login "succeeds" but the cookie is dropped → every request unauthenticated.    |
| Redis URL without `?family=0`          | Worker can't reach Redis over IPv6 → **jobs never process**.                                             |

---

## When to Apply

- Deploying **this** monorepo to Railway + Cloudflare for the first time.
- Deploying any **similar pnpm-monorepo split**: an `ssr:false` SPA on Cloudflare Workers + a Nitro/Node API + BullMQ worker + Postgres + Redis on Railway, with blobs in R2.
- **Re-running after config changes** — after a dependency change (refresh the lockfile, step 0), after changing the API hostname (rebuild the SPA, step 7), after changing auth config (re-check cookie/CORS, step 8), or after changing build/start behavior (set it on the service, not `railway.json`, step 2).
- Any time you provision Railway/Cloudflare **through their MCPs** and hit staged-not-deployed, masked domains, or the R2 `9109` token error.

---

## Examples

**Lockfile (before → after)**

```text
# before — Railpack build log
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with packages/app/package.json
```

```bash
# after
pnpm install --lockfile-only && git add pnpm-lock.yaml && git commit -m "chore: refresh lockfile"
```

**Redis URL (before → after)**

```bash
NITRO_REDIS_URL=${{Redis.REDIS_URL}}            # before — ioredis ENOTFOUND (IPv6)
NITRO_REDIS_URL=${{Redis.REDIS_URL}}?family=0   # after — allow IPv6 resolution
```

**SPA API URL (before → after)**

```bash
wrangler deploy   # before — var set on Worker at runtime, never reaches the browser
# after — baked at build time, then deploy
NUXT_PUBLIC_API_URL=https://api.trytree.house pnpm --filter app build && pnpm --filter app exec wrangler deploy
```

**Cross-site cookie (before → after)**

```text
# before — app on *.workers.dev, API on *.up.railway.app (cross-site) → cookie dropped
Set-Cookie: better-auth.session=...; SameSite=Lax
# after — same registrable domain via subdomains
COOKIE_DOMAIN=.example.com → Set-Cookie: ...; Domain=.example.com; SameSite=Lax; Secure
```

**R2 credential mapping (before → after)**

```text
# before — via Cloudflare MCP/OAuth token
Error 9109: Unauthorized — token cannot create account-level API tokens
# after — created in dashboard (R2 → Manage R2 API Tokens → Object Read & Write)
R2_ACCESS_KEY_ID = <token id>;  R2_SECRET_ACCESS_KEY = <sha256 of token value>
R2_ENDPOINT = https://<account_id>.r2.cloudflarestorage.com;  R2_BUCKET = treehouse-blobs
```

---

## Related

- [`DEPLOYMENT.md`](../../../DEPLOYMENT.md) — the canonical happy-path runbook (env tables, step order). This doc is the gotchas companion.
- **Open follow-up (not yet fixed):** a brand-new user with no organization gets `400 "No organization for user"` and the workspace view hangs on "Loading…". Onboarding should auto-create a personal org + default workspace on sign-up (or prompt to create one).