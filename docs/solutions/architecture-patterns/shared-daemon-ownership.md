---
title: Shared sync-daemon ownership — stable path, plist-drift repair, and the build-time env-baking trap
module: desktop
date: 2026-07-07
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "changing how the daemon binary is installed, updated, or launched (app or CLI side)"
  - "adding config the packaged Electron app must know at runtime"
  - "touching packages/cli/src/service.ts or packages/desktop/src/daemon.ts"
related_components:
  - development_workflow
tags:
  - launchd
  - daemon
  - electron-builder
  - esbuild-define
  - codesign
  - version-skew
---

# Shared sync-daemon ownership — stable path, plist-drift repair, and the build-time env-baking trap

## Context

One sync daemon serves two independently-updated installers: the CLI (`treehouse`) and the desktop app. Both historically wrote the launchd plist pointing at _their own_ executable (`process.execPath`), so whichever installed last owned the service — and an old CLI's `stop`/`start` could silently revert to a daemon missing newer safety guards.

## Guidance

The ownership rules (implemented in `packages/desktop/src/daemon.ts` `decideDaemonManagement`/`reconcileDaemon`, `packages/cli/src/service.ts`):

- The daemon binary lives at a **stable per-user path** outside the .app bundle (trash-the-app leaves a working daemon, not a launchd crash-loop) and outside the CLI binary (the CLI updater and app updater stop fighting).
- **Newest wins, from either side**: whichever installer carries a newer daemon swaps it in (temp+rename) — and the swap **verifies the binary's code signature against the expected Team ID first**, keeping the running daemon on failure.
- Clients refuse to manage a daemon whose IPC protocol handshake is newer than they know.
- **Old clients are hostile writers**: already-shipped CLIs rewrite the plist to `process.execPath` on `start` and delete it on `stop`. The shell runs a **monitor-and-repair loop** (on launch + periodic, error-contained, logged) that re-asserts the stable path. Design for the installed base you have, not the one you're shipping.

## Why This Matters

**The env-baking trap (validated P0):** the Team-ID gate read `process.env.TREEHOUSE_TEAM_ID` — but a packaged Electron app inherits no CI env. Setting the variable in the release workflow does **nothing** unless it's baked into the bundle at build time via an esbuild `define` (see `packages/desktop/scripts/build.mjs`). The shipped gate was fail-closed but _inert_: every daemon swap refused, and the fallback then baked the Electron GUI binary into the plist. Same class of trap as `NUXT_PUBLIC_API_URL` being build-time-baked in the SPA (see `developer-experience/railway-cloudflare-deploy-gotchas-2026-06-08.md`).

**Rule: any value the packaged app needs is either baked via `define` (with a CI assertion that the placeholder is gone — grep the bundle) or read from a file at runtime. A CI env var alone never reaches the bundle.**

## When to Apply

Any change to daemon install/update/launch on either side; any new build-time configuration for `packages/desktop`; release workflow changes touching signing or the daemon artifact.