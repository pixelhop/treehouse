# Testing onboarding end to end, locally

> **Prefer `scripts/desktop-e2e.mjs`** (see `e2e-harness.md`). It runs this same setup
> in a sandbox and also answers the native dialogs and delivers deep links, so an agent
> can drive the whole flow. This page stays as the manual recipe and the explanation of
> the address details.
>
> If you run the commands below from an Electron-based terminal (T3 Code, VS Code),
> unset `ELECTRON_RUN_AS_NODE` first. Otherwise Electron boots as plain Node and crashes
> on `app.isPackaged`.

How to run the desktop app against a local stack and walk the whole flow. Every
command here was run and verified on 2026-07-30; the two IP-address details in
step 2 are not cosmetic and the flow fails without them.

**Why not just point it at production?** The shell loads `/connect/workspace`,
which only exists on this branch. Against prod it 404s and the workspace step
waits out its five-minute timeout. The desktop app and the web app have to deploy
together.

---

## 1. Prerequisites

```bash
open -a OrbStack                 # the API needs Postgres
pnpm env:setup                   # per-worktree db + .env files (once)
```

## 2. Start the stack — on IPv4, deliberately

Run these in two terminals, from the repo root.

```bash
# API — must bind IPv4 explicitly
cd packages/api && HOST=127.0.0.1 pnpm dev --host 127.0.0.1

# App — must be reached over 127.0.0.1, not localhost
cd packages/app && NUXT_PUBLIC_API_URL=http://127.0.0.1:3010 pnpm dev --port 3000 --host 127.0.0.1
```

**Both address details matter, and each fails differently:**

- **The app must be `127.0.0.1`, not `localhost`.** On `localhost` the dev server
  answers `/.well-known/treehouse` with a `308` trailing-slash redirect, and
  `fetchDescriptor` passes `redirect: "error"` — so the shell reports "That
  doesn't look like a Treehouse server" and never starts.
- **The API must be bound to IPv4.** Nitro's dev server otherwise listens on
  `[::1]` only, so the `http://127.0.0.1:3010` the descriptor advertises refuses
  the connection and every API call fails after sign-in.

Neither applies to production, where the app is served over https on a real
hostname. They're artifacts of the dev servers.

Check both before continuing — this should print the descriptor with a
`127.0.0.1` apiUrl, with no redirect:

```bash
curl -s http://127.0.0.1:3000/.well-known/treehouse
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3010/api/health
```

## 3. Run the desktop app against it

Use an isolated `TREEHOUSE_HOME` so the run cannot touch your real links,
daemon, or synced folders.

```bash
export TREEHOUSE_HOME=~/.treehouse-e2e
rm -rf "$TREEHOUSE_HOME" && mkdir -p "$TREEHOUSE_HOME"

# A daemon in the same isolated home, so the app never installs a launchd service
node packages/cli/bin/treehouse.mjs daemon &

node packages/desktop/scripts/build.mjs
TREEHOUSE_APP_ORIGIN=http://127.0.0.1:3000 NODE_ENV=test \
  npx electron packages/desktop/dist/main.cjs
```

`NODE_ENV=test` is a safety belt: it stops the CLI installing or rewriting the
real `~/Library/LaunchAgents/io.treehouse.daemon.plist`, which is **not** isolated
by `TREEHOUSE_HOME`. Without it a dev run can point your real launchd service at
the Electron binary.

## 4. Walk the flow

1. **Sign in** (or sign up — a new account auto-provisions a personal org and a
   Default workspace).
2. **Workspace step** — pick one or create one. Workspaces already synced on this
   Mac appear marked and unpickable.
3. **Folder step** — a native dialog, defaulted to `~/Treehouse/<workspace name>`.
   Confirm it is named after the _real_ workspace, never `Workspace`.
4. **Approve** the device grant.
5. **Syncing** — the workspace window opens signed in.

Then exercise the menubar: the folder's path, Change Location, Stop Syncing, and
Add a Folder.

## 5. Watch what it's doing

```bash
tail -f "$TREEHOUSE_HOME/onboarding-journal.log"   # step transitions + failures
cat "$TREEHOUSE_HOME/onboarding.json"              # resume record (cleared at the end)
cat "$TREEHOUSE_HOME/links.json"                   # what the daemon supervises
```

The journal is the thing to reach for when a run dies: it records the step,
the previous step, and the failure reason, with secrets redacted.

Attach a debugger or drive the window by adding `--remote-debugging-port=9222`
to the electron command, then `agent-browser --cdp 9222 snapshot`.

## 6. Tear down

```bash
pkill -f "dist/main.cjs"; pkill -f "treehouse.mjs daemon"
rm -rf ~/.treehouse-e2e
```

Your real daemon and its launchd service are untouched throughout — the isolated
home plus `NODE_ENV=test` is what guarantees that.