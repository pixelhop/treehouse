---
title: Manage API keys
navTitle: API keys
description: Create a key for the sync CLI or an agent that can't sign in through a browser, see what each key can reach, and revoke the ones you no longer need.
type: how-to
position: 6
updated: 2026-10-30
related:
  - /docs/agents/connect/connected-agents
  - /docs/agents/connect/claude-code
  - /docs/agents/reference/authentication
  - /docs/account/security-and-privacy
---

An API key lets an agent, script or command-line tool act on your behalf. Keys are personal: a key can only reach workspaces you're a member of, and it stops working for a workspace the moment you leave it.

::callout{type="info" title="Most agents don't need a key"}
An agent that supports signing in through the browser can connect to the MCP server with no key at all, and you name it as you approve it. That's the recommended way to connect an agent: see [connect Claude Code](/docs/agents/connect/claude-code) or [connect other agents](/docs/agents/connect/other-agents). Use a key for the [sync CLI](/docs/desktop/sync-with-the-cli), your own scripts, and agents that can't open a browser, such as one running on a server or in CI.
::

![The API keys dialog showing a new key, with the ready-to-run Claude Code command below it](/docs/images/api-keys.webp)

## Create a key

1. In the web app, open the account menu at the bottom of the sidebar and choose **Agents & API keys**.
2. Under **API keys**, enter a **Name**. This is the label the [activity feed](/docs/sharing/activity) shows next to everything the key does, so name it after the agent or machine: `claude-code`, `inbox-filer`, `build-server`.
3. Choose **Used by**:
   - **Agent (MCP)** for an agent. Its changes are marked as an agent's.
   - **Human (CLI)** for your own scripts and tools. Its changes are marked as yours.
4. Choose its **Access** and **Reach**. See [limit what a key can do](#limit-what-a-key-can-do).
5. Select **Create key**.
6. Copy the key, and the ready-made command for Claude Code or the sync CLI if you need them.
7. Select **I've copied it**. The full key is never shown again.

::callout{type="tip" title="One key per agent"}
Give each agent its own key. You can then see exactly what each one did, and revoke one without disconnecting the others.
::

## What a key can reach

Keys you create under **API keys** in the web app reach **All your workspaces** unless you choose otherwise: they work in every workspace you belong to, and agents using them choose a workspace per request. Choose **This workspace** to tie a key to the one that's open.

The desktop app and the sync CLI get a different kind of key when you approve them in the browser. Those are tied to the one workspace you chose, and are named **Treehouse Desktop** or **treehouse-cli** in your list.

Either way, a key can do what you can do in that workspace, and no more. It can't see other members' [private files](/docs/files/private-files), and it can't create public links, invite people or manage keys, whatever it's used for.

## Limit what a key can do

A key can have less access than you. Giving an agent only what it needs makes it safe to leave running.

| Setting               | What it does                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access: Read only** | The key can read and comment, but can't create, change, move, delete or restore anything.                                                                                       |
| **Reach: a folder**   | The key can only reach that folder and what's inside it, in the workspace that's open. Everything else is out of reach, and it can't change the workspace's name or appearance. |

The limits show next to the key in your list. To change them, revoke the key and create a new one.

When you approve the desktop app or CLI in the browser, **Limit what this device can do** offers the same choices. A folder synced with a read-only key behaves like a [Viewer's](/docs/desktop/how-sync-works#syncing-with-view-only-access), and one limited to a folder only receives that folder.

Limits are checked on every request, on top of your own access. If you're made a [Viewer](/docs/sharing/invite-people#roles), every key you hold becomes read-only at the same moment. A key can never do more than you can, and it can't remove its own limits.

## Revoke a key

1. Open **Agents & API keys** from the account menu.
2. Under **API keys**, find the key by its name and the first few characters shown beside it.
3. Select **Revoke**, then confirm.

Anything using the key stops working immediately. Revoking a **Treehouse Desktop** or **treehouse-cli** key stops that folder syncing; the desktop app shows **Sign in needed** for it.

## Undo what a key changed

Next to a key, select **Undo changes…** to reverse everything it changed in the open workspace since a moment you choose. Changes anyone else made are kept. See [undo what an agent did](/docs/files/undo-an-agent).

## When someone leaves a workspace

When a member is [removed](/docs/sharing/invite-people), the keys tied to that workspace (their desktop app and CLI keys) are deleted straight away. Their account-wide keys keep working in their other workspaces but are refused in the one they left.

## Keep keys safe

- Treat a key like a password. Anyone who has it can do whatever the key is allowed to.
- Don't paste keys into files inside a synced folder. Everything in the folder syncs to the workspace, where your teammates can read it.
- Prefer client settings that read the key from an environment variable or a secure prompt, like the [VS Code and Codex examples](/docs/agents/connect/other-agents).
- Revoke keys you no longer use. If you think a key has leaked, revoke it and create a new one.