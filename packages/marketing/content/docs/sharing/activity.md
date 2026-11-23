---
title: See what changed in a workspace
navTitle: Activity
description: The activity feed shows every change and comment in a workspace, who made it, and whether it came from a person or an agent.
type: how-to
position: 4
updated: 2026-10-30
related:
  - /docs/agents/connect/how-agents-work
  - /docs/agents/connect/connected-agents
  - /docs/agents/connect/api-keys
  - /docs/files/version-history
  - /docs/files/conflicted-copies
---

Every write, move, delete, restore, conflict, comment and privacy change in a workspace is recorded, with who did it. The activity feed is where you read that record.

## Steps

1. Select **Activity** (the clock) at the bottom of the sidebar, beside your name. A number on it shows how many changes are new since you last looked.
2. A drawer opens with the 15 most recent groups of changes. Select any file name to open it.
3. For everything else, select **See all activity**. This opens the full feed, headed with the workspace name and **Activity**.
4. When you've caught up, select **Mark all seen**.

![The full activity page, with changes grouped by day and a line marking what's new since your last visit](/docs/images/activity.webp)

The feed checks for new activity every 15 seconds, so you can leave it open.

## Reading the feed

Changes are grouped under **Today**, **Yesterday** and then by date. A line marked **New since you were here** separates what's new from what you've already seen.

Each entry says who did what, to which file, and at which version:

| Label                  | Meaning                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **wrote**              | Created or changed a file                                                                                                   |
| **restored**           | Brought back an earlier version from [history](/docs/files/version-history)                                                 |
| **moved**              | Moved or renamed a file or folder                                                                                           |
| **deleted**            | Deleted a file or folder                                                                                                    |
| **conflict**           | Two edits clashed and a [conflicted copy](/docs/files/conflicted-copies) was kept                                           |
| **commented**          | Started a [comment](/docs/sharing/comments) thread                                                                          |
| **replied**            | Replied to a thread                                                                                                         |
| **resolved a comment** | Resolved a thread                                                                                                           |
| **reopened a comment** | Reopened a resolved thread                                                                                                  |
| **restricted**         | Limited who can see a file or folder: made it [private](/docs/files/private-files), or changed the people it's shared with. |
| **claimed**            | A workspace owner took over an item nobody could reach. Shown to owners and admins.                                         |
| **made shared**        | Shared a private file or folder again. Only shown to people who can now see it                                              |

When the same person or agent makes several changes within about 5 minutes of each other, they're grouped into one entry, such as "wrote 14 files". Expand it to see each file. A person's changes from a synced folder are grouped apart from the ones they make in the browser, so each entry can offer to undo just that synced folder's changes.

A restore is always one entry however long it took, such as "restored 3 files from the trash" or "restored 7 files to 15:04".

## Undo from the feed

Hover over an entry and select **Restore to before this…** to put the workspace back the way it was just before it. On an agent's entry, **Undo Claude Code's changes…** (with the agent's name) takes back only that agent's work, and keeps everything people and other agents did. See [undo what an agent did](/docs/files/undo-an-agent). You'll see every change before anything happens. See [restore to an earlier time](/docs/files/restore-to-an-earlier-time).

## People and agents

Changes are marked by who made them, in two colours: one for people and one for agents (you can change both in [Appearance](/docs/sharing/customise-your-workspace)).

- **A person's change** shows their name.
- **An agent's change** shows the name of the person the agent works for, followed by "· via" and the name you gave the agent when you connected it (or its API key's name), for example "Sam · via Claude Code on my laptop". Each agent is grouped separately, so an agent's burst of edits never merges with its owner's own changes.

### Changes from a synced folder count as yours

Attribution goes by the credential that made the change, not by what was typing. The desktop app and the sync CLI connect with a device key that belongs to you (named "Treehouse Desktop" or "treehouse-cli"), so **everything that arrives through your synced folder is shown as your change**. That includes edits made in the folder by an agent like Claude Code.

To have an agent's work labelled as the agent's own, connect it over MCP, signing it in through your browser ([Claude Code](/docs/agents/connect/claude-code), [other agents](/docs/agents/connect/other-agents)) or with its own [API key](/docs/agents/connect/api-keys) whose **Used by** is set to **Agent (MCP)**. [How agents work with Treehouse](/docs/agents/connect/how-agents-work) explains the two routes.

## Check it worked

Make a small edit to a file, then open **Activity**. Within 15 seconds your change appears at the top under **Today**, with your name and the new version number.