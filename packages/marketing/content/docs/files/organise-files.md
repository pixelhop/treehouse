---
title: Rename, move and organise files
navTitle: Organise files
description: Rename, move, reorder and delete files and folders, and give them icons, from the sidebar tree.
type: how-to
position: 4
updated: 2026-10-29
related:
  - /docs/files/version-history
  - /docs/files/private-files
  - /docs/playbooks/shape-your-workspace
  - /docs/files/link-notes
---

Every action for a file or folder is in its row menu. Hover over the row in the sidebar tree and select **⋯** at the end of it, or right-click the row. On a phone, tap the **⋯** at the end of the row, which opens the same menu as a sheet with **Move up** and **Move down** as well.

## Rename

1. Open the row menu (**⋯**) and select **Rename**.
2. Type the new name.
3. Press **Enter** to save, or **Esc** to cancel.

Renaming is a move to a new name, so the notes below about history apply. Notes that link to the file are updated to use its new name: see [link notes together](/docs/files/link-notes#rename-without-breaking-links).

## Move

1. Drag the file or folder onto the middle of a folder row. The folder is outlined when the drop will land inside it.
2. Let go.

To move something to the workspace root, drop it just above or below any top-level item. Or open the row menu (**⋯**), choose **Move to…**, then pick a folder or **Workspace root**.

Moving a folder moves everything inside it, along with its privacy setting and any icons inside it.

::callout{type="warning" title="Moving starts a new version count"}
A moved or renamed file starts again at version 1 at its new path, and its **History** tab starts fresh. It keeps its **Created** date, and the move counts as its latest change. Earlier versions are still recorded against the old path in the [activity feed](/docs/sharing/activity), but you can't view or restore them from the file. Comments move with the file. A file's custom icon doesn't follow it when you move or rename the file on its own, so set it again afterwards.
::

## Reorder

Drag a file or folder above or below its neighbours in the same folder. A line shows where it will land. On a phone, use **Move up** and **Move down**.

The order you choose is saved for everyone in the workspace. Reordering only works while the tree is in **Custom order**; if you've [sorted it](/docs/files/view-files#sort-the-tree) by name or date, switch back first. Items you haven't placed keep the default order, folders first and then alphabetical, after the ones you have. Custom order only affects the web app: a synced folder on disk is sorted by your computer as usual.

## Change an icon

1. Open the row menu (**⋯**) and select **Change icon…**.
2. Pick from **Emoji** or search the **Icon** set.
3. Select **Save**.

**Reset to default** puts back the standard file or folder icon. Icons are shared with everyone in the workspace.

## Delete

1. Open the row menu (**⋯**) and select **Delete**.
2. Confirm. The message reads `Delete “name”?` for a file, or `Delete folder “name” and everything in it?` for a folder.

Deleting a folder deletes every file inside it.

::callout{type="warning" title="Deletion is permanent in the web app"}
There's no bin and no undo, and a deletion syncs to every synced folder. If you might want something later, move it to an `archive` folder instead of deleting it.

An agent connected over MCP can bring a deleted file back with its `restore_file` tool, given the file's path and a version number from the [activity feed](/docs/sharing/activity). Don't rely on this as a backup.
::

## Troubleshooting

### "Couldn't move" or "Couldn't delete" some items

Something changed the file while you were moving or deleting it, or a file with the same name already exists at the destination. Nothing is lost. Refresh with **⋯** > **Refresh**, check the destination, and try again.

### The actions don't appear

In a read-only workspace (a lapsed subscription) the tree can't be changed. You can still open and download files.