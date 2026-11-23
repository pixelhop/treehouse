---
title: REST API
description: Endpoints for reading, writing, moving, searching, sharing and commenting on workspace files over HTTP, with headers, status codes and examples.
type: reference
position: 3
updated: 2026-10-30
related:
  - /docs/agents/reference/authentication
  - /docs/agents/handbook/versions-and-conflicts
  - /docs/agents/reference/change-feed
---

## Conventions

| Convention       | Detail                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base URL         | `https://api.trytree.house`                                                                                                                                                    |
| Workspace routes | `/api/workspaces/{workspaceId}/…`                                                                                                                                              |
| Auth             | `x-api-key: <key>` or a signed-in browser session. See [authentication](/docs/agents/reference/authentication).                                                                |
| Request bodies   | JSON, except file writes, which send the raw bytes                                                                                                                             |
| Errors           | JSON with `statusCode` and `statusMessage`. Some errors carry details in `data`; conflict and limit responses return a flat body such as `{ "error": "version_conflict", … }`. |
| Paths            | Workspace-relative, `/`-separated, such as `Projects/plan.md`. Encode each segment in the URL but keep the slashes. `..`, backslashes and null bytes return `400`.             |
| Private items    | A private or restricted file or folder you aren't on behaves as if it doesn't exist (`404`).                                                                                   |
| View-only access | A change you can see but aren't allowed to make returns `409` with `data: { "error": "read_only", "reason" }`. Retrying won't help. See below.                                 |
| Limited keys     | A path outside a [folder-limited key](/docs/agents/reference/authentication#limited-keys) returns `409` with `data: { "error": "outside_key_folder", "folder" }`.              |

Find your workspace id in the web app URL (`/w/<workspaceId>/…`), with `GET /api/workspace`, or with `list_workspaces` over MCP.

## Files

| Method   | Path                     | Purpose                                                    |
| -------- | ------------------------ | ---------------------------------------------------------- |
| `GET`    | `files/{path}`           | Read a file's bytes                                        |
| `PUT`    | `files/{path}`           | Create or update a file                                    |
| `DELETE` | `files/{path}`           | Delete a file                                              |
| `GET`    | `list?prefix=`           | List files                                                 |
| `POST`   | `move`                   | Move or rename one file                                    |
| `POST`   | `move-folder`            | Carry a folder's own privacy, icon and order to a new path |
| `GET`    | `version?path=&version=` | Read an earlier version                                    |
| `POST`   | `restore`                | Restore an earlier version as a new version                |
| `GET`    | `search?q=&limit=`       | Fuzzy search over names and paths                          |
| `GET`    | `links?path=`            | Notes that link to a file                                  |

All paths in this section are relative to `/api/workspaces/{workspaceId}/`.

### Read a file

`GET files/{path}` returns the raw bytes with these headers:

| Header                     | Value                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Treehouse-Version`      | The file's current version. Prefer this header.                                                                                                                                               |
| `ETag`                     | The version and content hash, quoted (`"3-<sha256>"`). Send it back unchanged in `If-None-Match` or `If-Range`. A CDN may weaken or strip it, so read the version from `X-Treehouse-Version`. |
| `X-Treehouse-Content-Hash` | SHA-256 of these exact bytes. Unlike a version number, it is never reused.                                                                                                                    |
| `Content-Type`             | The stored content type. See [content types](#content-types).                                                                                                                                 |

Send the `ETag` you received as `If-None-Match` to get `304 Not Modified` when you already have those bytes. Add `?download=1` to get a `Content-Disposition: attachment` response. Errors: `404` not found, `502` if the stored bytes are missing.

To read part of a file, send a single byte range such as `Range: bytes=0-1023`, `bytes=4096-` or `bytes=-512`. The response is `206 Partial Content` with `Content-Range: bytes <start>-<end>/<size>`, or `416` with `Content-Range: bytes */<size>` if the range starts past the end. Add the `ETag` you received as `If-Range` to get the whole file instead when it has changed since you started. The ETag includes the content hash, so this also catches a file deleted and recreated at the same version number. A request for several ranges gets the whole file.

```bash
curl -i https://api.trytree.house/api/workspaces/$WS/files/Projects/plan.md \
  -H "x-api-key: $TREEHOUSE_API_KEY"
```

For large downloads, send `x-treehouse-byte-redirect: 1`. The server may then answer `307 Temporary Redirect` to a download host instead of sending the bytes itself, marked with `X-Treehouse-Byte-Handoff: 1`. It does that only for video and audio, and for other files of 32 MB or more; smaller files always come back directly. The `Location` URL works on its own for a few hours, so follow it **without** your API key: most HTTP clients copy custom headers like `x-api-key` onto a redirect, so follow it yourself rather than letting the client do it. Only a redirect carrying that header is a handoff; treat any other redirect as usual, and never send your key to another origin. The download host sends the same headers, accepts the same `Range`, `If-Range` and `If-None-Match`, and answers `403` once the URL has expired, in which case request the file again. Without the header, or when the server has no download host, you always get the bytes directly. `GET version` accepts the same header.

### Write a file

`PUT files/{path}` with the complete file as the request body. Choose one precondition:

| Header             | Behaviour                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `If-Match: "<n>"`  | Update, only if the current version is `n`. Quotes are optional.                                     |
| `If-None-Match: *` | Create only. If the path exists with different content, your bytes become a conflicted copy (`412`). |
| Neither            | Create if the path doesn't exist; `428` if it does.                                                  |

The `Content-Type` you send is stored with the file. If you send none, it is guessed from the extension. Note that `curl --data-binary` sends `application/x-www-form-urlencoded` unless you set the header yourself.

| Status | Body                                                                       | Meaning                                                           |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `201`  | `{ "path", "version" }`                                                    | Created                                                           |
| `200`  | `{ "path", "version" }`                                                    | Updated. The new version is also in `ETag`.                       |
| `400`  | `Empty request body`, `Invalid If-Match`, or a path error                  | Nothing written                                                   |
| `402`  | `{ "error": "workspace_read_only" }`                                       | The subscription has lapsed. Reads, moves and deletes still work. |
| `404`  |                                                                            | You can't write to that path (another member's private item)      |
| `409`  | `data: { "error": "read_only", "reason" }`                                 | View-only: `role` (a Viewer), `grant` (this item) or `key`.       |
| `409`  | `data: { "error": "outside_key_folder", "folder" }`                        | Outside this key's folder. Nothing written.                       |
| `412`  | `{ "error": "version_conflict", "current_version", "conflict_copy_path" }` | Stale `If-Match`. Your bytes were saved at `conflict_copy_path`.  |
| `413`  | `data: { "error": "file_too_large", "limit_bytes" }`                       | Larger than the per-file limit                                    |
| `428`  | `If-Match required for existing file`                                      | The path exists and you sent no precondition                      |
| `507`  | `{ "error": "quota_exceeded", "used_bytes", "limit_bytes" }`               | Storage limit reached                                             |
| `507`  | `{ "error": "file_count_exceeded", "used_files", "limit_files" }`          | File limit reached                                                |

A stale write with content identical to the current file succeeds without creating a copy. See [versions and conflicts](/docs/agents/handbook/versions-and-conflicts).

```bash
# Update version 3 of a file
curl -X PUT https://api.trytree.house/api/workspaces/$WS/files/Projects/plan.md \
  -H "x-api-key: $TREEHOUSE_API_KEY" \
  -H 'If-Match: "3"' \
  -H "Content-Type: text/markdown" \
  --data-binary @plan.md
```

```bash
# Create a new file, failing safely if it already exists
curl -X PUT https://api.trytree.house/api/workspaces/$WS/files/Inbox/idea.md \
  -H "x-api-key: $TREEHOUSE_API_KEY" \
  -H "If-None-Match: *" \
  -H "Content-Type: text/markdown" \
  --data-binary @idea.md
```

### Delete a file

`DELETE files/{path}` with `If-Match: "<n>"` (required, `428` without it). Returns `204`. If the file has changed since version `n`, nothing is deleted and you get `412` with `{ "error": "version_conflict", "current_version" }`. A Viewer gets `409` `read_only`, as do moves, restores, icons, order, privacy, share links and workspace settings.

### List files

`GET list?prefix=Projects` returns every entry under the prefix in one response:

```json
{
  "entries": [
    { "path": "Projects/plan.md", "size": 1204, "contentType": "text/markdown", "version": 3 }
  ],
  "icons": { "Projects": "📁" },
  "orders": { "Projects/plan.md": 0 },
  "privatePaths": [],
  "nextCursor": null
}
```

Omit `prefix` for the whole workspace. Entries include `.keep` files, the hidden placeholders that keep empty folders in place. `privatePaths` lists items that are private to you. `limit` and `cursor` are accepted for forward compatibility but currently have no effect, and `nextCursor` is always `null`. If you page, keep requesting until `nextCursor` is `null`.

### Move a file

`POST move` with `{ "from", "to", "baseVersion"?, "updateLinks"? }`. Returns `{ "path", "version": 1 }`: a moved file restarts at version 1. With `baseVersion`, the move only happens if the source is still at that version (`412` otherwise). `404` if the source is missing, `409` if the destination exists (`409` with `read_only` for a Viewer: check `data.error`).

`"updateLinks": true` also rewrites the wikilinks and relative markdown links that reached the file, in every note you can edit, so they reach its new path (see [link notes together](/docs/files/link-notes)). The response then adds `"links": { "updated": [...], "failed": [...] }`, where `failed` lists notes that may still link to the old path (they changed during the move, the new name can't be written in their link, or they were too large or unreadable to check), and `version` is the moved file's latest version, which is higher than 1 when its own links were rewritten. It's off by default: a sync client mirroring a rename made in a local editor gets that editor's own link updates as ordinary writes. With `updateLinks`, a workspace with many notes written before links were indexed may answer `503` with a `Retry-After` header: nothing was moved, the indexing done so far is kept, and retrying gets further.

### Links between notes

`GET links?path=Projects/plan.md` returns `{ "path", "backlinks": [...], "complete" }`: the notes whose wikilinks or relative markdown links reach the file, filtered to what you can see. Add `&outgoing=1` to also get `"outgoing": [{ "kind", "target", "path" }]`, the file's own links resolved. `complete: false` means older notes are still being indexed; ask again. `404` if the file is missing or private to someone else. [`get_links`](/docs/agents/reference/mcp-server#get_links) over MCP returns the same, with `outgoing` always included.

### Tags

`GET tags` returns `{ "tags": [{ "tag", "paths": [...] }], "complete" }`: every tag on a markdown note you can see, sorted by name, with the notes carrying it. `GET tags?tag=planning` returns `{ "tag", "paths": [...], "complete" }`: the notes tagged `planning` or a tag nested under it, such as `planning/q4`. Tags are case-insensitive and come from front matter `tags:` and inline `#tags` (see [tag notes](/docs/files/tag-notes)). `400` if `tag` is empty or too long. `GET links` also returns the file's own `"tags"`. [`list_tags`](/docs/agents/reference/mcp-server#list_tags) is the MCP equivalent.

To move a folder, move each file, then call `POST move-folder` with `{ "from", "to" }` so the folder's own privacy setting, icon and ordering follow it. `move-folder` does not move any files.

### Versions and restore

`GET version?path=Projects/plan.md&version=2` returns that version's bytes, with an `ETag` of the same `"<version>-<sha256>"` form. It accepts the same `Range` and `If-Range` headers as reading a file, and `&download=1` for a `Content-Disposition: attachment` response. `404` if the path or version isn't available.

`POST restore` with `{ "path", "targetVersion" }` writes that version's bytes as a new version and returns `{ "path", "version", "restoredFrom" }`. If concurrent writes keep winning, it returns `409` with `{ "error": "restore_conflicted", "current_version", "conflict_copy_path" }` and the restored bytes are in the conflicted copy.

### Trash

`GET trash` lists deleted files you can see, newest deletion first:

```json
{
  "items": [
    {
      "path": "Research/notes.md",
      "deletedAt": "2026-10-29T14:02:11.000Z",
      "seq": 2210,
      "principal": "agent",
      "actorId": "u_91…",
      "actorKeyId": "k_3c…",
      "actorLabel": "claude-code",
      "restorable": true
    }
  ],
  "nextBefore": null
}
```

`prefix` limits it to one folder (never its siblings that share the name's start), `limit` is 1 to 500 (default 100), and `before=<nextBefore>` fetches the next page. Renamed and moved files aren't listed. `restorable` is `false` when the content from before the deletion was never recorded.

To bring files back, send `{ "kind": "trash", "paths": [...] }` (at most 5,000 paths) to either:

- `POST recovery/preview`, which changes nothing and returns `{ "actions", "skipped", "previewHead", "tooLarge" }`. Each action is `{ "kind": "recreate", "path", "size" }`.
- `POST recovery/apply`, which restores them and returns `{ "operationId", "applied", "skipped" }`.

To apply exactly what a preview showed, add two fields from it to the apply body. `previewHead` leaves alone any file that changed after the preview, with the reason `changed`. `approved` lists the previewed changes, each as the JSON text of `[kind, from, path]`, where `from` is `null` except for moves (for example `["recreate",null,"notes.md"]`). Anything else the apply would now do is left alone, with the reason `not_previewed`.

Each skipped entry is `{ "path", "reason" }`, with the same reasons as the MCP tool [restore_from_trash](/docs/agents/reference/mcp-server#restore_from_trash). A skipped file never stops the others. The restored files' change-feed events carry `operationId`.

### Restore to an earlier time

Send `{ "kind": "restore", "path": "Notes", "at": "2026-10-29T15:00:00Z" }` to `POST recovery/preview`. Omit `path` for the whole workspace. The response has the same shape as for the trash, with actions of kind `restore` (with the `version` it replaces), `recreate`, `move` (with `from`) and `delete` (with `version`).

Then send the same body plus `"previewHead"` and `"approved"` from the preview to `POST recovery/apply`, as for the trash. Paths that changed after the preview, including any made private or shared since, are skipped as `changed`. Skip reasons are those of the MCP tool [preview_restore_to](/docs/agents/reference/mcp-server#preview_restore_to). More than 5,000 changes is refused with `413`; restore one folder at a time.

### Undo a key's changes

Send `{ "kind": "undo", "keyId": "k_3c…", "since": "2026-10-29T15:00:00Z" }` to `POST recovery/preview`, then the same body plus `"previewHead"` to `POST recovery/apply`. Each file the key changed goes back to how it was just before its first change. Files someone else changed afterwards are skipped as `edited_later`, with `detail` naming who. In a browser session you can undo any key whose changes you can see. With an API key you can only undo that key's own changes: any other `keyId` gets `403`.

### Search

`GET search?q=clinot&limit=20` fuzzy-matches file and folder paths (not contents), ranked best first:

```json
{
  "results": [
    { "path": "Clients/acme/notes.md", "name": "notes.md", "isDir": false, "score": 41.2 }
  ],
  "totalMatches": 1,
  "truncated": false
}
```

`q` is required and at most 200 characters. `limit` defaults to 50 and is capped at 200. There is no offset: narrow the query instead.

## Workspace

| Method   | Path                                    | Purpose                                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}`                  | `{ id, name, icon, color, theme, themeCss, access: { role, canWrite, key } }`, where `access` describes the caller, and `key` the limits of the key they used.                                                                                                                                 |
| `PATCH`  | `/api/workspaces/{id}`                  | Update `name` (1-100 characters), `icon`, `color`, `theme`, `themeCss`. An empty string or `null` clears a field.                                                                                                                                                                              |
| `GET`    | `/api/workspaces/{id}/usage`            | `usedBytes`, `limitBytes`, `remainingBytes`, `usedFiles`, `limitFiles`, `remainingFiles`, `warning`, `maxFileBytes`, share-view counts and `billing`. Limits are `null` when unlimited.                                                                                                        |
| `GET`    | `/api/workspaces/{id}/members`          | `{ members: [{ id, name, image, role }] }`. No email addresses.                                                                                                                                                                                                                                |
| `PUT`    | `/api/workspaces/{id}/members/{userId}` | Set a member's role to `member` or `viewer`. Browser session only; owners and admins only. An owner's role and your own can't be changed.                                                                                                                                                      |
| `DELETE` | `/api/workspaces/{id}/members/{userId}` | Remove a member. Browser session only; owners and admins only. The last owner can't be removed (`409`).                                                                                                                                                                                        |
| `PUT`    | `/api/workspaces/{id}/node-icon`        | `{ path, icon }` sets a file or folder icon; empty `icon` clears it.                                                                                                                                                                                                                           |
| `PUT`    | `/api/workspaces/{id}/node-private`     | `{ path, kind, private }` makes an item private to you or shared again.                                                                                                                                                                                                                        |
| `PUT`    | `/api/workspaces/{id}/node-access`      | `{ path, kind, everyone?, grants: [{ userId, level }] }` sets who can reach an item, or `{ path, restricted: false }` opens it up. `level` is `read` or `write`; `everyone` adds `none`. Browser session only. You must stay an editor (`409`), and a `grants` entry must be a member (`400`). |
| `GET`    | `/api/workspaces/{id}/orphans`          | `{ orphans: [{ path, kind }] }`: restricted items no remaining member can reach. Browser session, owners only.                                                                                                                                                                                 |
| `POST`   | `/api/workspaces/{id}/orphans-claim`    | `{ path }` makes you the Editor of one of those, and records it. Browser session, owners only.                                                                                                                                                                                                 |
| `PUT`    | `/api/workspaces/{id}/node-order`       | `{ paths: [...] }` sets a custom display order (up to 1000 paths).                                                                                                                                                                                                                             |
| `POST`   | `/api/workspaces/{id}/icon`             | Raw image bytes (up to 1 MiB) as the workspace icon.                                                                                                                                                                                                                                           |

## Share links

| Method   | Path                                    | Purpose                                                                                                                              |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/workspaces/{id}/shares?path=`     | `{ shares, inherited }`: shares on this path, and folder shares above it that also cover it                                          |
| `POST`   | `/api/workspaces/{id}/shares`           | Create a link. Body `{ path, kind, access, password?, pinnedVersion?, pinnedContentHash?, allowScripts? }`. Returns `201 { share }`. |
| `PATCH`  | `/api/workspaces/{id}/shares/{shareId}` | `{ allowScripts }` turns script execution on or off for an HTML link                                                                 |
| `DELETE` | `/api/workspaces/{id}/shares/{shareId}` | Revoke a link                                                                                                                        |

`kind` is `file` or `folder`; `access` is `member` or `public`. **API keys can only create member links.** Public links, password-protected links, and turning scripts on require a signed-in browser session; with a key they return `403`. A key can turn scripts off. Restricted items, including private ones, can't be shared (`409`), and folder links can never run scripts (`400`).

## Comments

| Method | Path                                                      | Purpose                                                                               |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET`  | `/api/workspaces/{id}/comments`                           | List threads                                                                          |
| `POST` | `/api/workspaces/{id}/comments`                           | Start a thread                                                                        |
| `POST` | `/api/workspaces/{id}/comments/{threadId}/replies`        | Reply. Body `{ body, dedupeKey? }`. `201 { entry, deduped }`.                         |
| `PUT`  | `/api/workspaces/{id}/comments/{threadId}/resolved`       | Body `{ "resolved": true }` to resolve, `false` to reopen. Idempotent.                |
| `GET`  | `/api/workspaces/{id}/comments/{threadId}/pinned-content` | The exact markdown the thread was written against, as a download. `410` if it's gone. |

The list accepts the same filters as the MCP `list_comments` tool, as query parameters: `path`, `threadId`, `status`, `anchorStatus`, `author`, `limit`, `offset`, `entriesLimit`, `entriesOffset`. It returns `{ threads, total, nextOffset, truncated }`.

Creating a thread takes `{ path, body, kind, quote?, contextBefore?, contextAfter?, occurrence?, baseVersion? }`. Unlike MCP, `kind` (`range` or `point`) is required here. Success is `201 { thread }`. A quote that can't be placed returns `409` with `anchor_ambiguous` (plus `occurrences`), `anchor_not_found` or `base_version_conflict`. A non-markdown file returns `400 { "error": "not_markdown" }`, and a read-only workspace `402`. Size limits match the [MCP server](/docs/agents/reference/mcp-server#limits).

## Change feed

`GET /api/workspaces/{id}/changes?sinceSeq=<n>` returns every change after a cursor. See [change feed](/docs/agents/reference/change-feed).

## Account and top-level endpoints

| Method | Path                          | Auth                                                        | Purpose                                                                                                                                                                                  |
| ------ | ----------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                 | None                                                        | `{ status: "ok", timestamp }`                                                                                                                                                            |
| `GET`  | `/api/plans`                  | None                                                        | `{ available, plans }`, the plans on offer. `available: false` on servers without billing.                                                                                               |
| `GET`  | `/api/me`                     | Key or session                                              | `{ user }`, the account behind the credential                                                                                                                                            |
| `GET`  | `/api/workspace`              | Key or session                                              | `{ id, name }`: a workspace-scoped key's workspace, otherwise your oldest workspace                                                                                                      |
| `GET`  | `/api/workspaces`             | Session only                                                | `{ workspaces: [...] }`, every workspace you're a member of                                                                                                                              |
| `POST` | `/api/workspaces`             | Session only                                                | Create a workspace. Body `{ name, icon?, color? }`.                                                                                                                                      |
| `POST` | `/api/invites`                | Session only                                                | `{ workspaceId, expiresInDays?, maxUses?, role? }` returns an invite `url` (expiry 7 days by default, 90 at most). `role` is `member` (default) or `viewer`. Viewers can't create links. |
| `GET`  | `/api/invites/{token}`        | None                                                        | Preview an invite                                                                                                                                                                        |
| `POST` | `/api/invites/{token}/accept` | Session only                                                | Join the workspace                                                                                                                                                                       |
| `*`    | `/api/keys`, `/api/device/*`  | See [authentication](/docs/agents/reference/authentication) | Keys and the device flow                                                                                                                                                                 |

To list workspaces with an API key, use the MCP `list_workspaces` tool with an account-wide key.

## Content types

When a write doesn't send a `Content-Type`, the file's type comes from its extension. Anything else is stored as `application/octet-stream`.

| Extension                     | Content type       |
| ----------------------------- | ------------------ |
| `.md`, `.markdown`            | `text/markdown`    |
| `.txt`, `.log`                | `text/plain`       |
| `.csv`                        | `text/csv`         |
| `.html`, `.htm`               | `text/html`        |
| `.css`                        | `text/css`         |
| `.json`                       | `application/json` |
| `.yaml`, `.yml`               | `application/yaml` |
| `.toml`                       | `application/toml` |
| `.xml`                        | `application/xml`  |
| `.js`, `.mjs`, `.cjs`, `.jsx` | `text/javascript`  |
| `.ts`, `.mts`, `.cts`, `.tsx` | `text/typescript`  |
| `.vue`                        | `text/x-vue`       |
| `.py`                         | `text/x-python`    |
| `.sql`                        | `application/sql`  |
| `.sh`, `.bash`, `.zsh`        | `application/x-sh` |
| `.svg`                        | `image/svg+xml`    |
| `.png`                        | `image/png`        |
| `.jpg`, `.jpeg`               | `image/jpeg`       |
| `.gif`                        | `image/gif`        |
| `.webp`                       | `image/webp`       |
| `.mp4`, `.m4v`                | `video/mp4`        |
| `.webm`                       | `video/webm`       |
| `.mov`                        | `video/quicktime`  |
| `.ogv`                        | `video/ogg`        |
| `.mp3`                        | `audio/mpeg`       |
| `.m4a`                        | `audio/mp4`        |
| `.aac`                        | `audio/aac`        |
| `.wav`                        | `audio/wav`        |
| `.flac`                       | `audio/flac`       |
| `.ogg`, `.oga`, `.opus`       | `audio/ogg`        |
| `.pdf`                        | `application/pdf`  |
| `.zip`                        | `application/zip`  |

A video or audio file stored as `application/octet-stream`, which older sync clients sent for these extensions, is served with the type its extension names, so browsers can play it.

## Size limits

| Limit                  | Value                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single file            | Your plan's per-file limit, and never more than the server's ceiling (100 MB unless the operator changes it). Oversized uploads are rejected before they are stored. |
| Storage and file count | Per workspace, by plan. See [plans and limits](/docs/account/plans-and-limits).                                                                                      |
| Workspace icon         | 1 MiB                                                                                                                                                                |
| Search query           | 200 characters                                                                                                                                                       |
| Change feed page       | 1000 changes                                                                                                                                                         |