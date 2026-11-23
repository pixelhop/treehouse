---
date: 2026-06-06
topic: treehouse-mvp
---

# Treehouse MVP (Dogfooding v0)

## Summary

A cloud workspace of plain files that Claude Code operates through an MCP server (filesystem verbs over an HTTP API), the Pixelhop team edits via a two-way sync CLI on disk, and anyone on the team can browse read-only on the web — with sync that never silently loses data. It proves the core bet (agents + humans on the same files, no API to fight) on real Pixelhop work, and deliberately holds back the client-portal/permissions layer.

---

## Problem Frame

Today an agent can either work on plain local files (fast, zero-integration — but no sharing, permissions, web views, or history) or fight a verbose block API like Notion to get those things. Pixelhop runs Claude Code on real client and internal documents and hits exactly this wall: the moment the team wants a shared place where the agent and humans operate the _same_ documents, the files-on-disk workflow the agent is good at falls apart, and the alternatives make the agent a second-class citizen.

The first concrete cost shows up in everyday agency work: an agent drafts a proposal or spec, but there's no shared substrate where a teammate can pick it up in their own editor, where the work is visible without screen-shares or copy-paste, and where two people (or a person and an agent) touching the same file don't risk clobbering each other. The team needs to feel this work on its own real documents before betting further on the broader Treehouse vision.

---

## Actors

- A1. Agent (Claude Code): operates the workspace through the MCP server — reads, writes, moves, deletes, and lists files. The first-class user the product is designed around.
- A2. Team member (Pixelhop): edits workspace files on disk through the sync CLI using their own tools, and/or browses the read-only web view.
- A3. Treehouse service: the cloud source of truth — stores files, assigns version tokens, detects conflicts, records the change feed, and serves the web view.

---

## Key Flows

- F1. Agent does real work in a workspace
  - **Trigger:** A team member points Claude Code at a Treehouse workspace via the MCP server.
  - **Actors:** A1, A3
  - **Steps:** Agent lists the workspace → reads relevant files → writes new/edited files (proposal, spec, notes) → each write is accepted with a new version token and recorded in the change feed.
  - **Outcome:** The deliverable exists in the cloud workspace; the work is attributable to the agent in the change feed.
  - **Covered by:** R1, R2, R3, R8

- F2. Human and agent share the same files
  - **Trigger:** A team member runs the sync CLI against the same workspace the agent is operating.
  - **Actors:** A2, A3
  - **Steps:** CLI pulls the agent's files to a local folder → member edits in their own editor → CLI pushes the edits back → member continues seeing the agent's subsequent changes appear locally.
  - **Outcome:** Agent and human are demonstrably working on one shared set of plain files.
  - **Covered by:** R4, R5, R6

- F3. Concurrent edit without data loss
  - **Trigger:** Agent and human both write a changed version of the same file based on the same starting version.
  - **Actors:** A1, A2, A3
  - **Steps:** First write succeeds (new version) → second write arrives with a stale base version → service detects the conflict → service preserves both versions as separate files rather than overwriting.
  - **Outcome:** No edit is silently lost; the human can reconcile the two copies.
  - **Covered by:** R6, R7

- F4. Read-only visibility on the web
  - **Trigger:** A team member opens the workspace in the web app.
  - **Actors:** A2, A3
  - **Steps:** Member signs in → browses the workspace file tree → opens a text/markdown file and views its rendered/plain contents.
  - **Outcome:** Work is visible without installing anything or pulling the folder — the seed of the future client portal.
  - **Covered by:** R9, R10

---

## Requirements

**Agent interface**

- R1. The system exposes an MCP server providing filesystem-verb tools over a workspace: read a file, write a file, move/rename, delete, and list a directory.
- R2. The MCP server is backed by an HTTP API that is the actual contract; the MCP tools are clients of it.
- R3. Every successful write/move/delete is recorded in a per-workspace change feed attributed to the writing principal (agent vs human), enough to measure agent write actions per workspace per week.
- R8. Claude Code can connect to a workspace's MCP server with no bespoke glue code beyond standard MCP configuration.

**Sync (human access)**

- R4. A command-line tool syncs a cloud workspace to a local folder two-way: it pulls remote changes down and pushes local edits up.
- R5. The CLI can run in a watch mode that keeps a local folder continuously reconciled with the workspace.
- R6. Writes use optimistic concurrency: a write carries the base version it was derived from, and the service rejects/special-cases writes whose base is stale.
- R7. On a write conflict, the system preserves both the existing and the incoming content as distinct files (a "conflicted copy") rather than overwriting either — no silent data loss.

**Storage & identity**

- R11. The cloud workspace is the single source of truth for file contents; agent and human changes both reconcile against it.
- R12. Files are identified by path within a workspace for v0 (a rename is represented as delete + create).
- R13. Binary files (e.g., images, PDFs) sync as opaque blobs and round-trip intact through both the agent API and the CLI.

