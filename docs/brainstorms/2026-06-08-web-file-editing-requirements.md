# Web UI File Editing & Operations — Requirements

**Date:** 2026-06-08
**Status:** Ready for planning
**Scope:** Standard / Deep-feature

## Problem & Outcome

Treehouse is an agent-native + human shared file workspace, but the web UI is **read-only**. Agents can read, write, move, and delete files (via MCP tools); humans browsing the same workspace in the browser cannot edit anything. Today a human's only write path is the local-sync CLI — they must leave the browser to change a file.

**Outcome:** Humans can edit files and manage the file tree directly in the web UI, reaching parity with what agents already do. Markdown gets a rich editing experience; text/code gets a proper code editor; and the common file operations (create, rename, delete, folders, upload) are all available in the browser.

## Users

Humans working in a Treehouse workspace alongside agents — reviewing, correcting, and authoring content (notably markdown docs and config/text files) without dropping to the CLI or waiting on an agent.

## Approach Summary

The backend is essentially ready. The shared file service (`packages/api/server/utils/files.ts`) and REST routes (`packages/api/server/routes/api/workspaces/[workspaceId]/`) already support read, write (per-file version CAS with collision-safe conflicted copies), delete, and move. Agents use the same service through MCP. **This feature is almost entirely frontend** plus one new shared convention (`.keep`).

Editing splits by file type:

- **Markdown** → tiptap WYSIWYG editor, with a byte-faithful **source toggle** for raw markdown / front-matter.
- **Plain text & code** (`.ts`, `.json`, `.yaml`, `.csv`, …) → lightweight code editor (CodeMirror-style: monospace, syntax highlighting).
- **Other/binary** → remains read-only / download (unchanged).

## Requirements

### Editing

- Markdown files open in a **tiptap WYSIWYG editor**. A **source toggle** (the existing source/rendered control in `FileViewer.vue` is the natural home) switches to raw markdown editing.
  - In **WYSIWYG mode**, save re-serializes through tiptap's document model; formatting may be normalized.
  - In **source mode**, save writes **exact bytes** — this is the fidelity-safe path for front-matter and precise formatting.
- Plain-text and code files open in a **code editor** (monospace, line numbers, syntax highlighting). No rich formatting.
- **Save is explicit**: a Save button plus `Cmd/Ctrl-S`. An unsaved-changes indicator is shown.
- **Live collision awareness**: while a file is open for editing, if its version changes underneath the user (an agent or another tab writes to it — detected via the change feed the app already polls), show a **non-blocking banner** ("This file changed on the server") offering **Reload** or **Save as copy**. The user is never silently clobbered, and the backend's conflict-copy safety net remains the last line of defence.

### File operations

- **Create file** — create an empty file at a chosen path (folders in the path are implied).
- **Create folder** — writes a hidden `.keep` placeholder so the folder materializes, persists, and syncs to disk. (See the `.keep` convention below.)
- **Rename** — inline rename in the file tree, backed by the existing `POST /move`. `FileTree.vue` already emits `move`/`reorder` drag events to build on.
- **Delete** — with a confirmation step, backed by the existing version-checked `DELETE` endpoint.
- **Upload** — **drag-and-drop multiple files** onto a folder in the tree (or a drop zone), with an **Upload button** fallback (OS picker). Supports text and binary (images, PDFs, …). Shows per-file progress and handles overwrite of existing files.

### Frontend API client

- Extend `packages/app/app/composables/useTreehouseApi.ts` with **write methods** — write / create / delete / move wrappers — handling version/ETag headers and surfacing conflict responses. This is the principal frontend gap (the composable is currently read-only).

## The `.keep` convention (new shared contract)

Folders are **implicit** in the data model — there is no folder row in `schema.prisma`; a folder exists only because some file's path contains it. To support **empty folders**, "create folder" writes a hidden `.keep` file.

This crosses the agent/human boundary, so it must be treated as a shared contract:

- The web UI **hides `.keep`** from the file tree.
- The CLI (`packages/cli`) and agents should **ignore `.keep`** for display/sync-noise purposes (the file still syncs to disk so the folder exists locally).
- Deleting the last real file in a folder makes the folder disappear **unless** a `.keep` is present — this is expected behaviour.

## Agent-Native Parity

Every UI action maps to an existing agent capability — no human/agent capability gap is introduced:

| UI action     | Backing operation / MCP tool    |
| ------------- | ------------------------------- |
| Edit / save   | `write_file` (PUT, version CAS) |
| Create file   | `write_file` (create semantics) |
| Create folder | `write_file` writing `.keep`    |
| Rename / move | `move_file` (`POST /move`)      |
| Delete        | `delete_file` (DELETE, version) |
| Upload        | `write_file` with raw bytes     |

The only new concept is the `.keep` convention, which agents create implicitly whenever they write into a new path and should learn to ignore.

## Out of Scope / Deferred

- **Faithful partial-region markdown serialization** (editing only the changed bytes in WYSIWYG mode) — the source toggle covers the fidelity need instead.
- **Batch multi-select operations** (multi-delete, multi-move) beyond multi-file upload.
- **Real-time collaborative editing** (multiple humans live in one document) — collision handling is detect-and-warn, not CRDT/OT merge.
- **New backend endpoints** — assumption is that none are required (see below).

## Assumptions & Open Questions

- **No new backend endpoints needed** _(assumption to validate in planning)_. Create-file = PUT with create-only semantics (`If-None-Match: *`); create-folder = PUT `.keep`; upload = PUT bytes; rename = `POST /move`; delete = `DELETE`. Multi-file upload can loop client-side over PUT. If a server-side batch/convenience endpoint proves worthwhile, that's a planning decision.
- **Code editor library** is unspecified (CodeMirror is the assumed shape) — concrete choice belongs in planning, weighed against the Cloudflare Workers / Nuxt SPA bundle constraints.
- **tiptap markdown serialization** requires a markdown extension (e.g. `tiptap-markdown` / prosemirror-markdown); its fidelity limits (front-matter, embedded HTML, code fences) are the reason source mode exists. Planning should confirm the extension and its config.
- **Conflict banner detection** reuses the existing change-feed polling; planning should confirm the polling cadence is tight enough to catch under-edit changes promptly.

## Key Files (reference for planning)

- `packages/app/app/components/FileViewer.vue` — read-only viewer; home for edit mode + source toggle.
- `packages/app/app/components/FileTree.vue` — tree with existing drag `move`/`reorder` events; home for rename/create/delete/upload affordances.
- `packages/app/app/components/WorkspaceView.vue` — workspace layout/state container.
- `packages/app/app/composables/useTreehouseApi.ts` — API client to extend with write methods.
- `packages/app/app/composables/useWorkspaceData.ts` — workspace/tree state + vue-query caching to invalidate on writes.
- `packages/api/server/utils/files.ts` — shared file service (CAS, conflict copies); the single write path.
- `packages/api/server/routes/api/workspaces/[workspaceId]/` — existing REST routes (files, list, move, changes).
- `packages/api/server/utils/mcp.ts` — agent tools; reference for parity.
- `packages/cli` — must ignore `.keep` for sync-noise/display.