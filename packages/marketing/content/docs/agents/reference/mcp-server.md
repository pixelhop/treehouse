---
title: MCP server
description: Every tool the Treehouse MCP server exposes, with parameters, outputs, limits and the instructions it gives connected agents.
type: reference
position: 2
updated: 2026-10-30
related:
  - /docs/agents/connect/claude-code
  - /docs/agents/connect/other-agents
  - /docs/agents/handbook/versions-and-conflicts
---

## Connection

| Setting     | Value                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint    | `https://api.trytree.house/api/mcp`                                                                                                                              |
| Transport   | Streamable HTTP, stateless (no session id), JSON responses                                                                                                       |
| OAuth       | Supported: OAuth 2.1 with PKCE and dynamic client registration. Protected resource metadata at `https://api.trytree.house/.well-known/oauth-protected-resource`. |
| API key     | `x-api-key: <key>` header. An API key sent as `Authorization: Bearer` is not accepted.                                                                           |
| Server name | `treehouse`                                                                                                                                                      |

A client that supports MCP authorisation needs only the URL. It signs the person in through the browser when it first connects:

```json [mcp.json]
{
  "mcpServers": {
    "treehouse": {
      "type": "http",
      "url": "https://api.trytree.house/api/mcp"
    }
  }
}
```

To use an API key instead, add a header:

```json [mcp.json]
{
  "mcpServers": {
    "treehouse": {
      "type": "http",
      "url": "https://api.trytree.house/api/mcp",
      "headers": { "x-api-key": "th_example_key" }
    }
  }
}
```

The exact configuration format depends on your client; [connect other agents](/docs/agents/connect/other-agents) has examples. Every tool call is attributed exactly as a REST request would be: to an API key's actor type (`agent` or `human`) and name, or for an OAuth connection, always as an agent, labelled with the name the person gave the connection. See [authentication](/docs/agents/reference/authentication).

## Two tool sets

Which tools a client sees depends on the credential it connects with.

| Credential                                                        | Tools                                                                                                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth connection, or an account-wide key (created in the web app) | All the tools below. Every tool except `list_workspaces` and `create_workspace` takes a required `workspaceId` string, checked against your membership on each call. |
| Workspace-scoped (device flow)                                    | The same tools without `list_workspaces` and `create_workspace`, and without a `workspaceId` parameter: every call acts on the key's workspace.                      |

The parameter tables below omit `workspaceId`. Add it when you connect with OAuth or an account-wide key.

## Server instructions

Connected clients receive these instructions with the tool list. They are quoted exactly:

```text
Treehouse is a shared file workspace for humans and agents. Files are plain bytes; a markdown file may begin with a YAML front-matter block (--- ... ---) carrying metadata.

To change part of an existing text file, use edit_file (the exact text to replace, plus its replacement) rather than resending the whole file with write_file. It is cheaper, and it still lands when someone else has changed a different part of the file since you read it.

Read AGENTS.md at the workspace root before doing anything else, if it exists. It carries that workspace's own conventions — how it is organised and what belongs where. In a workspace that has not been set up yet, it instead carries a setup guide: follow it when the user asks you to set up, bootstrap, or organise the workspace.

Front-matter conventions the web UI understands — set them by writing the file, no special API needed:
- "date: YYYY-MM-DD" on a markdown file places it on its folder's Calendar view for that day. Change the date to reschedule it; remove it to take it off the calendar. Only files with a valid date appear there.
- A folder's README.md (or index.md) front matter can declare "view: calendar" to make the folder open as a calendar, and "title:" to give the folder a human-readable heading (shown instead of the raw folder name).
- Boards: "view: board" in a folder's README front matter makes the folder open as a board, with "columns: [To do, Doing, Done]" listing its columns in order. Each markdown file in the folder is a card; its "status:" names its column (matched case-insensitively). Move a card by changing its status; a status not in columns still shows, as an extra column; a card with no status sits in a "No status" lane. "order:" (a number) sets a card's place within its column, lowest first; cards without one follow, by title. "assignee:" is a name or a list of names (use list_members for the people in the workspace; anyone else, including an agent, is fine as free text), "due: YYYY-MM-DD" shows a due date, "tags:" shows labels, and "- [ ]" task lines in the body show as a checklist count. A columns entry can also be a map with a colour, like "{ name: Doing, color: orange }". "card_fields" in the README picks which other front-matter keys show as chips on every card (default: tags), each a key name or a map like "{ name: company, colors: { Acme: blue } }" that colours chips by value. Colours: gray, brown, orange, yellow, green, blue, purple, pink, red.

Notes link to each other with Obsidian-style wikilinks: [[Note]], [[Note|shown text]], [[Note#Heading]]. A wikilink names a file, not a path: case doesn't matter, .md is optional, and a folder prefix ([[Projects/Note]]) picks between files with the same name. Relative markdown links ([text](../other.md)) work too. Use get_links on a file to see which notes link to it and where its own links lead. move_file keeps links working: it rewrites the links that pointed at the old path.

Tag notes with "tags: [a, b]" in front matter or with inline #tags in the text (#project/alpha nests under #project). Use list_tags to see the tags in use, and list_tags with a tag to find the notes carrying it. Reuse existing tags rather than inventing near-duplicates.

Anything the web UI does with front matter is a plain-file operation, so reading and writing files is enough to participate in those. Comments are the exception: they are review threads held by the server, not files, and only the comment tools can see them.

Reviewers comment on markdown files by quoting the text they mean — there are no line numbers. When asked to address comments on a file: list_comments for that path, read_file it (note the returned version), make your changes with edit_file (or write_file for a full rewrite) using that version as baseVersion, then reply_comment on each thread saying what you changed, and resolve_comment only the threads you actually fixed. Don't resolve what you didn't fix — reply instead. A thread whose anchorStatus is not "anchored" refers to text that has since changed: read_file_version at its pinnedVersion to see the document it was written against. Use add_comment to raise a question of your own, quoting the passage it is about.

A tool error beginning "Read-only:" means you can see this but may not change it, and one beginning "Outside this key's folder" means the key doesn't reach that path. Retrying won't help and neither will a different tool: say so and stop, or leave a comment instead. Comments are open to anyone who can read a file.

A key with limits gets a line about them at the end of these instructions, so an agent knows before it starts.
```

