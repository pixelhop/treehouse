---
title: Sync CLI reference
navTitle: Sync CLI
description: Every treehouse command and flag, the files and environment variables the CLI reads, and the safety rules it follows while syncing.
type: reference
position: 5
updated: 2026-11-23
related:
  - /docs/desktop/sync-with-the-cli
  - /docs/desktop/how-sync-works
  - /docs/agents/reference/change-feed
---

The `treehouse` CLI keeps a local folder and a workspace in step, in both directions. For a walkthrough, see [sync with the CLI](/docs/desktop/sync-with-the-cli); this page is the reference.

## Install

```bash
curl -fsSL https://dl.trytree.house/install.sh | sh
```

| Platform             | Prebuilt binary |
| -------------------- | --------------- |
| macOS, Apple Silicon | Yes             |
| Linux                | Coming soon     |
| macOS, Intel         | Not yet         |
| Windows              | Coming soon     |

The script downloads the binary for your platform, checks it against the published SHA-256 checksums, and installs it to `~/.local/bin/treehouse`. Set `TREEHOUSE_BIN_DIR` to install somewhere else. On an unsupported platform it stops with a message and installs nothing.

## Commands

| Command                                  | What it does                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `treehouse login [folder]`               | Connect a folder to a workspace through the browser, then start syncing it. `link` is an alias.                                  |
| `treehouse sync [folder]`                | Reconcile the folder with its workspace once and exit. Running `treehouse` with no command does the same for the current folder. |
| `treehouse sync [folder] --watch`        | Keep syncing in the foreground until stopped: watches the folder and polls the change feed.                                      |
| `treehouse start`                        | Start the background daemon, which syncs every linked folder, and turn on autostart at login.                                    |
| `treehouse stop`                         | Stop the daemon and turn off autostart.                                                                                          |
| `treehouse restart`                      | Stop and start the daemon, for example after an update.                                                                          |
| `treehouse status`                       | Show each linked folder's state and whether an update is available.                                                              |
| `treehouse logs [name]`                  | Print the end of a log. `name` is `daemon` (the sync daemon, the default), `app` or `updater` (the desktop app's own logs).      |
| `treehouse pause [folder]`               | Pause syncing a folder, keeping it linked.                                                                                       |
| `treehouse resume [folder]`              | Resume a paused folder.                                                                                                          |
| `treehouse unlink [folder]`              | Stop syncing a folder and remove it from the daemon's list.                                                                      |
| `treehouse relocate <folder> <new-path>` | Move a synced folder to a new location, keeping its connection and sync state.                                                   |
| `treehouse update [--check]`             | Download, verify and install the latest version, then restart the daemon. `--check` only reports.                                |
| `treehouse version`                      | Print the installed version. `--version` and `-v` work too.                                                                      |
| `treehouse help`                         | List commands. `treehouse <command> --help` describes one.                                                                       |

`[folder]` defaults to the current directory.

### Flags

| Command  | Flag                | Effect                                                                           |
| -------- | ------------------- | -------------------------------------------------------------------------------- |
| `login`  | `--api-base <url>`  | API to connect to. Default `https://api.trytree.house`, or `TREEHOUSE_API_BASE`. |
| `login`  | `--workspace <id>`  | Preselect this workspace on the approval page. You can still choose another.     |
| `login`  | `--force`           | Replace an existing `.treehouse/config.json` in the folder                       |
| `login`  | `--no-open`         | Print the approval link instead of opening a browser                             |
| `login`  | `--no-start`        | Connect without starting to sync                                                 |
| `sync`   | `--watch`           | Keep syncing instead of exiting after one pass                                   |
| `logs`   | `-f`, `--follow`    | Keep printing new lines                                                          |
| `logs`   | `-n`, `--lines <n>` | Lines to print. Default 100.                                                     |
| `logs`   | `--path`            | Print the log folder instead, for attaching to a bug report                      |
| `update` | `--check`           | Report whether an update is available without installing it                      |

### How login works

`treehouse login` uses the [device authorisation flow](/docs/agents/reference/authentication#device-authorisation-flow). It prints a link and a code, opens your browser, and waits while you sign in, pick a workspace and approve. It then saves a workspace-scoped key in the folder and starts syncing. The code is valid for 10 minutes. With `--no-open` you can approve from any device, which is how you connect a headless server.

### unlink

`unlink` stops syncing but leaves your files and `.treehouse/config.json` where they are, and doesn't revoke the key. Revoke it from **Agents & API keys** in the web app if you're done with it.

## Files the CLI keeps

### In each synced folder

| File                     | Contents                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| `.treehouse/config.json` | `{ apiBase, apiKey, workspaceId, keyId }`, written with mode `0600`            |
| `.treehouse/index.json`  | What was last synced, used to tell local edits from remote ones                |
| `.treehouse/cursor.json` | The folder's position in the [change feed](/docs/agents/reference/change-feed) |
| `.treehouse/state.json`  | The folder's last reported sync state                                          |

The `.treehouse` folder is never synced.

### Per user

| Location      | macOS                                     | Linux                                                            |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| App directory | `~/Library/Application Support/Treehouse` | `$XDG_CONFIG_HOME/treehouse` (default `~/.config/treehouse`)     |
| Logs          | `~/Library/Logs/Treehouse`                | `$XDG_STATE_HOME/treehouse` (default `~/.local/state/treehouse`) |

The app directory holds `links.json` (the list of synced folders), the daemon's process id and control socket, and the daemon binary the autostart service runs. `TREEHOUSE_HOME` replaces both locations, with logs in `$TREEHOUSE_HOME/logs`.

Autostart uses a launchd agent on macOS and a `systemd --user` unit on Linux (or an XDG autostart entry where `systemd --user` isn't available).

## Environment variables

| Variable                            | Effect                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `TREEHOUSE_API_BASE`                | API URL. Overrides `apiBase` in the folder's config, and is the default for `login`.      |
| `TREEHOUSE_API_KEY`                 | API key. Overrides `apiKey` in the folder's config.                                       |
| `TREEHOUSE_WORKSPACE_ID`            | Workspace id. Overrides `workspaceId` in the folder's config.                             |
| `TREEHOUSE_HOME`                    | Use this directory for all per-user state and logs                                        |
| `TREEHOUSE_MAX_FILE_BYTES`          | Skip local files larger than this many bytes, with a warning. Default 104857600 (100 MB). |
| `TREEHOUSE_DL_BASE`                 | Download host for `update` and the install script. Default `https://dl.trytree.house`.    |
| `TREEHOUSE_BIN_DIR`                 | Where the install script puts the binary. Default `~/.local/bin`.                         |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Linux app and log directory bases                                                         |

With `TREEHOUSE_API_BASE`, `TREEHOUSE_API_KEY` and `TREEHOUSE_WORKSPACE_ID` all set, `treehouse sync` works in a folder that has no config file, without `login`.

## What isn't synced

The CLI has a fixed ignore list. There is no ignore file.

| Pattern                                                                                        | Why                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `.treehouse/`                                                                                  | The CLI's own state                        |
| `*.swp`, `*~`, `.#*`, `*.tmp`, `4913`                                                          | Editor swap, backup and temporary files    |
| `.DS_Store`                                                                                    | macOS folder metadata                      |
| `node_modules/`, `vendor/`, `Pods/`                                                            | Dependencies                               |
| `.git/`, `.hg/`, `.svn/`                                                                       | Version control internals                  |
| `.venv/`, `venv/`, `__pycache__/`                                                              | Python environments and caches             |
| `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`                                  | Obsidian's per-device layout (from 0.1.11) |
| `.next/`, `.nuxt/`, `.output/`, `.turbo/`, `.cache/`, `dist/`, `build/`, `target/`, `.gradle/` | Build output and caches                    |

Folder patterns match a folder with exactly that name at any depth, so a folder called `build-notes` still syncs. Files over the size limit are skipped and reported once.

## Conflicts and safety

The CLI follows the same [versions and conflicts](/docs/agents/handbook/versions-and-conflicts) rules as every other client. It adds some guards of its own:

- **Both sides changed.** Your local edit is uploaded against the version it was based on. If the workspace moved on, your bytes are kept as a conflicted copy, which then syncs back to the folder. `treehouse sync` lists these as `conflict(s) — both versions kept`.
- **Mass delete guard.** During a full sync, if the workspace comes back empty, or 25 or more local files would be deleted in one pass, the CLI keeps the local files and uploads them again instead. This protects you from a reset or a folder pointed at the wrong workspace.
- **Missing folder.** If the synced folder (its `.treehouse/config.json`) disappears, for example mid-move in Finder, the CLI stops propagating deletes rather than deleting the team's files.
- **Key revoked.** If the key stops working (`401` or `403`), the folder shows **sign in** in `treehouse status` and the daemon retries every 30 seconds. Run `treehouse login --force` in the folder to reconnect.
- **Access removed.** When someone makes a file or folder private and you lose access, the CLI deletes your local copy of it.
- **One file failing** doesn't stop the rest. A one-shot `treehouse sync` reports the failures and exits with status 1.

## With the desktop app

The desktop app and the CLI share one background daemon and one list of synced folders. Folders connected in either show up in `treehouse status`, and `treehouse pause`, `resume` and `relocate` work on folders the app connected. See [how sync works](/docs/desktop/how-sync-works).

## Running an agent on a server

The CLI is the simplest way to give an agent on a server, a VM or a CI runner a real folder to work in:

1. Install the CLI on the server.
2. Run `treehouse login ~/workspace --no-open`, and approve the printed link from your own browser.
3. Point the agent at `~/workspace`. Everything it writes syncs to the workspace, and everything your team writes appears in the folder.

If you prefer not to use the browser flow, create a key in the web app and set `TREEHOUSE_API_BASE`, `TREEHOUSE_API_KEY` and `TREEHOUSE_WORKSPACE_ID`, then run `treehouse sync ~/workspace --watch` under your process manager. Changes are attributed to the key's actor type, so choose **Agent (MCP)** under **Used by** if you want the agent's edits labelled as an agent's.