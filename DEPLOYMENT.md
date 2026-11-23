# Deploying Treehouse

Split deployment: the **front-end** runs on **Cloudflare Workers**, the **backends + database** run on **Railway**, and **file bytes** live in **Cloudflare R2**.

```
                 ┌─────────────────────────┐
 app.example.com │ Cloudflare Worker (Nuxt) │
                 └───────────┬─────────────┘
                             │ HTTPS (credentialed CORS)
                 ┌───────────▼─────────────┐        ┌──────────────┐
 api.example.com │ Railway · Nitro API      │◄──────►│ Railway Postgres
                 │ (better-auth + MCP)      │        └──────────────┘
                 └───────┬─────────┬────────┘        ┌──────────────┐
                         │         └───────────────► │ Railway Redis │
                         │ S3 API                     └──────────────┘
                 ┌───────▼────────┐
                 │ Cloudflare R2  │  (private bucket — files stream via the API)
                 └────────────────┘
 + Railway · Nitro Worker (BullMQ) ── Redis + Postgres
```

> **Not using Railway?** [`deploy/Dockerfile`](deploy/Dockerfile) builds one image holding both
> servers (API and workers), which runs on any container host. Run
> `prisma migrate deploy --config packages/db/prisma.config.ts` before each release. The
> environment variables in sections 3 and 4 apply unchanged.

