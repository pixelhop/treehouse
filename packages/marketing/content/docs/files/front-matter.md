---
title: Front matter reference
navTitle: Front matter
description: The YAML block at the top of a markdown file, and the keys Treehouse reads from it to label, title, schedule and track your files.
type: reference
position: 7
updated: 2026-10-30
related:
  - /docs/files/folder-pages
  - /docs/files/boards
  - /docs/files/create-and-edit
  - /docs/files/tag-notes
  - /docs/playbooks/routines
---

## Keys Treehouse understands

| Key           | Where it goes                        | Value                   | What it does                                                                                                        |
| ------------- | ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `title`       | A folder's `README.md` or `index.md` | Text                    | Replaces the folder's name as the heading of its **Files**, **Calendar** and **Board** views.                       |
| `title`       | Any markdown note                    | Text                    | Labels the note on its folder's calendar or board instead of its file name.                                         |
| `view`        | A folder's `README.md` or `index.md` | `calendar` or `board`   | Opens the folder on its calendar (as long as it has dated notes) or its board.                                      |
| `columns`     | A folder's `README.md` or `index.md` | A list                  | The board's columns, in order. An entry is a name, or `{ name, color }` for a coloured column.                      |
| `card_fields` | A folder's `README.md` or `index.md` | A list                  | Which other keys show as chips on the board's cards. An entry is a key, or `{ name, colors }` to colour its values. |
| `date`        | Any markdown note                    | `YYYY-MM-DD`            | Places the note on its folder's calendar. Dragging it to another day rewrites this value.                           |
| `status`      | Any markdown note                    | Text                    | The note's column on its folder's board. Moving the card rewrites this value.                                       |
| `order`       | Any markdown note                    | A number                | The card's place within its board column, lowest first. Dragging within a column rewrites this value.               |
| `due`         | Any markdown note                    | `YYYY-MM-DD`            | A due date on the note's board card.                                                                                |
| `tags`        | Any markdown note                    | Text, or a list of text | The note's [tags](/docs/files/tag-notes): search for them with `#` in the sidebar. Also labels on its board card.   |
| `assignee`    | Any markdown note                    | A name, or a list       | Who the board card is for. A workspace member's name shows their avatar.                                            |

[Turn a folder into a page or calendar](/docs/files/folder-pages) and [track work on a board](/docs/files/boards) show these keys at work.

## What front matter is

Front matter is a block of YAML at the very top of a markdown file, between two lines of three dashes. It holds facts about the document, separate from the text itself:

```markdown [plans/q4-roadmap.md]
---
title: Q4 roadmap
date: 2026-10-01
status: draft
tags: [planning, product]
---

The roadmap starts here.
```

The block must be the first thing in the file. Treehouse reads it only from markdown files.

## Other keys

You can add any other keys you like. Treehouse keeps them exactly as written and shows them in the file's **Metadata**, but gives them no special meaning. Nothing in the app filters, sorts or acts on `owner`, `priority` or anything else outside the table above.

That still makes them useful. Agents read front matter well, so a small shared vocabulary is a good way to tell them things. A common pattern is `status: draft` on work that isn't ready and `status: ready` once it is, with a line in your `AGENTS.md` saying what each value means. Because `status` is also what a [board](/docs/files/boards) sorts cards by, a folder that uses it can be viewed as one: its **Board** tab shows each value as a column. The [routines playbook](/docs/playbooks/routines) shows where conventions like this fit.

## Where you see it in the app

- **Reading a file:** a collapsed **Metadata** card above the document, showing a couple of values and the number of fields. Select it to see them all.
- **The Info tab:** the details panel lists every field under **Metadata**.
- **Editing:** a **Metadata** form above the document lets you change existing values. True or false values are checkboxes, and lists have an **Add…** box for new items. To add or remove a key, or change a nested value, switch the editor to **Source** and edit the YAML directly.

If the YAML can't be parsed, the editor says so and offers to open **Source** so you can fix it.

## How agents set it

There's no separate metadata API. Front matter is part of the file, so an agent sets it by writing the file with the block at the top, and changes it the same way. Everyone sees the change as a new version of the file, with the usual [history](/docs/files/version-history).

::callout{type="agent"}
When you change a markdown file, keep its front matter block intact and at the very top. Write dates as `YYYY-MM-DD`. Don't invent new meanings for the keys in the table above (`title`, `view`, `columns`, `card_fields`, `date`, `status`, `order`, `due`, `tags` and `assignee`): the app acts on them.
::