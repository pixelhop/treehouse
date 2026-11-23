---
title: Sync a folder with the CLI
navTitle: Sync with the CLI
description: Install the treehouse command-line tool to sync a folder from a terminal instead of the desktop app.
type: how-to
position: 4
updated: 2026-11-23
related:
  - /docs/desktop/cli-reference
  - /docs/desktop/how-sync-works
  - /docs/desktop/manage-synced-folders
---

The `treehouse` CLI keeps a folder in sync with a workspace, just like the desktop app, from a terminal. Use it when you'd rather not run the desktop app, such as on a headless Mac where your agents run. It uses the same sync engine as the desktop app, so [how sync works](/docs/desktop/how-sync-works) applies here too.

::callout{type="note"}
The CLI runs on **macOS on Apple silicon** for now. Windows and Linux are coming soon; use the web app there in the meantime. Intel Macs aren't supported yet.
::

## Steps

1. Install the CLI.

   ```bash
   curl -fsSL https://dl.trytree.house/install.sh | sh
   ```

   This installs `treehouse` to `~/.local/bin`. If that isn't on your `PATH`, the installer tells you the line to add.

   The installer checks the download's checksum and doesn't need admin rights.

2. Connect a folder:

   ```bash
   treehouse login ~/my-folder
   ```

3. Your browser opens at **Approve this device**. Check the code matches the one in your terminal. On a machine without a browser, open the address the command prints on any device you're signed in on.
4. Choose the workspace to sync and select **Connect to** followed by its name.
5. When you see **You're connected 🌳**, go back to the terminal.

![The Approve this device page, showing a code to check against the terminal and a list of workspaces to choose from](/docs/images/device-approve.webp)

The code is valid for 10 minutes. If it expires, run `treehouse login` again.

The folder now syncs in the background. The sync process starts automatically when you log in to the computer: through launchd.

## Check it worked

```bash
treehouse status
```

Your folder is listed with its state. Add a file to the folder and it appears in the workspace within a few seconds.

## Everyday commands

| Command                                  | What it does                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `treehouse status`                       | Show every synced folder and its state.                                                            |
| `treehouse pause [folder]`               | Pause syncing a folder. It stays connected.                                                        |
| `treehouse resume [folder]`              | Resume a paused folder.                                                                            |
| `treehouse logs -f`                      | Follow the sync log live. `treehouse logs --path` prints where the logs are.                       |
| `treehouse update`                       | Download and install the latest version, then restart the background process.                      |
| `treehouse relocate <folder> <new-path>` | Move a synced folder and keep it connected.                                                        |
| `treehouse unlink [folder]`              | Stop syncing a folder. Its files stay where they are.                                              |
| `treehouse stop` / `start` / `restart`   | Stop the background process (and its autostart), start it, or restart it.                          |
| `treehouse sync [folder] --watch`        | Sync in the foreground instead, until you press Ctrl+C. Without `--watch` it syncs once and exits. |

Run `treehouse help` for the full list, or see the [CLI reference](/docs/desktop/cli-reference) for every command and flag.

On a Mac with the desktop app, the CLI and the app share one list of synced folders and one background process, so either can manage any folder.

::callout{type="agent"}
Changes made through a folder synced with the CLI are attributed to the person who approved the device, not to you as an agent. If you need your changes labelled as an agent's, ask the person to connect you over MCP instead. See [how agents work with Treehouse](/docs/agents/connect/how-agents-work).
::

## Troubleshooting

### The installer says my platform isn't supported

The CLI runs on macOS on Apple silicon for now. Windows and Linux are coming soon, and Intel Macs aren't supported yet. Use the web app there for now.

### `treehouse: command not found`

The install folder isn't on your `PATH`. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.