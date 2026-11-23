---
date: 2026-06-06
topic: treehouse-web-ui
---

# Treehouse Web UI Rework (Notion-style workspace viewer)

## Summary

Rework the workspace web UI into a light-themed, three-pane Notion-style viewer: a left file-tree sidebar, a center viewer that adapts to file type (markdown, HTML, text/code, image), and a right panel for file metadata, per-file activity, a stubbed Share affordance, and workspace context. Read-only, internal-team; real sharing stays deferred.

---

## Problem Frame

The current workspace page (`packages/app/app/pages/workspace.vue`) is a functional demo: a plain file tree, a basic viewer (markdown rendered, everything else download/text), and an API-keys panel wedged into the page body, all on a dark theme. It proves the data path works but isn't pleasant to actually read and navigate real work in — and "the product experience" is a co-equal pillar of the strategy (we win on experience + own-your-data, not feature parity). The team's real content is documents — markdown specs/plans/proposals, HTML plans, documentation — so the reading experience is what matters most for dogfooding to feel good rather than like a debug tool.

---

## Actors

- A1. Team member (viewer): browses the workspace, opens files, reads rendered docs, inspects file metadata/activity. The primary actor for this rework.
- A2. Agent / CLI (indirect): writes the files and produces the change-feed activity the UI surfaces; not a direct user of this UI.

---

## Key Flows

- F1. Read a markdown document
  - **Trigger:** A1 selects a `.md` file in the tree.
  - **Steps:** Center pane renders the markdown (sanitized) by default → A1 can toggle to a raw "source" view and back.
  - **Outcome:** The document is comfortable to read; source is one click away.
  - **Covered by:** R3, R4, R5

- F2. Read an HTML plan
  - **Trigger:** A1 selects an `.html` file.
  - **Steps:** Center renders the HTML in a sandboxed frame (no script escape into the app) → A1 can toggle to source.
  - **Outcome:** "HTML plans" render like a page, safely.
  - **Covered by:** R3, R6

- F3. Read text / code
  - **Trigger:** A1 selects a text/code/data file (txt, json, csv, code).
  - **Steps:** Center shows syntax-highlighted source.
  - **Outcome:** Plain files are legible, not raw-dumped.
  - **Covered by:** R3, R7

- F4. View an image
  - **Trigger:** A1 selects an image file.
  - **Steps:** Center shows the image fit-to-view inline.
  - **Outcome:** Images display in-app instead of forcing a download.
  - **Covered by:** R3, R8

- F5. Open a folder
  - **Trigger:** A1 selects a folder node.
  - **Steps:** Center shows that folder's contents as a simple list (click-through to children).
  - **Outcome:** Folders are navigable from the center, not only the tree.
  - **Covered by:** R9

- F6. Inspect a file
  - **Trigger:** A file is selected.
  - **Steps:** Right panel shows file metadata (name, type, size, version) and recent per-file activity (agent/human + when), plus a stubbed Share section.
  - **Outcome:** A1 sees what a file is and who touched it.
  - **Covered by:** R10, R11, R12

- F7. Workspace context (no file selected)
  - **Trigger:** No file is selected (initial state / deselect).
  - **Steps:** Right panel shows workspace info and the API-keys / connection panel.
  - **Outcome:** Key management has a home without cluttering the page body.
  - **Covered by:** R13

---

## Requirements

**Layout & navigation**

- R1. A three-pane layout: left file-tree sidebar, center viewer, right metadata/settings panel.
- R2. Left and right panels are collapsible; the center viewer is the visual focus.
- R3. Selecting a tree node drives the center pane; the selected file/folder is reflected in the right panel.
- R9. Selecting a folder shows its contents in the center as a simple, click-through list.

**Type-aware viewer**

- R4. Markdown renders (sanitized) by default, with a toggle to view raw source and back.
- R5. The source view is available for any rendered type (markdown, HTML), not just markdown.
- R6. HTML renders inside a sandboxed frame that cannot run scripts against the app, with a source toggle.
- R7. Text/code/data files (txt, json, csv, code) show as syntax-highlighted source.
- R8. Single images display fit-to-view inline; unsupported/other binaries fall back to a download affordance.

**Right panel**

