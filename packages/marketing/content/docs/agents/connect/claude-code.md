---
title: Connect Claude Code
description: Give Claude Code access to a workspace through your synced folder, the Treehouse MCP server, or both.
type: how-to
position: 3
updated: 2026-10-30
related:
  - /docs/agents/connect/how-agents-work
  - /docs/agents/connect/connected-agents
  - /docs/agents/connect/api-keys
  - /docs/playbooks/write-your-agents-md
---

Claude Code can reach a Treehouse workspace in two ways. Open it in your synced folder and it works on the files directly. Connect the Treehouse MCP server, signing in through your browser, and it works through Treehouse itself, with its changes labelled as its own and access to review comments. You can set up either, or both. If your notes live in Obsidian, see [Obsidian and Claude Code for teams](/guides/obsidian-and-claude-code-for-teams).

## Option 1: work in the synced folder

::callout{type="info" title="Before you start"}
You need the workspace synced to your computer, with the [desktop app](/docs/desktop/install-the-desktop-app) or the [sync CLI](/docs/desktop/sync-with-the-cli).
::

1. In a terminal, go to the synced folder. The desktop app puts it in `~/Treehouse/<workspace name>` unless you chose somewhere else. To find it, choose the folder in the Treehouse menu bar icon and select **Open in Finder**.
2. Run `claude`.

That's it. Claude Code reads `AGENTS.md` at the root of the folder as it would in any project, and every file it writes syncs to the workspace within a few seconds.

```bash
cd ~/Treehouse/Acme
claude
```

## Option 2: connect the MCP server

1. In a terminal, add Treehouse as a server. There's no key to copy:

   ```bash
   claude mcp add --transport http treehouse https://api.trytree.house/api/mcp
   ```

2. Start Claude Code, run `/mcp`, choose **treehouse** and choose to authenticate. Claude Code opens your browser.
3. Sign in to Treehouse, or create an account if you don't have one yet. A new account has to confirm its email first: the link in that email brings you back to this step.
4. The browser shows **Connect** followed by the app's name, and says what the connection will be able to do. **Name this connection** starts as the name Claude Code gave itself; change it to something you'll recognise in the activity feed, such as `Claude Code on my laptop`.
5. Select **Allow**. The browser hands you back to Claude Code, which is now connected.

The same command, ready to copy, is in the web app: open the account menu at the bottom of the sidebar and choose **Agents & API keys**.

By default `claude mcp add` connects Treehouse only in the directory you ran it from. To make it available in every project, add `--scope user`:

```bash
claude mcp add --scope user --transport http treehouse https://api.trytree.house/api/mcp
```

The connection reaches every workspace you're a member of. Claude Code will list your workspaces and ask which one you mean, or you can name it in your request. It stays connected: Claude Code renews its access on its own, so you only sign in once. To rename or disconnect it later, see [manage connected agents](/docs/agents/connect/connected-agents).

### Connect with an API key instead

If Claude Code runs somewhere it can't open a browser, such as a server or CI, connect it with an [API key](/docs/agents/connect/api-keys):

1. In the web app, open the account menu and choose **Agents & API keys**.
2. Under **API keys**, set **Name** to something you'll recognise in the activity feed, such as `claude-code`.
3. Set **Used by** to **Agent (MCP)** and select **Create key**.
4. Copy the command under **Claude Code (MCP)** and run it. It looks like this:

   ```bash
   claude mcp add --transport http treehouse https://api.trytree.house/api/mcp \
     --header "x-api-key: <your key>"
   ```

5. Select **I've copied it** to close the dialog. The key won't be shown again.

## Check it worked

Start Claude Code and ask:

```text
List my Treehouse workspaces, then show me what's at the root of <workspace name>.
```

Over MCP it calls the Treehouse tools; run `/mcp` inside Claude Code to see the `treehouse` server and its tools. After it makes a change, open **Activity** in the web app: the change appears under your name followed by "via" and the name you gave the connection, such as "Sam · via Claude Code on my laptop".

## Troubleshooting

### Claude Code says the server needs authentication

Claude Code hasn't signed in yet, or its connection was disconnected. Run `/mcp`, choose **treehouse** and authenticate again.

### Claude Code says the server returned 401 with an API key

The key is missing, mistyped or revoked. Treehouse expects it in an `x-api-key` header, not `Authorization: Bearer`. Remove the server with `claude mcp remove treehouse` and add it again with a fresh key.

### The browser says the connection request has expired or isn't valid

The sign-in page Claude Code opened can no longer be used. Go back to Claude Code and authenticate again from `/mcp`.

### It can't find a file I can see in the web app

The file may be [private](/docs/files/private-files) to someone else, in which case Treehouse reports it as not found. Or the agent may be looking in the wrong workspace: ask it to list your workspaces first.

### Its edits in the synced folder show up as mine

That's expected. The folder syncs through your desktop app or CLI, which signs in as you. Use the MCP connection if you want the agent's changes labelled separately.