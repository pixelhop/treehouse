# Treehouse workers

A Nitro service that runs Treehouse's background jobs on BullMQ and Redis: hourly billing reconciliation and daily pruning of share-view records.

## Running locally

From the repository root, `pnpm dev -- --workers` starts the worker alongside the API and the app. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

The queue dashboard (Bull Board) is at `/admin/queues`, behind basic auth. It is disabled until `NITRO_BULL_BOARD_USERNAME` and `NITRO_BULL_BOARD_PASSWORD` are both set. Configuration is documented in [`.env.example`](./.env.example).