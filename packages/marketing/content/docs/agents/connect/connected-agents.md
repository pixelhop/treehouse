---
title: Manage connected agents
navTitle: Connected agents
description: See which agents have signed in to Treehouse as you, rename how their work is labelled, and disconnect the ones you no longer use.
type: how-to
position: 5
updated: 2026-10-29
related:
  - /docs/agents/connect/claude-code
  - /docs/agents/connect/other-agents
  - /docs/agents/connect/api-keys
---

When you connect an agent by signing in through the browser, Treehouse keeps a **connection** for it: one per app you approve. The name you gave it when you approved it is how its work is labelled in the [activity feed](/docs/sharing/activity), as in "Sam · via Claude Code on my laptop".

A connection acts as you, as an agent. It reaches every workspace you're a member of, and can do what you can do there and no more. Like an API key, it can't see other members' [private files](/docs/files/private-files) or create public links.

## See your connected agents

1. In the web app, open the account menu at the bottom of the sidebar (select your name) and choose **Agents & API keys**.
2. Look under **Connected agents**.

Each row shows the connection's name, the app's own name when you gave it a different one, and the date it was connected. If the list says "None yet", no agent has signed in as you.

## Rename a connection

1. Open **Agents & API keys** from the account menu.
2. Under **Connected agents**, select **Rename** next to the connection.
3. Type the new name (up to 80 characters) and select **Save**.

The new name applies to the agent's changes from now on. Its earlier activity keeps the name it had at the time.

## Disconnect an agent

1. Open **Agents & API keys** from the account menu.
2. Under **Connected agents**, select **Disconnect** next to the connection, then confirm.

The agent stops working straight away: its next request to Treehouse is refused. To use it again, it has to sign in again from the start, and you approve it again in the browser.

::callout{type="tip" title="One connection per agent"}
Every app you sign in from gets its own connection, so Claude Code on two computers shows as two rows. Give each a name you'll recognise, such as `Claude Code on my laptop`, and you can tell their work apart and disconnect one without affecting the others.
::

## When someone leaves a workspace

A connection reaches the workspaces you're a member of at the time of each request. If you leave a workspace, or are removed from it, your connected agents can't reach it any more, but keep working in your other workspaces.