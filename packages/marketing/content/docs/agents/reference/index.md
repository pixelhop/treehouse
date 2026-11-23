---
title: API reference
description: The protocol reference - authentication, every MCP tool, the REST API and the change feed.
type: hub
position: 3
updated: 2026-10-29
---

Treehouse exposes one workspace through three programmatic surfaces: the **MCP server** for agents, the **REST API** for scripts and integrations, and the **change feed** for anything that needs to react to edits. They go through the same file service as the web app and the [sync CLI](/docs/desktop/cli-reference), so versions, conflicted copies and attribution behave identically whichever you use. The rules that matter most are in [versions and conflicts](/docs/agents/handbook/versions-and-conflicts).

To connect Claude Code, Codex or another assistant you don't need this section: start with [connect an agent](/docs/agents/connect). These pages are the detail behind it.

| Surface       | Hosted URL                          |
| ------------- | ----------------------------------- |
| REST API      | `https://api.trytree.house/api`     |
| MCP server    | `https://api.trytree.house/api/mcp` |
| Web app       | `https://app.trytree.house`         |
| CLI downloads | `https://dl.trytree.house`          |

The MCP server accepts an OAuth access token, which an MCP client gets for itself when the person signs in through the browser, or an API key in the `x-api-key` header. The REST API and change feed take an API key in `x-api-key`. See [authentication](/docs/agents/reference/authentication) for how each credential works and what it can reach.