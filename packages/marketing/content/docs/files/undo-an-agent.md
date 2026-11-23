---
title: Undo what an agent did
navTitle: Undo an agent
description: Reverse everything one agent or API key changed since a moment you choose, while keeping every change anyone else made.
type: how-to
position: 12
updated: 2026-10-30
related:
  - /docs/files/restore-to-an-earlier-time
  - /docs/sharing/activity
  - /docs/agents/connect/api-keys
---

Every change in Treehouse is recorded with the API key that made it, so when one agent gets something wrong you can take back just its work. Changes by people and by other agents stay as they are.

[Viewers](/docs/sharing/invite-people#roles) can't undo changes, and neither can their agents.

## Undo from Activity

1. Select **Activity** in the sidebar, then **See all activity**.
2. Hover over the first entry by that agent you want undone and select **Undo Claude Code's changes…** (with your agent's name). The moment just before that entry is filled in.
3. Select **Preview changes**, check the list, then select **Undo changes**.

## Undo from the API keys list

1. Select your name at the bottom of the sidebar, then **API keys**.
2. Next to the key, select **Undo changes…**.
3. Choose how far back to go, select **Preview changes**, then **Undo changes**.

The API keys list shows your own keys. To undo another member's agent, use its entries in Activity.

## What gets undone

Each file the agent changed after that moment goes back to how it was just before the agent's first change to it:

- Files it **edited** get their earlier content back, as a new version.
- Files it **deleted** come back.
- Files it **renamed or moved** go back to their old names.
- Files it **created** are deleted. They go to the [trash](/docs/files/trash), so you can still bring them back.

The undo appears in [Activity](/docs/sharing/activity) as one entry, such as "undid 6 changes by Claude Code", and synced folders pick it up. To take the undo back, use **Restore to before this…** on that entry.

## When someone else changed a file afterwards

If a person or another agent changed a file after the agent did, that file is **left alone**, and the preview lists it with who changed it, such as "someone else changed it afterwards (Sam Rivera)". Undoing the agent's change would throw their work away, so Treehouse never does it. Open the file's [history](/docs/files/version-history) to pick the version you want by hand.

A rename is treated as one change. If someone edited the renamed file, both its old and new names are left alone.

The same rules as [restoring to an earlier time](/docs/files/restore-to-an-earlier-time#whats-left-alone) apply to everything else: files you can't see are never touched, a file private to someone else at the time is left alone, and anything changed after your preview is left alone.

## Agents undoing their own work

An agent connected over MCP can undo its own changes with `preview_undo_my_changes` and `undo_my_changes`. It can only ever undo changes made with its own key, never another agent's or a person's. See the [MCP server reference](/docs/agents/reference/mcp-server#preview_undo_my_changes).