- R10. When a file is selected, the right panel shows its metadata: name/path, content-type, size, current version.
- R11. The right panel shows recent per-file activity from the change feed (agent vs human, and when).
- R12. The right panel includes a visible but non-functional "Share" section (clearly "coming soon") that reserves the layout slot.
- R13. When no file is selected, the right panel shows workspace context (name, file count) and the API-key / connection panel (moved out of the page body, same functionality).

**Theme**

- R14. A light theme replaces the current dark theme across the whole app (auth, dashboard, organizations, workspace) for visual consistency. No light/dark toggle in v1.

**Quality**

- R15. The result should read as a polished, Notion-grade experience (spacing, typography, empty/loading/error states), not merely functional — consistent with the strategy's "win on product experience" bet.

---

## Acceptance Examples

- AE1. **Covers R4.** Given a selected `.md` file, when the page loads, the rendered markdown is shown; when the user clicks "source", the raw markdown text is shown; clicking "rendered" returns to the formatted view.
- AE2. **Covers R6.** Given a selected `.html` file containing a `<script>`, when rendered, the script does not execute in the app's origin (sandboxed); a source toggle shows the raw HTML.
- AE3. **Covers R8.** Given a `.png` it displays inline fit-to-view; given a `.zip` (unsupported) the center shows a download affordance, not a raw dump.
- AE4. **Covers R11.** Given a file the agent and a human both wrote, the right panel lists recent activity distinguishing agent vs human with timestamps.
- AE5. **Covers R13.** Given no file is selected, the right panel shows workspace info and the API-key panel; selecting a file replaces it with that file's metadata.

---

## Success Criteria

- The team prefers reading real work (markdown/HTML/docs) in the Treehouse UI over opening the raw files — it feels like a product, not a debug view.
- A file's "what is this / who changed it" is answerable at a glance from the right panel.
- The whole app is coherently light-themed with no leftover dark-theme patches.
- A downstream implementer can build each pane and viewer from this doc without inventing viewer behavior, the right-panel contents, or the folder/selection model.

---

## Scope Boundaries

### Deferred for later (designed-for, not this round)

- Real sharing / client portals / per-node auth (public · secret-link · password · account). v1 ships only a stubbed Share slot.
- Image-folder gallery / grid view, PDF inline viewer, audio/video preview — the next viewer tier.
- In-browser editing of files (stays read-only), markdown WYSIWYG, version history / restore.
- A light/dark theme toggle (v1 is light only).
- Resizable (drag-to-size) panels — collapsible is enough for v1.

### Outside this product's identity

- Real-time collaborative editing (CRDT/OT) — explicitly out per strategy.
- A full file manager (rename/move/upload via the web UI) — the agent + CLI own mutations; the web UI is a read-only viewer in v1.

---

## Key Decisions

- Internal-team audience; sharing is a visible stub, not implemented — keeps this rework aligned with the MVP's deliberate deferral of the web/share track while reserving its place in the layout.
- Light theme replaces dark app-wide (no toggle) — a half-applied theme reads as broken; a toggle is carrying cost without v1 value.
- Folders render as a simple contents list, not a gallery — galleries are deferred, but folders still need to be openable from the center.
- API-key management relocates into the right panel's workspace context — it's workspace-level, not page-body clutter; functionality is unchanged.
- Per-file activity reuses the existing change feed filtered to the file — no new data model, just a scoped view.
- Design quality is a requirement, not a nice-to-have — the strategy stakes the product on experience.

---

## Dependencies / Assumptions

- Builds on the existing `packages/app` (Nuxt 4 SPA, Tailwind 4) and the existing read APIs (`/api/workspace`, `/api/workspaces/[id]/list`, `/api/workspaces/[id]/files/...`, `/api/workspaces/[id]/changes`, `/api/keys`).
- Assumes the existing endpoints are sufficient or need only light extension (e.g. surfacing file timestamps, filtering the change feed by path) — to be confirmed in planning.
- The viewer remains Worker-safe (no server/Node deps in the app bundle) per the deployment boundary.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R10] Whether file metadata (timestamps, created/updated) needs a new/extended endpoint or can be derived from existing list data.
- [Affects R11] Whether per-file activity filters the change feed client-side or via a new query parameter.
- [Affects R7][Needs research] Choice of a Workers-safe syntax-highlighting approach.
- [Affects R6] Exact sandboxing approach for HTML rendering (iframe sandbox attributes / CSP).
- [Affects R1, R2] Whether to introduce a viewer-registry seam now (to ease the deferred gallery/PDF tiers) or branch by type for v1.