---
title: Set up a new workspace for someone
navTitle: Set up a new workspace
seoTitle: "Agent guide: set up a new Treehouse workspace"
description: Written for agents. Connect a person's new workspace to their computer, doing as much of the work yourself as you can, then help them organise it.
type: how-to
position: 2
updated: 2026-11-23
related:
  - /docs/get-started/set-up-with-an-agent
  - /docs/agents/handbook
  - /docs/desktop/sync-with-the-cli
---

::callout{type="agent" title="This page is for you, the agent"}
Someone has just created a Treehouse workspace and asked you to set it up. Your job has two parts: get the workspace connected so you can work in its files, then organise it with them by following its `AGENTS.md`. Do as much as you can yourself. They should only have to answer questions, approve things and click where a person has to.
::

## What Treehouse is

Treehouse is a shared workspace of plain files: markdown, HTML, images, PDFs, anything. A person, their team and their agents all work in the same files. On a computer, the workspace is an ordinary folder that the Treehouse desktop app or CLI keeps in sync. On the web, the same files render as pages people can read, comment on and share. There's no special format and no integration to write: you work in it the way you work in any folder.

## What you need from the prompt

The setup prompt you were given carries the facts for this workspace. Use them in every step below:

| Fact             | Example                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| Workspace name   | `Acme`                                                                   |
| Workspace id     | `ws_example`                                                             |
| Web app          | `https://app.trytree.house`                                              |
| API              | `https://api.trytree.house`                                              |
| MCP server       | `https://api.trytree.house/api/mcp`                                      |
| Desktop app link | `treehouse://open?workspace=ws_example&origin=https://app.trytree.house` |

If the prompt's web app or API address isn't `trytree.house`, the workspace is on a self-hosted server. Use the prompt's addresses wherever this page shows a `trytree.house` one, and pass `--api-base <API>` to the CLI.

## Steps

### 1. Work out how you can reach the workspace

- **You can run commands on their computer** (Claude Code, Codex, Cursor and similar): you can do nearly all of this yourself. Carry on with step 2.
- **You can't install software, but can use MCP connectors** (Claude Cowork, Claude Desktop, claude.ai, ChatGPT and similar): connect over MCP, as in [connect over MCP instead](#connect-over-mcp-instead). Then skip to step 6. If they'd rather have the workspace as a folder on their computer too, suggest they [install the desktop app](/docs/desktop/install-the-desktop-app) afterwards.
- **You have no files, commands or connectors**: you can't reach the workspace. Tell them, and suggest they open this prompt in an agent that can, such as Claude Code, Claude Cowork or Codex. Don't plan a structure they then have to build by hand.

### 2. Look for a folder that's already syncing

The workspace may already be on this computer. Read the list of synced folders, which the desktop app and the CLI share. On macOS it's at:

`~/Library/Application Support/Treehouse/links.json`

It holds `{ "links": [{ "root": "<folder path>", "workspaceId": "<id>" }] }`. If an entry's `workspaceId` matches the prompt's, its `root` is the workspace folder: go to step 4 to make sure it's actually syncing. An entry stays in the list while syncing is paused or signed out. If the CLI is installed, `treehouse status` shows the same list.

### 3. Otherwise, connect a folder

Tell them in a sentence what you're about to do and why ("I'll install the Treehouse app so this workspace becomes a folder on your computer"), and get a yes before installing anything. Then use the first option that fits.

**On a Mac with Apple silicon** (`uname -m` prints `arm64`), use the desktop app. It's what they'll use day to day.

1. Skip installing if `/Applications/Treehouse.app` already exists. Otherwise install it:

   ```bash
   curl -fsSL -o /tmp/Treehouse.dmg https://dl.trytree.house/desktop/latest/Treehouse-arm64.dmg
   hdiutil attach -nobrowse -quiet -mountpoint /tmp/treehouse-dmg /tmp/Treehouse.dmg
   cp -R /tmp/treehouse-dmg/Treehouse.app /Applications/
   hdiutil detach -quiet /tmp/treehouse-dmg
   ```

2. Open the prompt's desktop app link. The app opens straight at this workspace:

   ```bash
   open "treehouse://open?workspace=<id>&origin=<web app>"
   ```

3. Tell them what to do in the window that opens: sign in if it asks, then confirm where to keep the folder. On a self-hosted server the app first asks whether to trust the server's address.
4. Check `links.json` every few seconds until the workspace appears, for up to 10 minutes. Its `root` is the folder.

**On an Apple silicon Mac where the desktop app doesn't suit them**, use the CLI:

