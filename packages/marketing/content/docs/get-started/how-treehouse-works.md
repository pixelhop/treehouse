---
title: How Treehouse works
description: Workspaces, versions, conflicted copies and attribution - the handful of ideas the rest of Treehouse is built on.
type: concept
position: 3
updated: 2026-10-29
related:
  - /docs/files/version-history
  - /docs/files/conflicted-copies
  - /docs/agents/connect/how-agents-work
  - /docs/agents/handbook/versions-and-conflicts
---

## Workspaces

A **workspace** is a set of files and folders with its own members. Everything in Treehouse happens inside one: your files, the people you've invited, the agents you've connected, and the history of every change.

Members see the whole workspace, apart from files someone has made [private](/docs/files/private-files). Joining one workspace gives you that workspace and nothing else, so you can keep a personal workspace and a client workspace side by side without either seeing the other. Switch between them from the workspace switcher at the top of the sidebar.

## Everything is a plain file

A Treehouse file is exactly what you'd have on disk: a markdown note, an HTML page, a spreadsheet export, an image. There's no special document format and no block editor underneath. That's what lets an agent work on a workspace with the same tools it uses for any folder, and what lets the [desktop app](/docs/desktop) mirror it to your computer byte for byte.

Where the app does something special, it's driven by conventions in the files themselves. A folder's `README.md` becomes its [front page](/docs/files/folder-pages). A `date:` line at the top of a markdown file puts it on a calendar. Anyone, human or agent, can use those conventions just by writing the file.

## Every change is a new version

Each file has a version number that goes up by one every time it's saved. Earlier versions are kept, so you can look at any of them and [restore](/docs/files/version-history) one if a change goes wrong. Restoring doesn't erase anything either: it saves the old content as a new version on top.

## Nobody's work is lost

When someone saves a file, Treehouse checks that it's saving on top of the latest version. If somebody else saved in the meantime, the second save doesn't overwrite the first. It's kept alongside it as a **conflicted copy**, named so you can see whose it was and when:

```text
Launch plan (conflicted copy — agent — 2026-09-29T14:15:00.000Z).md
```

You then compare the two and merge them. The same rule covers deletes: an edit always beats a stale delete, so a file someone was still working on comes back instead of vanishing. [Conflicted copies](/docs/files/conflicted-copies) explains how to resolve one.

This matters most when agents are involved. An agent can make a lot of edits quickly, and it can't see that you've got the same file open. The version check means the worst case is a second file to tidy up, never lost work.

## People and agents

Every change in a workspace is attributed. Changes you make in the web app are yours. Changes an agent makes over MCP are labelled with the name you gave it when you connected it, and marked as an agent's. Changes made with an API key are labelled with the key's name and marked as coming from a person or an agent, depending on how the key was set up. The [activity feed](/docs/sharing/activity) shows them side by side, in different colours, so you can see at a glance what your agents have been doing.

Agents reach a workspace in one of two ways:

- **Through a synced folder.** The agent works on files on your computer, and your desktop app or CLI syncs them. Its changes arrive as yours.
- **Through the MCP server or REST API.** Over MCP it signs in through your browser and you give it a name; the REST API, and agents that can't open a browser, use an [API key](/docs/agents/connect/api-keys). Its changes are labelled as the agent's.

[How agents work with Treehouse](/docs/agents/connect/how-agents-work) compares the two.

## Sharing and review

There are two kinds of access to a workspace:

- **Members** are the people you've [invited](/docs/sharing/invite-people). They can read and change everything that isn't private.
- **Share links** give read-only access to one file or folder. A member link only works for people who are already members; a public link works for anyone who has it, optionally with a password. [Share links](/docs/sharing/share-links) covers both.

[Comments](/docs/sharing/comments) are the one thing that isn't a file. They're review threads attached to the text they're about, and they follow that text as the file changes. Agents read and answer them through the MCP server.

## Your files are encrypted at rest

Each workspace's files are encrypted with that workspace's own key before they're stored. [Security and privacy](/docs/account/security-and-privacy) explains what that protects against.