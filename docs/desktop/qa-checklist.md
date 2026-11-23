# Treehouse desktop app — release QA checklist

Run this against the **packaged, signed, notarized** app before every desktop release.
These scenarios cover what the automated tests (pure vitest in `packages/cli` and
`packages/desktop`) deliberately can't reach: real launchd, real Gatekeeper/TCC, real
Finder, real network, and the packaged auto-updater. Test on a **clean Apple-Silicon
Mac** (or a fresh user account) whenever a step says "clean".

Legend: ☐ = to verify · **[CRED]** = credential-gated (needs release secrets; see the
last section) · **[HW]** = only observable on real hardware/OS, never in unit tests.

---

## 1. The five origin acceptance examples (verbatim)

These are the product contract from
`docs/brainstorms/2026-07-06-desktop-app-requirements.md`. Each must pass end-to-end
against a **deployed** instance.

- ☐ **AE1 (R1, R2, R4).** Given a fresh Mac and an invite from a **self-hosted**
  instance, when the teammate follows F1, then the workspace's files appear in the
  chosen local folder syncing against that instance — and **no step showed a terminal**.
  - ☐ **AE1 cookie precondition (self-host).** The self-hosted app + API must share a
    **registrable domain** (e.g. `app.example.com` + `api.example.com`) **or** the API
    must set `SameSite=None; Secure` on its session cookie — otherwise sign-in in the app
    window silently fails (the cross-origin session cookie never lands). See
    `docs/solutions/developer-experience/railway-cloudflare-deploy-gotchas-2026-06-08.md`.
- ☐ **AE2 (R7).** Given a signed-in app with a syncing folder, when the user signs out,
  then the files **remain on disk** and subsequent local edits **do not sync**.
- ☐ **AE3 (R8).** Given a machine where the **CLI already syncs a folder**, when the app
  is installed and signed in to the same account, then the existing folder appears in the
  menubar status and is **not synced twice**.
- ☐ **AE4 (R6).** Given the network drops mid-sync, then the menubar shows an
  error/waiting state and **recovers without user action** when connectivity returns.
- ☐ **AE5 (R9).** Given onboarding just completed, when the main window opens, then the
  workspace UI is **already authenticated** — the user is not asked to sign in again.

Time the AE1 run end-to-end: the success criterion is **under five minutes, unassisted**
(origin success criteria). Have someone who didn't build it do the timed run.

---

## 2. Folder-move / data-loss guard (U1) **[HW]**

The daemon's root-liveness guard is unit-tested, but the real Finder path isn't.

- ☐ With a folder actively syncing, **drag the synced folder** in Finder to another
  location (or rename it). The remote workspace stays **intact** — no team-wide deletion.
- ☐ The menubar shows that folder in an **error state** with a "folder moved?"-style
  reason (not "synced", not silently deleting).
- ☐ No `.treehouse/` directory or `state.json` is recreated at the vacated path.
- ☐ Move the folder **back** to the original path → sync resumes without re-uploading
  unchanged files. An **empty** directory left at the path does **not** trigger re-attach.

## 3. TCC protected-folder path (U7) **[HW]**

TCC behaviour varies by macOS version and is only truly testable on real machines.

