# Desktop sync onboarding review — 2026-10-12

## How this was tested

All three routes into a synced folder were walked end to end against the **real**
Electron app (unpackaged, this branch) and a local stack, using
`scripts/desktop-e2e.mjs` (see `e2e-harness.md`):

- The app was driven over CDP.
- The web halves were driven in a separate browser.
- Native dialogs were answered through the harness's mailbox.
- Deep links were delivered both by hand-off to the running app and through macOS
  `open`.
- Each route was walked once **before** the fixes and once **after**. Screenshots are in
  `.e2e/shots/` (local only).

Not reachable this way, and therefore **not verified**:

- whether the window comes to the front;
- whether the folder picker appears as a sheet over the right window;
- the tray menu itself;
- a real browser click on a `treehouse://` link;
- the packaged app.

These are listed in `qa-checklist.md` §10.

## The reported bug: "syncing, but the UI said a different folder"

Four separate causes were reproduced. Any one of them produces the report.

| #   | Cause                                                                                                                                                                                                                                                                                                                                                                       | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| W1  | **Reconnecting after Stop Syncing made a second folder.** Stop Syncing leaves the folder and its files on disk, by design. Reconnecting the same workspace stepped around it to `~/Treehouse/<Name> 2`, and choosing the original folder was refused as "not empty". The user ends up with two folders. The one they know about in Finder is dead; sync goes to "<Name> 2". | Fixed  |
| W2  | **"Open" ignored which workspace.** `treehouse://open` for an already-synced workspace, and the tray's per-folder **Open Workspace**, both opened whatever workspace was last viewed. Reproduced: opening "Route One's Workspace" showed "Acme Launch".                                                                                                                     | Fixed  |
| W3  | **The app's workspace list was stale for 5 minutes.** A workspace created in the browser was missing from the app's switcher _while the app was syncing it_. The dashboard then fell back to the first workspace and said "Synced with <that one's folder>".                                                                                                                | Fixed  |
| W4  | **The approval and success pages rendered inside the previous workspace's chrome.** "Acme Launch is growing" appeared next to Route One's name, sidebar and files. The folder picker for Acme Launch opened over Route One's page too.                                                                                                                                      | Fixed  |

Also contributing: nothing refreshed the page's folder list after menubar changes
(Stop Syncing, Change Location, Add a Folder). **Fixed**: it now re-reads whenever the
window regains focus.

## Route 1 — create on the web → download → sign in

| #   | Finding                                                                                                                                                                                           | Status                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1a | **Only one workspace was ever offered.** Setup synced exactly one workspace and stopped. Other workspaces in the account were never mentioned; you had to find **Add a Folder…** in the menu bar. | Fixed: the success screen lists unsynced workspaces under **Also bring these home?**, each with **Sync**                                                                |
| R1b | **The download had no follow-through.** The page didn't change after **Download the Mac app**, and the new app asked which workspace again.                                                       | Fixed: after a download the main button becomes **Open <workspace> in Treehouse**. Verified: a fresh install opened from it goes sign-in → that workspace's folder step |
| R1c | **Sign-in timed out after 5 minutes** with "Setup didn't finish: sign-in timed out". This was observed. The workspace step had the same 5-minute limit.                                           | Fixed: no deadline while the window is open; closing the window is the exit. _Not re-run for 5+ minutes; verified by code and typecheck only._                          |
| R1d | The workspace step asks you to pick even when the account has a single workspace.                                                                                                                 | Open, low. Auto-picking would also hide **+ New workspace**.                                                                                                            |
| R1e | After sign-up the sync CTA is below the fold under **Next steps**. The dashboard also says "Nothing planted here yet" while listing two files.                                                    | Open, low                                                                                                                                                               |

## Route 2 — app installed → create on the web → "Open in Treehouse"

