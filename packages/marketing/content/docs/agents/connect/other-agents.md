---
title: Connect other agents
description: Connect Cursor, VS Code, Codex, Gemini CLI, Claude Desktop, claude.ai, ChatGPT or any other MCP client by signing in, or with an API key.
type: how-to
position: 4
updated: 2026-10-29
related:
  - /docs/agents/connect/claude-code
  - /docs/agents/connect/connected-agents
  - /docs/agents/connect/api-keys
  - /docs/agents/reference/mcp-server
---

Any agent that can open a folder can use a [synced workspace](/docs/desktop) straight away: point it at the folder. To connect over MCP instead, add Treehouse to your client as a remote server:

| Setting    | Value                                                             |
| ---------- | ----------------------------------------------------------------- |
| Server URL | `https://api.trytree.house/api/mcp`                               |
| Transport  | Streamable HTTP (often listed as "HTTP" or "remote")              |
| Sign-in    | OAuth, through your browser. Or an `x-api-key: <your key>` header |

## Sign in through your browser

This is the recommended way to connect. There's no key to create or paste.

1. Add the server URL to your client as a remote (HTTP) MCP server, with no headers. The examples below show where it goes in common clients.
2. When the client first connects, it opens your browser. Sign in to Treehouse, or create an account if you don't have one yet. A new account has to confirm its email first: the link in that email brings you back to this step.
3. The browser shows **Connect** followed by the app's name. Under **Name this connection**, give it a name you'll recognise in the [activity feed](/docs/sharing/activity), such as `Cursor on my laptop`. It starts as the app's own name.
4. Select **Allow**. The browser hands you back to your client.

The client finds Treehouse's sign-in by itself and renews its access on its own, so you only sign in once. The connection reaches every workspace you're a member of, and its changes are marked as an agent's, labelled with the name you chose. [Manage connected agents](/docs/agents/connect/connected-agents) covers renaming and disconnecting it.

MCP client settings change often. If an example below doesn't match your version, look in your client's docs for "remote" or "Streamable HTTP" servers.

### Cursor

Add Treehouse to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` in a project:

```json [mcp.json]
{
  "mcpServers": {
    "treehouse": {
      "url": "https://api.trytree.house/api/mcp"
    }
  }
}
```

### VS Code

Add a server to `.vscode/mcp.json`:

```json [.vscode/mcp.json]
{
  "servers": {
    "treehouse": {
      "type": "http",
      "url": "https://api.trytree.house/api/mcp"
    }
  }
}
```

### Codex

Add a server to `~/.codex/config.toml`:

```toml [config.toml]
[mcp_servers.treehouse]
url = "https://api.trytree.house/api/mcp"
```

### Gemini CLI

Add Treehouse to `mcpServers` in `~/.gemini/settings.json`:

```json [settings.json]
{
  "mcpServers": {
    "treehouse": {
      "httpUrl": "https://api.trytree.house/api/mcp"
    }
  }
}
```

### Claude Desktop, claude.ai and ChatGPT

Add Treehouse as a custom connector (in ChatGPT, a connector) with the server URL `https://api.trytree.house/api/mcp`. When you connect it, the app opens Treehouse in your browser to sign in.

## Connect with an API key

Use an [API key](/docs/agents/connect/api-keys) when the agent can't open a browser, such as one running on a server or in CI, or when your client can't sign in to remote servers. Create the key in the web app: account menu, **Agents & API keys**, then under **API keys** set **Used by** to **Agent (MCP)** and select **Create key**. Give each agent its own key so you can tell them apart in the activity feed and revoke one without affecting the others.

::callout{type="warning" title="Use x-api-key, not Bearer"}
Treehouse reads an API key from the `x-api-key` header. A key pasted into a client's "bearer token" field is sent as `Authorization: Bearer ...`, which Treehouse rejects with a 401. Look for a custom headers setting instead.
::

### Cursor with a key

Add Treehouse to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` in a project:

```json [mcp.json]
{
  "mcpServers": {
    "treehouse": {
      "url": "https://api.trytree.house/api/mcp",
      "headers": {
        "x-api-key": "<your key>"
      }
    }
  }
}
```

### VS Code with a key

Add a server to `.vscode/mcp.json`. The `inputs` block makes VS Code ask for the key once and store it securely, so it never lands in a file you might commit:

```json [.vscode/mcp.json]
{
  "inputs": [
    {
      "type": "promptString",
      "id": "treehouse-key",
      "description": "Treehouse API key",
      "password": true
    }
  ],
  "servers": {
    "treehouse": {
      "type": "http",
      "url": "https://api.trytree.house/api/mcp",
      "headers": {
        "x-api-key": "${input:treehouse-key}"
      }
    }
  }
}
```

### Codex with a key

Add a server to `~/.codex/config.toml`. `env_http_headers` reads the header value from an environment variable, which keeps the key out of the file:

```toml [config.toml]
[mcp_servers.treehouse]
url = "https://api.trytree.house/api/mcp"
env_http_headers = { "x-api-key" = "TREEHOUSE_API_KEY" }
```

Then set `TREEHOUSE_API_KEY` in the environment Codex runs in.

### Gemini CLI with a key

Add Treehouse to `mcpServers` in `~/.gemini/settings.json`:

```json [settings.json]
{
  "mcpServers": {
    "treehouse": {
      "httpUrl": "https://api.trytree.house/api/mcp",
      "headers": {
        "x-api-key": "<your key>"
      }
    }
  }
}
```

### Claude Desktop with a key

To use a key rather than a custom connector, connect through the `mcp-remote` bridge, which needs [Node.js](https://nodejs.org) installed. Open **Settings**, then **Developer**, then **Edit Config**, and add:

```json [claude_desktop_config.json]
{
  "mcpServers": {
    "treehouse": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://api.trytree.house/api/mcp",
        "--header",
        "x-api-key:${TREEHOUSE_API_KEY}"
      ],
      "env": {
        "TREEHOUSE_API_KEY": "<your key>"
      }
    }
  }
}
```

Restart Claude Desktop. Treehouse appears in the tools menu of a new chat.

## Check it worked

Ask your agent to list your Treehouse workspaces. It should call `list_workspaces` and reply with their names. If it can't see the server at all, restart the client after editing its config.

## Troubleshooting

### The client never opens a browser to sign in

Some clients only sign in when you ask them to, from their MCP settings or a login command; check your client's docs. Also check the server has no `x-api-key` header left over from an earlier set-up: with a key, the client never needs to sign in. If your client doesn't support signing in to remote servers, connect with an API key instead.

### The agent reports a 401

With a browser sign-in, the connection was disconnected or its access has lapsed; most clients prompt you to sign in again, or offer a way to re-authenticate the server. With an API key, check the header name and the key, and create a new key if in doubt.