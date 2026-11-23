# Treehouse app

The Treehouse web app: a Nuxt 4 single-page app holding the workspace (file browser, editor, comments, sharing, members and keys). It talks to the API in `packages/api` and deploys as a Cloudflare Worker.

## Running locally

From the repository root, `pnpm dev` starts the app and the API together. `pnpm dev:app` starts the app alone. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

Configuration is documented in [`.env.example`](./.env.example).