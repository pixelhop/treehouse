---
date: 2026-07-30
topic: unified-onboarding
---

# Unified Onboarding — Requirements

## Summary

One onboarding spine — **workspace → folder → connect** — entered from either the web or
the desktop app, so both directions run the same steps in the same order and meet at the
same "connect a folder" moment. Today the two directions are different shapes: the app
picks a folder before it knows which workspace it's for, and the web never mentions the
app unless you arrived by invite. A light branding pass rides along (default the app to
the existing `treehouse` theme, lift the onboarding/auth screens toward the marketing
site's feel) but the flow is the work.

## Problem Frame

Onboarding works, and the desktop app reaches a syncing folder. But the two entry
directions were built separately and the seams show — most visibly in a folder that is
named after nothing.

Concrete defects in the current build:

- **The folder is named `Workspace` on the create path.** Step order is folder → grant
  (`machine.ts:17`). On the create-workspace path there is no `workspaceId` yet, so
  `fetchWorkspaceName` returns `undefined` and the name falls back to the literal
  `"Workspace"` (`effects.ts:154`), then collides into `Workspace 2`, `Workspace 3`. The
  folder name and the workspace the user then picks can never agree, because the folder is
  named before the workspace is known. Observed live on 2026-07-30.
- **There is no folder picker.** `planFolder` accepts an `override` (`folder.ts:86`) but
  `createFolder` never passes one (`effects.ts:155`) — dead code. The folder is silently
  `mkdir`'d at `~/Treehouse/<name>` and the user is never asked. R3's "the chosen local
  folder" is not currently chosen by anyone.
- **The desktop app cannot create a workspace.** App-mode `/link` only selects an existing
  one; a user with zero workspaces dead-ends to a "Create one →" link pointing at a web
  page (`link.vue:570`) in the middle of the native flow.
- **The web → app direction does not exist.** The desktop app is offered on the invite page
  only. Create a workspace on the web and nothing suggests either the app or the CLI, and
  `/link` is CLI-shaped throughout (install → `treehouse login ~/my-folder` → approve).
- **No folder management after setup.** The tray offers Open in Finder, Re-authenticate and
  Pause/Resume (`tray.ts:86-100`). There is no way to change where a workspace syncs, add a
  second folder, or see the path without opening Finder.
- **Onboarding is off-brand.** `packages/design` holds the full system (tokens, Fraunces +
  Nunito Sans, logos, motifs, mascots) but only `packages/marketing` consumes it. The
  product app defaults to the generic blue `#2563eb`, and every auth/onboarding screen a new
  user meets is in that palette — while `[data-theme="treehouse"]` already sits in
  `tailwind.css:133` unused by default.

## Key Decisions

- **One spine, two entrances.** Both directions run workspace → folder → connect. The web
  entrance hands off at the folder step; the app entrance runs all three.
- **Move workspace _selection_ earlier, not the key write later.** Folder-before-grant
  exists so the minted key is written straight into the folder — no in-memory key custody,
  and resume needs no key persistence (`machine.ts:14-15`). That property is preserved
  exactly. Only the workspace choice moves ahead of the folder step.
- **Web screens for the workspace step, native dialog for the path.** The path pick has to
  be native (`dialog.showOpenDialog`); everything else is a web page, so one implementation
  serves both directions and inherits the brand.
- **No preload, no new IPC.** The shell orchestrates: it shows a web step, observes the
  outcome, then shows the native dialog itself. A web step returns its result by navigating
  to a sentinel URL the shell already watches in `security.ts` — the same
  observe-don't-call pattern already used for sign-in (cookie polling) and the grant
  (device-code polling). The remote-content lockdown is untouched.
- **Keep the app's own theming.** The `--th-*` system and its switcher stay. We change the
  _default_ to the treehouse palette; we do not adopt `design/tokens.css` into
  `packages/app`. Fonts and illustration assets may be imported from `design/` à la carte.
- **Branding is a pass, not a project.** Default theme, plus the auth/onboarding screens.
  The rest of the app is out of scope.

## Actors

- A1. **Invited teammate** — arrives by invite link. Unchanged entry; converges on the spine.
- A2. **Workspace creator, web-first** — signs up in a browser, creates a workspace, and
  needs to be told the folder exists and how to get it. Currently unserved.
- A3. **Workspace creator, app-first** — downloads the app cold and needs to create a
  workspace inside it. Currently dead-ends.
- A4. **Returning user** — adding a second folder, or moving one they already have.
- A5. **CLI user** — unaffected; `/link` without `?app=1` keeps its current behaviour.

## Key Flows

- **F1 — Web-first (A2).** Sign up → create workspace → "Connect a folder" screen offering
  the desktop app (platform-detected) or the CLI → download/open app → `treehouse://open`
  carries the workspace id → app skips straight to the folder step → approve → syncing.
- **F2 — App-first (A3).** Install → sign in → **choose or create a workspace** (new step) →
  folder step, now defaulting to `~/Treehouse/<real workspace name>` with a "Choose a
  different folder…" affordance → approve → syncing.
- **F3 — Invite (A1).** Unchanged up to the handoff, then joins F2 at the folder step with
  the workspace already known.
- **F4 — Manage (A4).** Tray → a folder's settings: see the path, change location, pause,
  unlink; and "Add a folder…" to run the spine again for another workspace.

## Requirements

- **R1.** A workspace step precedes the folder step in the desktop flow. It lists the user's
  workspaces and can create a new one, using the authed partition session.
- **R2.** The folder step defaults to `~/Treehouse/<workspace name>` using the _real_ name,
  and offers a native picker to override it. The existing TCC warning applies to overrides.
- **R3.** A folder is never created before its workspace is known. `"Workspace"` must not be
  reachable as a folder name.
- **R4.** The key is still minted after the folder exists and written straight into it. No
  step may hold a key in memory across a user interaction.
- **R5.** Resume still lands on the right step after a relaunch, including mid-workspace-step.
- **R6.** After creating a workspace on the web, the user is offered a folder connection —
  desktop app where supported, CLI otherwise — without having to know either exists.
- **R7.** `treehouse://open?workspace=…&origin=…` enters onboarding at the folder step when
  the workspace is not yet linked. Today it only focuses an already-linked workspace
  (`deep-link.ts:39`, `contract.ts:94`).
- **R8.** The tray exposes, per folder: the path, change location, pause/resume, unlink; and
  a global "Add a folder…".
- **R9.** Changing a folder's location moves the contents and re-registers the link without
  a re-grant and without a full re-upload.
- **R10.** The app defaults to the treehouse palette, with the theme switcher still working
  and other presets unaffected.
- **R11.** Sign-in, sign-up, invite, `/link` and the new onboarding screens carry the brand:
  Fraunces headings, the treehouse palette, and at least one motif or mascot per screen.
- **R12.** Every step of the spine leaves a diagnostic trail. An abandoned onboarding
  currently writes nothing to any log — the 2026-07-30 failure could not be reconstructed.

## Acceptance Examples

- **AE1.** Given a fresh Mac and no account, when a user installs the app and creates a
  workspace called "Acme", then the synced folder is `~/Treehouse/Acme` — not `Workspace`.
- **AE2.** Given the folder step, when the user picks `~/Projects/Acme` instead, then that
  is the folder that syncs, and a protected location warns first.
- **AE3.** Given a workspace just created in a browser on a supported Mac, when the user
  follows the offered path, then they reach a syncing folder without typing a command.
- **AE4.** Given a workspace created in a browser on Windows, then the CLI path is offered
  instead, with no dead end and no unsupported download.
- **AE5.** Given a syncing folder, when the user changes its location from the menubar, then
  the files move, sync resumes, and no re-authentication and no full re-upload occurs.
- **AE6.** Given onboarding is quit mid-flow, when the app relaunches, then it resumes at the
  step it left, and the abandonment is recoverable from a log.

## Success Criteria

- App-first onboarding reaches a syncing, correctly-named folder in **under three minutes**,
  unassisted, by someone who didn't build it.
- Zero occurrences of `~/Treehouse/Workspace` or its numbered siblings.
- A web-first user with a supported Mac gets a synced folder without ever seeing a terminal.
- Both directions execute the same step sequence — verifiable by the same state machine.

## Scope Boundaries

**In:** the desktop workspace step; the folder picker; step reordering; the web "connect a
folder" screen; `treehouse://open` routing; tray folder management; default theme; brand
pass on auth/onboarding screens; onboarding diagnostics.

**Out:** Windows/Linux desktop builds; adopting `design/tokens.css` into `packages/app`;
restyling the workspace UI beyond auth/onboarding; multi-folder-per-workspace; changing the
device-grant protocol; the marketing site itself.

## Dependencies / Assumptions

- `packages/design` is on main (merged in PR #44) and provides fonts, logos, motifs and
  mascots via subpath exports. `packages/marketing/app/assets/css/main.css` is the reference
  Tailwind v4 mapping — referenced, not copied.
- The `[data-theme="treehouse"]` preset (`tailwind.css:133`) already matches the brand's leaf
  palette closely enough to promote to default; `#2e7d5b` vs the brand's `#2e7d58`.
- The desktop shell can already make authenticated API calls through the partition session
  (`effects.ts:68`, `:82`), so listing and creating workspaces needs no new API surface.
- Assumes moving a synced folder is safe with the daemon's root-liveness guard (U1) — R9
  needs verifying against it before design.

## Outstanding Questions

- **Q1.** Does the workspace step live in `packages/app` (shown in the shell's window) or as
  a small set of app-only routes? Shared routes risk the flow being reachable in a plain
  browser, where the folder step is meaningless.
- **Q2.** R9 (change location) — move the contents, or re-sync from remote into the new path?
  Moving is faster and offline-safe; re-syncing is simpler and can't half-fail.
- **Q3.** Should the web-first flow let a user pre-name their folder before downloading, or
  is that a decision better made on the machine that owns the disk?
- **Q4.** Is "create a workspace" in the app the same UI as the web's `WorkspaceDialog`, or a
  purpose-built onboarding screen? Reuse is cheaper; onboarding-specific is calmer.
- **Q5.** How much joy is the right amount? A mascot per step is easy to overdo on a screen
  users see once and then live behind for months.