- ☐ Default onboarding folder `~/Treehouse/<workspace>/` creates and syncs with **no TCC
  prompt** (it's outside Desktop/Documents/Downloads/iCloud).
- ☐ Override the folder to a **TCC-protected** location (Desktop or Documents): the
  onboarding UI shows the **protected-path warning** before proceeding.
- ☐ When macOS shows its own permission prompt, **granting** it lets sync proceed;
  **denying** it lands the folder in the error state (EPERM → same path as missing-root),
  not a data-loss propagation.
- ☐ Repeat on the **oldest and newest supported macOS** versions.

## 4. Autostart across OS restart (U10) **[HW]**

- ☐ After onboarding, **restart the Mac** and log back in **without opening the app**:
  the daemon autostarts (launchd `RunAtLoad`) and the folder is syncing before the app UI
  is touched.
- ☐ `~/Library/LaunchAgents/io.treehouse.daemon.plist` exists and its `ProgramArguments`
  point at the **stable path** `~/Library/Application Support/Treehouse/bin/treehouse-daemon`
  (NOT inside `Treehouse.app`, NOT the CLI binary).

## 5. App-in-Trash behaviour (U10) **[HW]**

- ☐ With the daemon running, **move `Treehouse.app` to the Trash**. The daemon **keeps
  running** from the stable path — launchd does **not** crash-loop (the plist doesn't
  point into the removed bundle).
- ☐ Sync continues for already-linked folders while the app is gone.
- ☐ Documented limitation confirmed: uninstalling the app **leaves the daemon** running
  (see getting-started.md → Known limitations for the one-line removal command).

## 6. Update-from-previous-version (U11) **[CRED] [HW]**

- ☐ Install a **previous** signed release, let it sync, then publish a **newer** signed
  release to R2. The running app detects the update (electron-updater reads
  `desktop/latest/latest-mac.yml`), downloads the **zip**, and applies it on relaunch.
- ☐ After update, the app version increments and sync is uninterrupted.
- ☐ The bundled daemon is **upgraded at the stable path** only if the shipped daemon is
  newer (newest-wins); an equal/older daemon is left in place.

### 6a. The updater's own UI — native menus/dialogs, unreachable by CDP

The menubar menu and every `dialog.showMessageBox` are native macOS surfaces, so none of
this can be driven or screenshotted from a test. The label mapping is unit-tested
(`test/updater.test.ts`); what needs a human is that the right label appears at the right
moment, and that a click is never answered with silence.

- ☐ The menubar menu opens with a greyed-out **Treehouse Beta** line, then a separator,
  above the folder list.
- ☐ **Up to date** → the menubar item reads `Up to date (<version>)` with the version you
  are actually running. This is the whole point of the item: "Check for Updates…" alone
  cannot distinguish a working updater from a dead one, which is how a completely broken
  updater went unnoticed for months.
- ☐ **Manual check, nothing available** → clicking answers with a dialog. A click that
  produces no dialog and no label change is the bug this replaced.
- ☐ **Manual check, update available** → label goes `Checking…` → `Downloading update… N%`
  (the percentage actually moves) → `Restart to update to <version>`, and the item is
  **not clickable** while checking or downloading.
- ☐ **Restart prompt** appears on its own when the download finishes; **Later** dismisses
  it and does **not** re-ask on the next 6h check; clicking the menubar item afterwards
  re-opens it.
- ☐ **Restart Now** applies the update, and **sync keeps running throughout** — the
  daemon is a separate launchd process, which is what the dialog's detail line promises.
  The app must **exit and come back by itself on the new version** within a few seconds;
  `updater.log` shows `restarting to install the update`, and `ShipIt_stderr.log` (in
  `~/Library/Caches/io.treehouse.desktop.ShipIt/`) ends in `Successfully launched`. An
  app that stays running with no window after this click is the bug that shipped in 0.1.4.
- ☐ **Restart Now with unsaved edits in the editor** → the window refuses to close, the
  app keeps running on the old version, and `updater.log` says `restart cancelled`. It
  must not be force-quit.
- ☐ **Reopen with no window**: close the workspace window, then click the Dock icon (and
  separately, open the app again from Finder). Each brings the window back.
- ☐ **Offline / broken feed** → label reads `Update check failed — click to retry`, the
  item stays **clickable**, and a manual check surfaces the error in a dialog.
- ☐ `~/Library/Logs/Treehouse/updater.log` exists and records every transition, including
  electron-updater's own resolved feed URL. This is the only post-hoc diagnostic when an
  update fails on someone else's Mac.
- ☐ **Dev build** shows `Updates disabled in dev builds`, greyed out (never a live check).

## 7. CLI ↔ app coexistence matrix (U10)

Exactly **one healthy daemon** must survive every combination.

- ☐ **App only** → daemon at stable path, plist points there, autostart works.
- ☐ **CLI first, then app** → app adopts the existing links; the CLI-synced folder shows
  in the menubar and is **not double-synced** (AE3).
- ☐ **App first, then CLI** (`treehouse status`) → the CLI talks to the same daemon;
  `treehouse` commands converge on the **stable path** (no plist fight).
- ☐ **A failed `launchctl bootstrap` recovers on its own.** Kill the daemon and boot the
  service out (`launchctl bootout gui/$UID ~/Library/LaunchAgents/io.treehouse.daemon.plist`)
  while leaving the plist and binary current — the state where everything looks converged
  but nothing is running. Within one reconcile tick (≤5 min) the app must restart it. This
  hole used to strand sync indefinitely, most likely straight after an app update, because
  `KeepAlive` is `{Crashed, SuccessfulExit: false}` and the SIGTERM path exits 0.
- ☐ **App update with an older CLI installed** → daemon binary updated; the old CLI still
  talks to it (IPC handshake tolerant).
- ☐ **`treehouse update` with the app installed** → no plist fight; the newest daemon is
  retained (the CLI copies its newer binary to the stable path — `convergeStableDaemon`);
  both sides still point at the stable path.
- ☐ **Agent-native parity**: `treehouse pause <folder>` / `treehouse resume <folder>` act on
  the same registry as the menubar's Pause/Resume — a folder paused from the CLI shows
  paused in the menubar and vice versa (not double-synced, not fighting).
- ☐ **Old-CLI drift**: run a shipped-old `treehouse start`/`stop` that rewrites/deletes the
  plist → within one monitor interval (or next app launch) the shell **re-asserts** the
  stable path and restarts the service.
- ☐ **Newer daemon than the app knows** (simulate a newer-protocol daemon) → the app
  **refuses to manage it** and leaves it running.

## 8. Menubar / ongoing presence (U8) **[HW]**

- ☐ The menubar item is **visible** on a packaged build (a state glyph shows even before
  template icon art lands — an empty image renders zero-width and unreachable).
- ☐ Icon tracks a live session through **transfer → idle/synced**.
- ☐ Network drop → error/waiting; restore → back to synced with no user action (AE4).
- ☐ Revoke the workspace key server-side → folder goes **auth-lost** (not endless
  syncing); the **re-authenticate** action re-enters the grant step.
- ☐ Kill the daemon → menubar shows **last-known** state from `state.json` + a "start
  sync" action, no crash.
- ☐ **Quit (sync continues)** closes the UI but leaves the daemon running; **Pause
  syncing** stops engines.
- ☐ Sign out → opening the workspace window **prompts for sign-in again** (partition
  cleared) and local files are intact (AE2).
- ☐ **Show Logs in Finder** opens `~/Library/Logs/Treehouse/`, which holds `daemon.log`,
  `app.log` and (once the updater has run) `updater.log`. Double-clicking a `.log` opens
  it in Console.app.
- ☐ On a **packaged** build launched from Finder, `app.log` gains a
  `[main] Treehouse <version> starting (packaged, …)` line on every launch, and a failed
  tray action (e.g. Pause while the daemon is unreachable) is recorded there. Before this
  log existed, a packaged app's `console.error`s went nowhere.

## 9. Deep links (U9) **[HW]**

- ☐ "Open in Treehouse" on the invite page with the app installed lands in the right
  onboarding state (new workspace → folder screen; already-linked → focuses the window).
- ☐ A `treehouse://` URL naming an **unknown origin** routes through the **TOFU
  confirmation** before anything loads — it never silently mutates the allow-list.
- ☐ Garbage/oversized/wrong-scheme URLs are ignored without error.

## 10. The onboarding spine — workspace → folder → connect **[HW]**

The step logic is unit-tested; the Electron glue around it is not. The workspace step
is a REMOTE web page driven by the shell, and the folder step is a native dialog, so
everything below only exists once both halves are running together.

**Workspace step**

- ☐ Create path (no invite): after sign-in the workspace step lists the account's
  workspaces and **creating one from inside the app works** — this used to dead-end at
  a "Create one →" link pointing back at a web page.
- ☐ A brand-new account with **zero** workspaces opens the naming form directly, not an
  empty list.
- ☐ Invite / deep-link path: the step does **not** ask which workspace — it resolves the
  name for the one already chosen and moves on.
- ☐ Picking a workspace the account **cannot access** (e.g. a hand-edited sentinel URL)
  fails with an access error and creates **no folder**. The id off the sentinel is a
  hint, not proof — this verifies the re-resolution actually gates it.
- ☐ Closing the window mid-step, or a superseding deep link, aborts cleanly — no orphan
  folder, no wedged flow.

**Folder step**

- ☐ The suggested folder is named after the **real workspace** (`~/Treehouse/Acme`).
  **`~/Treehouse/Workspace` or `Workspace 2` must never appear** — that is the defect
  this spine exists to fix.
- ☐ Choosing a different folder syncs **that** folder, not the default.
- ☐ **Cancelling** the picker ends setup quietly: no "Setup didn't finish" dialog, no
  folder created, and the window shows the workspace. (Changed 2026-10-12. Cancel used
  to fall back to the default folder and sync anyway.)
- ☐ Choosing a folder that already contains files is **refused with an explanation**,
  offering **Choose another** or **Use the suggested folder**. (Bootstrap pushes
  everything local, so adopting a populated folder would upload personal documents to
  the whole workspace.)
- ☐ **Reconnecting after Stop Syncing** suggests the workspace's **old** folder ("Your
  earlier … folder is still on this Mac"), not "<Name> 2". Files edited while stopped
  upload. The old key no longer appears under the workspace's keys.
- ☐ Choosing an **empty existing** folder is accepted.
- ☐ Choosing a TCC-protected location (Desktop/Documents) still warns — §3 above.

**What the e2e harness can't see** (`docs/desktop/e2e-harness.md`; check these by hand)

- ☐ Click **Already have the app? Open … in it** in a real browser while Treehouse is in
  the background. Treehouse **comes to the front** and the folder picker appears **as a
  sheet on its window**, not behind the browser and not floating free.
- ☐ The same link with Treehouse **not running** cold-starts it straight into that
  workspace's folder step after sign-in.
- ☐ The folder picker's top line names the workspace ("Choose where “Acme” syncs on this
  Mac…").
- ☐ Menubar → a folder → **Open Workspace** opens **that folder's** workspace, even when a
  different one was open last.
- ☐ After **Stop Syncing** or **Change Location…** from the menubar, switching back to the
  app window shows the change (Customize → Synced folder) without a reload.

**End to end**

- ☐ Time a create-path run: workspace → folder → approve → syncing, **under three
  minutes** unassisted, by someone who didn't build it.
- ☐ Relaunch mid-flow at each step and confirm it resumes to the same step — including
  after the workspace step but before the folder exists.

## 11. Folder management + relocation (U8) **[HW]**

Relocation MOVES USER DATA. Every item here is worth doing on a folder you don't mind
losing before it is done on a real one.

- ☐ The submenu shows the folder's real path with `~` collapsed, and that line isn't
  clickable.
- ☐ **Change Location to a new path**: the folder _and_ its `.treehouse/` arrive, sync
  resumes there, and there is **no re-grant prompt and no full re-upload** (the key and
  the local index came with it — that is the whole argument for moving over re-syncing).
- ☐ Change Location onto an existing **non-empty** folder is refused with an explanation
  and **nothing moves**.
- ☐ Move the folder in Finder FIRST, then Change Location: refused with a distinct
  "can't find it" reason, not the not-empty one.
- ☐ **Cancelling** the dialog leaves the folder syncing exactly as it was.
- ☐ Relocating a **paused** folder leaves it paused afterwards — it must not quietly
  start syncing as a side effect of being moved.
- ☐ **Cross-volume** move (e.g. to an external disk) takes the copy-then-remove path and
  still ends with one working folder.
- ☐ Kill the app **mid-move** (large folder, cross-volume): the old root is still
  authoritative, sync still works from it, and no files are lost. The `links.json`
  rewrite is the commit point — before it, the move never happened.
- ☐ Confirm the remote workspace is **intact** after every case above. The liveness
  guard is what makes a half-moved tree safe from delete-propagation; verify it held.
- ☐ "Stop Syncing This Folder…" confirms first; files remain on disk **and** in the
  workspace.
- ☐ "Add a Folder…" re-enters onboarding, including from a zero-folder menu.

## 12. App icon + identity **[HW]**

The `.icns` and the bundle name only take effect in a packaged build, so nothing here is
reachable from unit tests. A dev run is a **partial** check: `setDevDockIcon()` applies
`build/icon.png` to the Dock, so the artwork IS reviewable unpackaged — but the Dock tile
is still named "Electron", because the bundle name comes from `CFBundleName`, which only
exists in a packaged build. Don't reject the icon on a dev run; don't accept the name on one.

- ☐ **Dev run only:** `vp run desktop#dev` shows the treehouse artwork on the Dock
  tile (not the stock Electron icon). This is the cheap check that the master PNG is
  readable and correctly composed, before spending a release on it.

- ☐ The Dock tile shows the **treehouse icon**, not the stock Electron one, and Finder
  shows it on `Treehouse.app`.
- ☐ The **Dock tooltip** and the **application menu** (next to the Apple menu) both read
  **"Treehouse"**. The menu name comes from `app.setName`; the tooltip comes from the
  bundle's `CFBundleName` (electron-builder writes it from `productName`) — they have
  **different sources**, so check both.
- ☐ Get Info renders the icon cleanly at every size. Known weakness: the illustration is
  detailed and goes muddy at **16px** (Finder list view) — confirm it's still recognisable
  before deciding it's good enough to ship.
- ☐ **The profile does not sit on the daemon's state.** `~/Library/Application
  Support/Treehouse/` holds `links.json`, `daemon.pid`, `bin/` **and** a `desktop/`
  subdirectory — Chromium's `Cache/`, `Cookies` and `Partitions/` must be **inside
  `desktop/`**, never beside the links registry.
- ☐ Sign out, then quit and relaunch: `links.json` and `bin/treehouse-daemon` **survive**
  (clearing the session partition must not reach the daemon's state).
- ☐ Sign in, quit, relaunch → **still signed in** (AE5 across a restart). The session
  partition lives inside `userData`, so any future change to that path silently signs
  every existing user out — treat a `userData` move as a breaking change.

## 13. After an Electron major upgrade **[HW]**

Run this section on the first release after any change to the `electron` version in
`packages/desktop/package.json`, on top of §6. Last applied for **Electron 33 → 45**
(the first release after desktop 0.1.10, November 2026). That jump was driven over CDP against a local stack
(sign-up, workspace, folder, grant, syncing, a markdown file, the bridge, the
permission and navigation lockdown) but **none of the items below were checked**,
because CDP can't reach them.

- ☐ **Minimum macOS is now 13 (Ventura).** Electron 44 dropped macOS 12, and the
  packaged `Info.plist` carries `LSMinimumSystemVersion` 13.0. On a macOS 12 Mac a
  fresh install must refuse to open with macOS's own "can't be used with this version
  of macOS" message, not crash.
- ☐ **Auto-update onto an unsupported macOS.** electron-updater does **not** block an
  update by OS version (electron-builder writes no `minimumSystemVersion` into
  `latest-mac.yml`), so a 0.1.10 install on macOS 11 or 12 will download and apply the
  Electron 45 build and then fail to launch. Confirm whether any users are on macOS
  11/12 before the release; if any are, tell them to stay on the old build.
- ☐ **Update across the jump.** From the last Electron 33 build (0.1.10), an
  auto-update to the Electron 45 build downloads, restarts by itself and comes back on
  the new version (§6a's Restart Now check, `ShipIt_stderr.log` ends in
  `Successfully launched`). The Squirrel.framework inside the bundle changed with
  Electron, so this is the riskiest path in the upgrade.
- ☐ **Still signed in after the update.** Signed in on 0.1.10 → update → the workspace
  window opens authenticated. Chromium migrates the profile and cookie store forward
  across twelve majors; a failure here signs every user out.
- ☐ **Signing and notarization with electron-builder 26.** The release run signs the
  app and `Contents/Resources/daemon`, notarizes and staples. Check with
  `codesign --verify --strict --deep`, `xcrun stapler validate` and
  `spctl -a -vvv -t install` (credential-gated items below). The unsigned path
  (`after-pack.cjs` ad-hoc signing) was built and verified locally.
- ☐ **Tray.** The menubar icon renders as a template image in light and dark menu bars,
  and every menu item still works (§8).
- ☐ **Native dialogs start in the right place.** Since Electron 43 a file dialog with no
  `defaultPath` opens in ~/Downloads. Change Location… must open in the folder's
  current parent, and the onboarding picker must preselect `~/Treehouse/<workspace>`.
- ☐ **launchd and Finder.** §4 (autostart across restart) and §5 (app in Trash) still
  hold. The daemon is a separate Node SEA binary and did not change with Electron, but
  the app that installs it did.

---

## 12a. Read-only folders in the tray **[HW]**

The daemon side is verified (a live edit by a viewer is reverted, saved under
`.treehouse/reverted/`, and listed in `notices` on its status). The tray menu
itself can't be reached over CDP, so these need a person looking at it.

- ☐ As a Viewer, edit a synced file. Within about 10 seconds the menu shows
  **⚠ 1 change not synced, view-only access** under the folder.
- ☐ The folder's submenu lists `<path>: reverted, your edit is saved`.
- ☐ Delete a file and add a new one. Each gets its own line, and neither repeats.
- ☐ The folder's own state still reads **Up to date**, and the notice is gone a
  day later.

## Credential-gated verifications (feed from U11)

These **cannot be checked without release secrets or a signed build** and were not
verifiable in the build environment. They must be run on a Mac release runner / clean Mac
once the secrets are configured. Missing any secret degrades the build (unsigned /
GitHub-only) but does not fail it — so their absence is silent; verify explicitly.

- ☐ **[CRED]** **Developer-ID signing** of `Treehouse.app` **and** the bundled daemon
  (`Contents/Resources/daemon`). Requires `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`
  (electron-builder `CSC_LINK` / `CSC_KEY_PASSWORD`). Verify: `codesign --verify --strict
  --deep Treehouse.app` and `codesign -dvvv` shows the expected `TeamIdentifier`.
- ☐ **[CRED]** **Notarization + stapling** via notarytool. Requires `APPLE_ID`,
  `APPLE_APP_PASSWORD` (→ `APPLE_APP_SPECIFIC_PASSWORD`), `APPLE_TEAM_ID`. Verify:
  `xcrun stapler validate Treehouse.app` and `spctl -a -vvv -t install Treehouse.app`.
- ☐ **[CRED] [HW]** **Gatekeeper passes offline** on a **clean** Mac (download the dmg,
  disconnect network, open) — the whole point of stapling vs the CLI's online ticket.
- ☐ **[CRED]** **`TREEHOUSE_TEAM_ID` is set to the real Apple Team ID** at build time.
  Until it is, `EXPECTED_TEAM_ID` is the `UNSET_TEAM_ID` placeholder and the shell
  **refuses every daemon swap** (fail-closed). Confirm the app installs/updates the daemon
  once the real Team ID is baked, and that a **foreign-signed** daemon is refused.
- ☐ **[CRED]** **R2 upload + layout.** Requires `R2_DL_ACCESS_KEY_ID`,
  `R2_DL_SECRET_ACCESS_KEY`. Verify `desktop/latest/` and `desktop/v<version>/` each hold
  `Treehouse-arm64.dmg`, `Treehouse-arm64.zip` (+ blockmaps) and `latest-mac.yml`, and that
  `https://dl.trytree.house/desktop/latest/Treehouse-arm64.dmg` resolves (matches
  the invite page's `DESKTOP_DOWNLOAD_URL`).
- ☐ **[CRED] [HW]** **Auto-update end-to-end** (§6) — needs two signed builds published.

### Environmental blocker recorded during U11

- The full `electron-builder --dir` / dmg build could **not** be completed in the CI-less
  build environment: the `electron` binary doesn't resolve under the scoped pnpm workspace
  install there, so electron-builder stops at "Cannot compute electron version". The
  **config schema itself validated** (electron-builder loaded `electron-builder.yml` with
  no errors). First real packaging must therefore happen on the **macos-15 release runner**
  (`.github/workflows/release-desktop.yml`); confirm the run produces the artifacts in §5's
  R2 check on first tag.
- That blocker no longer applies locally: on 2026-11-02 (Electron 45, electron-builder 26)
  an unsigned `pnpm --filter desktop exec electron-builder --mac --publish never`
  produced `Treehouse-arm64.dmg`, `Treehouse-arm64.zip`, both blockmaps and
  `latest-mac.yml` on an Apple-Silicon Mac, with the SEA daemon staged at
  `packages/desktop/resources/daemon` first.

## Analytics (PostHog)

Everything here needs a **real PostHog project key** — with no key the SDK never
initialises, so every check below reads as "off" whether or not the code works,
and passes vacuously. See
`docs/solutions/architecture-patterns/posthog-privacy-masking-contract.md`.

### Web app — the privacy contract

- ☐ **[CRED]** **Watch an actual replay.** Open a workspace, browse the tree, open
  a markdown file, edit it, search, then play the session back in PostHog. The
  file tree entries must be **asterisks**, the editor body and the file viewer
  must be **grey boxes**, and the app's own chrome (nav, buttons, dialog titles)
  must stay **readable**. This is the one check that cannot be faked by a passing
  test: a masking class on the wrong element typechecks perfectly.
- ☐ **[CRED]** **Hover a file row during playback** and confirm no tooltip text
  leaks the name (`maskAttributeFn`).
- ☐ **[CRED]** **Check `$current_url` on an autocapture event** (not just a
  pageview) from inside a file — it must end in `<redacted>`.
- ☐ **[CRED]** **Open a public share link** (`/s/<token>`) and confirm **no
  replay is produced for that session**, while pageviews still arrive with the
  token redacted. Untestable without a key: with none, recording is `disabled`
  everywhere, so "stopped" and "never started" are indistinguishable.
- ☐ **[CRED]** Confirm no event anywhere carries a file name, folder name, search
  query, share token or invite token. Sort PostHog's property values and read them.

### Source maps

- ☐ **[CRED]** After a production build with `POSTHOG_CLI_TOKEN` and
  `POSTHOG_PROJECT_ID` set, throw a test exception and confirm the stack frames
  name real `.vue` files and line numbers rather than `chunk-a1b2c3.js:1:48210`.
- ☐ Confirm `.map` files are **not** served from the deployed origin
  (`--delete-after` removes them).

### Desktop shell

- ☐ **[CRED]** Complete onboarding in a packaged build and confirm
  `onboarding_step` events arrive with `$app_version` set to the **app's** version,
  not Electron's.
- ☐ **[CRED]** Confirm **no property anywhere contains a filesystem path.** The
  user's sync folder lives under `/Users/<their real name>/`, so one path property
  leaks the operator's name.
- ☐ **[CRED]** Quit from the tray and confirm the last events still arrive
  (`will-quit` flush).
- ☐ Confirm a **dev / self-built** shell (no baked key) sends nothing at all.

### Marketing site consent

- ☐ **[CRED]** Fresh profile: confirm **zero** network requests to `/ph/` and zero
  storage written before the banner is answered.
- ☐ **[CRED]** Reject: confirm no PostHog cookie and no PostHog localStorage — only
  our own `treehouse:analytics-consent` key.
- ☐ **[CRED]** Accept, then click through to the app, and confirm the marketing
  visit and the app session resolve to the **same person** in PostHog (cross-domain
  identity between `trytree.house` and `app.trytree.house` is NOT automatic).