**Web view**

- R9. The web app lets a signed-in team member browse a workspace's file tree.
- R10. The web app renders text/markdown file contents read-only; binary files are listed but not rendered inline.

**Workspace & access**

- R14. A workspace belongs to an organization (better-auth org from the template); all members of that organization can read and write the workspace's files. There are no per-file permissions in v0.

---

## Acceptance Examples

- AE1. **Covers R6, R7.** Given `proposal.md` is at version N, when the agent writes a new `proposal.md` (advancing it to N+1) and a human then pushes an edit still based on version N, the human's push does not overwrite the agent's version — both are kept (e.g., the original plus a clearly-named conflicted copy).
- AE2. **Covers R3.** Given an agent performs a write through the MCP server, when the workspace's change feed is inspected, the write appears attributed to the agent (distinguishable from human/CLI writes).
- AE3. **Covers R4, R11.** Given the agent created `spec.md` in the cloud workspace, when a team member runs the sync CLI against that workspace, `spec.md` appears in their local folder; when they edit and the CLI pushes, the cloud workspace reflects the edit.
- AE4. **Covers R10, R13.** Given a workspace contains `notes.md` and `logo.png`, when a member opens the web view, `notes.md` renders as text/markdown and `logo.png` is listed but not rendered inline.

---

## Success Criteria

- Pixelhop actually produces a real internal or client deliverable in a Treehouse workspace — with Claude Code doing meaningful writes — instead of the current tool, and chooses to keep doing so.
- Across a dogfooding period, a workspace shows both agent and human write activity in the change feed (genuinely shared, not single-player).
- No instance of an agent or human silently losing another's edit during the dogfood.
- A downstream implementer/agent could build each track from this doc without having to invent product behavior, the human↔agent access model, or the v0 sync-safety contract.

---

## Scope Boundaries

### Deferred for later (on the roadmap, not in v0)

- Client portals, the per-node auth menu (public / secret-link / password / account), and the viewer/client tier — the web/share differentiation track beyond an internal read-only view.
- Per-node ACLs and permission inheritance.
- Version history, content-addressed versioning, and restore.
- Stable node IDs with move/rename detection (v0 uses path-based identity; rename = delete + create).
- A native desktop sync app (menu-bar/tray); v0 is CLI-only.
- Self-host / SQLite backend and multi-backend storage portability (keep the adapter seam, defer the backends per strategy).

### Outside this product's identity

- GitHub-for-code semantics: branching, rebasing, cherry-picking.
- CRDT / operational-transform real-time co-editing.
- Syncing dependency folders, build caches, or full dev environments.
- Feature-for-feature parity with Fastio.

---

## Key Decisions

- MCP server backed by an HTTP API (not agent-uses-the-sync-CLI): the agent interface is the core strategic bet, and routing agent writes through a real Treehouse path is what makes the change feed and the agent-write metric possible and keeps agent writes distinct from human ones.
- Safe-minimal sync over last-write-wins or full versioning: with two writers on real client deliverables, never-lose-data is the trust the dogfood must prove; conflicted-copy + optimistic concurrency delivers that at far lower cost than content-addressed history, which is deferred.
- Read-only web view included now and treated as the seed of the future portal layer: it gives the team visibility without installs and is reused, not throwaway, when the share/portal track lands.
- Workspace = better-auth organization with flat member access: reuses template infrastructure and avoids building the ACL system before it's needed for internal dogfooding.
- Defer the client portal entirely: the fastest path to "testable and useful" is the shared-files-with-agent core; portals add value only once that core earns daily use.

---

## Dependencies / Assumptions

- Builds on the existing template: better-auth (+ organization plugin), the Nitro API and BullMQ workers on Railway, Prisma/Postgres, and the Nuxt app on Cloudflare.
- Per strategy, v0 ships Cloudflare-backed storage behind an adapter seam ("build the boundary, not the backends"); the API/sync/MCP logic runs on the Railway/Node side where Prisma and long-running processes live.
- The CLI is a separate distributable the team can install locally; how it's packaged is a planning detail.
- Assumes Claude Code is the primary agent client for v0; other agents can use the HTTP API but aren't a v0 target.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R2][Technical] Where the MCP server runs and how it authenticates a workspace session (e.g., token issued by the control plane) — a planning/architecture decision.
- [Affects R4, R5][Technical] CLI conflict-detection mechanics on the local side (change detection, dirty-file handling during pull) — resolve during planning.
- [Affects R7][Technical] Exact conflicted-copy naming/placement convention — a planning detail, as long as R7's no-loss guarantee holds.
- [Affects R13][Needs research] Cloudflare-backed blob storage choice and the adapter-seam shape that keeps later backends viable.
- [Affects R3][Technical] Change-feed storage and how agent-vs-human attribution is captured at write time.