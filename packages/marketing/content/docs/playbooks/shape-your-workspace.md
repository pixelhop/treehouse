---
title: Shape your workspace
description: Folder structures that work for people and agents alike, and the handful of habits that keep a workspace easy to navigate as it grows.
type: guide
position: 2
updated: 2026-10-29
related:
  - /docs/playbooks/write-your-agents-md
  - /docs/files/folder-pages
  - /docs/files/organise-files
---

An agent finds its way around a workspace the same way a new teammate does: by reading folder names, opening READMEs and following links. A structure that's easy for one is easy for the other. These are the habits that make the difference.

## Start small, with an Inbox

Begin with four or five top-level folders you'll actually use, plus an **Inbox**. You can always add more; empty folders just teach everyone to ignore the structure. Good starting points:

| Workspace              | Top-level folders                                              |
| ---------------------- | -------------------------------------------------------------- |
| Company knowledge base | Inbox, Brand, Product, People, Customers, Operations, Meetings |
| Personal second brain  | Inbox, Notes, Projects, Areas, Resources, Journal              |
| Client work            | Inbox, Clients, Proposals, Templates                           |
| A single project       | Inbox, Docs, Decisions, Research, Meetings                     |

These are the templates an agent offers when it [sets up a workspace](/docs/get-started/set-up-with-an-agent). The Inbox is the one to keep, whatever else you cut: it's where anything goes when nobody has time to decide where it belongs. [Run an inbox your agent files](/docs/playbooks/inbox-and-filing) shows how to keep it from filling up.

## Give every thing one home

The most useful rule for a shared workspace is that each kind of thing lives in exactly one place. A spec lives in Specs/, not also in the meeting notes where it was discussed; the notes link to it. When there's one home, an agent looking for "the pricing spec" finds one file, not three versions of it.

Use links rather than copies. Relative links work in the web app, so `[pricing spec](../Specs/pricing/README.md)` from a meeting note takes you straight there.

## A README in every folder

A folder's `README.md` is its [front page](/docs/files/folder-pages) in the web app, and the first thing an agent reads there. Write a real paragraph: what belongs in the folder, what doesn't, how files are named. Give it a `title:` in its front matter and that becomes the folder's heading.

For a folder with a lot going on, the README can be a proper overview: a status table, links to the most important files, who owns what. It's a page people will actually read, because it's the first thing they see.

## Name things so they sort

- **Dates first, in ISO format**: `2026-09-29-launch-review.md`. They sort in order, and agents parse them without guessing.
- **Lowercase and hyphens** for files: `pricing-page-copy.md`. Folder names can be friendlier, like `Customer research`.
- **Say what it is**: `acme-proposal-v2.md` beats `proposal-final-FINAL.md`. Version numbers in names aren't needed at all; Treehouse keeps [every version](/docs/files/version-history) for you.

## Turn dated folders into calendars

Meetings, journal entries, decisions and content plans are naturally dated. Give each file a `date:` in its front matter and put `view: calendar` in the folder's README, and the folder opens as a month calendar in the web app:

```markdown [Meetings/README.md]
---
title: Meetings
view: calendar
---

Notes from every meeting, one file each. Set `date:` to the day it happened.
```

Drag an entry to another day and Treehouse rewrites its `date:` for you. [Folder pages and calendars](/docs/files/folder-pages) has the rules.

## Track work in progress on a board

A roadmap, a content pipeline or a hiring loop is work moving through stages. Make it a folder with one file per piece of work, give each a `status:`, and put `view: board` in the README with the stages in order:

```markdown [Roadmap/README.md]
---
title: Roadmap
view: board
columns: [Backlog, Doing, Review, Done]
---

One file per piece of work. `status:` says where it's up to.
```

Drag a card to another column and Treehouse rewrites its `status:`. An agent moves work the same way, by changing that one line. [Track work on a board](/docs/files/boards) has the rest.

## Keep an Archive

Deleting in a shared workspace is risky: a deleted file can be brought back from the [trash](/docs/files/trash), but only once someone notices it's gone, and the thing you delete might be what someone else's agent was about to read. Keep an `Archive/` folder and move retired files there instead. Tell your agents to do the same in [AGENTS.md](/docs/playbooks/write-your-agents-md).

## Keep private work private

Anything you want to keep to yourself, such as drafts, personal notes or an agent's scratch space, can live in a folder you [make private](/docs/files/private-files). Only you and your own keys can see it; everyone else's agents can't. It's a good place for an agent to work on something before it's ready to share.

## Let the structure grow

Revisit the structure every month or so, or ask an agent to: "Look at how we've actually been using this workspace. Suggest changes to the folder structure and AGENTS.md, but don't make them yet." Folders that stay empty can go. Folders that keep overflowing want splitting.