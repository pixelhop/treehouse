---
title: How sync works
description: What the sync engine does in the background, which files it skips, and how it protects your work when things go wrong.
type: concept
position: 2
updated: 2026-10-30
related:
  - /docs/files/conflicted-copies
  - /docs/files/private-files
  - /docs/sharing/activity
  - /docs/get-started/how-treehouse-works
---

A synced folder is a two-way copy of one workspace. Change a file on your computer and it's uploaded; change it anywhere else, in the web app, over MCP or on a teammate's computer, and it's downloaded. The desktop app and the sync CLI share the same engine, so everything on this page applies to both.

## It runs in the background

Sync is done by a small background process, separate from the app. It starts when you log in to your computer and keeps running when no window is open. Quitting the desktop app doesn't stop it: the menu item even says **Quit (sync continues)**. To actually stop syncing, pause the folder or sign out (see [manage synced folders](/docs/desktop/manage-synced-folders)).

While it runs, it:

- notices changes in your folder as you save them;
- checks the workspace for other people's changes about every 2 seconds;
- does a full comparison of the folder and the workspace every 5 minutes, to catch anything missed, for example while your computer was asleep.

## When two edits collide

If a file changes in two places before sync can pass one change to the other, neither is thrown away. One version keeps the file's name and the other is saved beside it as a [conflicted copy](/docs/files/conflicted-copies), both in the workspace and in your folder. Compare them, keep what you want, and delete the copy.

An edit always beats a delete. If you edit a file on your computer while someone else deletes it, your edit brings it back rather than being lost.

## Safety nets

Sync is built so that a mistake on one computer can't wipe the workspace for everyone:

- **If the folder goes missing**, because you moved it, renamed it or put it in the Bin, sync stops and reports an error instead of deleting everything from the workspace. Put the folder back and sync carries on by itself. To keep a folder somewhere else, move it with **Change Location…** from the menu bar icon, or `treehouse relocate` in the CLI.
- **If a single pass would delete 25 or more files from your folder**, or the workspace suddenly looks empty, sync assumes something is wrong. It keeps your local files and uploads them again rather than deleting them.
- **Every change is versioned.** Anything sync writes to the workspace can be [restored from history](/docs/files/version-history).

## One folder, one workspace

Each synced folder belongs to exactly one workspace, and each workspace syncs to one folder per computer. To work on several workspaces, sync each to its own folder.

## What doesn't sync

Some files are never synced, in either direction. There's no way to add your own rules yet.

- **Files:** `.DS_Store`, `4913`, anything ending in `.swp`, `.tmp` or `~`, and anything starting with `.#`. These are editor and system temporary files.
- **Folders, anywhere in the tree:** `node_modules`, `.git`, `.hg`, `.svn`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`, `.output`, `.turbo`, `.cache`, `dist`, `build`, `target`, `vendor`, `.gradle` and `Pods`. These are dependency, version-control and build folders, which can hold tens of thousands of files.
- **The `.treehouse` folder** at the top of your synced folder.
- **Obsidian's layout files:** `.obsidian/workspace.json` and `.obsidian/workspace-mobile.json`, from version 0.1.11. They record one person's open tabs, so each person keeps their own. The rest of `.obsidian` syncs.

If one of these files is already in the workspace, or someone adds one in the web app, sync leaves that copy alone and doesn't touch yours.

The match is on the exact name, so a folder called `my-build-notes` still syncs. Other dotfiles, such as `.env.example` or `.prettierrc`, do sync.

Files larger than your plan's [maximum file size](/docs/account/plans-and-limits) are skipped, with a note in the sync log.

::callout{type="warning"}
The `.treehouse` folder holds this folder's settings and the key it uses to reach your workspace. Never share it, copy it into another folder, or commit it to a Git repository.
::

## Whose name is on the change

Your synced folder connects with a key that belongs to you. Every change that arrives through it is shown in [Activity](/docs/sharing/activity) as yours, whether you made it or an agent working in the folder did. To have an agent's changes labelled as the agent's, connect it over MCP with its own key. [How agents work with Treehouse](/docs/agents/connect/how-agents-work) explains the difference.

## Private files and losing access

Your synced folder includes your own [private files](/docs/files/private-files), since you can see them. It never includes other people's.

If a file or folder becomes private to someone else, sync removes your local copy of it, because you no longer have access. If you're removed from the workspace, the folder's key stops working and the folder stops syncing, showing **Sign in needed**.

## Syncing with view-only access

If you're a [Viewer](/docs/sharing/invite-people#roles), or the folder's [key is read-only](/docs/agents/connect/api-keys#limit-what-a-key-can-do), your synced folder still receives every change, but nothing you do locally reaches the workspace. Sync puts things back rather than leaving your folder out of step:

| What you did locally | What happens                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edited a file        | The workspace's version is restored. Your edit is saved in `.treehouse/reverted/` inside the folder.                                                                                                                          |
| Deleted a file       | It's downloaded again.                                                                                                                                                                                                        |
| Added a new file     | It stays in your folder, but it isn't uploaded. If you're given edit access, it uploads when sync next starts. If someone adds a file with that name to the workspace, theirs replaces yours and yours is saved the same way. |

No conflicted copies are made and nothing is retried. Each one is noted in the sync log, and the Treehouse menu shows a line such as **1 change not synced, view-only access** for a day. Each saved edit keeps its file name plus a short code, so one edit never replaces another. `.treehouse/` never syncs, so they're yours to keep or delete.