# File sidebar — future improvements

Backlog of ideas for the workspace file sidebar, captured after round one
(collapse/expand + persisted state, filter, expand/collapse-all, drag-reorder,
drag-into-folder moves). Not scheduled — pick up as needed.

## Write operations (from the sidebar)

New file, new folder, rename, and delete directly in the tree. The REST API +
MCP already support all of these (`write`, `move`, `delete`) — it's a UI-only
addition. Natural home: the `⋯` tree menu (new file/folder) + a per-row context
menu or hover actions (rename/delete). Mind the same-write-path safety the file
service already provides (version CAS, conflicted copies).

## Change-indicator dots

Show a small dot/badge on files an agent (or teammate) recently touched, sourced
from the change feed (`/changes`). Helps you spot "what changed" at a glance in a
busy workspace. Could also drive a "recent" section.

## Keyboard navigation

Arrow keys to move through the tree, Enter to open, left/right to collapse/expand,
type-ahead to jump. Accessibility + power-user speed.

## Sort options

Beyond manual order + the default (folders-first, alphabetical): sort by name,
modified time, or type. Lives in the `⋯` menu. Manual `order` (NodeMeta.order)
would take precedence when set.

## Zero-copy local rename in the CLI sync

Today a web move syncs to the CLI as delete-old + download-new (correct end
state, but re-downloads content and leaves an empty old directory). Since a moved
file keeps its content hash, the CLI could match "new remote path whose hash ==
an old local path's baseline hash" and `renameSync` locally instead — instant,
bandwidth-free — plus prune now-empty directories. See the move semantics in
`packages/cli/src/reconcile.ts` / `sync.ts`.

## Virtualization (only if needed)

Expand-all renders every node; fine into the low thousands. If a workspace ever
dwarfs that, virtualize the tree (render only visible rows).

## Folder-move polish

Cross-folder moves of folders currently batch-move each descendant file. Consider
progress feedback for large folders and surfacing partial-failure (a mid-batch
conflict) rather than only revalidating.