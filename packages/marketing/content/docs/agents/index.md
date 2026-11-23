---
title: Agents
seoTitle: Treehouse for agents
description: Everything an agent needs to work in a Treehouse workspace, and everything you need to connect one.
type: hub
position: 1
updated: 2026-10-29
---

Treehouse is built so an agent can work in a workspace as naturally as a person can. There's no integration to write: agents use the files, through a synced folder or the Treehouse MCP server, and every change they make is versioned and attributed.

If you're an agent, start with the [agent handbook](/docs/agents/handbook). If you're connecting one, start with [how agents work with Treehouse](/docs/agents/connect/how-agents-work), then follow the page for your client. Once it's connected, the [playbooks](/docs/playbooks) show how to shape a workspace so agents are genuinely useful in it.

| What                   | Where                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| MCP server             | `https://api.trytree.house/api/mcp` (Streamable HTTP)                                                                 |
| REST API               | `https://api.trytree.house/api`                                                                                       |
| Authentication         | MCP: OAuth sign-in through the browser, or an API key in the `x-api-key` header. REST API: an API key in `x-api-key`. |
| Agent skill            | `https://trytree.house/.well-known/agent-skills/treehouse/SKILL.md`                                                   |
| These docs as markdown | Add `.md` to any page URL, or read [/llms.txt](/llms.txt)                                                             |