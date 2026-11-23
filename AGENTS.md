# General info

This repository is **Treehouse** — an agent-native + human shared file workspace built on the Pixelhop monorepo. Packages:

- `packages/api` – Nitro API. Hosts better-auth (`/api/auth/*`, email/password + organization + **api-key** plugins), the Treehouse **file service + REST API** (`/api/workspaces/[id]/{files,list,move,changes,members}`, `/api/keys`, `/api/workspace`, `/api/invites`), and the **MCP server** (`/api/mcp`) exposing filesystem tools to agents. Runs on Node (Railway).
- `packages/app` – Nuxt 4 SPA with auth plus the Treehouse **workspace** page (file browser, per-workspace members panel, invite links, API-key management). There is no organizations UI — the workspace is the only container users see. Deploys to Cloudflare Workers.
- `packages/db` – Prisma 7 client (driver adapter). better-auth schema **plus hand-maintained Treehouse models** (Workspace, FileNode, ChangeEvent).
- `packages/workers` – Nitro-based BullMQ worker (billing maintenance jobs). Runs on Node.
- `packages/cli` – `treehouse` two-way sync CLI (run via `bin/treehouse.mjs`). Syncs a local folder to a workspace using a workspace-scoped API key.
- `packages/design` – brand/design tokens, fonts, and logo/motif SVG assets. The spec is `/design.md` at the repo root (machine-readable YAML frontmatter + prose rules); the package is the implementation.
- `packages/marketing` – Nuxt 4 marketing site (same stack/deploy target as `app`). Hosts the live brand reference at `/brand`. Dev: `vp run marketing#dev` (port 3030; needs `TMPDIR=/tmp` on macOS — same vite-node socket caveat the dev-env script handles for the app).

Treehouse specifics:

- **Auth for agents/CLI** is the better-auth `apiKey` plugin; keys carry `{ workspaceId, actorType }` metadata. Change-feed attribution is by the key's `actorType` (by credential, not by route).
- **The shared file-service** (`packages/api/server/utils/files.ts`) is the single write path for both REST and MCP: per-file version CAS, collision-safe conflicted copies on stale writes (never lose data), hard-delete with resurrection-over-loss.
- **Storage**: file bytes live behind `useBlobStore()` — R2 (S3 API) when `R2_*` env vars are set, else a local filesystem driver (`BLOB_DIR`). Metadata is in Postgres.
- **Reading request headers**: build a `Headers` object via `getRequestHeaders(event)` (see `webHeaders` in `server/utils/workspace.ts`), NOT `toWebRequest(event)` — the latter locks the body stream and hangs PUT/POST.
- **Schema caveat**: the Treehouse models are hand-maintained below the auth section of `schema.prisma`. `auth:generate` regenerates the WHOLE file and will delete them — don't re-run it now that they exist (regenerate into a scratch file and merge by hand if the auth config must change).

Guidelines:

- Write all application code in TypeScript.
- Tooling is **Vite+** (`vp`): use `vp install`, `vp check`, `vp fmt`, `vp lint`, `vp test`, and `vp run <script>`. `vp` delegates package management to pnpm. Prefer `vp check` for validation loops.
- Authentication is **better-auth** with the **organization** plugin, enabled by default. The auth server lives in `packages/api/server/utils/auth.ts`; the app client in `packages/app/app/composables/useAuthClient.ts`. Don't add a second auth provider — extend better-auth (plugins) instead. **Organizations are invisible**: each workspace owns exactly one, purely to carry its member list, roles, and the key-revoking `afterRemoveMember` hook. Never surface an organization to a user, and never add a second workspace to an existing one — create workspaces with `createWorkspaceWithOrg` (`packages/api/server/utils/workspace.ts`).
- After changing the auth config, run `pnpm --filter api run auth:generate` then `pnpm --filter db run prisma:migrate`.
- Never commit secrets. Each package has a committed `.env.example`; real `.env` files are gitignored.
- Everything in this repo is **AGPL-3.0-only**, including the desktop app and any future mobile app. A new package declares `"license": "AGPL-3.0-only"` in its `package.json`. The Treehouse name and logo are trademarks, not licensed: see `TRADEMARK.md`.
- CI (`.github/workflows/ci.yml`) runs lint → typecheck → test on PRs and pushes to `main` using workspace-wide `vp` commands, with a Postgres service for the suites that need a database. Tests are auto-discovered; a new package joins the typecheck stage by declaring a `typecheck` script (`nuxt typecheck` for Nuxt, `tsc --noEmit` otherwise). Reproduce locally with `pnpm lint`, `pnpm typecheck`, `pnpm test` (the last after `pnpm env:setup`, for the database).
- Code health is tracked with **Fallow** (`.fallowrc.jsonc`). A separate CI job posts the score and fails on newly introduced error-level findings. Before committing or opening a PR, run `pnpm fallow:audit` and fix new findings rather than suppressing them. See `.agent/docs/fallow.md` for commands, exceptions and how the gate works.
- pnpm 11 config lives in `pnpm-workspace.yaml`. Packages must be at least three days old to install, and only packages listed in `allowBuilds` may run install scripts.
- **Verify changes visually — actually look at them — unless it is genuinely impossible.** Green tests and a clean typecheck say the code runs, not that it works or that it is any good. Run the thing, drive the path you changed, and look at the result before reporting it done. Nearly every UX defect in this repo's history was found by using the app, not by a test or a review: the desktop app offering "Download the Mac app" to someone already inside it; onboarding rendering inside the workspace chrome for a workspace not yet connected; a folder control given permanent sidebar space for a once-a-year action; blue workspace tiles on a cream-and-green screen. None of those fail a test, and none survive a look.
  - **Web UI:** `agent-browser` (see its skill) drives a real browser and takes screenshots. Close its daemon before attaching to a different target — `--cdp <port>` is silently ignored when one is already running, and you will screenshot the wrong browser without noticing.
  - **The desktop shell:** launch Electron with `--remote-debugging-port=9222` and attach. `docs/desktop/testing-onboarding-locally.md` has a tested recipe, including the two address details that make the local stack work.
  - **Genuinely impossible** means native dialogs, the tray, Finder, launchd, packaged-app behaviour — the things CDP cannot reach. Those go on `docs/desktop/qa-checklist.md` instead, so untestable never quietly becomes unverified.
  - When you could not look, **say so plainly** in the report rather than implying it was checked.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.

