# Driving the real desktop app end to end

`scripts/desktop-e2e.mjs` runs the **real** Electron app (unpackaged, from this checkout)
against a local stack, in a sandbox, and makes every step drivable by an agent:

- the app's window, over CDP, with `agent-browser`;
- a normal browser for the web-side half of each flow, also with `agent-browser`;
- the **native dialogs** CDP cannot see (folder picker, "That folder isn't empty",
  Retry/Cancel, "Connect to this server?"), through a file mailbox;
- `treehouse://` links, either as a hand-off to the running app or through macOS itself.

It is the tool behind `docs/desktop/onboarding-review-2026-10-12.md`. Re-run those
walkthroughs after any change to onboarding, the deep-link router, the connect pages or
`/link`.

## What the sandbox isolates

| Thing                                          | How                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `links.json`, daemon socket, onboarding record | `TREEHOUSE_HOME=.e2e/sandbox/th`                                                                          |
| The app's browser profile and session cookies  | Derived from `TREEHOUSE_HOME` (`main.ts` sets `userData` under it)                                        |
| Synced folders (`~/Treehouse/<name>`)          | `HOME=.e2e/sandbox/home`, so `~` is inside the sandbox                                                    |
| The sync daemon                                | A separate `treehouse daemon` in the sandbox. Your real launchd daemon keeps running untouched.           |
| `~/Library/LaunchAgents` plist                 | `NODE_ENV=test` (`TREEHOUSE_HOME` does **not** isolate it)                                                |
| The macOS `treehouse://` handler               | A dev run no longer claims it unless asked (`TREEHOUSE_DEV_PROTOCOL=1`). `down` restores it if a run did. |
| Database and blobs                             | The worktree's own database from `pnpm env:setup`                                                         |

Everything lives under `.e2e/` (gitignored). `down --wipe` removes it.

## Run it

```bash
pnpm env:setup                                  # once per worktree: db + .env files
node scripts/desktop-e2e.mjs stack              # api :3110 + app :3100 on 127.0.0.1, waits for ready
node scripts/desktop-e2e.mjs launch --fresh     # build + launch a brand-new install (CDP :9333)
```

Then drive it:

```bash
D() { agent-browser --session desktop --cdp 9333 "$@"; }   # the app window
W() { agent-browser --session web "$@"; }                   # an ordinary browser

D snapshot -i
D fill 'input[type=email]' you@e2e.test && D fill 'input[type=password]' … && D press Enter
node scripts/desktop-e2e.mjs state      # links, folders on disk, resume record, journal, waiting dialog
node scripts/desktop-e2e.mjs dialog     # what the app is asking (buttons are numbered)
node scripts/desktop-e2e.mjs answer default        # folder picker: accept the suggestion
node scripts/desktop-e2e.mjs answer ~/somewhere    # …or choose a folder (created if missing)
node scripts/desktop-e2e.mjs answer cancel         # …or cancel
node scripts/desktop-e2e.mjs answer 1              # message box: press button [1]
node scripts/desktop-e2e.mjs answer 1 '#6'         # …a specific dialog, when several are open (default: newest)
```

`--cdp 9333` on **every** `D` call matters. Without it the session silently launches its
own Chromium, and you screenshot the wrong thing. Element refs (`@e3`) don't survive
between separate `--cdp` invocations, so use selectors or `find role … --name …`.

Screenshots: `D screenshot "$PWD/.e2e/shots/<name>.png"`. Use an absolute path, because a
relative path ends up in agent-browser's temp folder.

## Deep links

```bash
# Hand a link to the running app: a second launch passes its argv to the first and exits.
# Same code path as a warm macOS hand-off. Safe — never touches LaunchServices.
node scripts/desktop-e2e.mjs deeplink "treehouse://open?workspace=<id>&origin=http%3A%2F%2F127.0.0.1%3A3100"

# Through macOS itself, which is what a browser click does. Needs the dev app to own the scheme:
node scripts/desktop-e2e.mjs quit
E2E_REAL_PROTOCOL=1 node scripts/desktop-e2e.mjs launch
node scripts/desktop-e2e.mjs open "treehouse://open?workspace=<id>&origin=…"
node scripts/desktop-e2e.mjs down     # restores the handler to the installed app
```

`open` **refuses** unless the dev app owns `treehouse://`. Otherwise LaunchServices hands
the link to the **installed** Treehouse. It then starts onboarding against your local
test server on your real profile: it shows "Connect to this server?" and saves a resume
record that brings the prompt back on every launch. That happened while this harness was
being written, so the guard is not theoretical.

The web app's "Already have the app?" link is a plain `<a href="treehouse://…">`. Read it
with `W get attr 'a[href^="treehouse://"]' href` and deliver it with one of the commands
above. agent-browser's Chromium doesn't hand custom schemes to the OS.

