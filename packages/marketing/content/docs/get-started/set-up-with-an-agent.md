---
title: Set up a workspace with an agent
navTitle: Set up with an agent
description: Hand a new, empty workspace to an agent. It interviews you, proposes a structure and builds it once you agree.
type: how-to
position: 4
updated: 2026-10-29
related:
  - /docs/playbooks/shape-your-workspace
  - /docs/playbooks/write-your-agents-md
  - /docs/playbooks/inbox-and-filing
---

Every new workspace comes with a setup guide for agents, in a file called `AGENTS.md` at its root. You don't have to follow it yourself: hand the workspace to an agent and it does the rest with you, including getting the workspace onto your computer if it isn't there yet.

::callout{type="info" title="Before you start"}
You need an agent that can reach the workspace. You don't need to have synced it yet:

- An agent that runs commands on your computer, such as Claude Code or Codex, installs the [desktop app](/docs/desktop/install-the-desktop-app) or the [CLI](/docs/desktop/sync-with-the-cli) for you, after asking.
- Claude Cowork, and chat apps such as claude.ai or ChatGPT, connect over [MCP](/docs/agents/connect/other-agents) instead: you add Treehouse as a connector and approve it in your browser.
  ::

## Steps

1. Open your new workspace in the web app. While a workspace is still empty (two files or fewer, and no folders), its front page and your dashboard show a card called **Let an agent set this up**.

   ![The "Let an agent set this up" card, with buttons for Claude Code, Claude Cowork, Codex and Copy prompt](/docs/images/setup-card.webp)

2. Choose your agent. **Claude Code**, **Claude Cowork** and **Codex** each open the app on this computer with the setup prompt filled in, ready for you to send. **Copy prompt** copies it, to paste into any other agent. **See the prompt** shows it first.
3. If the workspace isn't on your computer yet, the agent offers to connect it. Say yes, then do the parts only a person can:
   - With the desktop app, sign in in the window that opens and confirm where to keep the folder.
   - With the CLI, check the code on **Approve this device** matches the one the agent shows you, then select **Connect to** your workspace.
4. Answer the agent's questions. It wants to know what the workspace is for, who will read it, what you'll put in first and who else will work in it.
5. Review the folder structure it proposes. Ask for changes until it looks right. It won't create anything until you say yes.
6. Say yes. The agent creates the folders and writes a `README.md` in each one explaining what belongs there. Open the workspace in the web app to watch it fill up.
7. When you're happy, let the agent finish up. It rewrites the root `README.md` as a real front page, replaces `AGENTS.md` with the rules for this workspace, and adds a `CLAUDE.md` so Claude's tools read the same rules.
8. The agent suggests two or three things to set up next, such as a weekly sweep of your Inbox or inviting your team. Pick any you want, or none.

You can do the same thing without the card: open the synced folder in your agent and say "Read AGENTS.md and set up this workspace."

## What the agent offers

The setup guide gives the agent four starting points, which it adapts to your answers and trims to what you'll actually use:

| For                      | Starting folders                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A company knowledge base | Inbox, Brand, Product, People, Customers, Operations, Tasks, Meetings                                                 |
| A personal second brain  | Inbox, Notes, Projects, Areas, Resources, Tasks, Journal                                                              |
| Client work              | Inbox, Clients (a folder per client with Brief, Deliverables and Notes), Brand, Proposals, Templates, Tasks, Meetings |
| A single project         | Inbox, Docs, Decisions, Research, Tasks, Meetings                                                                     |

Every structure starts with an **Inbox**: somewhere to drop anything without deciding where it goes. The agent writes filing rules into `Inbox/README.md` so it (or another agent) can sort the Inbox later. [Run an inbox your agent files](/docs/playbooks/inbox-and-filing) explains how to keep it moving.

Every structure also has a **Tasks** folder that opens as a [board](/docs/files/boards), and a dated folder, Meetings or Journal, that opens as a [calendar](/docs/files/folder-pages). The agent gives each a real first entry: a few cards for your first tasks, taken from what you told it, and a note dated today recording what you decided during setup.

## Check it worked

- Every top-level folder has a `README.md` that says what it's for.
- The root `AGENTS.md` no longer reads like a setup guide. It describes _your_ workspace: its folders, naming and conventions.
- A `CLAUDE.md` at the root imports `AGENTS.md`.
- Tasks opens as a board with your first few cards, and Meetings (or Journal) opens as a calendar with today's setup note on it.

## Troubleshooting

### The card isn't showing

It only appears while the workspace has two files or fewer and no folders. Once you've added anything else, open your agent in the synced folder, or connect it over MCP, and say "Read AGENTS.md and set up this workspace" instead.

### My agent says setup has already happened

The guide tells agents to stop if the workspace already has a real structure, rather than rebuilding it. If you want a fresh start, say so explicitly, or tell the agent what you'd like changed.

### A button doesn't open anything

Each button needs its app installed on this computer: Claude Code for **Claude Code**, the Claude desktop app for **Claude Cowork**, and the Codex app for **Codex**. The buttons are also left out when the prompt is too long to pass through a link. Use **Copy prompt** and paste it into your agent yourself.

### The agent can't install the desktop app

Some agents, Claude Cowork among them, can't install software on your computer. The agent will ask you to connect it over MCP instead: add Treehouse as a custom connector with the address it gives you, then sign in and approve it in your browser. If you'd rather work from a folder, [install the desktop app](/docs/desktop/install-the-desktop-app) yourself, then share the synced folder with the agent and send the prompt again.