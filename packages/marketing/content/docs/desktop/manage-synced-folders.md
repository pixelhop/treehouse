---
title: Manage synced folders
description: Check sync status, pause, move or stop syncing a folder, add another workspace, and sign out, all from the Treehouse icon in your menu bar.
type: how-to
position: 3
updated: 2026-10-12
related:
  - /docs/desktop/how-sync-works
  - /docs/desktop/sync-with-the-cli
  - /docs/help/troubleshooting
---

Everything the desktop app does day to day happens from the Treehouse icon in your menu bar. The icon itself tells you how things are: a tree when everything is synced, arrows while files are syncing, and a warning sign when a folder needs your attention.

## Check a folder's status

Click the Treehouse icon. Each synced folder is listed by name, followed by its status:

| Status                             | Meaning                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| **Up to date**                     | Everything is in sync.                                                                     |
| **Syncing…**                       | Files are being uploaded or downloaded.                                                    |
| **Starting…** or **Reconnecting…** | Sync is getting going, or trying to reach Treehouse again.                                 |
| **Paused**                         | You paused this folder. Nothing syncs until you resume it.                                 |
| **Sign in needed**                 | The folder's key no longer works, for example because you were removed from the workspace. |
| **Error**, followed by a reason    | Something is stopping sync, such as the folder having been moved.                          |

## Folder actions

Hover over a folder in the menu to see where it lives on your Mac and what you can do with it:

- **Open in Finder** opens the folder.
- **Open Workspace** opens this folder's workspace in the app's window.
- **Pause Syncing** stops this folder syncing until you choose **Resume Syncing**. Your changes wait on your computer and are uploaded when you resume.
- **Re-authenticate…** appears instead when the folder shows **Sign in needed**. It asks you to sign in and approve the folder again.
- **Change Location…** moves the folder somewhere else on your Mac and keeps it connected. Choose the new parent folder and select **Move Here**. Use this rather than dragging the folder in Finder.
- **Stop Syncing This Folder…** disconnects it for good. You'll be asked to confirm with **Stop Syncing**.

Stopping syncing doesn't delete anything. The folder and its files stay on your Mac, and the workspace keeps its copies. They just stop being kept in step. The folder's key is revoked, and you can connect the workspace again later with **Add a Folder…**. When you do, Treehouse suggests the same folder and carries on from where it stopped, uploading your edits from the meantime. New files that appeared in the folder are listed first, and are only uploaded if you choose **Upload and Sync**.

## The main menu

- **Open Workspace** opens the web app in its own window.
- **Add a Folder…** syncs another workspace (or the same one again after you stopped syncing it). It walks you through choosing a workspace and a folder, as on first install.
- **Pause Syncing** and **Resume Syncing** pause or resume every folder at once.
- **Sign Out** stops every folder the app set up from syncing, revokes their keys and signs the app's window out. Your files stay exactly where they are. Folders you connected with the [CLI](/docs/desktop/sync-with-the-cli) aren't touched.
- The update item shows the app's version, and lets you check for updates or restart to install one.
- **Show Logs in Finder** opens the folder of log files, `~/Library/Logs/Treehouse/`. They're useful to attach when you report a problem.
- **Quit (sync continues)** closes the app's windows and menu bar icon. Your folders keep syncing in the background.

## From the terminal

The desktop app and the `treehouse` command-line tool share one list of synced folders, so you can manage the same folders from either. If you have the [CLI](/docs/desktop/sync-with-the-cli) installed:

```bash
treehouse status                          # every folder and its state
treehouse pause ~/Treehouse/Acme          # pause one folder
treehouse resume ~/Treehouse/Acme         # resume it
treehouse logs -f                         # follow the sync log live
```

## Troubleshooting

### A folder shows "Sign in needed"

Its key stopped working. That happens when you're removed from the workspace, or when the key is revoked. If you should still have access, choose **Re-authenticate…** from the folder's menu.

### A folder shows an error saying it was moved or deleted

Sync can't find the folder where it expects it, so it has stopped rather than delete anything. Move the folder back to where it was (the path is shown at the top of the folder's menu) and sync picks up again by itself. If you want it somewhere else, use **Change Location…** once it's back.

### The menu bar icon has gone

You probably quit the app. Open Treehouse from Applications to bring the icon back. Your folders were still syncing in the meantime.