---
title: Self-host Treehouse
navTitle: Self-hosting
description: Run your own Treehouse server - the architecture, required and optional environment variables, storage and encryption, and connecting clients.
type: hub
position: 9
updated: 2026-10-29
related:
  - /docs/agents/reference/authentication
  - /docs/agents/reference/mcp-server
  - /docs/desktop/cli-reference
---

Treehouse is built to run on infrastructure you control. This page describes what a deployment needs. The repository's `DEPLOYMENT.md` has step-by-step instructions for the reference setup on Cloudflare and Railway.

## 1. Understand the architecture

| Component    | What it is                                                              | Runs on (reference setup)      |
| ------------ | ----------------------------------------------------------------------- | ------------------------------ |
| Web app      | Nuxt single-page app, served from a Cloudflare Worker                   | Cloudflare Workers             |
| API          | Nitro server: authentication, the file service, REST API and MCP server | Node (Railway)                 |
| Worker       | Nitro BullMQ worker for background maintenance jobs, mostly billing     | Node (Railway)                 |
| Database     | PostgreSQL, for accounts, file metadata, versions and the change feed   | Managed Postgres (Railway)     |
| Redis        | The worker's job queue                                                  | Managed Redis (Railway)        |
| Blob storage | File contents, encrypted at rest                                        | Cloudflare R2, or a local disk |

The app talks to the API across origins, so the simplest setup puts them on subdomains of one domain (`app.example.com` and `api.example.com`) and sets `COOKIE_DOMAIN=.example.com` so the sign-in cookie is shared. The browser never talks to blob storage: file bytes always stream through the API.

Run database migrations with `pnpm --filter db run prisma:migrate:deploy` on every deploy, before the new API starts.

## 2. Set the required API variables

| Variable              | Value                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | PostgreSQL connection string                                                                                                                                                            |
| `BETTER_AUTH_SECRET`  | A random secret: `openssl rand -hex 32`                                                                                                                                                 |
| `BETTER_AUTH_URL`     | The API's public URL, such as `https://api.example.com`. It is also the base of the MCP server's OAuth issuer and resource, so it must be the exact URL agents reach.                   |
| `APP_URL`             | The web app's public URL. Comma-separate several origins (for example preview URLs); the first is used in links the API generates, and hosts the sign-in and consent pages agents open. |
| `SHARE_COOKIE_SECRET` | A random secret: `openssl rand -hex 32`. Signs password-unlock cookies for share links.                                                                                                 |
| `BLOB_KEK`            | The master encryption key, in the form `<id>:<base64>` where the decoded key is exactly 32 bytes. Generate one with `printf 'v1:%s\n' "$(openssl rand -base64 32)"`.                    |

With `NODE_ENV=production`, the API refuses to start without `SHARE_COOKIE_SECRET` and `BLOB_KEK`.

::callout{type="warning" title="Back up BLOB_KEK before storing anything"}
`BLOB_KEK` wraps the key that encrypts every workspace's files. **If you lose it, every file is lost permanently.** There is no recovery path: the stored bytes can't be read without it. Keep a copy somewhere outside the deployment that uses it. If you rotate keys, keep every old key too (see `BLOB_KEK_RETIRED` below) until nothing is sealed with it.
::

## 3. Choose blob storage