| #   | Finding                                                                                                                                                                                                         | Status                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2a | **No context behind the picker.** The window kept showing the previous workspace, and the picker's title ("Choose a folder to sync") didn't name the workspace.                                                 | Fixed: new **Where should <name> live?** step behind the picker. The picker title and message name the workspace, and it is attached to the window as a sheet |
| R2b | `/connect` leads with **Download the Mac app** even for people who already have it. **Already have the app?** is a small text link. The server could tell, because the account holds a "Treehouse Desktop" key. | Open, medium. Needs an API signal                                                                                                                             |
| R2c | Whether the app comes to the front when the link is clicked in a browser can't be checked from CDP. The fix adds an explicit bring-to-front and parents the picker to the window.                               | Needs the manual check in `qa-checklist.md` §10                                                                                                               |

## Route 3 — create inside the app

| #   | Finding                                                                                                                            | Status                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R3a | **Extra page.** After creating a workspace in the app, a "Sync a folder" page asked whether to sync, without naming the workspace. | Fixed: goes straight to **Where should <name> live?** The picker's Cancel is the "not now" |
| R3b | The onboarding workspace step (menubar **Add a Folder…**) has no Cancel or Back. The only way out is closing the window.           | Open, low                                                                                  |

## Across all routes

| #   | Finding                                                                                                                                                                                                                                                 | Status                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | **Cancel in the folder picker didn't cancel.** It fell back to the default folder and synced anyway. That was deliberate in the original design ("never wedge"), but the result is a Cancel button that does the opposite of what it says.              | Fixed: Cancel ends setup quietly (no Retry dialog, nothing created) and shows the workspace. **This reverses a deliberate earlier decision.** |
| X2  | "That folder isn't empty" offered only **Choose another**.                                                                                                                                                                                              | Fixed: adds **Use the suggested folder**                                                                                                      |
| X3  | There's no way to sync a folder that already has your own files, such as an existing project. The never-adopt rule is a deliberate safety choice.                                                                                                       | Open: product decision                                                                                                                        |
| X4  | **Ready to sync** is a second confirmation of choices made seconds earlier, in the same app. Auto-approving in the shell would remove a click. It needs care: it must never be triggerable from a browser, or it becomes a device-code phishing vector. | Open                                                                                                                                          |
| X5  | A `treehouse://` link naming an unknown server makes the installed app show **Connect to this server?** and save a resume record. If the app is force-quit at that prompt, the prompt comes back on every launch until answered.                        | Open, low                                                                                                                                     |

## Found while recording the evidence videos

| #   | Finding                                                                                                                                                                                                                                                                                                                          | Status                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | **The device grant is rate-limited to 5 codes per IP per 10 minutes.** Every connected folder costs one code, so a sixth workspace in a row failed with "Setup didn't finish: could not start device grant: 429". A team onboarding behind one office IP shares those five. Approvals were capped at 10 per user per 15 minutes. | Fixed: both defaults raised to 30 (`DEVICE_CODE_MAX`, `DEVICE_APPROVE_MAX`), and the error is now worded so the user knows what to do |
| V2  | **A failed setup left an empty `~/Treehouse/<Name>`**, so the retry suggested "<Name> 2". This is another road to the wrong-folder report.                                                                                                                                                                                       | Fixed: the planner reuses an empty, unlinked folder                                                                                   |
| V3  | **Regression from this PR:** `setPageLayout("onboarding")` on `/link` stuck after leaving the page, so "Open the workspace" rendered the workspace without its sidebar.                                                                                                                                                          | Fixed: `layout: false` plus an explicit `<NuxtLayout>`. Verified in both app mode and the browser                                     |

## Independent review (Codex, GPT-6.1-Sol)

The first pass returned "mergeable after the BLOCKERs". All four findings are fixed in `36e8d35` and were verified live with the harness:

