---
title: Quickstart
description: Create a workspace, sync it to your computer, connect an agent and let it set things up. About ten minutes.
type: guide
position: 2
updated: 2026-11-23
related:
  - /docs/get-started/set-up-with-an-agent
  - /docs/agents/connect/claude-code
  - /docs/playbooks/write-your-agents-md
---

By the end of this page you'll have a workspace, a folder on your computer that stays in sync with it, and an agent that can read and write it. Stage 2 is optional, but it's the quickest way to give an agent like Claude Code access, so it's worth doing if you're on a Mac.

## 1. Create your account

1. Go to [app.trytree.house/sign-up](https://app.trytree.house/sign-up).
2. Enter your name, email and a password (8 characters or more). Telling us how you heard about Treehouse, and ticking the box for product news, are both optional.
3. Select **Plant your treehouse**.
4. Treehouse emails you a link. Open it to confirm your address; it signs you in. The link lasts 24 hours. If it runs out, sign in and you'll be sent a new one.
5. If you're asked to **Pick a plan**, choose **Start on Seedling** to stay on the free plan. You can [upgrade](/docs/account/billing) any time.

You now have a workspace called "_Your name_'s Workspace". It already holds two files:

- `README.md`, the workspace's front page. It explains how to connect, and your agent will replace it.
- `AGENTS.md`, a setup guide written for agents. When you ask an agent to set up the workspace, this is what it follows.

To rename the workspace or give it an icon, open the workspace switcher at the top of the sidebar and choose **Customize current**.

## 2. Sync a folder to your computer

A synced folder lets you, and anything on your computer, work on the workspace as ordinary files. On an Apple silicon Mac:

1. [Download the Treehouse app](https://dl.trytree.house/desktop/latest/Treehouse-arm64.dmg) and drag it into Applications.
2. Open it, sign in, and choose the workspace.
3. Pick an empty folder, or accept the default `~/Treehouse/<workspace name>`.

Within a few seconds the folder fills with your workspace's files. From now on, changes flow both ways on their own. [Install the desktop app](/docs/desktop/install-the-desktop-app) has the details.

Syncing a folder on Windows and Linux is coming soon; use the web app there for now.

## 3. Connect an agent

Pick whichever fits your agent.

**If it can use your files** (Claude Code, Codex, Cursor and most coding agents): open it in the synced folder from stage 2. That's all. It can read and write the workspace like any project.

**If it can't, or you want its changes labelled as the agent's own**, connect it to the Treehouse MCP server. For Claude Code:

1. Run this in a terminal. There's no key to copy:

   ```bash
   claude mcp add --transport http treehouse https://api.trytree.house/api/mcp
   ```

2. Start Claude Code, run `/mcp`, choose **treehouse** and authenticate. Your browser opens.
3. Give the connection a name you'll recognise, such as `Claude Code on my laptop`, and select **Allow**.

For other clients, see [connect other agents](/docs/agents/connect/other-agents). [Connect Claude Code](/docs/agents/connect/claude-code) has the details, including how to use an API key when the agent can't open a browser. [How agents work with Treehouse](/docs/agents/connect/how-agents-work) explains the difference between the two routes.

## 4. Let your agent set up the workspace

A new workspace shows a **Let an agent set this up** card on its front page and on your dashboard.

1. Select **Claude Code** to open Claude Code with the setup prompt filled in, or **Copy prompt** to paste it into any agent.
2. Answer the agent's questions: what the workspace is for, who will read it, what goes in first.
3. Review the folder structure it proposes. It won't create anything until you say yes.
4. Once you agree, it builds the folders, writes a `README.md` in each, and replaces the starter `AGENTS.md` with rules for this workspace.

[Set up a workspace with an agent](/docs/get-started/set-up-with-an-agent) covers the prompt and the starting structures it offers.

## 5. Bring in your team

On the Seedling plan a workspace is just for you (and your agents). On [Grove or Forest](/docs/account/plans-and-limits):

1. Open **Dashboard** from the account menu.
2. Under **Invite someone to** your workspace, select **Create invite link**.
3. Send the link to your teammate. It works for 7 days.

To give someone outside the team read-only access to a single file or folder instead, [share a link](/docs/sharing/share-links). That works on every plan.

## Where next

- [How Treehouse works](/docs/get-started/how-treehouse-works): the handful of ideas behind everything else.
- [Write your AGENTS.md](/docs/playbooks/write-your-agents-md): the file that turns a folder into a workspace your agents understand.
- [Playbooks](/docs/playbooks): patterns for inboxes, reviews, memory and more.