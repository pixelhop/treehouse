---
title: Frequently asked questions
navTitle: FAQ
description: Short answers to the questions people ask most about Treehouse, agents, sharing and data.
type: reference
position: 2
updated: 2026-11-23
---

## What is Treehouse for?

Giving a team and its agents one shared place to work, made of plain files. People use the web app and a synced folder; agents use the same files through that folder or the MCP server. [What is Treehouse?](/docs/get-started/what-is-treehouse) has the longer answer.

## Does Treehouse include an AI model or run agents for me?

No. Treehouse is where the work lives. You bring your own agents, such as Claude Code, Codex, Cursor or anything that speaks MCP, and connect them to your workspace. It doesn't run anything on a schedule either; see [routines](/docs/playbooks/routines) for how to do that.

## Which agents work with Treehouse?

Any agent that can work with files on your computer can use a synced folder. Any MCP client that supports remote servers can connect to the MCP server, signing in through your browser or, if it can't, with an API key in a custom header. [Connect other agents](/docs/agents/connect/other-agents) has settings for the common ones.

## Can two people, or a person and an agent, edit the same file at once?

Yes, safely. If two saves collide, the second is kept as a [conflicted copy](/docs/files/conflicted-copies) next to the original, so nothing is lost. You then merge the two.

## Can I get back a file I changed by mistake?

Yes. Every save is a new version, and you can view and restore earlier ones from the file's **History** tab. See [version history](/docs/files/version-history). Deleted files go to the [trash](/docs/files/trash), where you can bring them back.

## Who can see my files?

Members of the workspace see everything except other people's [private files](/docs/files/private-files). People outside it see only what you share with a [public link](/docs/sharing/share-links). Your agents see what you see. [Security and privacy](/docs/account/security-and-privacy) goes into more detail.

## Can agents share my files publicly?

No. Only a person signed in to the web app can create a public link. Agents can create member links, which only work for people already in the workspace.

## Is there a Windows or Linux app?

Not yet. Syncing a folder works on Apple silicon Macs for now, with the desktop app or the [sync CLI](/docs/desktop/sync-with-the-cli). Windows and Linux are coming soon: until then, use the web app, which works in any modern browser.

## Can I use Treehouse on my phone?

Yes, in the browser. You can add the web app to your home screen, and it adapts to a small screen. There's no native phone app.

## How much does it cost?

Seedling is free for one person and one workspace. Grove and Forest are priced per member per month; you'll see the current prices when you choose a plan. See [plans and limits](/docs/account/plans-and-limits).

## Is my data encrypted?

Yes, at rest. Each workspace's files are encrypted with that workspace's own key before they're stored. See [security and privacy](/docs/account/security-and-privacy).