| #   | Finding                                                                                                                                                               | Fix                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | BLOCKER: reclaiming a folder would upload files added after syncing stopped, such as unrelated private documents. A config with no `apiBase` also matched.            | Files outside the sync baseline are listed in **Upload new files?**, and **Choose Another Folder** is the default. The config must name the same workspace and server. Verified: a dropped-in `tax-return-2026.pdf` was listed, and declining uploaded nothing. |
| C2  | BLOCKER: the suggested folder was judged before the picker opened, not after. Files written into it mid-dialog would have uploaded.                                   | The final choice is re-validated after the dialog, and the user sees **That folder changed**. Verified by writing a file into the suggestion while the picker was open.                                                                                         |
| C3  | SHOULD-FIX: the entry queue awaited the whole flow, so a superseding link waited behind an open sign-in or workspace step. With no deadlines that wait was unbounded. | The queue covers only cancel-and-install. Verified: a link superseded a waiting workspace step in about 1s.                                                                                                                                                     |
| C4  | SHOULD-FIX: the tray's **Open Workspace** resolved the id against the first trusted server.                                                                           | The tray passes the link's recorded `appOrigin`.                                                                                                                                                                                                                |

Evidence (after-fix videos and before-fix screenshots):
https://diditthough.app/reviews/rev_01M4R1CGHZM0N8MWSKDYD1EHFW

## Developer and test infrastructure

| #   | Finding                                                                                                                                                                                                               | Status                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | **Any dev run of the app took over the system `treehouse://` handler**, moving it from the installed app to the stock Electron. After `pnpm dev` in `packages/desktop`, "Open in Treehouse" links broke machine-wide. | Fixed: dev runs only register when `TREEHOUSE_DEV_PROTOCOL=1`             |
| D2  | Electron-based terminals export `ELECTRON_RUN_AS_NODE=1`, so the documented `npx electron …` recipe crashes on boot.                                                                                                  | The harness unsets it. Documented.                                        |
| D3  | No repeatable way existed to drive native dialogs or deep links.                                                                                                                                                      | `scripts/desktop-e2e.mjs` plus the dev-only dialog mailbox (`src/e2e.ts`) |
| D4  | Comments in `contract.ts` and `utils/connect.ts` still say the workspace window has "no preload, no IPC". It has had a preload since the bridge landed.                                                               | Open, trivial                                                             |

## What changed, by file

**Desktop**

- `main.ts`
  - `openWorkspace(workspaceId?)` lands on the named workspace.
  - Deep links and the tray pass the id through.
  - Dev runs don't claim `treehouse://`.
  - Connect requests wait for a flow that's only _finishing_, so a **Sync** click on the
    success screen isn't dropped.
- `onboarding/folder.ts`: `planFolder` / `checkOverride` recognise a **reclaimable**
  folder, meaning one whose config names this workspace and which nothing links. Tested.
- `onboarding/effects.ts`
  - The folder step loads `/connect/folder` and names the workspace in the picker.
  - The picker opens as a sheet.
  - It reclaims the old folder: best-effort revoke of the old key, then strips it from the
    config so the grant mints a fresh one.
  - Cancel throws `FolderPickCancelledError`.
  - Sign-in and the workspace step have no deadline.
- `onboarding/machine.ts`, `onboarding/run.ts`: a user cancel ends the flow quietly. Tested.
- `windows.ts`: a non-finite timeout means no timer.
- `contract.ts`: `buildFolderStepUrl`. Tested.
- `e2e.ts`: the dialog mailbox. Dev only.

**App**

- `pages/connect/folder.vue` (new): the step shown behind the picker.
- `pages/link.vue`
  - Onboarding layout and no top bar in app mode.
  - The **Also bring these home?** list.
- `pages/connect/index.vue`
  - Names the workspace.
  - Auto-starts the folder pick after an in-app create.
  - Hand-off after a download.
- `components/WorkspaceSwitcher.vue`: passes `created=1`.
- `composables/useWorkspaceData.ts`: refetches the workspace list when a wanted id is
  missing from it.
- `composables/useDesktopFolders.ts`: refreshes on window focus.

**Docs**

- `install-the-desktop-app.md` and `manage-synced-folders.md`: new labels, Cancel,
  reconnecting picks up the old folder, **Also bring these home?**.