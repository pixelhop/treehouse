---
title: Create and edit files
navTitle: Create and edit
description: Make new files and folders in the web app, edit markdown, code and HTML, and save your changes.
type: how-to
position: 2
updated: 2026-09-29
related:
  - /docs/files/front-matter
  - /docs/files/conflicted-copies
  - /docs/files/version-history
---

::callout{type="note"}
Saving is manual. Nothing you type is stored until you select **Save** or press **⌘S** (**Ctrl+S** on Windows and Linux).
::

## Where new files and folders go

New files, new folders and uploads land in the folder you're working in:

- the selected folder, if you've selected one;
- otherwise the folder of the file that's open;
- otherwise the workspace root.

To aim at the root, select the first row of the tree, the one with the workspace's name.

## Create a file

1. Select **+** next to the search box at the top of the sidebar, then **New file**. To create it in a particular folder instead, hover over that folder and select **New file in this folder** (the plus icon), or choose **New file here** from its row menu.
2. Type a name in the row that appears, such as `meeting-notes`. The placeholder reads `name.md`.
3. Press **Enter**. Press **Esc** to cancel.

A name without an extension becomes a markdown file, so `meeting-notes` is saved as `meeting-notes.md`. Any extension you type is kept as it is. The new file opens straight in the editor.

If you see "A file with that name already exists.", pick another name. Names can't contain `/`.

## Create a folder

1. Select **+** next to the search box, then **New folder**.
2. Enter a name when asked for the **New folder name**.

An empty folder holds a hidden `.keep` file so that it exists on disk too. The web app hides it, and you'll only notice it in a synced folder.

## Edit a file

Markdown, plain text, code and HTML files can be edited. Images and other files can't.

1. Open the file and select **Edit** in the top bar.
2. Make your changes. A small dot next to the file name means there are unsaved changes.
3. Select **Save**, or press **⌘S** / **Ctrl+S**.
4. Select **Done** to go back to reading.

If you select **Done**, open another file or leave the page with unsaved changes, you're asked **Discard unsaved changes?** Cancel to stay in the editor.

Every save makes a new version, so you can always go back. See [version history](/docs/files/version-history).

### The markdown editor

Markdown opens in **Rendered** mode, where you edit the formatted document directly. Switch to **Source** to edit the raw markdown, including the front matter.

![The markdown editor in Rendered mode, with the Rendered and Source switch and the formatting toolbar across the top](/docs/images/markdown-editor.webp)

The toolbar has **Bold**, **Italic**, **Strikethrough**, **Inline code**, **Heading 1** to **Heading 3**, **Bullet list**, **Numbered list**, **Quote**, **Divider** and **Link**, plus a button to comment on the selected text.

If the file has front matter, a collapsed **Metadata** form sits above the document. Expand it to change existing values without touching YAML. To add or remove fields, or change nested values, use **Source**. [Front matter reference](/docs/files/front-matter) lists the keys Treehouse understands.

### Code and HTML

Text, code and HTML files open in a code editor with syntax highlighting. **⌘S** / **Ctrl+S** saves from here too.

## If the file changes while you're editing

Someone else, or an agent, might change the file while you have it open. Treehouse never quietly overwrites either version.

- **"This file was changed on the server while you were editing."** Select **Reload** to load the latest version (your unsaved changes are discarded, after a warning), or **Dismiss** to keep editing.
- **"This file changed on the server, so your save was kept as a copy: …"** Your save arrived after someone else's. Your version is safe in the copy named in the message, and the original holds theirs. Select **Reload latest** to see their version, then combine the two. See [conflicted copies](/docs/files/conflicted-copies).

If the file was deleted while you were editing, saving brings it back.

## Troubleshooting

### Why are New file and New folder greyed out?

The workspace is read-only because its subscription has lapsed. The banner at the top of the page explains what to do. You can still read and download everything. See [plans and limits](/docs/account/plans-and-limits).