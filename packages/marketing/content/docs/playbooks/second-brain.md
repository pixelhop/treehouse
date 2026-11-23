---
title: Build a second brain
description: A personal workspace where you capture everything quickly and an agent keeps it filed, linked and useful.
type: guide
position: 9
updated: 2026-10-30
related:
  - /docs/playbooks/inbox-and-filing
  - /docs/playbooks/routines
  - /docs/files/folder-pages
---

A second brain is a personal workspace for everything you want to remember: notes, ideas, reading, projects, a journal. The hard part has always been the upkeep. With an agent doing the filing, linking and summarising, you only have to do the easy part: capture.

Already keep your notes in Obsidian? You can [keep it and add Treehouse](/compare/obsidian), and there's a guide to [running Obsidian and Claude Code as a team](/guides/obsidian-and-claude-code-for-teams).

## 1. Start with a simple structure

```text
Inbox/       everything lands here first
Notes/       durable notes, one idea per file
Projects/    things with an end date
Areas/       ongoing responsibilities: health, money, the house
Resources/   reference material and reading notes
Journal/     one file a day, opens as a calendar
```

This is the personal template an agent offers when it [sets up a workspace](/docs/get-started/set-up-with-an-agent). Give each folder a README that says what goes in it, and make `Journal/` a [calendar](/docs/files/folder-pages) with `view: calendar` in its README.

## 2. Capture anywhere, sort never

Put everything in `Inbox/` and don't think about where it belongs:

- **On your computer**, save files straight into the `Inbox` folder of your [synced folder](/docs/desktop).
- **On your phone**, open the web app (you can add it to your home screen) and create a note with **New file** in the Inbox.
- **In a conversation with an agent**, finish with "save the useful bits of this to my Inbox".

## 3. Let an agent keep it tidy

Write your filing rules in `Inbox/README.md` (see [run an inbox your agent files](/docs/playbooks/inbox-and-filing)), then have an agent process the Inbox daily or weekly. Ask it to do a little more than file:

```markdown [Inbox/README.md]
## When filing

- One idea per note in Notes/. Split notes that cover several.
- Add a "Related" list of [[wikilinks]] to existing notes on the same topic.
- Anything with a deadline goes to the relevant project's README under "Next".
- Reading notes go in Resources/ with the source link in the front matter.
```

Over time the links matter more than the folders. An agent that adds them as it files turns a pile of notes into something you can follow from one idea to the next. Each note's **Linked from** list shows the other direction, and an agent can follow both with `get_links`. See [link notes together](/docs/files/link-notes). Tags cut across folders the other way: `#reading` or `#project/alpha` on a note, and typing `#` in the sidebar search finds every note with it. See [tag notes](/docs/files/tag-notes).

## 4. Keep a journal

A daily note is the easiest habit to keep. Create `Journal/2026-09-29.md` with `date: 2026-09-29` in its front matter, or ask an agent to start one each morning with your open projects and anything due. The calendar view shows the month's entries at a glance.

## 5. Ask your notes

The payoff is being able to ask. With the workspace connected, your agent can search and read all of it:

```text
What have I written about pricing experiments? Summarise it and link the notes.
```

```text
Read this week's journal entries and draft a weekly review in Journal/,
dated Sunday: what I got done, what I kept putting off, and what to focus on.
```

## Keep it yours

A personal workspace on the Seedling plan is just for you and your agents; nobody else can join it. If you later share a workspace with a team, keep your second brain as its own workspace, or keep personal folders [private](/docs/files/private-files).