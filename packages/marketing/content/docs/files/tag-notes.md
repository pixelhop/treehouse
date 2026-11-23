---
title: Tag notes
navTitle: Tag notes
description: Label notes with tags in their front matter or text, and find every note with a tag from the sidebar search.
type: how-to
position: 16
updated: 2026-10-30
related:
  - /docs/files/front-matter
  - /docs/files/link-notes
  - /docs/files/private-files
  - /docs/agents/reference/mcp-server
---

Tags group notes across folders. A note can carry any number, and they're written in the note itself, so they travel with it: an Obsidian vault you sync into Treehouse keeps its tags.

## Add a tag

Write it in the note's text, or list it in the note's [front matter](/docs/files/front-matter). Both count the same.

```markdown [projects/launch.md]
---
tags: [planning, product]
---

Ship the beta by Friday. #launch/beta
```

That note has three tags: `planning`, `product` and `launch/beta`.

- **In the text**, a tag is `#` and a word, written after a space or at the start of a line: `#planning`. It can hold letters, numbers, `-`, `_` and `/`, but not only numbers (`#2026` isn't a tag).
- **In front matter**, `tags:` takes a list (`tags: [planning, product]`) or names separated by commas (`tags: planning, product`). The `#` is optional there.

Capitals don't matter: `#Planning` and `#planning` are the same tag.

A `#` in a heading (`# Title`), in the middle of a word or address (`page#section`), or inside code isn't a tag.

## Nest tags

A `/` puts one tag under another. `#launch/beta` is also filed under `#launch`, so looking for `launch` finds notes tagged `launch/beta` as well.

## Find notes by tag

Type `#` in the sidebar's search box. It shows the tags in use, each with the number of notes carrying it, and lists those notes. Keep typing to narrow it: `#pla` matches `planning` and `planning/q4`. Select a tag to show only its notes and any nested under it. To find one note among many with a tag, add part of its name after the tag: `#planning roadmap`.

Open a note to see its tags under **Tags** in the details panel's **Info** tab. Select one to search for it.

## Agents and tags

An agent connected over MCP calls `list_tags` to see the tags in use, and `list_tags` with a tag to find the notes carrying it. `get_links` on a note includes its tags. Agents add tags the same way people do, by writing them into the note. See the [MCP server reference](/docs/agents/reference/mcp-server#list_tags).

## Limits

- **Private notes stay private.** A note that's private to someone else is never listed or counted under a tag for you. See [keep files private](/docs/files/private-files).
- **Markdown only.** Tags are read from markdown files. Notes over 2 MB aren't read for tags.
- **Older notes.** In a workspace with many notes written before tags were indexed, the search says it's still indexing and the list fills in as it works.
- **Tags aren't highlighted in the text.** An inline `#tag` reads as ordinary text in the note.