This guide assumes app + API on **subdomains of one custom domain** (`app.example.com`, `api.example.com`) so the session cookie is shared cleanly (same-site). See [Cookies](#cookies) for the alternative.

---

## 1. Cloudflare R2 (file storage)

1. **R2 → Create bucket** (e.g. `treehouse-blobs`). Keep it private.
2. **R2 → Manage API Tokens → Create** an **S3 (Account) API token** with Object Read & Write on the bucket. Note the **Access Key ID** + **Secret Access Key**.
3. Your endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

These become the API's `R2_*` env vars. The browser never talks to R2 directly — files stream through the API — so no public access / bucket CORS is needed.

---

## 2. Railway — Postgres + Redis

In a Railway project: **New → Database → PostgreSQL**, and **New → Database → Redis**. They expose `DATABASE_URL` and `REDIS_URL`, which you reference from the services below.

---

## 3. Railway — API service

**New → GitHub Repo →** this repo. Railway picks up [`packages/api/railway.json`](packages/api/railway.json); set the service's **Config-as-code path** to `packages/api/railway.json` if it isn't detected. It encodes:

- **Build:** `pnpm install --frozen-lockfile && pnpm --filter db run prisma:generate && pnpm --filter api run build`
- **Pre-deploy:** `pnpm --filter db run prisma:migrate:deploy` (runs migrations once per deploy)
- **Start:** `node packages/api/.output/server/index.mjs`

> **Toolchain:** Railway's builder (Railpack) takes Node from `.nvmrc` and pnpm from `engines.pnpm` in the root `package.json`. It does not read `packageManager` for pnpm. Without `engines.pnpm` it guesses pnpm 9 from the lockfile format, which pnpm 9, 10 and 11 all share, and the build fails. When you bump pnpm, change `engines.pnpm` and `packageManager` together.

**Variables:**

| Variable                                    | Value                                                              |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`                              | `${{Postgres.DATABASE_URL}}`                                       |
| `NITRO_REDIS_URL`                           | `${{Redis.REDIS_URL}}?family=0`                                    |
| `BETTER_AUTH_SECRET`                        | `openssl rand -hex 32`                                             |
| `BETTER_AUTH_URL`                           | `https://api.example.com`                                          |
| `APP_URL`                                   | `https://app.example.com` (comma-separate to add preview origins)  |
| `COOKIE_DOMAIN`                             | `.example.com`                                                     |
| `POSTHOG_KEY`                               | _(optional)_ `phc_…` — server-side error tracking. Omit to disable |
| `POSTHOG_HOST`                              | _(optional)_ `https://eu.i.posthog.com`                            |
| `R2_ENDPOINT`                               | `https://<account-id>.r2.cloudflarestorage.com`                    |
| `R2_BUCKET`                                 | `treehouse-blobs`                                                  |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | from step 1                                                        |
| `SHARE_COOKIE_SECRET`                       | `openssl rand -hex 32`                                             |
| `BLOB_KEK`                                  | `printf 'v1:%s\n' "$(openssl rand -base64 32)"`                    |

> **Both of the last two are required — the API refuses to boot without them.**
> `SHARE_COOKIE_SECRET` signs share unlock cookies; `BLOB_KEK` is the master key
> that wraps every workspace's file-encryption key.
>
> ⚠️ **Losing a KEK loses every file it seals, permanently.** There is no
> recovery path — the objects in R2 are unreadable without it. Back up **every
> key you have ever used**, not just the current one, somewhere outside the
> blast radius of the Railway project that holds them, before you put any real
> data in.
>
> That means retired keys too. `BLOB_KEK_RETIRED` (optional, comma-separated)
> holds keys that no longer seal new writes but still open existing workspaces,
> and because no rotation tooling ships yet, rows stay sealed under a retired
> key indefinitely until something re-wraps them. A retired key is not a spent
> key — keep it until you have confirmed every `workspace_key` row has moved.

> `?family=0` on the Redis URL is required — Railway's private network is IPv6 and ioredis needs it. Railway injects `PORT`; Nitro respects it (no port config needed).

**Networking → Generate Domain**, then add your custom domain `api.example.com`.

---

## 4. Railway — Workers service

**New → GitHub Repo →** same repo, **Config-as-code path** `packages/workers/railway.json`.

| Variable                                                  | Value                                                    |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `NITRO_REDIS_URL`                                         | `${{Redis.REDIS_URL}}?family=0`                          |
| `DATABASE_URL`                                            | `${{Postgres.DATABASE_URL}}` (only if a job uses Prisma) |
| `NITRO_BULL_BOARD_USERNAME` / `NITRO_BULL_BOARD_PASSWORD` | your choice (the dashboard is off until both are set)    |

---

## 5. Cloudflare — the app (Nuxt SPA Worker)

Config lives in [`packages/app/wrangler.jsonc`](packages/app/wrangler.jsonc).

> **Build-time gotcha:** this is an SPA (`ssr: false`) whose shell is prerendered for the PWA service worker, so `NUXT_PUBLIC_API_URL` is **frozen into the shell at build time** — a Worker runtime `var` will _not_ reach the browser. Set it as a **build env var**, and keep `wrangler.jsonc` `vars.NUXT_PUBLIC_API_URL` (which feeds `/.well-known/treehouse`) identical: the build fails if the two disagree. When the API origin moves, change both: the build variable is in `.github/workflows/cloudflare.yml` `env`, and the runtime var is in `wrangler.jsonc`.

**How it deploys (Treehouse):** GitHub Actions, in `.github/workflows/cloudflare.yml`.
PRs build and dry-run, and pushes to `main` deploy the app and the marketing site
with retries. The build variables are in the workflow. Setup (an API token secret,
plus disconnecting Workers Builds) and the reasons for moving off Cloudflare's git
integration are in
[`docs/solutions/developer-experience/cloudflare-deploys-via-github-actions.md`](docs/solutions/developer-experience/cloudflare-deploys-via-github-actions.md).
Don't reconnect Workers Builds as well, or every merge deploys twice.

**From your machine (one-off or rollback):**

```bash
NUXT_PUBLIC_API_URL=https://api.example.com pnpm --filter app build
pnpm --filter app run deploy   # wrangler deploy
```

### PostHog (optional)

All **build** variables, for the same reason as `NUXT_PUBLIC_API_URL` — this is
an SPA, so runtime Worker vars never reach the client bundle. For Treehouse they
are set in `.github/workflows/cloudflare.yml`: the key in `env`, `POSTHOG_CLI_TOKEN`
as a repo secret and `POSTHOG_PROJECT_ID` as a repo variable. Omit them all and
analytics is entirely off: no requests, no storage.

| Variable                  | Value                                       |
| ------------------------- | ------------------------------------------- |
| `NUXT_PUBLIC_POSTHOG_KEY` | `phc_…` (project public key, EU Cloud)      |
| `POSTHOG_CLI_TOKEN`       | `phx_…` **secret** — source map upload only |
| `POSTHOG_PROJECT_ID`      | numeric project id — source map upload only |

`NUXT_PUBLIC_POSTHOG_HOST` is left unset: it defaults to `/ph`, this Worker's own
reverse proxy for PostHog, which is what stops tracker blockers from silently
deleting the data. The source map variables are optional even when the key is
set — without them the upload step no-ops and the build still succeeds, you just
get minified stack traces.

The marketing Worker takes `NUXT_PUBLIC_POSTHOG_KEY` the same way. Note it will
not send anything until a visitor accepts the cookie banner.

Then add the custom domain `app.example.com` to the Worker (Workers → your worker → Settings → Domains & Routes).

---

## Cookies

The session cookie is the thing most likely to bite. The app and API are different origins, so the cookie must travel cross-origin with `credentials: include` (already wired in `useAuthClient` + the CORS middleware).

- **Subdomains of one domain (recommended):** set `COOKIE_DOMAIN=.example.com`. better-auth then scopes the cookie to the parent domain; it's same-site, so `SameSite=Lax` is enough. This is what the steps above assume.
- **Different domains (`*.workers.dev` + `*.up.railway.app`):** there's no shared parent, so leave `COOKIE_DOMAIN` unset and instead configure the cookie as `SameSite=None; Secure` in `packages/api/server/utils/auth.ts` (`advanced.defaultCookieAttributes`). Workable, but a custom domain is cleaner and avoids third-party-cookie blocking.

---

## Staging

Treehouse runs a second, fully separate copy for testing before production:

|         | Production          | Staging                                 |
| ------- | ------------------- | --------------------------------------- |
| Branch  | `main`              | `staging`                               |
| App     | `app.trytree.house` | `staging-app.trytree.house`             |
| API     | `api.trytree.house` | `staging-api.trytree.house`             |
| Worker  | `treehouse-app`     | `treehouse-app-staging` (`env.staging`) |
| Stripe  | live mode           | test mode                               |
| PostHog | on                  | off                                     |

To test something on staging, push it to the `staging` branch.
`.github/workflows/deploy.yml` deploys the api and workers, and `.github/workflows/cloudflare.yml` deploys the app
Worker with `CLOUDFLARE_ENV=staging`. Marketing has no staging copy.

Staging's secrets (`BETTER_AUTH_SECRET`, `BLOB_KEK`, `SHARE_COOKIE_SECRET`,
`INTERNAL_JOB_SECRET`, …) are its own, never production's. Staging data is
disposable, so its KEK is not backed up like production's.

