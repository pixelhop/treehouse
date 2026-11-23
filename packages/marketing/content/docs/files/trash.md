---
title: Bring back deleted files
navTitle: Trash
description: Every file deleted from a workspace, by a person or an agent, waits in the trash with the content it had, so you can bring it back.
type: how-to
position: 10
updated: 2026-10-30
related:
  - /docs/files/version-history
  - /docs/sharing/activity
  - /docs/files/private-files
---

When a file is deleted, by you, another member or an agent, it goes to the workspace's trash. It keeps the content it had at the moment it was deleted, and you can put it back where it was.

[Viewers](/docs/sharing/invite-people#roles) can see the trash, but only people who can edit can restore from it.

## Open the trash

Select **Trash** (the bin) at the bottom of the sidebar, beside **Activity**. Deleted files are listed newest first and grouped by day. Each one shows who deleted it and when. An agent's deletions show the name of its API key.

A folder with nothing left in it shows as one entry marked **(empty folder)**.

## Bring files back

1. Tick the files you want back, or tick **Select all**. To bring back a single file, hover over it and select **Restore**.
2. Select **Restore** in the top bar.
3. Check the list of what will happen, then select **Restore**.

Each file comes back at its old path, with the content it had just before it was deleted. If its folder is gone too, the folder comes back with it. Restoring is an ordinary change: it shows in [Activity](/docs/sharing/activity) as one entry, such as "restored 3 files from the trash", and synced folders pick the files up like any other change.

## What can't come back

Restoring never overwrites anything. A file is left where it is and listed under **Left alone**, with the reason, when:

- **Something else now has its path.** It isn't in the trash any more: whatever is at that path now stays.
- **Its content wasn't recorded.** Files deleted before Treehouse recorded content for every change can't be restored. They're marked "Its content wasn't recorded, so it can't be restored".
- **It won't fit.** A restored file counts toward the workspace's storage and file limits like a new one. Treehouse restores what fits and lists the rest, so you can free some space or [upgrade](/docs/account/billing) and try again. See [plans and limits](/docs/account/plans-and-limits).

Everything else in the same restore still comes back.

## Renamed and moved files

A renamed or moved file isn't in the trash: it still exists at its new path. Find it in the sidebar or in [Activity](/docs/sharing/activity).

## Private files

You only see deleted files you could see before they were deleted. Another member's private files never appear in your trash, even after they've been deleted, and the same goes for your private files in theirs. A file that was private when it was deleted stays out of other members' trash even if its folder is shared later, and when you restore it, it comes back private to you, even if the folder it was in has since been renamed or shared.

Files deleted before the trash existed are handled more cautiously, because Treehouse didn't yet record who could see each file. Once another member had made anything private, older files deleted after that point don't appear in your trash. And when you restore an older file that was deleted after you had made something private, it comes back private to you. You can [make it shared again](/docs/files/private-files#make-it-shared-again) if it shouldn't be.

## How long deleted files are kept

Treehouse currently keeps deleted files in the trash indefinitely, on every plan. Files in the trash don't count toward your storage or file limits. There is no way to empty the trash or delete a file from it permanently yet.

## For agents

Agents can do the same through the MCP tools [list_trash and restore_from_trash](/docs/agents/reference/mcp-server#list_trash), or the [REST API](/docs/agents/reference/rest-api#trash).