1. Install it:

   ```bash
   curl -fsSL https://dl.trytree.house/install.sh | sh
   ```

   If `treehouse` isn't found straight afterwards, call it by its full path rather than asking them to open a new terminal: `~/.local/bin/treehouse`, or `$TREEHOUSE_BIN_DIR/treehouse` if that variable is set.

2. Connect a folder. Quote the path: workspace names often contain spaces and apostrophes.

   ```bash
   treehouse login "$HOME/Treehouse/<workspace name>" --workspace <id>
   ```

   Add `--api-base <API>` on a self-hosted server. The command prints an approval link and a code, and opens the browser at **Approve this device** with the workspace already chosen.

3. Give them the link and the code it printed, in case the browser didn't open in front of them. Ask them to check the code matches, then select **Connect to** the workspace.
4. The command waits up to 10 minutes for that, then starts syncing. If your shell would time out sooner, run it in the background and check `treehouse status` until the folder shows up.

**On Windows, Linux or an Intel Mac**, there's no sync app yet. Windows and Linux are coming soon. Don't install the CLI there. [Connect over MCP instead](#connect-over-mcp-instead).

### 4. Check it's syncing

Check this before you create anything. A folder that isn't syncing still accepts files, so you could build the whole structure without any of it reaching the web app.

If the CLI is installed:

1. Run `treehouse status` and read its first line before anything else. `treehouse is not running (last known state)` means nothing is syncing, whatever the folder's badge says: the badges below it are only the last state recorded. Run `treehouse start`, and `treehouse resume "<folder>"` if the folder is paused, then run `treehouse status` again.
2. Once the first line says `treehouse is running`, act on the folder's badge:

   | Badge        | What it means and what to do                                                                                 |
   | ------------ | ------------------------------------------------------------------------------------------------------------ |
   | `✓ synced`   | It's working.                                                                                                |
   | `● starting` | Sync is starting up. Check again in a few seconds.                                                           |
   | `⇅ syncing`  | Files are moving. Check again in a few seconds.                                                              |
   | `◐ polling`  | Syncing, but it notices local changes every few seconds rather than instantly. Check again until `✓ synced`. |
   | `‖ paused`   | `treehouse resume "<folder>"`                                                                                |
   | `⚠ sign in`  | `treehouse login --force "<folder>" --workspace <id>`, and they approve it again                             |
   | `✗ error`    | `treehouse logs` shows what went wrong.                                                                      |

3. Start building only when the first line says `treehouse is running` and the folder shows `✓ synced`.

Without the CLI, look at the folder's entry in `links.json`: `"paused": true` means it's paused. Ask them to check the folder in the Treehouse menu bar icon and resume it, or sign in again, from there.

Then list the folder. A new workspace holds `README.md` and `AGENTS.md`. If it's empty, give it a few seconds: the first sync is still running.

### 5. Work in the folder

If your session started somewhere else, work in the folder by its full path. Never read, edit or delete the `.treehouse/` folder inside it: it holds the sync settings and key.

Your changes reach the web app within a few seconds. You can tell them to open the workspace there and watch it fill up.

### 6. Follow AGENTS.md

Read `AGENTS.md` at the root of the workspace and follow it. In a new workspace it's a setup guide: you'll interview them about what the workspace is for, propose a folder structure, build it once they agree, and finish by suggesting what to set up next.

## Connect over MCP instead

If you can't install anything, or their computer has no ready-made sync app, connect to the workspace over MCP. There's no key involved: the person signs in through their browser.

1. Ask them to add the prompt's MCP server address as a remote MCP server, with no key. In Claude Cowork, Claude Desktop and claude.ai that's a custom connector; in ChatGPT, a connector. [Connect other agents](/docs/agents/connect/other-agents) shows where it goes in each client.
2. When the client connects, it opens their browser. They sign in to Treehouse, name the connection and select **Allow**.
3. Call `list_workspaces` and use the workspace id from the prompt in every tool call.

Over MCP you read and write with the Treehouse tools (`list_files`, `read_file`, `write_file`) instead of a folder, and steps 2 to 5 don't apply.

## Check it worked

- The workspace's entry is in `links.json` (or `treehouse status`), and its folder holds `README.md` and `AGENTS.md`.
- A file you create in the folder appears in the web app within a few seconds.

## Troubleshooting

### The desktop app link does nothing

The app isn't installed or hasn't been opened yet. Open `/Applications/Treehouse.app` once, then open the link again.

### The approval page shows a different workspace

The CLI you have may be older than the `--workspace` flag. Ask them to choose the workspace named in the prompt, or run `treehouse update` first.

### The workspace already has folders

Someone has set it up already. `AGENTS.md` says so too. Don't start again: ask what they want changed.