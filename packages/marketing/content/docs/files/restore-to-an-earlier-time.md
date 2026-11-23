---
title: Restore a folder or workspace to an earlier time
navTitle: Restore to an earlier time
description: Put a folder, or the whole workspace, back the way it was at a moment you choose, after seeing every change it will make.
type: how-to
position: 11
updated: 2026-10-30
related:
  - /docs/files/trash
  - /docs/files/version-history
  - /docs/sharing/activity
---

When a lot has gone wrong at once, such as an agent rewriting a folder or a sync tidying up the wrong files, you can put everything back the way it was at a moment you choose. Nothing changes until you've seen the full list of what will.

[Viewers](/docs/sharing/invite-people#roles) can't restore a folder or workspace.

## Undo a burst of changes from Activity

This is the quickest way when you can see the moment things went wrong.

1. Select **Activity** in the sidebar, then **See all activity**.
2. Hover over the first entry you want undone and select **Restore to before this…**. The time is filled in for you, exactly.
3. Select **Preview changes**, check the list, then select **Restore**.

This restores the whole workspace to just before that entry, so anything that happened after it is undone too, by anyone.

## Restore a folder

1. Open the folder, select **Show details** in the top bar, then **Restore to an earlier time…**. On a phone, tap the **⋯** at the end of the folder's row in the sidebar instead.
2. Choose a moment: pick one of **15 minutes ago**, **An hour ago**, **Start of today**, **A day ago** or **A week ago**, or set the **Date and time** yourself (to the second).
3. Select **Preview changes**.
4. Check the list, then select **Restore**.

Only the folder and what's inside it change. A folder next to it whose name merely starts the same way, such as `Notes 2` beside `Notes`, is left alone.

To restore the whole workspace, select the **⋯** above the file tree and then **Restore workspace…**, or **Restore to…** at the top of the Activity page.

## What a restore does

The preview lists each file and what will happen to it:

| In the preview                    | What happens                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Restore an earlier version**    | The file gets the content it had then, as a new version. The versions in between stay in its history. |
| **Bring back**                    | A file deleted since comes back.                                                                      |
| **Move back**                     | A file renamed or moved since goes back to its old name, keeping its comments and history.            |
| **Delete (it goes to the trash)** | A file created since is removed. You can bring it back from the [trash](/docs/files/trash).           |

A restore is itself an ordinary set of changes. It appears in [Activity](/docs/sharing/activity) as one entry, such as "restored 7 files to 15:04", and synced folders pick it up. To undo it, use **Restore to before this…** on that entry.

## What's left alone

Some files are listed under **Left alone**, with the reason, and the rest of the restore still goes ahead:

- **It changed after the preview.** Anything someone edits between your preview and selecting **Restore** isn't touched, so you never undo work you haven't seen. The same goes for a file made private or shared in that time.
- **It was renamed, and another file has its old name now.** Putting it back would mean overwriting the newer file in place, which would leave comments and history on the wrong file. Two files that swapped names are left alone for the same reason. Rename them back by hand.
- **It was private to someone else at that point.** See below.
- **Who can reach it has changed since then.** If a file has its own list of people and that list is different now, the older version stays out. Restoring it would either show it to people who weren't on it then, or change who has access. Change the list first if you want it back.
- **It was renamed together with a file that's being left alone.** A rename is one change: if one name can't go back, neither does the other, so you never end up with the file deleted or doubled.
- **Its earlier content wasn't recorded or can't be read.** This affects only files from before Treehouse recorded content for every change.
- **It would go over a limit.** Bringing files back counts toward your storage and file limits. Treehouse restores what fits. See [plans and limits](/docs/account/plans-and-limits).

## Private files

A restore only ever touches files you can see now.

- Another member's private files are never changed, recreated or listed, even when you restore the whole workspace.
- A file that was private to someone else at the moment you restore to is left alone, even if it has been shared since. What they wrote while it was private was never yours to see.
- Your own private files are restored like any other, and they stay private. If you restore content from while a file was private, and it has been shared since, it becomes private to you again and is removed from other members' synced folders. You can [make it shared again](/docs/files/private-files#make-it-shared-again).

## For agents

Agents can preview and apply the same restore with the MCP tools [preview_restore_to and restore_to](/docs/agents/reference/mcp-server#preview_restore_to), or the [REST API](/docs/agents/reference/rest-api#restore-to-an-earlier-time).