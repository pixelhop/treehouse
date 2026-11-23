---
title: How agents work with Treehouse
navTitle: How agents work
description: The two ways an agent can reach a workspace, what it can do there, and how its work shows up for everyone else.
type: concept
position: 1
updated: 2026-10-29
related:
  - /docs/agents/connect/claude-code
  - /docs/agents/connect/connected-agents
  - /docs/agents/connect/api-keys
  - /docs/agents/handbook
---

An agent in Treehouse is a teammate with access to the workspace. It reads the same files you do, writes new ones, reorganises folders and answers review comments. Everything it does is versioned, so a bad edit is one restore away, and a clash with someone else's edit leaves a [conflicted copy](/docs/files/conflicted-copies) rather than lost work.

## Two ways in

|                         | Through a synced folder                                                                                                                    | Through the MCP server                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **How**                 | The agent works on a folder on your computer that the [desktop app](/docs/desktop) or [CLI](/docs/desktop/sync-with-the-cli) keeps in sync | The agent connects to `https://api.trytree.house/api/mcp` and signs in through your browser, or uses an [API key](/docs/agents/connect/api-keys) |
| **Good for**            | Coding agents with file access: Claude Code, Codex, Cursor, Aider                                                                          | Agents without your filesystem, agents running elsewhere, and anything that needs comments                                                       |
| **Setup**               | Open the agent in the folder                                                                                                               | One command or config entry, [per client](/docs/agents/connect/other-agents)                                                                     |
| **Its changes show as** | Yours, because they sync through your device                                                                                               | The agent's, labelled with the name you gave the connection                                                                                      |
| **Comments**            | Not visible (comments aren't files)                                                                                                        | Read, reply and resolve                                                                                                                          |
| **Creates share links** | No                                                                                                                                         | Member links only                                                                                                                                |

You can use both. A common set-up is Claude Code working in the synced folder for heavy editing, with the Treehouse MCP server also connected so it can pick up review comments.

::callout{type="tip" title="Want to see what your agent changed?"}
Connect it over MCP. Its changes then appear in the [activity feed](/docs/sharing/activity) in the agent colour, grouped under the name you gave it, instead of blending in with your own edits.
::

## Signing in over MCP

Most MCP clients sign in through your browser. You add the server URL, the client opens Treehouse, you sign in and approve it, and you give the connection a name. That name labels everything it does. The connection acts as you, as an agent, in every workspace you belong to, and keeps itself signed in until you [disconnect it](/docs/agents/connect/connected-agents).

An agent that can't open a browser, such as one on a server or in CI, connects with an [API key](/docs/agents/connect/api-keys) in a header instead. The sync CLI uses keys too.

## What an agent can do over MCP

The MCP server gives an agent the same abilities you have in the web app, apart from a few that deliberately need a person:

- **Files**: list, search by name, read, write, move and delete, including binary files like images and PDFs.
- **History**: read any earlier version of a file and restore it.
- **Organisation**: set file and folder icons, and mark things private.
- **Comments**: list review threads, reply, resolve them, and start new ones.
- **Sharing**: create and revoke member links.
- **Workspaces**: list your workspaces and create new ones (not with a workspace-scoped key).

What it can't do: create public or password-protected links (those need a person signed in to the web app), invite or remove members, manage API keys or connections, or change billing. The [MCP server reference](/docs/agents/reference/mcp-server) lists every tool.

## How agents know what to do

Two plain files carry a workspace's instructions:

- **`AGENTS.md`** at the workspace root is its rulebook: how it's organised, what goes where, what an agent may and may not do. The Treehouse MCP server tells every agent to read it first, and coding agents look for it by convention. Claude's tools read `CLAUDE.md` instead, so a workspace set up by an agent also has a `CLAUDE.md` containing `@AGENTS.md`, which imports the same rules. [Write your AGENTS.md](/docs/playbooks/write-your-agents-md) shows what to put in it.
- **A `README.md` in each folder** says what belongs in that folder. It's also the folder's [front page](/docs/files/folder-pages) in the web app, so people and agents read the same description.

Agents that support skills can also load the Treehouse [agent skill](/.well-known/agent-skills/treehouse/SKILL.md), which teaches the general rules of working in any Treehouse workspace. The [agent handbook](/docs/agents/handbook) is the same material as a docs page.

## What Treehouse doesn't do

Treehouse doesn't run agents. It has no scheduler, no model and no background jobs of its own. If you want an agent to process an inbox every morning, the schedule lives wherever the agent runs: a Claude Code routine, a cron job, a cloud agent. [Routines](/docs/playbooks/routines) shows a few ways to set that up.