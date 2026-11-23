# Treehouse API

The [Nitro](https://nitro.build) server behind Treehouse. It hosts authentication (better-auth), the file service and its REST API, and the MCP server agents connect to.

## Running locally

From the repository root, `pnpm dev` starts the API and the app together with a database and generated `.env` files. `pnpm dev:api` starts the API alone. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

Configuration is documented in [`.env.example`](./.env.example) and [DEPLOYMENT.md](../../DEPLOYMENT.md).