---
title: Versions and conflicts
description: The concurrency contract every Treehouse client shares - version numbers, compare-and-swap writes, conflicted copies, deletes, moves and restores.
type: concept
position: 1
updated: 2026-10-29
related:
  - /docs/files/conflicted-copies
  - /docs/agents/reference/rest-api
  - /docs/agents/reference/mcp-server
---

Treehouse never loses a write. Every surface (the web app, synced folders, MCP and REST) goes through one file service that applies the rules on this page, so they hold whoever or whatever is writing.

## The rules

| Situation                                   | Result                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| New file                                    | Created at version 1                                                                             |
| Write with the current version as the base  | Saved; the version goes up by exactly one                                                        |
| Write with a stale base, different content  | The file is untouched. Your bytes are saved as a **conflicted copy** and the response names it.  |
| Write with a stale base, identical content  | Succeeds, returning the current version. No copy, no new version.                                |
| Write to a file deleted since you read it   | The edit wins: the file is recreated at version 1 with your content                              |
| Partial edit with a stale base              | Applied to the current version if the text it replaces is unchanged; otherwise a conflicted copy |
| Delete with the current version as the base | Deleted                                                                                          |
| Delete with a stale base                    | Nothing is deleted (`412`, or an MCP error naming the current version)                           |
| Move                                        | The file restarts at version 1 at its new path                                                   |
| Restore                                     | The old bytes become a new version on top of the history                                         |

## Versions

A file's version is an integer that starts at 1 and goes up by one with each successful write. You get it back from every read (`X-Treehouse-Version` over REST, `version` from `read_file`) and every write.

Version numbers are per path, and a path that is deleted and later recreated starts again at 1. When you need to name exact bytes, use the content hash (`X-Treehouse-Content-Hash`) instead: it is a SHA-256 of the content and is never reused.

## Compare-and-swap writes

To update a file, tell Treehouse which version you based your edit on:

- **MCP:** `write_file` or `edit_file` with `baseVersion`.
- **REST:** `PUT` with `If-Match: "<version>"`.

If the file is still at that version, your write lands. If someone else wrote first, the file is left as they wrote it and your content is saved next to it as a conflicted copy.

## Partial edits

`edit_file` sends only the text to replace and its replacement, not the whole file. Because an edit names the text it changes, it can survive someone else's change elsewhere in the file:

- If the file is still at your `baseVersion`, the edit lands like any write.
- If the file has moved on but the text you're replacing is still there, unchanged and in one place, the edit is applied to the current version. Both changes are kept, no copy is made, and the result carries `rebasedFrom` so you know it happened.
- If the text you're replacing was itself changed, Treehouse applies your edit to the version you read and saves that as a conflicted copy, the same as a stale `write_file`.
- If your `oldString` isn't in the file at all, nothing is written and you're told the current version.
- If the file has been deleted, `edit_file` reports it as not found. Unlike a full write, an edit never recreates a deleted file.

So the conflicted copies an agent produces are mostly the ones that need a human or agent to decide something. See [`edit_file`](/docs/agents/reference/mcp-server#edit_file) for the parameters.

Creating is the same idea with no base. Over MCP, omit `baseVersion`; over REST, send `If-None-Match: *` (or no precondition, which REST rejects with `428` if the path already exists). If the path turns out to exist with different content, you get a conflicted copy rather than an overwrite.

## Conflicted copies

A conflicted copy sits next to the original, with who and when in its name:

```text
Projects/plan (conflicted copy — agent — 2026-09-29T14:03:12.481Z).md
```

- The middle part is the writer's actor type, `agent` or `human`, from their API key. OAuth connections always write as `agent`.
- The timestamp is the server's time of the conflict, in ISO 8601 UTC.
- If that name is already taken (two different conflicts on the same file, from the same kind of writer, in the same millisecond), the later one gets a counter: `plan (conflicted copy — agent — 2026-09-29T14:03:12.481Z) (2).md`.
- A file without an extension gets the suffix at the end: `Makefile (conflicted copy — human — 2026-09-29T14:03:12.481Z)`.
- If a conflicted copy of that file already holds exactly the same bytes, Treehouse returns that copy's path instead of making another.
- A conflicted copy of a private file is private to the same owner.

The response tells you where your bytes went: `conflictCopyPath` from `write_file`, or `conflict_copy_path` in a REST `412` body. Resolving it is up to you or the person who owns the file; see [conflicted copies](/docs/files/conflicted-copies) for the human side.

## Deletes and moves

A delete also takes a base version (`baseVersion` over MCP, `If-Match` over REST, both required). A stale delete loses: nothing is removed, and you learn the current version. Combined with "a write to a deleted file recreates it", this means an edit always beats a delete that didn't see it.

A move creates the file at its new path and removes the old one in one step. The moved file starts at **version 1**, and the change feed records two events: a `delete` at the old path and a `move` at the new one. Comment threads move with the file. Over MCP a move applies to whatever the current version is; over REST you can pass `baseVersion` to make it conditional.

## Restores

Restoring an old version never rewrites history. The old bytes are written as a new version at the top, attempted up to five times against the latest version if other writes are landing. If other writes keep winning after that, the restored content is saved as a conflicted copy instead. A restore of a file that has since been deleted recreates it at version 1.

## Plan limits

Limits only block a clean write: a new file, or an update whose base is current. They never block the safety paths.

| Check                             | Clean write | Conflicted copy | Move, delete, restore |
| --------------------------------- | ----------- | --------------- | --------------------- |
| Per-file size limit               | Enforced    | Enforced        | Not checked           |
| Storage limit                     | Enforced    | Not checked     | Not checked           |
| File-count limit (new files only) | Enforced    | Not checked     | Not checked           |
| Read-only workspace (lapsed plan) | Enforced    | Not checked     | Not checked           |

So a stale write is always preserved as a copy, even in a workspace that is full or read-only. See [plans and limits](/docs/account/plans-and-limits).

## Worked example

An agent and a person both edit `notes.md`, currently at version 4.

1. The agent reads `notes.md` and gets version 4.
2. The person saves an edit in the web app. `notes.md` is now version 5.
3. The agent writes its edit with `baseVersion: 4`. The base is stale, so `notes.md` stays at version 5 and the agent's content is saved as `notes (conflicted copy — agent — 2026-09-29T14:03:12.481Z).md`. The result is `{ ok: false, currentVersion: 5, conflictCopyPath: "notes (conflicted copy — agent — …).md" }`.
4. The agent reads `notes.md` again (version 5), merges its change into the person's version, and writes with `baseVersion: 5`. It lands as version 6.
5. The agent deletes its conflicted copy, since its content is now merged.

Had the person's edit in step 2 been a delete instead, step 3 would have recreated `notes.md` at version 1 with the agent's content.

## The recommended loop for agents

1. **Read** the file and keep its version.
2. **Change** it with `edit_file` (or, to replace the whole file, `write_file`), passing that version as the base.
3. **If `edit_file` says `oldString` wasn't found or matched more than once**, nothing was written. Re-read if the file has changed, and send a more exact `oldString`.
4. **On a conflict**, re-read the file, merge your change into what's there now, and write again with the new version. Then delete your conflicted copy (reading it first to get its version, which is 1), so the folder stays tidy.
5. Never retry a conflicted write with the same stale base: it will conflict again.

The [agent handbook](/docs/agents/handbook) gives agents the same guidance in their own terms.