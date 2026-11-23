---
title: Production sign-in did nothing after the PWA merge — the prerendered shell froze a stale build-time API URL
module: packages/app/nuxt.config.ts
date: 2026-09-04
problem_type: bug
component: deployment
severity: critical
applies_when:
  - "the app's API origin changes (new domain, new host, self-hosted instance)"
  - "changing what nuxt.config prerenders, or how the service worker serves navigations"
  - "editing the Cloudflare Workers Builds build variables or wrangler.jsonc vars"
  - "sign-in appears to succeed but the app bounces straight back to the sign-in page"
related_components:
  - pwa_service_worker
  - well_known_descriptor
  - better_auth_cookies
tags:
  - pwa
  - prerender
  - nuxt
  - cloudflare-workers
  - runtime-config
  - cookies
  - deployment
---

# Production sign-in did nothing after the PWA merge

## Symptom

On https://app.trytree.house, clicking "Climb in" with correct credentials did
nothing: no error, no navigation. The request itself returned 200.

## Cause

The installable-PWA work (PR #74) prerenders `/` so Workbox can precache the
app shell and bind its navigation fallback to it. Prerendering freezes the
public runtime config — including `apiUrl` — into `index.html` **at build
time**. Before that, the Worker rendered the shell per request and injected the
runtime `NUXT_PUBLIC_API_URL` var, which had been quietly overriding a stale
build-time value for months.

The git-connected Cloudflare build still carried the retired
`treehouse-api.pixelhop.io` as its build variable, while the runtime var (and
the API's `COOKIE_DOMAIN`) had moved to `trytree.house`. So:

1. The prerendered shell sent every API call to the old host.
2. Once the service worker installed, its navigation fallback served that shell
   for **every** page, so even a direct load of `/sign-in` got the stale value.
3. Sign-in succeeded on the old host, which set the session cookie with
   `Domain=.trytree.house`. Browsers reject a cookie whose domain does not
   match the responding host, so the cookie was dropped and the session check
   after `navigateTo("/workspace")` bounced the user back.

Diagnostic that made it obvious: `curl https://app.trytree.house/` showed
`apiUrl:"https://treehouse-api.pixelhop.io"` in the config payload, while
`curl https://app.trytree.house/sign-in` (runtime-rendered) and
`/.well-known/treehouse` both said `https://api.trytree.house`.

## Fix

- **Operational:** set the Workers Builds **build** variable
  `NUXT_PUBLIC_API_URL=https://api.trytree.house` (Settings → Build →
  Variables, separate from the runtime var) and redeploy.
- **Guard:** `scripts/verify-pwa-build.mjs` (chained into `pnpm build`) now
  reads the `apiUrl` baked into `index.html` and fails the build when it
  disagrees with `wrangler.jsonc` `vars.NUXT_PUBLIC_API_URL`. The check runs at
  build, not deploy, so a git-connected build with a stale variable fails
  closed instead of shipping. The localhost dev default is still allowed at
  build time; `preflight-deploy.mjs` refuses to deploy that.

## Rule

The build-time `NUXT_PUBLIC_API_URL` and the Worker var are **one value in two
places**, and the build enforces that. When the API origin moves, change both,
and remember that Workers Builds keeps build variables and runtime variables in
different settings pages.

## After a corrected deploy

Users already on the stale shell recover automatically: the browser re-fetches
`sw.js` on the next navigation (it is served `max-age=0, must-revalidate`),
the new worker installs and waits, the plugin activates it as soon as the tab
has no unsaved work, and the tab reloads onto the corrected shell.