**The cookie prefix.** Both copies sit under `.trytree.house`, so the browser
sends production's session cookie to staging's API too. Staging sets
`AUTH_COOKIE_PREFIX=treehouse-staging`, which renames its cookies so it ignores
production's. Leave it unset in production.

---

## Connecting agents / the CLI

Once deployed, create a **user-scoped API key** in the app (account menu → API keys), then:

```bash
claude mcp add --transport http treehouse https://api.example.com/api/mcp \
  --header "x-api-key: <key>"
```

The CLI sync uses the same key with `TREEHOUSE_API_BASE=https://api.example.com`.

---

## Post-deploy checklist

- [ ] `https://api.example.com/api/health` returns 200
- [ ] Sign up / sign in works (check the session cookie is set on `.example.com`)
- [ ] Create a workspace, upload a file → confirm it lands in R2
- [ ] The change feed shows activity; an agent key connects over MCP (`list_workspaces`)
- [ ] Migrations applied (pre-deploy log shows `prisma migrate deploy`)
- [ ] A newly uploaded file's R2 object starts with `THE\0` (encrypted at rest),
      while the app still renders it
- [ ] Files uploaded **before** this deploy still open — they are plaintext at
      rest and are served as-is, verified against their content hash
- [ ] Every KEK — current **and** retired — is backed up somewhere the Railway
      project cannot take with it