The front-matter conventions are described in [front matter](/docs/files/front-matter), [folder pages](/docs/files/folder-pages) and [boards](/docs/files/boards). Wikilinks are described in [link notes together](/docs/files/link-notes), and tags in [tag notes](/docs/files/tag-notes).

## Result conventions

- Most tools return a short text summary plus a `structuredContent` object. Read values such as `version` from `structuredContent`, not by parsing the text: file content can contain anything.
- **Hard errors** set `isError: true` with a text message: not found, invalid path, file too large, read-only workspace, a refused share, a stale delete, and malformed input. Paths you can't see (another member's private files) are reported as not found.
- **View-only access** is a hard error beginning `Read-only:`, naming what wasn't changed. It means the key's owner is a [Viewer](/docs/sharing/invite-people#roles), or the [key is read-only](/docs/agents/connect/api-keys#limit-what-a-key-can-do). Don't retry it. Reading and commenting still work.
- **A path outside a limited key's folder** is a hard error beginning `Outside this key's folder`, whether or not the path exists. Paths inside it work as normal.
- **Recoverable outcomes** are returned as data with `ok: false`, so the agent keeps its work and can retry: a `write_file` or `edit_file` version conflict (your content is saved as a conflicted copy), an `edit_file` `oldString` that doesn't match, a storage or file-count limit, and an `add_comment` quote that can't be placed.
- Paths are workspace-relative with `/` separators, such as `Projects/plan.md`. A leading `/` and `.` segments are ignored; `..`, backslashes, null bytes and an empty path are rejected with `Invalid path: …`.

## Workspaces

### list_workspaces

Lists the workspaces the credential can reach. OAuth connections and account-wide keys only. No parameters.

Output: `{ workspaces: [{ id, name }] }`.

### create_workspace

Creates a workspace owned by you, with no other members. OAuth connections and account-wide keys only. Subject to your plan's workspace allowance.

| Parameter | Type   | Required | Description                                                                                    |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `name`    | string | Yes      | Workspace name.                                                                                |
| `icon`    | string | No       | An emoji or an Iconify name. For an image, create first, then call `set_workspace_image_icon`. |
| `color`   | string | No       | `blue`, `violet`, `emerald`, `amber`, `rose`, `cyan`, `slate` or `neutral`.                    |

Output: `{ id, name }`. New workspaces start with a `README.md` and an `AGENTS.md` setup guide unless the server disables seeding.

### set_workspace

Updates the workspace's display settings. Pass an empty string to clear `icon`, `color` or `theme`. An empty `name` is ignored.

| Parameter | Type   | Required | Description                                                                        |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------- |
| `name`    | string | No       | New name.                                                                          |
| `icon`    | string | No       | An emoji or an Iconify name.                                                       |
| `color`   | string | No       | `blue`, `violet`, `emerald`, `amber`, `rose`, `cyan`, `slate` or `neutral`.        |
| `theme`   | string | No       | `light`, `dark`, `dracula`, `nord`, `solarized-light`, `rose-pine` or `treehouse`. |

Output: `{ id, name, icon, color, theme }`.

### set_workspace_image_icon

Sets an image as the workspace icon.

| Parameter | Type   | Required | Description                                                                                                                              |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `content` | string | Yes      | Base64-encoded PNG, JPEG, GIF or WebP, up to 1 MiB. Square images around 256×256 look best; other shapes are letterboxed, never cropped. |

Output: `{ id, name, icon }`.

### get_usage

Storage and file-count usage against the workspace's plan. No parameters.

Output: `{ usedBytes, limitBytes, remainingBytes, warning, usedFiles, limitFiles, remainingFiles }`. Limits and remaining values are `null` when unlimited. `warning` is `true` once the file count reaches 90% of its limit. See [plans and limits](/docs/account/plans-and-limits).

### list_members

The people in the workspace, so an agent can assign a [board](/docs/files/boards) card to a real person. No parameters. Email addresses and user IDs are never returned.

Output: `{ members: [{ name, role }] }`, oldest member first. `role` is `owner`, `admin` or `member`. The text form is one `name<TAB>role` line per member.

Write a member's `name` exactly as returned into a card's `assignee` and the app shows their avatar. Anyone else, including an agent, can be written as free text.

## Files

### list_files

Lists files under an optional folder, sorted by path. Hidden `.keep` placeholders are omitted.

| Parameter | Type    | Required | Description                                                       |
| --------- | ------- | -------- | ----------------------------------------------------------------- |
| `prefix`  | string  | No       | Folder to list, such as `Projects`. Omit for the whole workspace. |
| `limit`   | integer | No       | Maximum entries. Default and maximum 1000.                        |
| `offset`  | integer | No       | Entry to start from, for paging.                                  |

Output: text only, one line per file in the form `path<TAB>(v3, 1204 bytes)`. When there are more entries, the last line says how many and which `offset` to pass next. An empty result is `(no files)`.

### search_files

Fuzzy search over file and folder names and paths, not contents. The characters of the query must appear in order but need not be adjacent: `clinot` matches `Clients/acme/notes.md`. Results are ranked best first and there is no paging, so narrow the query instead.

| Parameter | Type    | Required | Description                               |
| --------- | ------- | -------- | ----------------------------------------- |
| `query`   | string  | Yes      | Text to match.                            |
| `limit`   | integer | No       | Maximum results. Default 50, maximum 200. |

Output: `{ results: [{ path, name, isDir }], totalMatches }`. `totalMatches` counts every match before the limit. The text summary frames names as untrusted data, because anyone in the workspace can name a file.

### read_file

Reads a file's current bytes and version.

| Parameter  | Type    | Required | Description                                                                         |
| ---------- | ------- | -------- | ----------------------------------------------------------------------------------- |
| `path`     | string  | Yes      | File path.                                                                          |
| `encoding` | string  | No       | `utf8` (default) or `base64`. Use `base64` for images, PDFs and other binary files. |
| `maxBytes` | integer | No       | Read at most this many bytes, starting at `offset`.                                 |
| `offset`   | integer | No       | Byte offset to start from.                                                          |

Output: `{ version, contentType, content }`. Keep `version`: it is the `baseVersion` for your next write.

A single response is capped at 1 MiB. A larger file read without `maxBytes` or `offset` is refused with its size, and `maxBytes` above the cap is clamped to it. Read a large file in windows by advancing `offset`.

### write_file

Creates a file, or replaces all of one. To change part of an existing text file, [`edit_file`](#editfile) is cheaper and less likely to conflict.

| Parameter     | Type    | Required | Description                                                    |
| ------------- | ------- | -------- | -------------------------------------------------------------- |
| `path`        | string  | Yes      | File path. Missing parent folders are created implicitly.      |
| `content`     | string  | Yes      | The complete new content.                                      |
| `baseVersion` | integer | No       | The version you last read. Omit only when creating a new file. |
| `encoding`    | string  | No       | `utf8` (default) or `base64`.                                  |

| Outcome               | `structuredContent`                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Written               | `{ ok: true, version }`                                                                          |
| Version conflict      | `{ ok: false, currentVersion, conflictCopyPath }`. Your content was saved at `conflictCopyPath`. |
| Storage limit reached | `{ ok: false, quotaExceeded: true, usedBytes, limitBytes }`. Nothing written.                    |
| File limit reached    | `{ ok: false, fileCountExceeded: true, usedFiles, limitFiles }`. Nothing written.                |

How `baseVersion` is handled:

- **Omitted, path doesn't exist:** the file is created at version 1.
- **Omitted, path exists:** if your content is byte-for-byte identical, the call succeeds and returns the existing version. If it differs, nothing is overwritten: your content is saved as a conflicted copy and the result is `ok: false`.
- **Matches the current version:** the file is updated and the version goes up by one.
- **Stale:** identical content succeeds without a new version; different content becomes a conflicted copy. If the file was deleted since you read it, your write recreates it at version 1.

A file larger than the workspace's per-file limit is a hard error. A read-only workspace (lapsed subscription) is a hard error. [Versions and conflicts](/docs/agents/handbook/versions-and-conflicts) explains the rules in full.

### edit_file

Changes part of a text file without sending the whole file: replaces `oldString` with `newString`. This is the usual way for an agent to change an existing file.

| Parameter     | Type    | Required | Description                                                                                               |
| ------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `path`        | string  | Yes      | File path.                                                                                                |
| `oldString`   | string  | \*       | The exact text to replace, including whitespace, indentation and line breaks. Must not be empty.          |
| `newString`   | string  | \*       | The replacement. An empty string deletes `oldString`.                                                     |
| `replaceAll`  | boolean | No       | Replace every occurrence. Without it, `oldString` must appear exactly once.                               |
| `edits`       | array   | \*       | Up to 50 edits, each `{ oldString, newString, replaceAll? }`. Use instead of `oldString` and `newString`. |
| `baseVersion` | integer | Yes      | The version you last read.                                                                                |

\* Pass either `oldString` and `newString`, or `edits`, not both. Edits in a list apply in order, each to the result of the one before, and either all of them land or none do.

| Outcome                     | `structuredContent`                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Edited                      | `{ ok: true, version, replacements }`                                                                |
| Edited on a newer version   | `{ ok: true, version, replacements, rebasedFrom }`. See below.                                       |
| `oldString` not in the file | `{ ok: false, error: "old_string_not_found", currentVersion, editIndex }`. Nothing written.          |
| `oldString` matches twice+  | `{ ok: false, error: "old_string_ambiguous", currentVersion, editIndex, matches }`. Nothing written. |
| Version conflict            | `{ ok: false, currentVersion, conflictCopyPath }`. Your edited file was saved at `conflictCopyPath`. |
| Retry can't be checked      | `{ ok: false, error: "retry_unverifiable", currentVersion }`. Nothing written. See below.            |
| Storage or file limit       | As for `write_file`. Nothing written.                                                                |

`editIndex` counts from 0 and says which edit in the list failed. To fix an ambiguous match, include more of the surrounding text in `oldString`, or pass `replaceAll: true` if you mean every occurrence.

How `baseVersion` is handled:

- **Matches the current version:** the edit is applied and the version goes up by one.
- **Stale, and the text you targeted is unchanged:** someone else changed a different part of the file. The edit is applied to the current version anyway, both changes are kept, and the result includes `rebasedFrom` (your `baseVersion`). Re-read the file if your change depends on what they changed.
- **Stale, and the text you targeted has changed:** the edit is applied to the version you read and saved as a conflicted copy, exactly as a stale `write_file` would be. The file itself is untouched.
- **Stale, and `oldString` isn't in either version:** nothing is written, and you get `old_string_not_found` with the current version.
- **A retry of an edit that already landed** (the same edit and `baseVersion`, sent again after a reply that never arrived): Treehouse checks the writes your key has made to the file since `baseVersion`. If one of them is exactly this edit, the call succeeds with the current version and writes nothing, even if other people have written since, so the edit isn't applied twice. (The most recent 20 of your writes since `baseVersion` are checked.) An identical change made by someone else doesn't count: your edit is then treated as a new one.
- **A retry that can't be checked:** if your key has written the file since `baseVersion` but that write can't be compared with this edit (it was made to the first version of a conflicted copy, or to a very old version), nothing is written and you get `retry_unverifiable`. Re-read the file, and edit the current version if your change isn't there.

The file must be UTF-8 text. A binary file (anything that isn't valid UTF-8, or contains a null byte) is a hard error: use `write_file` with `encoding: "base64"` instead. A missing file is a hard error, including one deleted since you read it: unlike `write_file`, `edit_file` never recreates a deleted file (use `write_file` if you mean to). An empty `oldString`, and an `oldString` identical to its `newString` are hard errors too. An edit that would make the file larger than the workspace's per-file limit is a hard error, refused before it is built. Otherwise the edited file is subject to the same storage, file-count and read-only checks as `write_file`.

### move_file

Moves or renames one file. Folders are moved by moving their files.

| Parameter     | Type    | Required | Description                                                  |
| ------------- | ------- | -------- | ------------------------------------------------------------ |
| `from`        | string  | Yes      | Current path.                                                |
| `to`          | string  | Yes      | New path.                                                    |
| `updateLinks` | boolean | No       | Rewrite links to the file so they follow it. Default `true`. |

Output: text only. Fails if `to` already exists. There is no `baseVersion`: the move applies to whatever the current version is. The file restarts at **version 1** at its new path, and its comment threads move with it. Re-read before writing to the new path.

With `updateLinks` on, the wikilinks and relative markdown links that reached the file are rewritten to reach its new path, in every note you can edit, and the moved note's own relative links are adjusted for its new folder. Only the link target changes: aliases, headings and every other byte are kept. Each rewritten note gets a new version attributed to your key. The text names the notes that were updated, and any that may still point at the old path: ones that changed during the move and couldn't be updated, and ones too large or unreadable to check for links. A wikilink that still resolves after the move (a note moved between folders, keeping its name) is left alone. A note is also listed as not updated when the new name can't be written in its link: a wikilink can't hold `#`, `|` or brackets. If older notes are still being indexed, the call fails with nothing moved; call it again, since each call indexes more, or pass `updateLinks: false`.

### get_links

Follows links between notes. Returns the notes that link to a file, the file's tags, and the links the file itself makes, each resolved to the file it reaches.

| Parameter | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `path`    | string | Yes      | File path.  |

Output: `{ path, backlinks, outgoing, tags, complete }`.

- `backlinks` is the sorted list of notes whose wikilinks or relative markdown links reach `path`.
- `outgoing` lists the file's own links, once each: `{ kind, target, path }`, where `kind` is `wikilink` or `markdown`, `target` is the link as written (a wikilink's name without alias or heading, or a markdown link's destination) and `path` is the file it reaches, or `null` when it reaches nothing.
- `tags` lists the file's own tags, front matter first, as written. See [`list_tags`](#list_tags).
- `complete: false` means notes written before links were indexed are still being processed, so `backlinks` may be missing some. Call again.

Wikilinks resolve by name: capitals don't matter, `.md` is optional, a folder prefix such as `[[Projects/Plan]]` picks between notes with the same name, and a still-ambiguous name reaches the matching note nearest the workspace root. Everything is computed from the files your key's user can see: a private note never appears in `backlinks`, and never changes where a link resolves. A path you can't see is reported as not found. See [link notes together](/docs/files/link-notes).

### list_tags

Lists the tags on notes, or finds the notes with a tag. A note's tags come from its front matter (`tags: [a, b]` or `tags: a, b`) and from inline `#tags` in its text.

| Parameter | Type    | Required | Description                                                   |
| --------- | ------- | -------- | ------------------------------------------------------------- |
| `tag`     | string  | No       | A tag, with or without `#`. Omit it to list every tag in use. |
| `limit`   | integer | No       | Maximum entries. Default and maximum 1000.                    |
| `offset`  | integer | No       | Entry to start from, for paging.                              |

Output: `{ tags: [{ tag, count }], paths, more, nextOffset, complete }`.

- Without `tag`: every tag on a note you can see, sorted by name, with how many notes carry it. A tag is shown as it was first written. `paths` is empty: ask for a tag to get its notes.
- With `tag`: one entry in `tags`, and the notes tagged with it or with a tag nested under it in `paths`, so `project` also finds notes tagged `project/alpha`. Fails if `tag` is empty or too long.
- `more` says how many entries are left. Pass `nextOffset` as `offset` to read them.
- Tags are case-insensitive. A private note you can't see is never listed or counted.
- `complete: false` means older notes are still being indexed. Call again.

See [tag notes](/docs/files/tag-notes).

### delete_file

Deletes a file.

| Parameter     | Type    | Required | Description                |
| ------------- | ------- | -------- | -------------------------- |
| `path`        | string  | Yes      | File path.                 |
| `baseVersion` | integer | Yes      | The version you last read. |

Output: text only. If the file has changed since `baseVersion`, nothing is deleted and the call returns an error naming the current version. Re-read before deciding again.

### set_file_icon

Sets the icon shown for a file or folder.

| Parameter | Type   | Required | Description                                                                                                         |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `path`    | string | Yes      | File or folder path, up to 1024 characters.                                                                         |
| `icon`    | string | No       | An emoji or an Iconify name such as `solar:document-bold-duotone`, up to 64 characters. Empty or omitted clears it. |

Output: text only.

### set_private

Makes a file or folder private to the person the agent acts as (the key's owner, or whoever approved the connection), or shared again. A private folder hides its whole subtree from other members.

| Parameter | Type    | Required | Description                                                          |
| --------- | ------- | -------- | -------------------------------------------------------------------- |
| `path`    | string  | Yes      | File or folder path, up to 1024 characters.                          |
| `kind`    | string  | No       | `file` or `folder`. Defaults to `folder`, so pass `file` for a file. |
| `private` | boolean | No       | `true` (default) to make private, `false` to share again.            |

Output: text only. Only the owner can make a private item shared again. Something [shared with specific people](/docs/files/private-files) can only be changed in the web app. A [Viewer](/docs/sharing/invite-people#roles) gets a `Read-only:` error.

## History

### read_file_version

Reads the bytes of an earlier version.

| Parameter  | Type    | Required | Description                   |
| ---------- | ------- | -------- | ----------------------------- |
| `path`     | string  | Yes      | File path.                    |
| `version`  | integer | Yes      | Version number to read.       |
| `encoding` | string  | No       | `utf8` (default) or `base64`. |

Output: `{ version, contentType, content }`. If that version's content isn't available, the call returns an error.

### restore_file

Restores an earlier version as a new version on top of the history. Nothing is overwritten or removed.

| Parameter       | Type    | Required | Description                |
| --------------- | ------- | -------- | -------------------------- |
| `path`          | string  | Yes      | File path.                 |
| `targetVersion` | integer | Yes      | The version to bring back. |

Output: `{ status: "ok", version, restoredFrom }`, or `{ status: "conflict", conflictCopyPath }` if other writes kept winning and the restored content was saved as a conflicted copy instead.

## Trash

### list_trash

Lists deleted files you can see, newest deletion first, with who deleted them. Renamed or moved files aren't listed: they still exist at their new path.

| Parameter | Type    | Required | Description                                      |
| --------- | ------- | -------- | ------------------------------------------------ |
| `prefix`  | string  | No       | Only files that were in this folder.             |
| `limit`   | integer | No       | Maximum entries. Default 100, maximum 500.       |
| `before`  | integer | No       | `nextBefore` from the previous page, to page on. |

Output: `{ items: [{ path, deletedAt, deletedBy, restorable }], nextBefore }`. `deletedBy` is `human`, or `agent (<key name>)`. `restorable` is `false` when the content from before the deletion was never recorded. `nextBefore` is `null` on the last page.

### restore_from_trash

Brings deleted files back at their old paths, each with the content it had just before it was deleted. It only recreates files: nothing is overwritten or deleted.

| Parameter | Type     | Required | Description                                                  |
| --------- | -------- | -------- | ------------------------------------------------------------ |
| `paths`   | string[] | Yes      | Paths from `list_trash`. At most 5,000.                      |
| `dryRun`  | boolean  | No       | `true` to report what would happen without changing a thing. |

Output: `{ restored: [path], skipped: [{ path, reason }], dryRun }`. A file that can't come back is skipped and the rest still are. Reasons:

| `reason`        | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `not_in_trash`  | Nothing deleted at that path that you can see, or it's been recreated |
| `unavailable`   | Its content wasn't recorded, or can't be read                         |
| `storage_limit` | It would take the workspace over its storage limit                    |
| `file_limit`    | It would take the workspace over its file limit                       |
| `too_large`     | It's larger than the plan's largest file                              |
| `read_only`     | The workspace is read-only                                            |
| `changed`       | Something was written at that path while the restore ran              |
| `failed`        | An unexpected error. Try again.                                       |

Each restored file shows in the change feed as a `restore` event. Its version carries on from the file's last version before it was deleted, rather than starting again at 1. The activity feed groups the restored files as one entry.

::callout{type="agent"}
Restore only what the person asked for. If a file is skipped for `storage_limit` or `file_limit`, tell them which limit was reached rather than retrying.
::

## Restore to an earlier time

### preview_restore_to

Shows what putting a folder, or the whole workspace, back the way it was at an earlier time would change. Changes nothing.

| Parameter | Type   | Required | Description                                                    |
| --------- | ------ | -------- | -------------------------------------------------------------- |
| `path`    | string | No       | Folder to restore. Omit for the whole workspace.               |
| `at`      | string | Yes      | The moment to go back to, as ISO 8601: `2026-10-29T15:00:00Z`. |

Output: `{ previewToken, changes: [{ kind, path, from? }], skipped: [{ path, reason }], tooLarge }`. `kind` is `restore` (earlier content as a new version), `recreate` (a deleted file comes back), `move` (a renamed file goes back to `path` from `from`) or `delete` (a file created since goes to the trash). Skip reasons are as for [restore_from_trash](#restorefromtrash), plus `private_then` (the file was private to someone else at that moment), `name_taken` (it was renamed since and another file has its old name now), `access_changed` (who can reach it has changed since then) and `linked` (it was renamed together with a file that's being left alone, so it stays put too). Only files you can see are considered; other members' private files are never listed.

### restore_to

Applies a restore you previewed. Pass the same `path` and `at`, and the `previewToken` from `preview_restore_to`. Only the changes the preview listed are made. Anything that changed after the preview is skipped as `changed` rather than undone unseen, and anything the preview didn't list (say, a file left alone for a limit that has since freed up) is skipped as `not_previewed`.

| Parameter      | Type   | Required | Description                      |
| -------------- | ------ | -------- | -------------------------------- |
| `path`         | string | No       | As in the preview.               |
| `at`           | string | Yes      | As in the preview.               |
| `previewToken` | string | Yes      | `previewToken` from the preview. |

Output: `{ changes, skipped }`, as in the preview, for what actually happened. It's recorded as one entry in the activity feed.

::callout{type="agent"}
Only restore when the person asked you to. Show them the preview first: a restore can delete files created since (to the trash) and undo other people's recent work.
::

## Undo your own changes

These tools only ever undo changes made with the key the agent is connected with. They can't undo another agent's work or a person's: that's left to people in the app, so an agent can't be talked into undoing a colleague's work by something it reads.

### preview_undo_my_changes

Shows what undoing everything this key changed since a moment would do. Changes nothing.

| Parameter | Type   | Required | Description                                       |
| --------- | ------ | -------- | ------------------------------------------------- |
| `since`   | string | Yes      | Undo changes made after this moment, as ISO 8601. |

Output: `{ previewToken, changes, skipped, tooLarge }`, as for [preview_restore_to](#previewrestoreto). Each file goes back to how it was just before this key's first change to it. A file someone else changed afterwards is skipped as `edited_later`, with `detail` naming who.

### undo_my_changes

Applies it. Pass the same `since` and the `previewToken`. As for [restore_to](#restoreto), only the changes the preview listed are made.

| Parameter      | Type   | Required | Description                      |
| -------------- | ------ | -------- | -------------------------------- |
| `since`        | string | Yes      | As in the preview.               |
| `previewToken` | string | Yes      | `previewToken` from the preview. |

Output: `{ changes, skipped }`. It appears in the activity feed as one entry, "undid N changes by" the key's name.

## Sharing

### create_share

Creates a member link to a file or folder: a link that only workspace members can open.

| Parameter | Type   | Required | Description                                     |
| --------- | ------ | -------- | ----------------------------------------------- |
| `path`    | string | Yes      | File or folder path.                            |
| `kind`    | string | Yes      | `file` or `folder`.                             |
| `access`  | string | No       | Only `member` is accepted. `public` is refused. |

Output: `{ id, path, access, memberUrl }`. Public and password-protected links can only be made by a person signed in to the web app, whatever credential the agent uses, so a leaked key or token can't publish your files. Private items can't be shared.

### list_shares

| Parameter | Type   | Required | Description          |
| --------- | ------ | -------- | -------------------- |
| `path`    | string | Yes      | File or folder path. |

Output: `{ shares: [...] }`, the active shares on exactly that path.

### revoke_share

| Parameter | Type   | Required | Description       |
| --------- | ------ | -------- | ----------------- |
| `shareId` | string | Yes      | The share's `id`. |

Output: text only.

## Comments

Comment threads live on markdown files and are anchored by quoting text, never by line or character position. See [comments](/docs/sharing/comments) for how they look to people.

### list_comments

| Parameter       | Type    | Required | Description                                      |
| --------------- | ------- | -------- | ------------------------------------------------ |
| `path`          | string  | No       | Only threads on this file.                       |
| `threadId`      | string  | No       | Read one thread.                                 |
| `status`        | string  | No       | `open` or `resolved`.                            |
| `anchorStatus`  | string  | No       | `anchored`, `ambiguous` or `outdated`.           |
| `author`        | string  | No       | Only threads started by this user id.            |
| `limit`         | integer | No       | Threads per page. Default 50, maximum 200.       |
| `offset`        | integer | No       | Thread to start from.                            |
| `entriesLimit`  | integer | No       | Replies per thread. Default 20, maximum 100.     |
| `entriesOffset` | integer | No       | Reply to start from, to read past the first 100. |

Output: `{ threads, total, more, nextOffset, truncated }`. Each thread has `id`, `path`, `status`, `anchorKind`, `quote`, `contextBefore`, `contextAfter`, `currentText` (the matching text now, or `null` once the anchor stops resolving), `pinnedVersion` (the version it was written against), `anchorStatus`, `createdBy`, `entries`, `entryCount` and resolution details. `nextOffset` is `null` on the last page. `truncated: true` means an `anchorStatus` filter stopped scanning early; narrow the other filters rather than paging.

### add_comment

Starts a thread on a markdown file.

| Parameter       | Type    | Required    | Description                                                             |
| --------------- | ------- | ----------- | ----------------------------------------------------------------------- |
| `path`          | string  | Yes         | Markdown file path.                                                     |
| `body`          | string  | Yes         | The comment, up to 64 KiB.                                              |
| `quote`         | string  | For `range` | The exact text being commented on, up to 4 KiB.                         |
| `contextBefore` | string  | No          | Text just before the quote (or the point), up to 512 bytes.             |
| `contextAfter`  | string  | No          | Text just after, up to 512 bytes.                                       |
| `occurrence`    | integer | No          | Which match to use (from 1) when the quote appears more than once.      |
| `kind`          | string  | No          | `range` (default) or `point`. A point needs both contexts and no quote. |
| `baseVersion`   | integer | No          | The version you copied the quote from.                                  |

| Outcome                     | `structuredContent`                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Created                     | `{ ok: true, thread }`                                                               |
| Quote appears several times | `{ ok: false, error: "anchor_ambiguous", occurrences }`                              |
| Quote not in the file       | `{ ok: false, error: "anchor_not_found" }`                                           |
| File changed too much       | `{ ok: false, error: "base_version_conflict", baseVersion, currentVersion, reason }` |

Nothing is created on an `ok: false` result. A non-markdown file is a hard error.

### reply_comment

| Parameter   | Type   | Required | Description                                                                                                        |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `threadId`  | string | Yes      | The thread.                                                                                                        |
| `body`      | string | Yes      | The reply, up to 64 KiB.                                                                                           |
| `dedupeKey` | string | No       | Any string unique to this reply. Send one every time: a retried call with the same key records one reply, not two. |

Output: `{ ok: true, entry, deduped }`. `deduped: true` means the reply already existed.

### resolve_comment

| Parameter  | Type    | Required | Description                           |
| ---------- | ------- | -------- | ------------------------------------- |
| `threadId` | string  | Yes      | The thread.                           |
| `resolved` | boolean | Yes      | `true` to resolve, `false` to reopen. |

Output: `{ ok: true, resolved, changed, resolvedAt, resolvedAtVersion, resolvedBy }`. Idempotent: `changed: false` means it was already in that state.

## Limits

| Limit                            | Value                                                          |
| -------------------------------- | -------------------------------------------------------------- |
| `read_file` response             | 1 MiB per call; page larger files with `maxBytes` and `offset` |
| `list_files` entries             | 1000 per call; page with `offset`                              |
| `search_files` results           | Default 50, maximum 200, no paging                             |
| File size on write               | Your plan's per-file limit                                     |
| `edit_file` edits per call       | 50                                                             |
| Comment body / reply             | 64 KiB                                                         |
| Comment quote                    | 4 KiB                                                          |
| Comment context (each side)      | 512 bytes                                                      |
| Threads per `list_comments` page | Default 50, maximum 200                                        |
| Replies per thread per page      | Default 20, maximum 100                                        |
| Workspace image icon             | 1 MiB                                                          |