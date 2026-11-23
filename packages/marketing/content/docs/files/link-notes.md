---
title: Link notes together
navTitle: Link notes
description: Connect notes with wikilinks, see which notes link to a file, and keep those links working when you rename it.
type: how-to
position: 15
updated: 2026-10-30
related:
  - /docs/files/organise-files
  - /docs/files/private-files
  - /docs/playbooks/second-brain
  - /docs/agents/reference/mcp-server
---

Notes link to each other with wikilinks: a note's name in double square brackets, such as `[[Launch plan]]`. It's the same syntax Obsidian uses, so a vault you sync into Treehouse keeps its links. Ordinary markdown links like `[the brief](../Clients/acme/brief.md)` work too, including reference-style links whose destination is written once at the bottom of the note (`[brief]: ../Clients/acme/brief.md`).

## Link to a note

1. Open a markdown file and select **Edit**.
2. Type `[[`, the name of the note, then `]]`. For example, `[[Launch plan]]`.
3. Select **Save**.

The link appears as soon as you type the closing brackets. In the reading view, select it to open the note. While editing, hold **⌘** (or **Ctrl**) and click it.

To change a link while editing, put the cursor just after it and press **Backspace**. It turns back into text so you can edit it, and becomes a link again when you type the closing `]`.

## Wikilink forms

| You write                   | Shows as             | Links to                                      |
| --------------------------- | -------------------- | --------------------------------------------- |
| `[[Launch plan]]`           | Launch plan          | The note named `Launch plan.md`               |
| `[[Launch plan\|the plan]]` | the plan             | The same note, with your own text             |
| `[[Launch plan#Budget]]`    | Launch plan > Budget | The note, at its Budget heading               |
| `[[Projects/Launch plan]]`  | Projects/Launch plan | The `Launch plan.md` inside a Projects folder |
| `[[diagram.png]]`           | diagram.png          | Any file, by its full name                    |
| `![[diagram.png]]`          | diagram.png          | Shown as a link; embedding isn't supported    |

A link names a file, not a path:

- Capitals don't matter, and `.md` is optional.
- If two notes share a name, add as much of the folder as it takes to tell them apart: `[[Clients/Acme/Notes]]`. Otherwise the link goes to the one nearest the top of the workspace.
- A link to a note that doesn't exist yet is shown greyed out with a dotted underline. It starts working as soon as someone creates that note.

Links inside inline code, code blocks, raw HTML and front matter are left as text, including code nested in a list or a quote.

## See what links to a file

Open the file and look at **Linked from** in the details panel's **Info** tab. It lists every note that links to the file, by wikilink or by markdown link. Select one to open it.

If nothing links there yet, the panel shows the wikilink to use. In a workspace with many older notes, the list may first say **Still indexing older notes** and fill in as you use it.

## Rename without breaking links

When you rename or move a single file in the sidebar, Treehouse updates the notes that link to it so they point at the new name. Aliases, headings and the rest of each note are kept exactly as they were. Each updated note gets a new version, credited to you in the [activity feed](/docs/sharing/activity).

Moving a file to another folder without changing its name usually needs no changes at all, because a wikilink finds a note by name wherever it lives. The moved note's own relative markdown links are updated so they still reach the same files.

If a note changes at the same moment and can't be updated, you'll see a message listing the notes that may still point at the old name. Open them and fix the links by hand. The same happens when the new name can't be written as a wikilink: a name containing `#`, `|` or square brackets would read as a heading, an alias or the end of the link, so those links are left alone and listed. Notes Treehouse couldn't check for links, because they're too large or couldn't be read, are listed too.

In a workspace with many notes written before linking was available, the first rename can say **Nothing was renamed yet**. Treehouse is still working out which notes link where, so it doesn't rename a file and miss a link. Try again after a few seconds.

## Agents and links

Agents use the same links. An agent connected over MCP can call `get_links` on a file to see which notes link to it and where each of its own links leads, and `move_file` updates links the same way the sidebar does. See the [MCP server reference](/docs/agents/reference/mcp-server#get_links).

## Limits

- **Private notes stay private.** A note that's private to someone else never appears in your **Linked from** list, and links are resolved using only the files you can see. See [keep files private](/docs/files/private-files).
- **Renaming updates only what you can edit.** Another member's private notes that link to the file aren't changed, so their links to the old name stop working.
- **A private file's name stays private.** Renaming your private file doesn't update notes other people can read, because that would show them its new name. They're listed for you to fix by hand.
- **Very large notes aren't checked.** A note over 2 MB or 100,000 lines isn't scanned for links, so it doesn't appear under **Linked from**, and a rename lists it as a note that may still point at the old name.
- **Folder moves don't update links.** Wikilinks to the notes inside still work, since the notes keep their names. Links that spell out the old folder, like `[[Old folder/Note]]`, and relative links from outside the folder need fixing by hand.
- **Synced folders.** Renaming a file on your computer doesn't update links on the server. If you use Obsidian, its own setting to update links on rename does this, and the edits sync like any other change.
- **No embedding or graph view yet.** `![[file]]` shows as a link rather than the file's contents.