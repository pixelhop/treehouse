---
title: Find and view files
navTitle: Find and view
description: Browse the file tree, search by name, and see how Treehouse shows markdown, HTML, code, images, video, audio and everything else.
type: how-to
position: 1
updated: 2026-10-29
related:
  - /docs/files/create-and-edit
  - /docs/files/folder-pages
  - /docs/files/version-history
---

## Browse the tree

The sidebar shows every file and folder you can see in the workspace. Select a folder's arrow to expand it, or its name to open it. The first row, **Files** with a house icon, is the workspace root: select it to make new files, folders and uploads land at the top level.

When you open a file, the tree expands its folders and scrolls to it, and the file's row is highlighted. If you've scrolled away or collapsed its folders since, select the file's name at the end of the breadcrumb in the top bar, or select the **⋯** next to the search box and choose **Reveal open file**. On a phone, selecting the name in the breadcrumb also opens the sidebar.

To open or close every folder at once, select the **⋯** next to the search box and choose **Expand all** or **Collapse all**.

### Show hidden files

Files and folders whose names start with a dot, such as `.claude` or `.obsidian`, are usually settings that apps and agents keep for themselves, so the sidebar and folder listings hide them. To see them, select the **⋯** next to the search box and choose **Show hidden files**. Choose it again to hide them. Like the sort order, this only changes your own view, in this browser, and hidden files are still synced and readable by agents.

### Sort the tree

The same **⋯** menu has **Sort by**:

- **Custom order** (the default) is the order saved for everyone in the workspace. See [reorder](/docs/files/organise-files#reorder).
- **Name** sorts A to Z.
- **Recently modified** puts the most recently changed files first, and orders folders by the newest file inside them.

Folders always come before files. Your choice only changes your own view, in this browser. While the tree is sorted by name or date you can still drag things into folders, but not reorder them.

### Spot what's new

A dot at the end of a row marks a file that someone else, or an agent, changed in the last 7 days and you haven't opened since. A collapsed folder shows a dot when something inside it is new, so you can follow the dots down to the file. Opening the file clears its dot. Your own edits never get one, but an agent's do, even when it works with your key.

### Open files in tabs

To keep several files open, hold **⌘** (Mac) or **Ctrl** and select a file in the sidebar, a search result or a link: it opens in a new tab behind the current one. Add **Shift** to switch to it straight away. A middle click does the same, and every row's menu has **Open in new tab**. The tab row appears once a second tab is open.

| Shortcut              | What it does                    |
| --------------------- | ------------------------------- |
| **⌥T**                | New tab                         |
| **⌥W**                | Close the tab                   |
| **⌥⇧[** / **⌥⇧]**     | Previous / next tab             |
| **⌥1**–**⌥8**, **⌥9** | Go to that tab, or the last one |

In the Mac app, **⌘T**, **⌘⇧[** / **⌘⇧]**, **Ctrl-Tab** and **⌘1**–**⌘9** work too. Tabs are on by default on a wide screen. To turn them off, open the account menu at the bottom of the sidebar and switch off **Tabs**.

## Browse a folder

Open a folder to see what's in it as a table: **Name**, **Modified**, **Created**, **Size** and **Modified by**. Narrow screens show only the name and when it was modified. A folder's row shows the newest change inside it, its earliest created date and its total size.

Select a column heading to sort by it, and select it again to reverse it. A third time goes back to the folder's own order. The sort you pick applies to every folder until you change it.

**Modified by** names whoever made the latest change to the file: **You**, another member, or the agent's name.

## Search for a file

1. Select **Search files…** at the top of the sidebar and start typing.
2. Use **↑** and **↓** to move through the results.
3. Press **Enter** to open the highlighted file or folder, or select it.
4. Press **Esc** to clear the search and go back to the tree.

Search matches file and folder names and paths, not what's inside files. Opening a result also reveals it in the tree, where you can rename, move or delete it. If there are too many matches, the list tells you to narrow your search.

## How each kind of file is shown

| File                                                                                                              | What you see                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown (`.md`, `.markdown`)                                                                                     | Rendered as a document. Front matter appears as a collapsed **Metadata** card above it.                                                                       |
| HTML (`.html`, `.htm`)                                                                                            | Rendered full width in a sandbox, with scripts off. See [publish an HTML page](/docs/files/html-pages).                                                       |
| Text and code (`.txt`, `.json`, `.yaml`, `.csv`, `.css`, `.js`, `.ts`, `.vue`, `.py`, `.sh` and other text files) | Shown with syntax highlighting, with long lines wrapped. JSON saved on a single line is laid out with indentation for reading; the file itself isn't changed. |
| Images (PNG, JPEG, GIF, WebP, SVG)                                                                                | Shown inline.                                                                                                                                                 |
| Video (`.mp4`, `.m4v`, `.webm`, `.mov`, `.ogv`)                                                                   | Played in the page. You can jump anywhere without waiting for the whole file to download.                                                                     |
| Audio (`.mp3`, `.m4a`, `.aac`, `.wav`, `.flac`, `.ogg`, `.oga`, `.opus`)                                          | Played in the page, on a card with the file's name and size.                                                                                                  |
| Anything else, including PDFs                                                                                     | A card with the file's name, size, "not previewable" and a **Download** button. There's no PDF viewer yet.                                                    |

Video and audio play in your browser's own player, so what plays depends on the browser. If a file won't play, you see the download card with "this browser couldn't play this video" (or audio) instead. If the browser can play a video's sound but not its picture, which happens with some `.mov` files outside Safari, the sound plays on its own with a note and a link to download the file.

## The top bar

The top bar shows where you are as a breadcrumb, with the controls for the open file on the right.

- **Reading**, **Source** and **Changes** switch between views of a file. **Source** shows the raw markdown or HTML. **Changes** appears on a markdown file that has changed since you last opened it; see [version history](/docs/files/version-history#see-what-changed-since-you-last-looked).
- **Edit** opens the file in the editor. See [create and edit files](/docs/files/create-and-edit).
- The **⋯** menu holds **Refresh**, **Download** and **Copy path**. On a folder with a front page it also has **Open file**, and on an HTML page with scripts it has **Run scripts**.
- The panel icons at either end are **Hide sidebar** / **Show sidebar** on the left and **Hide details** / **Show details** on the right.

On a phone, the view switcher moves into the **⋯** menu.

## The details panel

**Show details** opens a panel on the right with four tabs along its top: **Info**, **History** (with a count of versions), **Comments** (markdown files only) and **Share**. The tab you're on shows its name; the others show as icons.

![A markdown file open in the web app, with the Info tab of the details panel showing who last edited it, its front matter and the notes that link to it](/docs/images/file-info.webp)

The **Info** tab shows:

- Who last edited the file and when, with its version (for example `v4`).
- **Copy path** and **Download**, as two icon buttons beside that line.
- The file's front matter under **Metadata**, for markdown files.
- **File details**, which opens to show the **Path**, **Type** and size, **Dimensions** for images, **Length** in words and lines for text files, and when the file was **Created** and by whom.

With a folder selected, the panel shows how many folders and files it holds, with **Copy path**, **Restore to an earlier time…** and the folder's sharing. With nothing selected, it shows the workspace's details.

## Links between files

Relative links and images in markdown and HTML files resolve from the file's own folder, the same way they would on disk. In `projects/acme/README.md`, `![Plan](plan.png)` shows `projects/acme/plan.png`, and `[Notes](../notes.md)` opens `projects/notes.md`. A link starting with `/` resolves from the workspace root. Selecting a link to another file opens it in the app.

The files themselves are never rewritten, so the same links keep working in a synced folder and for agents.