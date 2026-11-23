# Getting started with the Treehouse desktop app (macOS)

Treehouse gives your team a **shared folder that syncs itself**. The desktop app is the
no-terminal way in: install it, sign in, and a folder full of your workspace's files
appears on your Mac. Edit files in any app; changes flow both ways automatically. A
menubar icon shows sync status at a glance.

> **Requirements:** an **Apple-Silicon Mac** (M1 or later) on **macOS 13 Ventura or later**. Intel Macs
> aren't supported yet — the invite page will tell you, and you can keep using Treehouse in
> your browser meanwhile.

---

## The hero flow: join a workspace from an invite

_(This is the five-minute path — no terminal, no configuration.)_

1. **Click the invite link** your teammate sent. It opens in your browser and joins you to
   the workspace.
2. On the invite page, choose **Download for Mac (Apple Silicon)**. Open the downloaded
   `Treehouse-arm64.dmg` and drag **Treehouse** to Applications.
3. **Open Treehouse.** (First launch: macOS confirms it's a notarized app from an
   identified developer — click **Open**.) If the app is already installed, the invite
   page's **Open in Treehouse** button jumps you straight here.
4. **Sign in** in the window that appears — the same account the invite joined. If you're
   coming from a self-hosted instance, the app already knows which server to use (it
   learned it from the invite); a first-time custom server asks you to **confirm the
   address** once.
5. **Folder.** Treehouse creates `~/Treehouse/<workspace name>/` for you (v1 uses this
   default automatically; a protected location such as Desktop/Documents/iCloud would show
   a short warning first — the default avoids those on purpose).
6. **Approve** the one-click workspace grant. Sync starts, the workspace window opens
   **already signed in**, and the **menubar icon** turns to "synced".

That's it — your workspace files are now in the folder, and edits sync both ways.

## Creating a workspace instead

No invite? Open the app, **sign up or sign in**, **create a workspace** in the web UI,
pick a folder, and you're at the same end state. Invite teammates from the workspace UI.

## Everyday use (the menubar)

Click the menubar icon for:

- **Per-folder status** — synced, syncing/transferring, or an error with a reason.
- **Open folder in Finder** and **Open workspace** (the web UI).
- **Pause syncing** / resume, per folder.
- **Sign out** — stops syncing your app-linked folders and clears the app's web session;
  your **local files stay on disk**.
- **Quit (sync continues)** — closes the windows but **keeps syncing** in the background.
  To actually stop syncing, use Pause or Sign out.

The daemon that does the syncing runs in the background and **autostarts on login**, so
your folder stays current even when the app window is closed.

## Signing in and out

- Signing out leaves every local file exactly where it is; it just stops **new** changes
  from syncing and signs the workspace window out.
- If your access is revoked (e.g. you're removed from the workspace), the folder shows
  **"sign in"** in the menubar rather than retrying forever — that's expected.

---

## Known limitations (v1)

- **Apple-Silicon only.** Intel Macs aren't supported in v1; use the web app. (Windows and
  Linux are planned later.)
- **iCloud "Optimize Mac Storage" can evict files.** If your sync folder lives inside an
  iCloud-managed location and macOS offloads a file to free space, Treehouse sees a file
  that isn't fully present locally. Keep the sync folder **outside** iCloud Drive (the
  default `~/Treehouse/` is) to avoid eviction surprises.
- **Uninstalling the app leaves the daemon running.** Dragging `Treehouse.app` to the
  Trash intentionally does **not** stop background sync (so an accidental delete doesn't
  silently break syncing). To fully remove the background daemon:

  ```sh
  launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/io.treehouse.daemon.plist 2>/dev/null; \
  rm -f ~/Library/LaunchAgents/io.treehouse.daemon.plist \
        ~/Library/Application\ Support/Treehouse/bin/treehouse-daemon
  ```

  (If you also use the `treehouse` CLI, `treehouse stop` does the stop + plist removal for
  you.) Your synced files are never touched by this — they're just files in a folder.

- **Memory footprint.** The app embeds Chromium (Electron), so it uses more memory than a
  native shell. Closing the workspace window frees most of it; the lightweight menubar
  presence keeps running. Sync itself is handled by the small background daemon, not the
  UI.

## Coexisting with the CLI

The app and the `treehouse` CLI **share one background daemon and one folder registry** —
a folder is never synced twice. Whichever side has the newer daemon owns the shared
binary, and both point the login service at the same stable path. See
`docs/desktop/qa-checklist.md` §7 for the full coexistence matrix.

You can drive the same folder from **either side**: the app's menubar has Pause/Resume and
Sign out, and the CLI has the matching verbs —

```sh
treehouse pause  ~/Treehouse/<folder>   # stop syncing this folder (stays linked)
treehouse resume ~/Treehouse/<folder>   # resume it
treehouse status                        # per-folder state, from the same daemon
```

— so an agent scripting the CLI and a human clicking the menubar act on the same registry.

## Debugging: where the logs are

Every log lives in one folder, `~/Library/Logs/Treehouse/`:

- `daemon.log`: the sync daemon (per-folder sync activity and errors)
- `app.log`: the desktop app's main process (tray actions, onboarding, daemon ownership)
- `updater.log`: the app's self-updater

The menubar's **Show Logs in Finder** opens that folder. From a terminal:

```sh
treehouse logs                # last 100 lines of the daemon log
treehouse logs -f             # follow it live
treehouse logs app -n 300     # the desktop app's log
treehouse logs --path         # print the folder (to attach to a bug report)
```

## Self-hosting: cookie/domain requirement

The workspace window signs in with a **cross-origin cookie** (the app is one origin, the
API another). For that cookie to stick, a self-hosted deployment must either serve the app
and API under a **shared registrable domain** (e.g. `app.example.com` + `api.example.com`)
**or** have the API set `SameSite=None; Secure` on its session cookie — otherwise sign-in
in the app window silently fails (the session never lands). See
`docs/solutions/developer-experience/railway-cloudflare-deploy-gotchas-2026-06-08.md`.