| Option           | Variables                                                              | Notes                                                                                 |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Cloudflare R2    | `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | All four or none: a partial set stops the API from starting. Keep the bucket private. |
| Local filesystem | `BLOB_DIR`                                                             | A path on a persistent volume. In production it must be set explicitly.               |

R2 is reached through its S3-compatible API. Another S3-compatible endpoint configured through the same `R2_*` variables may work, but only R2 is tested.

In production, with neither R2 nor `BLOB_DIR` set, the API refuses to start rather than write files to disk that a redeploy would wipe.

## 4. Build the web app

The web app needs one variable, `NUXT_PUBLIC_API_URL`, set to the API's public URL. It is baked into the app **at build time**, so set it as a build variable. Also set the same value as the Worker's runtime variable in `wrangler.jsonc`: it feeds the discovery descriptor below, and the build fails if the two differ.

## 5. Add optional settings

| Group           | Variables                                                                                             | Effect                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Cookies         | `COOKIE_DOMAIN`                                                                                       | Shares the session cookie across subdomains, such as `.example.com`                                                         |
| Email           | `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM`, `POSTMARK_MESSAGE_STREAM`                                      | Sends password-reset and email-verification emails through Postmark. Without a token, emails are written to the server log. |
| Email           | `REQUIRE_EMAIL_VERIFICATION`                                                                          | New accounts must confirm their email before signing in whenever a Postmark token is set. `true` or `false` overrides that. |
| Starter content | `TREEHOUSE_SEED`                                                                                      | `0` creates new workspaces empty, without the starter `README.md` and `AGENTS.md`                                           |
| Limits          | `DEFAULT_WORKSPACE_QUOTA_BYTES`, `DEFAULT_WORKSPACE_FILE_LIMIT`                                       | Per-workspace storage and file-count limits. Unset means unlimited.                                                         |
| Limits          | `MAX_FILE_BYTES`                                                                                      | Largest single file, in bytes. Default 104857600 (100 MB). Keep it modest on a small server: uploads are held in memory.    |
| Limits          | `MCP_MAX_READ_BYTES`                                                                                  | Largest `read_file` response over MCP. Default 1048576 (1 MiB).                                                             |
| Encryption      | `BLOB_KEK_RETIRED`                                                                                    | Comma-separated old keys that still open existing workspaces after a rotation                                               |
| Encryption      | `BLOB_DEK_ROTATE_BEFORE`                                                                              | A past time, such as `2026-10-30T09:00:00Z`. Gives every workspace a new data key and re-encrypts its stored files          |
| Encryption      | `DEVICE_KEY_ENC_KEY`                                                                                  | Encrypts keys waiting in the device flow. Defaults to `BETTER_AUTH_SECRET`.                                                 |
| Queue           | `NITRO_REDIS_URL`                                                                                     | Redis connection, for the worker                                                                                            |
| Analytics       | `POSTHOG_KEY`, `POSTHOG_HOST`                                                                         | Server-side error tracking. Off when the key is blank.                                                                      |
| Billing         | `BILLING_ENABLED`, `DEFAULT_PLAN_SLUG`, `STRIPE_*`, `FREE_WORKSPACES_PER_USER`, `INTERNAL_JOB_SECRET` | Plans and payments. Leave unset to run without billing.                                                                     |

### Without billing

With `BILLING_ENABLED` and `DEFAULT_PLAN_SLUG` unset and no Stripe keys, billing is off. Workspaces get no plan and are unlimited, apart from any `DEFAULT_WORKSPACE_*` and `MAX_FILE_BYTES` limits you set, and `GET /api/plans` returns `available: false` so the app shows no plan picker. No Stripe account is needed.

### Rotating encryption keys

Rotation is a configuration change; the API does the work on its own when it restarts, and again every ten minutes.

- **A new master key.** Generate a new key with a new id (`v2:...`) and add it to `BLOB_KEK_RETIRED`. Once every server has restarted with it, swap them: the new key goes in `BLOB_KEK` and the old one in `BLOB_KEK_RETIRED`. Every workspace's data key is then re-sealed under the new master key within seconds. No file is touched. The first step matters if you run more than one server: none of them should meet a data key sealed under a master key it doesn't have. Remove the old key from `BLOB_KEK_RETIRED` only after every server is running with the new key active and the status (below) shows no data key still sealed with the old one. Re-sealing runs every ten minutes, so this can take up to ten minutes after the last server restarts.
- **New data keys.** If the master key and a copy of the database may both have leaked, also set `BLOB_DEK_ROTATE_BEFORE` to the current time. Every workspace gets a new data key, every stored file is re-encrypted under it, and the old data keys are destroyed a day later, once nothing needs them. At the same point, the stored files of workspaces that have been deleted are removed, because there is no key left to re-encrypt them with. Database backups taken before then can no longer open files.

`GET /api/internal/keys/status`, with your `INTERNAL_JOB_SECRET` in the `x-internal-job-secret` header, shows how far a rotation has got.

## 6. Check the discovery descriptor

The web app serves `/.well-known/treehouse`, which tells clients where your API is:

```json
{ "product": "treehouse", "version": 1, "apiUrl": "https://api.example.com" }
```

The desktop app uses it, so people can connect by entering your app's URL. Because that server isn't the hosted Treehouse, the desktop app asks them to confirm they trust it before connecting. The API must be served over HTTPS for the desktop app to accept it.

The CLI doesn't read the descriptor. Pass your API's URL when connecting a folder:

```bash
treehouse login ~/Acme --api-base https://api.example.com
```

or set `TREEHOUSE_API_BASE=https://api.example.com`. See the [CLI reference](/docs/desktop/cli-reference).

## 7. Connect agents

Agents connect exactly as they do to the hosted service, with your API's URL in place of `api.trytree.house`. With browser sign-in there's nothing to create first:

```bash
claude mcp add --transport http treehouse https://api.example.com/api/mcp
```

The client discovers your server's sign-in from `https://api.example.com/.well-known/oauth-protected-resource` and opens the sign-in and consent pages on the first `APP_URL` origin. If `BETTER_AUTH_URL` isn't the API's real public URL, clients can't discover the server, or the tokens they get are refused because their audience doesn't match. The OAuth tables are created by the normal migration step above.

For agents that can't open a browser, create a key in your web app (account menu, **Agents & API keys**) and add it as a header:

```bash
claude mcp add --transport http treehouse https://api.example.com/api/mcp \
  --header "x-api-key: <your key>"
```

See [MCP server](/docs/agents/reference/mcp-server) and [connect other agents](/docs/agents/connect/other-agents).

## 8. Check it works

- `https://api.example.com/api/health` returns `{ "status": "ok", … }`.
- You can sign up and sign in, and the session cookie is set on your domain. With a Postmark token set, sign-up sends a confirmation email first.
- Uploading a file to a new workspace stores it in your bucket or `BLOB_DIR`.
- An agent connected over MCP can call `list_workspaces`.
- Every `BLOB_KEK` you have used is backed up outside the deployment.