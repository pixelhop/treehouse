---
title: "Cloudflare Workers deploys moved from Workers Builds to GitHub Actions"
date: 2026-10-12
category: developer-experience
module: deployment
problem_type: developer_experience
component: development_workflow
severity: high
applies_when:
  - "A 'Workers Builds: treehouse-app' or 'treehouse-marketing' check fails, or a merge to main doesn't reach production"
  - "Changing how the app or marketing Worker is built or deployed, or adding a build-time variable"
  - "Rotating the Cloudflare API token used by CI"
  - "A PR's marketing preview is missing or out of date"
tags:
  - cloudflare-workers
  - github-actions
  - wrangler
  - deployment
  - ci
---

# Cloudflare deploys run in GitHub Actions

`.github/workflows/cloudflare.yml` builds and deploys three Workers:

- `treehouse-app` serves `app.trytree.house` from `packages/app`.
- `treehouse-marketing` serves `trytree.house` and the docs from `packages/marketing`.
- `treehouse-blob-worker` serves file bytes on `treehousefiles.com` from
  `packages/blob-worker` (staging: `treehouse-blob-worker-staging` on
  `staging.treehousefiles.com`). See `blob-worker-byte-path.md`.

## Why we stopped using Workers Builds (Cloudflare's git integration)

Until 2026-10-12 both Workers deployed through Workers Builds. Its build commands,
branch rules and build variables lived only in the Cloudflare dashboard, and so did
its logs. GitHub only showed a bare pass or fail. In practice:

- **Every PR branch failed `treehouse-app`** (#90–#97). The cause was a branch-build
  configuration nobody could read from the repo, so every PR merged red.
- **Merges to main failed intermittently.** After #96 and #97 the marketing build
  _uploaded_ a new version but never activated it, so the docs stayed stale. A
  local dry run of the same deploy passed. The log that would say why is
  dashboard-only, and the wrangler OAuth token is refused for build logs.
- **Nothing retried and nothing queued.** Two merges two minutes apart produced
  overlapping production builds, and one of them failed.

The underlying platform issue may be transient: a Cloudflare API "malformed
response" seen during the investigation went away on retry. Either way, the fix is
a pipeline we can read and that retries.

## What the workflow does

| Trigger        | Steps                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request` | Install with a frozen lockfile, build exactly as production does, run the app's dev-URL preflight, then `wrangler deploy --dry-run`. Needs no credentials. |
| push to `main` | The same steps, then `wrangler deploy` with 3 attempts and backoff, then a check that the live URL answers 200.                                            |

### Marketing previews on pull requests

Every PR from a branch in this repo uploads a **preview version** of the
marketing site with `wrangler versions upload --preview-alias pr-<number>`. A
version takes no production traffic; the alias gives it a stable URL,
`https://pr-<number>-treehouse-marketing.<subdomain>.workers.dev`, which moves
to each new push. The workflow checks that the preview answers, then posts the
URL as a PR comment and edits that one comment on later pushes.

- It needs `preview_urls: true` in `packages/marketing/wrangler.jsonc`
  (wrangler's default is off).
- It uses the same `CLOUDFLARE_API_TOKEN`, so it works for branches in this repo
  only. Forks get no secrets and skip the preview.
- PR builds have analytics off (`NUXT_PUBLIC_POSTHOG_KEY` is empty), so previews
  never land in production analytics. They read the production API, so the
  homepage shows the live prices.
- The app gets no preview. Its session cookie is scoped to `.trytree.house`,
  and a `workers.dev` preview could not sign in against either API.

- One deploy per Worker runs at a time. A newer merge waits for the current deploy
  instead of racing it.
- All build-time configuration is in the workflow's `env`:
  - `NUXT_PUBLIC_API_URL`, which is baked into the SPA at build time. It must equal
    `packages/app/wrangler.jsonc` `vars.NUXT_PUBLIC_API_URL`, and the build
    enforces that.
  - `NUXT_PUBLIC_POSTHOG_KEY`, the public project key. Without it the build ships
    with analytics off, which is how staging and PR builds are built.
  - Optionally `POSTHOG_CLI_TOKEN` (secret) and `POSTHOG_PROJECT_ID` (repo
    variable) for source-map upload.
- Runtime variables still come from each `wrangler.jsonc`.

## One-time setup

1. **Create a Cloudflare API token.** In the Cloudflare dashboard go to My Profile
   → API Tokens → Create Token, then use the **"Edit Cloudflare Workers"** template:
   - Account resources: the **Pixelhop** account.
   - Zone resources: **all zones** in the account (the token in use, named
     `treehouse-github`, has this). The app and marketing Workers attach custom
     domains on `trytree.house`, the byte Worker on `treehousefiles.com`; a
     token limited to specific zones must list both.

   The template grants Workers Scripts: Edit, Workers Routes: Edit and Account
   Settings: Read, which is what `wrangler deploy` with custom domains needs.

2. **Add it to GitHub** as the repository secret `CLOUDFLARE_API_TOKEN`:
   `gh secret set CLOUDFLARE_API_TOKEN`. The account ID is not secret and is
   already in the workflow.
3. **Switch off Workers Builds on both Workers.** Otherwise every merge deploys
   twice. Go to Workers & Pages → `treehouse-app` → Settings → Build → **Disconnect**
   the Git repository, then repeat for `treehouse-marketing`. This also removes
   the "Workers Builds: …" checks from PRs.
4. Re-run the latest `main` run of the **Cloudflare** workflow, or push to `main`,
   and confirm both jobs end with "→ 200".

If the token is missing, a `main` run fails with an explicit error rather than
skipping the deploy silently.

## Deploying by hand

This is still possible, for example to roll back:

```bash
NUXT_PUBLIC_API_URL=https://api.trytree.house NUXT_PUBLIC_POSTHOG_KEY=phc_… pnpm --filter app build
pnpm --filter app run deploy                     # preflight + wrangler deploy
pnpm --filter marketing build && pnpm --filter marketing exec wrangler deploy
```

To roll back without rebuilding, activate an earlier version with
`wrangler versions deploy <version-id>@100%`. List versions with
`wrangler versions list --name <worker>`.