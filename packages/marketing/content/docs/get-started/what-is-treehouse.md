---
title: What is Treehouse?
navTitle: What is Treehouse?
description: A shared workspace of plain files that people and agents both work in, with the sharing, history and review that plain folders lack.
type: concept
position: 1
updated: 2026-09-29
related:
  - /docs/get-started/quickstart
  - /docs/get-started/how-treehouse-works
  - /docs/agents/connect/how-agents-work
---

Agents are good at working with files. They read folders, grep for what they need, write markdown and move things around. Teams are good at working together: sharing, reviewing, keeping track of who changed what. Until now you had to choose. A folder on your laptop is great for an agent but hard to share. A wiki or a doc tool is great for sharing but gives an agent a clumsy API to fight.

Treehouse is both. A workspace is a set of plain files and folders, the same kind your agents already know how to use, with the things a team needs built around them.

![A Treehouse workspace in the web app, with the file tree on the left and a folder's README shown as its front page](/docs/images/workspace-overview.webp)

## One workspace, three ways in

Everyone works on the same files, each in the way that suits them:

- **The web app** at [app.trytree.house](https://app.trytree.house), for reading, writing, commenting and sharing from any browser.
- **A synced folder** on your computer, kept in step by the [desktop app](/docs/desktop) or the [sync CLI](/docs/desktop/sync-with-the-cli). Anything on your machine can use it, including coding agents like Claude Code.
- **The MCP server and REST API**, for agents that don't have your filesystem. [Connecting one](/docs/agents/connect/claude-code) takes a single command.

A change made in any of them shows up in the others within seconds.

## What Treehouse adds to a folder

- **Nothing is lost.** Every file keeps its full history, and any version can be [restored](/docs/files/version-history). When two people (or a person and an agent) edit the same file at once, both versions are kept as a [conflicted copy](/docs/files/conflicted-copies) rather than one silently overwriting the other.
- **You can see who did what.** The [activity feed](/docs/sharing/activity) shows every change, and marks which came from a person and which from an agent.
- **Sharing is built in.** [Invite](/docs/sharing/invite-people) teammates into a workspace, or [share a link](/docs/sharing/share-links) to one file or folder with anyone, with an optional password.
- **Review happens in place.** Select text in a markdown file and [comment](/docs/sharing/comments) on it. Agents can read those comments, make the changes and reply.
- **Folders become pages.** A folder's `README.md` is shown as its [front page](/docs/files/folder-pages), and a folder of dated notes can open as a calendar.

## What Treehouse is not

Treehouse is where your team's work lives, not the thing that does the work. It doesn't run agents, call AI models or run anything on a schedule. You bring the agents (Claude Code, Codex, Cursor or anything that can use files or MCP) and point them at your workspace. The [playbooks](/docs/playbooks) show how to set that up so they're genuinely useful.

## Next steps

- [Quickstart](/docs/get-started/quickstart): make a workspace and connect your first agent.
- [How Treehouse works](/docs/get-started/how-treehouse-works): versions, conflicted copies and attribution in a few minutes.