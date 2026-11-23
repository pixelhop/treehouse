# One image for the api and workers services (Kubernetes via Canine; see pixelhop infra apps/treehouse).
# Each service picks its server with its command:
#   api:     node packages/api/.output/server/index.mjs
#   workers: node packages/workers/.output/server/index.mjs
# and migrations run before each deploy (Canine's predeploy Job, no shell):
#   node_modules/.bin/prisma migrate deploy --config packages/db/prisma.config.ts
# No secrets at build time: everything comes from the environment at runtime.
#
# Not at the repo root on purpose: Railway builds a root Dockerfile as soon as one appears on a
# branch it deploys. Build from the repo root: docker build -f deploy/Dockerfile .

# Must equal .nvmrc: CI fails when they differ (the "Dockerfile Node matches .nvmrc" step in ci.yml).
ARG NODE_VERSION=22.23.4

FROM node:${NODE_VERSION}-alpine AS build
ENV CI=true
WORKDIR /app
COPY . .
# pnpm from packageManager in package.json (the version Railway read from engines.pnpm).
RUN npm install -g "$(node -p "require('./package.json').packageManager")"
# Only what the two servers need: no app, marketing, desktop (Electron) or CLI. VP_GIT_HOOKS=0:
# the root `prepare` (vp config) would install git hooks, and there's no git here.
RUN VP_GIT_HOOKS=0 pnpm install --frozen-lockfile --filter "api..." --filter "workers..."
RUN pnpm --filter api run build && pnpm --filter workers run build
# The Prisma CLI for migrations: packages/db with its own dependencies, from pnpm-lock.yaml.
RUN pnpm --config.inject-workspace-packages=true --filter db deploy /migrate

FROM node:${NODE_VERSION}-alpine
WORKDIR /app
COPY --from=build /migrate ./packages/db
# So the predeploy command's node_modules/.bin/prisma resolves from /app (Canine runs it there).
RUN ln -s packages/db/node_modules node_modules
COPY --from=build /app/packages/api/.output ./packages/api/.output
COPY --from=build /app/packages/workers/.output ./packages/workers/.output
ENV NODE_ENV=production
USER node
CMD ["node", "packages/api/.output/server/index.mjs"]
