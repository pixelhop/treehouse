---
title: Authentication
description: How OAuth sign-in for MCP clients and API keys work, what each credential can reach, the device flow the CLI uses, and how access is revoked.
type: reference
position: 1
updated: 2026-10-30
related:
  - /docs/agents/connect/connected-agents
  - /docs/agents/connect/api-keys
  - /docs/agents/reference/mcp-server
  - /docs/agents/reference/rest-api
---

## Credentials

| Credential             | Sent as                                | Works for                                            |
| ---------------------- | -------------------------------------- | ---------------------------------------------------- |
| OAuth access token     | `Authorization: Bearer <token>` header | The MCP server only                                  |
| API key                | `x-api-key: <key>` header              | The REST API, the MCP server and the change feed     |
| Browser session cookie | Cookie set by signing in               | The REST API, including the key-management endpoints |

An MCP client normally gets an OAuth token for itself, by [signing the person in through the browser](#oauth-for-mcp-clients). Use an API key for scripts, the REST API, the change feed, and agents that can't open a browser. When a request to the MCP server carries an `x-api-key` header, the key is used and any `Authorization` header is ignored.

::callout{type="warning" title="Send API keys as x-api-key, not Bearer"}
The server reads an API key from the `x-api-key` header only. On the REST API, a key sent as `Authorization: Bearer <key>` is ignored, and the request fails with `401` as if no credential was sent. On the MCP server, a `Bearer` value is read as an OAuth access token, so a key sent that way fails with `401` and an OAuth challenge. This is the most common reason a new integration can't connect.
::

```bash
curl https://api.trytree.house/api/workspace \
  -H "x-api-key: th_example_key"
```

## OAuth for MCP clients

The MCP server is an OAuth 2.1 protected resource. A client that supports MCP authorisation needs only the server URL: it discovers everything else, registers itself and signs the person in. Nothing has to be set up in advance.

| Step             | What happens                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Challenge     | A request to `/api/mcp` with no credential, or with a token that is no longer valid, returns `401` with a `WWW-Authenticate` header pointing at the protected resource metadata.                           |
| 2. Discovery     | The client reads `https://api.trytree.house/.well-known/oauth-protected-resource` (RFC 9728), which names the authorisation server, then that server's metadata.                                           |
| 3. Registration  | The client registers itself with dynamic client registration. No client id is issued in advance.                                                                                                           |
| 4. Authorisation | The client opens the person's browser at the authorisation endpoint, using PKCE. They sign in to the web app, or create an account, then approve the client on the consent screen and name the connection. |
| 5. Token         | The client exchanges the code for an access token, bound to the MCP server as its audience, and a refresh token.                                                                                           |

| Detail                | Value                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Issuer                | `https://api.trytree.house/api/auth`                                                         |
| Protected resource    | `https://api.trytree.house/api/mcp`                                                          |
| Scopes                | `openid`, `profile`, `email`, `offline_access`. There are no finer-grained Treehouse scopes. |
| Access token lifetime | One hour. Clients renew it with the refresh token (`offline_access`) without asking again.   |
| Accepted by           | The MCP server only. The REST API and change feed don't accept OAuth tokens.                 |

### Connections

Each approval creates a **connection**: one client, signed in as one person. A connection:

- Reaches every workspace the person is a member of, checked on each request, with the same tool set as an [account-wide key](#kinds-of-key): every tool takes a `workspaceId`, plus `list_workspaces` and `create_workspace`.
- Always acts as an agent. Its changes are recorded with the `agent` principal and labelled with the connection's name, which the person sets on the consent screen (up to 80 characters, starting as the client's own name) and can rename later. A rename applies to later changes only.
- Can't create public or password-protected share links, like an API key.

The person sees and manages their connections under **Agents & API keys** in the web app. See [manage connected agents](/docs/agents/connect/connected-agents).

### Revoked connections

Disconnecting a connection deletes its tokens and takes effect immediately: the next request with one of its access tokens returns `401` with a fresh `WWW-Authenticate` challenge, even if the token hasn't expired. The same happens for any other invalid or expired token. A client that supports MCP authorisation will normally prompt the person to sign in again.

## Kinds of key

| Kind             | How it's made                                                              | Reaches                                                 | MCP tool set                                                                  |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Account-wide     | Created in the web app, or `POST /api/keys` without `workspaceId`          | Every workspace you're a member of, checked per request | Every tool takes `workspaceId`; adds `list_workspaces` and `create_workspace` |
| Workspace-scoped | The device flow (desktop app, CLI), or `POST /api/keys` with `workspaceId` | One workspace. Any other workspace returns `403`        | No `workspaceId` parameter                                                    |

Every key also carries an **actor type**, `agent` or `human`. It is how Treehouse attributes changes: every write, move, delete and comment made with the key is recorded with that `principal`, together with the key's id and name. The activity feed shows agent changes as agent changes because the key says so, not because of which endpoint was used.

### Keys from the web app

In the web app, open the account menu and choose **Agents & API keys**. Under **API keys**, **Used by** sets the actor type:

| Used by         | Actor type |
| --------------- | ---------- |
| **Agent (MCP)** | `agent`    |
| **Human (CLI)** | `human`    |

Keys created here are account-wide. The key is shown once, when you create it. The [API keys](/docs/agents/connect/api-keys) page covers the UI in detail.

### Keys from the device flow

The desktop app and `treehouse login` get a workspace-scoped key through the [device authorisation flow](#device-authorisation-flow) below. These keys default to the `human` actor type.

## Key management endpoints

These accept a browser session cookie only. A request carrying `x-api-key` is refused with `403` and the message `Key management requires a logged-in session, not an API key`, so a leaked key can never mint or revoke other keys.

| Method   | Path             | Body / result                                                                                                                                                                    |
| -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/keys`      | Body `{ name?, actorType?, workspaceId?, access?, folder? }`. Returns `{ id, key, name, actorType }`, plus `workspaceId` when scoped. The plaintext `key` is only returned here. |
| `GET`    | `/api/keys`      | `{ keys: [...] }`, each with its `metadata` (`actorType`, and `workspaceId` for scoped keys). No plaintext keys.                                                                 |
| `DELETE` | `/api/keys/{id}` | Revokes the key. Returns `{ ok: true }`.                                                                                                                                         |

`actorType` is `agent` or `human`; anything else is treated as `human`. `name` defaults to `treehouse-key` (account-wide) or `treehouse-cli` (workspace-scoped). With `workspaceId`, you must be a member of that workspace.

## Device authorisation flow

A client with no browser session (the CLI, the desktop app, or your own tool) can get a workspace-scoped key by asking the user to approve it in the web app. It follows the shape of OAuth device authorisation (RFC 8628).

1. The client calls `POST /api/device/code` with no credentials.
2. The client shows the user `verification_uri_complete` (the web app's `/link` page, with the code filled in) and `user_code`.
3. The user signs in, picks a workspace and approves.
4. The client polls `GET /api/device/poll?device_code=<device_code>` every `interval` seconds until it gets the key.

`POST /api/device/code` returns:

```json
{
  "device_code": "…",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://app.trytree.house/link",
  "verification_uri_complete": "https://app.trytree.house/link?code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 5
}
```

The code expires after 10 minutes and can be used once.

### Poll responses

| Status | Body                                                                            | Meaning                                                             |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `200`  | `{ "status": "pending" }`                                                       | Not approved yet. Keep polling.                                     |
| `200`  | `{ "status": "approved", "api_key", "api_key_id", "workspace_id", "api_base" }` | Approved. Store the key; this response is delivered once.           |
| `400`  | `device_code required`                                                          | The query parameter is missing.                                     |
| `404`  | `invalid_grant`                                                                 | Unknown device code.                                                |
| `410`  | `expired_token`                                                                 | The code expired. Start again.                                      |
| `410`  | `already_consumed`                                                              | The key was already delivered to an earlier poll.                   |
| `429`  | `slow_down`                                                                     | You polled sooner than `interval` after the last poll. Wait longer. |
| `403`  | `access_denied`                                                                 | The request was denied.                                             |

`api_base` is the API's own public URL, so a client that started from the app URL learns where to send requests.

## Errors and limits

A missing or invalid credential returns `401`. On the MCP server, a `401` without an API key carries the OAuth challenge described [above](#revoked-connections). When an API key is rejected, the error's `data` explains why:

```json
{ "error": "invalid_api_key", "reason": "INVALID_API_KEY" }
```

`reason` is the auth library's code for the specific failure (for example a key that was deleted or has expired), so a client can tell a revoked key from a transient problem.

### Limited keys

`access: "read"` makes a key read-only, and `folder` confines it to one subtree (it needs `workspaceId`). Both are stored on the key and fixed when it's created. They're checked on every request on top of the owner's current access, so a key never exceeds its owner.

| Refusal                           | Response                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| A change with a read-only key     | `409` with `data: { "error": "read_only", "reason": "key" }`                                   |
| Any path outside the key's folder | `409` with `data: { "error": "outside_key_folder", "folder" }`, whether or not the path exists |
| A path its owner can't see        | `404`                                                                                          |

`GET /api/workspaces/{id}` reports the limits in `access.key`. Keys can't call `/api/auth/*` at all (`403`), so a limited key can't create or change keys.

A valid key used on a workspace it can't reach returns `403` with `Key is not scoped to this workspace` (a workspace-scoped key) or `Not a workspace member`. An unknown workspace returns `404`.

There is no per-key rate limit: the sync CLI and agents authenticate on every request. The device endpoints are limited: `POST /api/device/code` to 5 requests per 10 minutes per IP address, and approvals to 10 per 15 minutes per user. Over the limit returns `429`.

## When someone leaves a workspace

When a member is removed from a workspace, or leaves it:

- Their **workspace-scoped keys** for that workspace are deleted. A synced folder using one stops syncing and asks them to sign in again.
- Their **account-wide keys** and **OAuth connections** keep working for their other workspaces, but get `403 Not a workspace member` for this one.

## Keeping keys safe

- **One key per agent or integration.** The key's name appears in the activity feed, so separate keys make it clear who did what, and you can revoke one without breaking the others.
- **Revoke keys you no longer use**, from **Agents & API keys** in the web app or with `DELETE /api/keys/{id}`. Disconnect OAuth connections you no longer use from the same place.
- **Never commit a key** to a repository or paste it into a shared file. Treat it like a password: anyone holding it can read and write every workspace it reaches.
- The CLI stores its key in `<folder>/.treehouse/config.json` with file mode `0600` (readable only by you). Keep `.treehouse/` out of version control.