---
title: Install the desktop app
description: Download Treehouse for Mac, sign in and pick a folder, and your workspace's files appear on your computer and stay in sync.
type: how-to
position: 1
updated: 2026-11-23
related:
  - /docs/desktop/how-sync-works
  - /docs/desktop/manage-synced-folders
  - /docs/desktop/sync-with-the-cli
---

::callout{type="note"}
The desktop app runs on Macs with Apple silicon (M1 or later) and macOS 13 Ventura or later. Windows and Linux are coming soon, and Intel Macs aren't supported yet, so keep working in the browser there.
::

## Steps

1. [Download Treehouse for Mac](https://dl.trytree.house/desktop/latest/Treehouse-arm64.dmg). You can also get it from the web app: open **Dashboard**, select **Sync a folder**, then **Download the Mac app**. It's offered after you accept an invite, too.
2. Open the downloaded file and drag **Treehouse** into Applications.
3. Open Treehouse from Applications. The first time, macOS asks you to confirm you want to open an app downloaded from the internet.
4. Sign in with your Treehouse account.
5. Under **Which workspace comes home?**, choose the workspace to sync. If you don't have one yet, you can name a new one here and select **Plant it**. If you opened the app from an invite, it already knows the workspace and skips this step.
6. The app asks **Where should** your workspace **live?** and a folder picker opens. Select **Sync here** to accept the suggested folder, or pick a different, empty one. The suggestion is `~/Treehouse/<workspace name>`, with " 2", " 3" and so on added if that name is already taken by something else. Select **Cancel** if you'd rather not sync now: nothing is created, and you can connect a folder later.
7. Confirm the workspace and select **Connect to** followed by its name.

Syncing starts straight away. The Treehouse icon appears in your menu bar, the folder fills with your workspace's files, and the workspace opens in the app's own window, already signed in.

If you have other workspaces that aren't synced on this Mac yet, the finished screen lists them under **Also bring these home?**. Select **Sync** next to one to set it up the same way.

## Check it worked

- Open the folder in Finder: your workspace's files are there.
- Click the Treehouse icon in the menu bar. Your folder is listed with **Up to date** once the first sync finishes.
- Drop a file into the folder. Within a few seconds it appears in the workspace in the web app.

## Choosing a folder

The folder you sync has to be empty. Treehouse uploads everything in it, so an existing folder full of your own files would be shared with the whole workspace. If you pick one that isn't empty, you'll see **That folder isn't empty**, with **Choose another** or **Use the suggested folder**.

The one exception is a folder this workspace synced to before. If you stopped syncing a workspace and connect it again, Treehouse suggests its old folder and picks up where it left off, rather than making a second copy next to it. Edits you made to the workspace's files while it wasn't syncing are uploaded. If any **new** files appeared in the folder in the meantime, you'll see **Upload new files?** with a list of them. Choose **Upload and Sync** to share them with the workspace, or **Choose Another Folder** to keep them private.

Avoid macOS's protected folders: Desktop, Documents, Downloads, Library, Movies, Music and Pictures. You can choose one, but you'll get a warning, and macOS may stop Treehouse syncing there until you grant access in System Settings. Keeping the folder outside iCloud Drive also avoids macOS offloading files to save space. The default `~/Treehouse` avoids both.

Each workspace can sync to one folder on a Mac. To sync another workspace, use **Add a Folder…** from the menu bar icon (see [manage synced folders](/docs/desktop/manage-synced-folders)).

## Updates

The app checks for updates when it starts and every 6 hours. When one is ready you'll be asked to restart, with **Restart Now** or **Later**. If you choose **Later**, the menu bar menu shows **Restart to update to** followed by the version, so you can do it when it suits you. Your folders keep syncing throughout, because the sync engine runs separately from the app.

## Self-hosted servers

If you use Treehouse on your own server, the app asks **Connect to this server?** before you sign in, and shows the address. Only continue if you recognise it. People using Treehouse at trytree.house won't see this step.

## Troubleshooting

### Setup stopped with "Setup didn't finish"

Something went wrong partway through, often a network problem. Select **Retry** to carry on from where it stopped. Nothing you've done so far is lost.

### The app won't open on my Mac

Your Mac probably has an Intel chip, or runs a macOS older than 13 Ventura. The desktop app doesn't support Intel Macs yet, so use the web app there. On an older macOS, update it with **Software Update** or use the web app.

For anything else, see [troubleshooting](/docs/help/troubleshooting).