# Local dev / worktrees

Run the stack with `pnpm dev` (api + app; add `-- --workers` for the BullMQ worker) from any checkout. Every git worktree gets an **isolated env** via `scripts/dev-env.mjs`: branch-prefixed Portless hostnames (`https://<branch>.treehouse.localhost`), its own Postgres database (`treehouse_wt_<slug>` in the shared container), generated `.env` files, per-worktree blob dir, and a BullMQ queue prefix. So features can run in parallel worktrees without colliding — no manual env setup needed. `pnpm env:status` prints this worktree's URLs/db; `pnpm env:teardown` drops its db; orphaned dbs are pruned automatically on the next `pnpm dev` anywhere (or `pnpm env:prune`). The primary checkout keeps the unprefixed URLs and the `postgres` db. See "Parallel dev environments in git worktrees" in CONTRIBUTING.md.

**Only start the dev env when you actually need a running stack.** Most tasks don't: for code changes, `vp check` and `vp test` are enough, and migrations can be validated against a scratch database. Reach for `pnpm dev` when the task requires observing runtime behavior — verifying a change in the browser, manually exercising API routes, debugging something that only reproduces live, or demoing. In-between options: `pnpm env:setup` prepares the env (db + .env files + migrations) without starting servers — enough to run integration tests or one-off scripts; `pnpm dev:api` starts just the API. If you do start servers, they're yours to stop when you're done verifying.

Worktree caveats: `.env` files are deliberately NOT copied from the main checkout (each env generates its own, pointing at its own database — don't add them to a `.worktreeinclude`), and a worktree must be on a feature branch (a worktree sitting on `main`/detached HEAD shares the primary checkout's hostnames and database).

# Hosting & deployment

This template assumes a split deployment. Keep this boundary in mind when adding code or infrastructure:

- **Cloudflare** hosts the **front-end only** (`packages/app`, a Nuxt SPA deployed as a Cloudflare Worker via the `cloudflare_module` preset + `wrangler.jsonc`). It must run on the Workers runtime — avoid Node-only APIs not covered by `nodejs_compat`, and do **not** import Prisma, Redis, or other server/Node dependencies into the app bundle.
- **Railway** hosts the **backends and the database** (Node runtime):
  - `packages/api` – the Nitro API + better-auth.
  - `packages/workers` – the BullMQ worker (needs Redis + a long-running process).
  - **PostgreSQL** – the database (managed Railway Postgres). `DATABASE_URL` points the api/workers/db packages at it.
  - Redis – the BullMQ broker.
- The app talks to the API over the network (cross-origin), so the session cookie depends on the credentialed CORS + `trustedOrigins` setup. Add every deployed front-end origin (prod + Cloudflare previews) to the API's `APP_URL`, and set `NUXT_PUBLIC_API_URL` on the Worker.
- Anything that needs Prisma, Redis, a filesystem, or a long-lived process belongs on Railway, not Cloudflare.
- **Cloudflare deploys run in GitHub Actions** (`.github/workflows/cloudflare.yml`), not Cloudflare's git integration. PRs build and dry-run the Workers (app, marketing, and the byte Worker in `packages/blob-worker`), and the marketing site also gets a preview at a per-PR URL, linked in a PR comment; merges to `staging` and `main` deploy them. Build-time variables (`NUXT_PUBLIC_API_URL`, `NUXT_PUBLIC_POSTHOG_KEY`) live in that workflow. See `docs/solutions/developer-experience/cloudflare-deploys-via-github-actions.md`.

# Agent skills

Repo skills live in `.agent/skills/` and are symlinked into `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex), so both agents discover the same copy. Edit the canonical files under `.agent/skills/`.

- `adversarial-review`: after opening a PR, have it reviewed by a model from the _other_ provider (Claude-written PRs are reviewed by the local Codex CLI, Codex-written PRs by the local Claude CLI). Findings are posted as inline PR review comments.
- `babysit-pr`: work through a PR's review comments and failing checks until none are left. It fixes valid feedback, replies with reasoning when it disagrees, and keeps polling until the PR is quiet.

The usual flow for agent-written work: open the PR → `adversarial-review` → `babysit-pr`.

# ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in `.agent/PLANS.md`) from design to implementation.

# Public docs

The user and agent documentation at `trytree.house/docs` lives in `packages/marketing/content/docs/` (Nuxt Content markdown, prerendered, with `.md` twins, `/llms.txt` and an agent skill). Read `.agent/docs/public-docs.md` before adding or changing a page, and update the docs in the same PR when you change something they describe (a UI label, a limit, an MCP tool). Screenshots are regenerated with `packages/marketing/scripts/docs-screenshots/`.

# Comparison pages and guides

`/compare` and `/guides` on the marketing site live in `packages/marketing/content/pages/`. Read `.agent/docs/compare-pages.md` before adding one or changing what one claims, and update them in the same PR when you change something they describe.

# Documented solutions

`docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

# Concepts

`CONCEPTS.md` — shared domain vocabulary (entities, named processes, status concepts) with project-specific meaning. Relevant when orienting to the codebase or discussing domain concepts.