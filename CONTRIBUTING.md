# Contributing to Treehouse

Thanks for your interest in improving Treehouse!

> **We aren't accepting pull requests from outside Pixelhop yet.** Treehouse is
> still early and changing quickly, so please don't open one. Issues are very
> welcome.

Treehouse is licensed under **AGPL-3.0-only** (see [`LICENSE`](./LICENSE)). The
Treehouse name and logo are covered by [`TRADEMARK.md`](./TRADEMARK.md), not the
license. The rest of this guide covers how to set up the project, and the tooling
and workflow the team uses.

## How to help

- **Report a bug** — open a [bug report](https://github.com/pixelhop/treehouse/issues/new/choose).
- **Request a feature** — open a feature request issue.
- **Ask a question / share an idea** — email <info@pixelhop.io>.
- **Report a security vulnerability** — **do not** open a public issue; follow
  [`SECURITY.md`](./SECURITY.md).

## Repository layout

Treehouse is a pnpm monorepo:

- `packages/api` — Nitro API: better-auth, the file service + REST API, and the
  MCP server (`/api/mcp`).
- `packages/app` — Nuxt 4 SPA (auth, workspace file browser, members, sharing).
- `packages/db` — Prisma 7 client and the database schema.
- `packages/workers` — BullMQ worker.
- `packages/cli` — the `treehouse` two-way sync CLI.
- `packages/desktop` — the Electron desktop app.
- `packages/blob-worker` and `packages/blob-io` — the Cloudflare Worker that
  serves file bytes, and the code it shares with the API.
- `packages/marketing` — the marketing site and public docs.
- `packages/design` — brand tokens, fonts and logo assets.
- `packages/shared` — code shared across packages.

## Prerequisites

- **Node.js** — the version pinned in [`.nvmrc`](./.nvmrc) (Node 22). Use
  `nvm use` (or your version manager's equivalent).
- **pnpm** — the exact version is pinned by `packageManager` in `package.json`.
- **Docker** — for the local Postgres (and Redis) containers.

## Getting started

```bash
git clone https://github.com/pixelhop/treehouse.git
cd treehouse
vp install --frozen-lockfile
```

## Tooling: Vite+ (`vp`)

Treehouse uses **[Vite+](https://viteplus.dev/)** as its toolchain. The `vp`
binary is installed with the dependencies (`node_modules/.bin/vp`). The commands
you'll use most:

- `vp check` — typecheck + lint + format check across the monorepo. **This is
  the primary validation loop — run it before pushing.**
- `vp test` — run the test suites.
- `vp fmt` — auto-format (Markdown and YAML included). Run this on any docs or
  config you add.
- `vp lint` — lint only.

`vp` delegates package management to pnpm, so `pnpm install` and `vp install`
are interchangeable. To build every package for production, use `vp run build`
(the root `build` script), **not** `vp build`: the app is built by Nuxt and the
API and workers by Nitro, so there is no standalone Vite entry for `vp build`.

pnpm 11 reads its settings from `pnpm-workspace.yaml` (`.npmrc` is for registry
auth only). A package only installs once it is at least three days old
(`minimumReleaseAge`), and only packages listed under `allowBuilds` may run
install scripts. If a new dependency needs one, add it there deliberately rather
than running `pnpm approve-builds` blindly.

TypeScript stays on 6.x for now: `vue-tsc` (used by `nuxt typecheck`) needs the
JavaScript compiler API that TypeScript 7's native compiler no longer ships.

CI runs lint, typecheck and tests on every pull request, plus a
[Fallow](./.agent/docs/fallow.md) code-health check that fails on newly
introduced error-level findings (see
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml)). Reproduce it locally
with `pnpm lint`, `pnpm typecheck`, `pnpm test` (after `pnpm env:setup`, for the
database) and `pnpm fallow:audit`.

## Running the stack locally

Most changes don't need a running server — `vp check` and `vp test` are enough,
and migrations can be validated against a scratch database. Start servers only
when you need to observe runtime behavior.

- `pnpm dev` — start the api + app (add `-- --workers` for the BullMQ worker).
- `pnpm dev:api` — start just the API.
- `pnpm env:setup` — provision this checkout's env (database + `.env` files +
  migrations) **without** starting servers — enough to run integration tests or
  one-off scripts.
- `pnpm env:status` — print this checkout's URLs and database name.
- `pnpm env:teardown` — drop this checkout's database.

The dev servers run behind [Portless](https://portless.sh) (`npm install -g
portless`), which gives each one a stable HTTPS URL: the app at
`https://treehouse.localhost` and the API at `https://api.treehouse.localhost`.
The first run asks for your password once, so Portless can bind port 443, add the
`.localhost` hostnames and trust its local certificate authority. The app and API
are sibling subdomains, so the session cookie flows between them with no extra
config. `pnpm dev` starts Postgres (and Redis, with `--workers`) in Docker itself.

Scripts and agents hitting the API over Portless HTTPS need Node to trust its
certificate authority through the system store (Node 24+):

```bash
SMOKE_BASE=https://api.treehouse.localhost \
NODE_OPTIONS=--use-system-ca \
  node_modules/.bin/tsx scripts/e2e-demo.mts
```

`portless get api.treehouse` prints a service's URL.

### Parallel dev environments in git worktrees

Every git **worktree on a feature branch** gets a fully isolated environment
automatically: branch-prefixed hostnames, its own Postgres database, generated
`.env` files, a per-worktree blob directory, and a queue prefix — so you can run
features in parallel worktrees without collisions. The `.env` files are
generated per worktree and are **not** copied between checkouts (each points at
its own database). A worktree must be on a feature branch; one sitting on `main`
or a detached HEAD shares the primary checkout's environment.

`scripts/dev-env.mjs` derives a slug from the branch name (its last segment,
sanitised, so `feat/search` becomes `search`) and isolates each concern:

| Concern        | Isolation                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Hostnames      | Portless prefixes routes per worktree: `https://search.treehouse.localhost`, `https://search.api.treehouse.localhost` |
| Ports          | Portless assigns each dev server a free port                                                                          |
| Postgres       | A database per worktree, `treehouse_wt_<slug>`, in the **shared** container                                           |
| `.env` files   | Generated from `.env.example` on first run (secrets included), never overwritten                                      |
| Blob storage   | `BLOB_DIR=.data/blobs` is relative, so it's already per worktree                                                      |
| BullMQ / Redis | Shared Redis, with a per-worktree `NITRO_QUEUE_PREFIX` namespacing the queues                                         |

The primary checkout keeps the `postgres` database and the unprefixed URLs.
`pnpm dev -- --clone` seeds a new worktree's database from the primary
checkout's data (the primary env must be idle).

Teardown is automatic: every `pnpm dev` and `pnpm env:setup` drops databases
whose worktree no longer exists. `pnpm env:teardown` drops this worktree's
database now, and `pnpm env:prune` drops the orphaned ones. `.env` files and
`.data/` blobs live inside the worktree, so `git worktree remove` cleans those up.

## Working with the database schema — important

`packages/db/prisma/schema.prisma` contains the better-auth tables **plus
hand-maintained Treehouse models** (`Workspace`, `FileNode`, `ChangeEvent`,
`Share`, and others) kept below the auth section.

> **Do not run `pnpm --filter api run auth:generate` casually.** It regenerates
> the **entire** `schema.prisma` from the auth config and **deletes the
> hand-maintained Treehouse models**. If you must change the auth config,
> regenerate into a scratch file and merge the auth section back by hand — never
> let `auth:generate` overwrite the whole schema.

For ordinary schema changes, edit `schema.prisma` directly and create a
migration:

```bash
pnpm --filter db run prisma:migrate      # create + apply a dev migration
```

## Development workflow

### For small changes

Branch, make the change, ensure `vp check` and `vp test` pass, and open a
PR. Keep PRs focused — one logical change per PR.

### For features and significant refactors — write a plan

For anything non-trivial, write a plan first, in whatever format suits the work.
Plans live in `docs/plans/`. If you're proposing a substantial change, open an
issue or a draft plan first so we can align on the approach before you write the
code — it saves everyone a round of rework. Existing plans and the documented
solutions in `docs/solutions/` are good context before starting work in an area.

## Commit and PR conventions

- Write clear, focused commits. Conventional-commit subjects
  (`feat(scope): …`, `fix(scope): …`) are preferred but not required.
- Fill in the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md).
- Make sure `vp check`, `vp test` and `pnpm fallow:audit` pass.
- If you changed something people see, run it and look at the result. A passing
  test doesn't show that it works or that it's any good.
- If you changed something the public docs describe, update
  `packages/marketing/content/docs/` in the same PR.
- Reference the issue your PR addresses.
- New behavior should come with tests where the surrounding code is tested.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating you agree to uphold it. Report unacceptable behavior to
<info@pixelhop.io>.