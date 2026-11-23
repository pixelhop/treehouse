---
title: Troubleshooting
seoTitle: Troubleshooting Treehouse sync, agents and sharing
description: The problems people hit most often with sync, agent connections, sharing and limits, and how to fix each one.
type: how-to
position: 1
updated: 2026-10-29
related:
  - /docs/desktop/manage-synced-folders
  - /docs/agents/connect/claude-code
  - /docs/files/conflicted-copies
---

## Sync

### A folder shows "Sign in needed"

The key that folder syncs with has stopped working: it was revoked, or you were removed from the workspace. Choose the folder in the Treehouse menu bar icon and select **Re-authenticate…**. If you've left the workspace, stop syncing the folder instead. See [manage synced folders](/docs/desktop/manage-synced-folders).

### Changes on my computer aren't showing up in the web app

1. Check the Treehouse menu bar icon. If the folder says **Paused**, choose **Resume Syncing**.
2. Check the file isn't one Treehouse never syncs, such as anything inside `node_modules`, `.git`, `dist` or `build`. The full list is in [how sync works](/docs/desktop/how-sync-works).
3. Check the file isn't over your plan's [size limit](/docs/account/plans-and-limits).
4. If it's still stuck, choose **Show Logs in Finder** from the menu bar icon, or run `treehouse logs` in a terminal, and look for the file's name.

### Files called "(conflicted copy ...)" keep appearing

Two edits to the same file collided, and Treehouse kept both rather than losing one. Merge the copy into the original and delete the copy. If they keep appearing for the same file, two people or agents are editing it at once: see [conflicted copies](/docs/files/conflicted-copies) and [work with several agents](/docs/playbooks/multiple-agents).

### I moved my synced folder and sync stopped

Sync stops rather than risk deleting everything in the workspace. Move the folder back, or use **Change Location…** from the menu bar icon to move it properly.

## Agents

### My agent gets a 401 from the MCP server

If the agent signed in through your browser, it hasn't signed in yet, or its connection was [disconnected](/docs/agents/connect/connected-agents). Most clients then prompt you to sign in again; in Claude Code, run `/mcp`, choose **treehouse** and authenticate.

If it uses an API key, the key is missing, wrong or revoked, or it's being sent in the wrong header. Treehouse reads the key from `x-api-key`; a key sent as `Authorization: Bearer` isn't accepted. Check your client's configuration against [connect other agents](/docs/agents/connect/other-agents), and create a new key if in doubt.

### My agent says a file doesn't exist, but I can see it

Either the file is [private](/docs/files/private-files) to someone else, or the agent is looking in another workspace. Connected agents and keys created in the web app reach every workspace you belong to, so ask the agent to list your workspaces and use the right one.

### My agent's changes show up as mine

The agent is working in your synced folder, which syncs through your desktop app or CLI, so its changes arrive as yours. Connect it over MCP if you want its work labelled separately. See [how agents work with Treehouse](/docs/agents/connect/how-agents-work).

### My agent can't see comments

Comments aren't files, so they don't appear in a synced folder. Connect the agent to the MCP server as well; it can then use the comment tools.

### My agent can't create a public link

That's deliberate. Public links can only be made by a person signed in to the web app, so a leaked key can never open your files to the internet. Agents can create member links.

## Sharing

### A public link says it's "temporarily unavailable"

On the Seedling plan, the workspace has used its 500 share views for the month, and its links are paused until the month ends. The owner gets an email. Upgrading to Grove or Forest brings the links back straight away. See [plans and limits](/docs/account/plans-and-limits).

### A public link says it's "no longer available"

The link was revoked, or the file or folder it pointed to was deleted or moved. Create a new link from the **Share** tab.

### I can't invite anyone

On the Seedling plan a workspace is for one person. Upgrade to Grove or Forest to invite people. See [invite people](/docs/sharing/invite-people).

## Workspaces and limits

### I can't create files, and there's a banner saying the workspace is read-only

The workspace's subscription has lapsed or its checkout wasn't finished. Nothing is deleted, and you can still read, download, move and delete files. An owner or admin can fix it from the banner. See [billing](/docs/account/billing).

### An upload or save says a limit was reached

The workspace is at its storage or file limit, or the file is over the size limit. Delete or archive what you don't need, or upgrade. See [plans and limits](/docs/account/plans-and-limits).