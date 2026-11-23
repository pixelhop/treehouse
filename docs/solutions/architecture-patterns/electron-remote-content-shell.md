---
title: Electron remote-content shell — security posture and the webview cookie-partition trap
module: desktop
date: 2026-07-07
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "building or modifying packages/desktop windows that load the deployed web app"
  - "adding any flow that assumes browser state (session, active org) reaches the shell's webview"
  - "handling treehouse:// deep links or any externally-supplied origin"
related_components:
  - authentication
tags:
  - electron
  - webview
  - cookie-partition
  - tofu
  - deep-links
  - sandbox
---

# Electron remote-content shell — security posture and the webview cookie-partition trap

## Context

The desktop app (`packages/desktop`) renders the _deployed_ web app in an Electron window rather than bundling a second UI. Remote content in a native shell is a privileged-escalation surface: anything the page can reach, a compromised or phished page can reach too. Separately, the shell's webview looks like "the browser" but is not — which broke the hero invite flow in a validated P0.

## Guidance

**Security posture (see `packages/desktop/src/security.ts` — policy is pure and snapshot-tested):**

- The workspace window is sandboxed, context-isolated and `nodeIntegration: false`.

**Amended 2026-07-30.** This originally said "no preload script at all — zero IPC
surface", with local actions confined to the tray. That held until the workspace UI
needed to answer "where does this workspace sync on this Mac?". The shell could only
push state at page-load time (URL fragments), which is useless for a window the user
navigates around in, so the honest options were a bridge or leaving folders
undiscoverable outside the menubar.

A preload now exists. What replaces "no surface" as the safety argument is the SHAPE
of that surface, and it is worth stating so nobody widens it casually:

- **Read and request, never perform.** The page can read what is synced and ask for
  an action. Every mutation runs in the main process behind a native dialog the user
  answers. Compromising the page buys the ability to open a dialog, not to touch the
  filesystem.
- **No paths outward.** Only basenames cross. The page never learns the user's home
  directory or a folder's location.
- **Ids are validated before use** (`isValidWorkspaceId`) — anything with a path
  separator, dot, whitespace or control character is refused before it reaches the
  registry.
- **Origin-scoped.** A preload attaches to the webContents, so it re-runs on every
  permitted navigation including to the API origin. The bridge is exposed only on the
  app origin, and the origin is injected per window rather than baked — a baked one
  would withhold the bridge from every self-hosted instance.
- Sandbox and context isolation stay on, so `contextBridge` remains the only crossing.

The cost, stated plainly: an XSS on the app origin can now make a dialog appear. It
still cannot move, unlink, or read a path.

- Navigation is allow-listed to exactly the app origin + API origin (`will-navigate`, `will-redirect` and `will-frame-navigate`, which covers iframes). The one exception is for subframes, never the main frame: they may load the YouTube, Vimeo and Loom player paths in `EMBEDDED_PLAYERS` (`security.ts`), so videos in the "What's new" release notes play instead of leaving a blank box. `setWindowOpenHandler` denies and routes validated `https:`-only URLs to the system browser.
- The session lives in a named persistent partition (`persist:treehouse-workspace`) so sign-in survives restarts — and **sign-out must clear the partition**, not just revoke sync keys, or a "signed out" shared machine still opens an authenticated workspace UI.
- Any origin arriving from outside (deep link, pasted URL) gets a **trust-on-first-use confirmation in shell chrome before anything loads** — a chrome-less window has no address bar, so the shell must supply the signal the browser normally provides. Never persist an untrusted origin before the user confirms it: a declined hostile deep link that was persisted pre-consent re-hijacked every subsequent launch until fixed.

## Why This Matters

**The cookie-partition trap (validated P0):** the shell's partition is a _separate cookie jar_ from the user's browser. Anything a web flow sets browser-side — session, and critically better-auth's _active organization_ — does not exist in the webview's session. The invite flow accepted membership in the browser (which called `setActive`), but the webview session fell back to the user's personal org, so the org-scoped workspace list omitted the invited workspace and the device grant livelocked (mint → mismatch → revoke → identical retry).

**Rule: never build a shell flow on org/session state a browser flow set.** Resolve what you need authoritatively by id with membership checked server-side (see `/link`'s app mode resolving `?workspace` via a cross-org lookup instead of trusting the active-org list).

## When to Apply

Any new window, webview, deep-link handler, or onboarding step in `packages/desktop`; any web-page change that expects to interoperate with the shell.