## The three routes

Each route starts from `launch --fresh` and a new email address.

1. **Web first, then download.**
   - Sign up at `W open http://127.0.0.1:3100/sign-up` and create a second workspace from
     the switcher.
   - Then `launch --fresh` (that's "downloaded the app") and sign in inside the app.
   - Expect: the workspace step, then **Where should … live?**, then **Ready to sync**,
     then **… is growing**, with **Also bring this home?** listing the other workspace.
     **Sync** goes straight into that one's folder step.
2. **App installed, workspace created on the web.**
   - Create a workspace in `W`, take the `treehouse://open` link off `/connect`, and
     `deeplink` it while `D` shows a _different_ workspace.
   - Expect: the window switches to that workspace's folder step, the picker names it, and
     **Open the workspace** lands on it.
   - Also `deeplink` an `open` for an already-synced workspace. Expect: that workspace,
     not the last-viewed one.
3. **Created inside the app.**
   - In `D`: switcher, **New workspace**, **Create**.
   - Expect: straight to **Where should … live?**, with no "Sync a folder" interstitial.

Edge cases worth re-running:

- **Cancel the picker.** Expect: no dialog, no folder on disk, and the window on the
  workspace.
- **Pick a non-empty folder.** Expect: **That folder isn't empty**, offering
  **Use the suggested folder**.
- **Stop syncing, then reconnect.**
  - Stop with `HOME=… TREEHOUSE_HOME=… NODE_ENV=test node packages/cli/bin/treehouse.mjs unlink <dir>`
    (the tray's Stop Syncing does the same and also revokes the key).
  - Reconnect with a `deeplink`.
  - Expect: the old folder is suggested ("Your earlier … folder is still on this Mac").
    There's no "<Name> 2", files edited while stopped get uploaded, and the old key is gone
    from `/api/keys`.

## Recording evidence

`scripts/cdp-record.mjs` records any CDP page target to MP4 using the DevTools
screencast. That covers the app window (`--port 9333`) and agent-browser's Chromium (its
port is in `agent-browser --session web get cdp-url`). `agent-browser record` can't record
Electron, because it needs a new browser context, which Electron refuses.

```bash
node scripts/cdp-record.mjs --port 9333 --out .e2e/video/route-3.mp4 &
printf 'Create a workspace inside the app' > .e2e/video/route-3.mp4.caption   # narration banner
# …drive the flow…
touch .e2e/video/route-3.mp4.stop                                              # stop and encode
```

- **Captions** are a banner injected into the page while recording, re-applied after
  every navigation. Use them to say what happened where the screencast can't see, such as
  "folder picker answered: Sync here". The Nuxt DevTools badge is hidden while
  recording.
- **Side by side**: record the browser and the app at the same time, then `hstack` the two
  files with ffmpeg at the same height.
- **Uploading**: `npx @pixelhop/dit upload --project treehouse --review pr-<n> --round
  <key> --title … --description … --file <mp4|png>` (MP4 and WebM are accepted).

## Gotchas

- **`ELECTRON_RUN_AS_NODE=1`** is exported by Electron-based terminals (T3 Code, VS Code).
  Electron then boots as plain Node and dies on `app.isPackaged`. The harness unsets it. If
  you launch by hand, `env -u ELECTRON_RUN_AS_NODE …`.
- **`127.0.0.1`, not `localhost`**, and the API bound to IPv4. See
  `testing-onboarding-locally.md` for why. `stack` does both.
- **Nuxt DevTools** overlays the bottom of the page and intercepts clicks. Press Enter in
  a field rather than clicking a covered button.
- **Quit before relaunching.** `quit` waits for the process to exit. A relaunch racing a
  still-exiting app sees "already running" and does nothing.
- **What CDP and the mailbox can't show**: whether the window actually comes to the
  front, whether the picker opens as a sheet over the right window, and the tray menu
  itself. Those stay on `qa-checklist.md` §10.

## Dialog mailbox internals

In an unpackaged run with `TREEHOUSE_E2E=1`, `packages/desktop/src/e2e.ts` replaces
`dialog.showMessageBox` / `dialog.showOpenDialog`:

- The app writes each dialog's options to `<TREEHOUSE_HOME>/e2e/dialog-<n>.json`. Several can be open at once, for example a stale Retry prompt beneath a newer flow's picker.
- It waits for `<TREEHOUSE_HOME>/e2e/dialog-<n>-answer.json`, which holds `{ response }` for a
  message box, or `{ filePaths }` / `{ canceled }` for a picker.

A packaged build never installs it: it is gated on `!app.isPackaged`, the same gate as
every other dev affordance in the shell.