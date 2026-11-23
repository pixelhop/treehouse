---
title: "feat: Web UI rework — Notion-style workspace viewer"
type: feat
status: completed
date: 2026-06-06
origin: docs/brainstorms/treehouse-web-ui-requirements.md
---

# feat: Web UI rework — Notion-style workspace viewer

## Summary

Rebuild the workspace page in `packages/app` into a light-themed, three-pane layout (file-tree sidebar · type-aware center viewer · metadata/settings right panel). The center viewer resolves a file to one of four sub-viewers — markdown (`@tailwindcss/typography` prose + source toggle), sandboxed HTML, highlighted text/code (highlight.js), inline image — with a binary download fallback; the right panel surfaces file metadata, per-file change-feed activity, a stubbed Share, and (when nothing is selected) workspace info + the relocated API-keys panel.

---

## Problem Frame

The current `packages/app/app/pages/workspace.vue` is a working demo (plain tree, basic viewer, API-keys panel in the page body, dark theme). It proves the data path but isn't pleasant for reading real documents, and "product experience" is a co-equal pillar of the strategy. See origin: `docs/brainstorms/treehouse-web-ui-requirements.md`.

---

## Requirements

Traced from the origin doc. R-IDs match origin.

**Layout & navigation**

- R1. Three-pane layout: left file-tree sidebar · center viewer · right metadata/settings panel.
- R2. Left and right panels collapsible; center viewer is the focus.
- R3. Selecting a tree node drives the center pane and is reflected in the right panel.
- R9. Selecting a folder shows its contents in the center as a simple, click-through list.

**Type-aware viewer**

- R4. Markdown renders (sanitized) by default, with a source toggle.
- R5. Source view is available for any rendered type (markdown, HTML).
- R6. HTML renders in a sandboxed frame that cannot script the app, with a source toggle.
- R7. Text/code/data files show as syntax-highlighted source.
- R8. Single images display fit-to-view inline; other binaries fall back to a download affordance.

**Right panel**

- R10. File selected → metadata: name/path, content-type, size, current version.
- R11. Recent per-file activity from the change feed (agent vs human, when).
- R12. A visible but non-functional "Share" section (clearly deferred) that reserves the slot.
- R13. No file selected → workspace context (name, file count) + the API-key/connection panel (moved out of the page body).

**Theme & quality**

- R14. A light theme replaces the dark theme across the whole app; no light/dark toggle in v1.
- R15. Polished, Notion-grade result (spacing, typography, empty/loading/error states).

**Origin actors:** A1 (team member / viewer), A2 (agent/CLI, indirect — produces files + activity)
**Origin flows:** F1 markdown · F2 HTML · F3 text/code · F4 image · F5 folder · F6 inspect file · F7 workspace context
**Origin acceptance examples:** AE1 (R4), AE2 (R6), AE3 (R8), AE4 (R11), AE5 (R13)

---

## Scope Boundaries

Carried from origin (Deep-feature; single list).

- Real sharing / client portals / per-node auth (public · secret-link · password · account) — only a stubbed Share slot this round.
- Image-folder gallery/grid, PDF inline, audio/video preview — the designed-for next viewer tier.
- In-browser editing (stays read-only), markdown WYSIWYG, version history/restore.
- Light/dark theme toggle (v1 is light only).
- Resizable (drag-to-size) panels — collapsible is enough.
- Real-time collaborative editing; a full web file manager (rename/move/upload) — mutations stay with agent + CLI.

---

## Context & Research

### Relevant Code and Patterns

- `packages/app/app/pages/workspace.vue` — current page to rebuild (tree + viewer + ApiKeys inline).
- `packages/app/app/components/FileTree.vue` — recursive tree (reused, re-themed).
- `packages/app/app/components/FileViewer.vue` — current viewer (markdown via marked+DOMPurify, binary download); becomes the viewer container + sub-viewers.
- `packages/app/app/components/ApiKeys.vue` — relocated into the right panel's workspace context.
- `packages/app/app/composables/useTreehouseApi.ts` — credentialed client (`getWorkspace`, `list`, `readFile`, `fileUrl`, `listKeys`/`createKey`/`revokeKey`).
- `packages/app/app/utils/treehouse.ts` — `buildTree`, re-exports `previewKind`/`isConflictedCopy` from `shared`.
- `packages/app/app/assets/css/tailwind.css` — Tailwind v4 CSS-first entry (`@import "tailwindcss"`); base layer currently sets dark `bg-slate-950 text-slate-50`.
- `packages/app/app/layouts/default.vue`, `app/app.vue`, and pages `index.vue`/`sign-in.vue`/`sign-up.vue`/`dashboard.vue`/`organizations.vue` — dark-themed surfaces to convert.
- `shared` package — `previewKind`, `contentTypeFor`, `isConflictedCopy` (extend here for the viewer-kind resolver).

### Institutional Learnings

- None in `docs/solutions/` (greenfield). Capture the Tailwind-v4-typography and iframe-sandbox decisions post-landing via `/ce-compound`.

### External References (verified 2026)

- **`@tailwindcss/typography` works with Tailwind v4 CSS-first** — enable via `@plugin "@tailwindcss/typography";` in the CSS entry (no `tailwind.config.js`). Use `prose` (+ `prose-slate`/`prose-gray`, `max-w-none`) for the light theme; per-element `prose-*` variants for tweaks.
- **highlight.js** for syntax highlighting — synchronous, light, no WASM; register only needed languages (`highlight.js/lib/core` + per-lang); ship one light theme stylesheet (e.g. `github.css`). Chosen over Shiki (async-only + WASM/large bundles) for a read-only viewer. CSV is not a real highlighter language → render as plaintext (or a parsed table, deferred).
- **Sandboxed HTML**: render via `<iframe srcdoc>` with an **empty `sandbox=""`** (no scripts, no same-origin) + `referrerpolicy="no-referrer"`; DOMPurify-sanitize first as defense-in-depth. **Never** combine `allow-scripts` with `allow-same-origin` (lets the frame remove its own sandbox). Prefer `srcdoc` over blob URLs (blob inherits page origin).
- **DOMPurify CVE-2026-0540** affects 3.1.3–3.3.1; the app is on `^3.4.8` (patched) — keep it ≥3.4.x.

---

## Key Technical Decisions

- **highlight.js (sync, no WASM) over Shiki** for code highlighting — simpler integration in a read-only Vue viewer and a far lighter bundle; language coverage breadth isn't needed. (origin Outstanding Q resolved)
- **`@tailwindcss/typography` `prose`** for markdown rendering — first-class light typography with v4 CSS-first; keeps the existing marked→DOMPurify pipeline, just restyled.
- **HTML is rendered statically (no scripts) in v1** via `srcdoc` + `sandbox=""` + DOMPurify — the safest mode; running agent JS is deferred. (origin Outstanding Q resolved)
- **No API changes**: file metadata (name/type/size/version) comes from existing `list` entries; per-file activity is a **client-side filter** of the existing `/changes` feed by path. Timestamps beyond version are deferred. (origin Outstanding Qs resolved)
- **Viewer-kind resolver + sub-components**, not a plugin registry — one function maps content-type/extension → a viewer kind (`markdown | html | text | image | binary`), and a container renders the matching sub-viewer. Adding `gallery`/`pdf` later is a new kind + component, not a rearchitecture. (origin Outstanding Q resolved)
- **Light theme is a global token sweep** replacing the dark base in `tailwind.css` and per-component classes; no `dark:`/toggle machinery in v1.

---

## Open Questions

### Resolved During Planning

- Syntax highlighter: highlight.js (sync, light). (origin)
- HTML sandboxing: `srcdoc` + `sandbox=""` + DOMPurify + `no-referrer`. (origin)
- File metadata source: existing `list` data; no endpoint change. (origin)
- Per-file activity: client-side filter of `/changes` by path. (origin)
- Viewer architecture: resolver + sub-components, not a registry. (origin)

### Deferred to Implementation

- Exact light palette tokens (surface/border/text shades) — pick during U1 against the Notion-like reference; keep them consistent across components.
- Which highlight.js languages to register (driven by the file types actually seen) — start with json/xml(html)/js/ts/bash/css and expand.
- Whether collapsible panel state persists (e.g. localStorage) — default to in-memory; persistence is a cheap follow-up.
- CSV rendering polish (plaintext now; parsed table is a deferred gallery-tier nicety).

---

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. Treat it as context, not code to reproduce._

Layout + viewer resolution shape:

```
WorkspacePage (3-pane)
├── LeftSidebar:  FileTree            (select → selectedPath)
├── Center:       FileViewer (container)
│      viewerKind(entry) → "markdown" | "html" | "text" | "image" | "binary"
│        markdown → MarkdownViewer   (prose render ⇄ source)
│        html     → HtmlViewer       (sandboxed iframe ⇄ source)
│        text     → CodeViewer       (highlight.js)
│        image    → ImageViewer      (fit-to-view)
│        binary   → BinaryViewer     (download)
│      folder selected → FolderView  (contents list)
└── RightPanel:
       file selected → FileMeta + FileActivity + ShareStub
       none selected → WorkspaceInfo + ApiKeys
```

`viewerKind` extends the existing `previewKind` (in `shared`) — same content-type input, finer output (adds `html`/`image` distinction). The container owns loading/error/empty states once; sub-viewers are presentational.

---

## Implementation Units

- U1. **Light theme foundation + app-wide reskin**

**Goal:** Replace the dark theme with a cohesive light theme across the global shell and non-workspace pages.

**Requirements:** R14, R15

**Files:**

- Modify: `packages/app/app/assets/css/tailwind.css` (light base layer; add `@plugin "@tailwindcss/typography";`)
- Modify: `packages/app/app/app.vue`, `packages/app/app/layouts/default.vue`
- Modify: `packages/app/app/pages/index.vue`, `sign-in.vue`, `sign-up.vue`, `dashboard.vue`, `organizations.vue`
- Add (dev dep): `@tailwindcss/typography`
- Test: `packages/app/test/` — n/a (visual); see Verification

**Approach:**

- Establish a small, consistent light palette (page surface, panel surface, border, primary/secondary text, accent) and apply via Tailwind utilities; flip `bg-slate-950 text-slate-50` base to light.
- Convert the header/nav/footer and the auth/dashboard/org pages to the light palette so nothing is left half-dark.
- Wire `@tailwindcss/typography` now (used by U3).

**Patterns to follow:** existing SFC structure + Tailwind utility usage in `layouts/default.vue`.

**Test scenarios:**

- Test expectation: none (pure styling). Verify visually + via build.

**Verification:** `pnpm --filter app build` succeeds; app renders light with no leftover dark-theme surfaces on the auth/dashboard/org/landing pages.

---

- U2. **Three-pane workspace shell + selection + viewer container/resolver + folder view**

**Goal:** Restructure the workspace page into the collapsible 3-pane layout, own selection state, and route the center pane through a viewer-kind resolver (sub-viewers stubbed here, filled by U3–U6); render folders as a contents list.

**Requirements:** R1, R2, R3, R9, R15

**Dependencies:** U1

**Files:**

- Modify: `packages/app/app/pages/workspace.vue` (3-pane layout, selection state, panel collapse)
- Modify: `packages/app/app/components/FileTree.vue` (light theme; selection styling)
- Create: `packages/app/app/components/FileViewer.vue` (container — repurpose existing; resolves kind, owns loading/error/empty)
- Create: `packages/app/app/components/viewers/FolderView.vue`
- Modify: `packages/shared/index.ts` (add `viewerKind(contentType, path)` extending `previewKind`)
- Test: `packages/shared/` (viewerKind) and `packages/app/test/treehouse.test.ts` (tree/selection helpers)

**Approach:**

- Layout: left sidebar (tree), center (FileViewer container), right (panel — built in U7; placeholder until then). Side panels collapsible (toggle buttons); in-memory state.
- Selection: track selected path + whether it's a file or folder; folder → FolderView (list of children, click-through using existing `buildTree`/`list`); file → FileViewer.
- `viewerKind` resolver in `shared` returns `markdown | html | text | image | binary` from content-type/extension; the container switches on it.

**Patterns to follow:** existing `workspace.vue` data flow (`useTreehouseApi`, `buildTree`); `shared` pure-function + test pattern.

**Test scenarios:**

- Happy path: `viewerKind` maps `text/markdown`→markdown, `text/html`→html, `application/json`/`text/*`→text, `image/*`→image, else→binary.
- Edge: content-type with charset param (`text/markdown; charset=utf-8`) still resolves to markdown.
- Edge: selecting a folder yields its direct children; empty folder → empty-state (not error).

**Verification:** Selecting files/folders drives the center pane; panels collapse/expand; `viewerKind` unit tests pass; build succeeds.

---

- U3. **Markdown viewer (typography + source toggle)**

**Goal:** Render markdown as styled prose by default with a source toggle.

**Requirements:** R4, R5, R15

**Dependencies:** U2

**Files:**

- Create: `packages/app/app/components/viewers/MarkdownViewer.vue`
- Test: `packages/app/test/` (component or a small render-mode util)

**Approach:**

- Reuse marked + DOMPurify (already present); wrap output in a `prose` container (light). Toggle between rendered and raw source (the raw text in a `<pre>`).
- Keep DOMPurify ≥3.4.x.

**Patterns to follow:** the existing markdown path in the current `FileViewer.vue` (marked+DOMPurify+`v-html`).

**Test scenarios:**

- Covers AE1: markdown renders by default; toggling shows raw source; toggling back returns to rendered.
- Edge: a markdown file whose body starts with `---` (front-matter-like) still renders without breaking the toggle.

**Verification:** A `.md` file shows formatted prose; source toggle works; sanitization preserved.

---

- U4. **HTML sandboxed viewer (+ source toggle)**

**Goal:** Render HTML files visually in a sandboxed frame with a source toggle, safely.

**Requirements:** R6, R5, R15

**Dependencies:** U2

**Files:**

- Create: `packages/app/app/components/viewers/HtmlViewer.vue`
- Test: `packages/app/test/` (sandbox-attribute / sanitize util)

**Approach:**

- DOMPurify-sanitize the HTML, then render via `<iframe srcdoc>` with empty `sandbox=""` and `referrerpolicy="no-referrer"`. No `allow-scripts` in v1. Source toggle shows raw HTML.

**Execution note:** The sandbox attributes are the security contract — assert them in a test.

**Test scenarios:**

- Covers AE2: an HTML file containing `<script>` does not execute against the app (sandboxed/sanitized); source toggle shows the raw HTML.
- Edge: the iframe carries `sandbox=""` (no `allow-scripts`/`allow-same-origin`) and `referrerpolicy="no-referrer"`.

**Verification:** HTML renders visually; no script runs in the app origin; source toggle works.

---

- U5. **Text / code viewer (highlight.js)**

**Goal:** Show text/code/data files as syntax-highlighted source.

**Requirements:** R7, R15

**Dependencies:** U2

**Files:**

- Create: `packages/app/app/components/viewers/CodeViewer.vue`
- Add (dep): `highlight.js`; import a light theme stylesheet
- Test: `packages/app/test/` (language-pick / highlight util)

**Approach:**

- `highlight.js/lib/core` + register a starter language set (json, xml/html, js, ts, bash, css); highlight the raw string into `<pre><code>`. Unknown/plain → no highlighting (plain `<pre>`). CSV → plaintext for v1.
- Pick the language from extension/content-type via a small helper.

**Patterns to follow:** `shared` helper + test pattern for the language-pick function.

**Test scenarios:**

- Happy path: a `.json` file renders highlighted; a `.txt` file renders as plain monospace (no highlight error).
- Edge: an unknown extension falls back to plaintext without throwing.

**Verification:** Code/text files are legible and highlighted where supported; no runtime errors on unknown types.

---

- U6. **Image + binary viewer**

**Goal:** Display images inline; fall back to a download affordance for other binaries.

**Requirements:** R8, R15

**Dependencies:** U2

**Files:**

- Create: `packages/app/app/components/viewers/ImageViewer.vue`, `packages/app/app/components/viewers/BinaryViewer.vue`
- Test: `packages/app/test/` (covered by `viewerKind` from U2)

**Approach:**

- Image: render `<img>` fit-to-view from the file URL (`useTreehouseApi.fileUrl`), credentialed. Binary: filename + size + download link (existing pattern), "not previewable".

**Test scenarios:**

- Covers AE3: a `.png` displays inline fit-to-view; a `.zip` shows a download affordance, not a raw dump.

**Verification:** Images show inline; unsupported binaries show a clean download card.

---

- U7. **Right panel (metadata · activity · share stub · workspace/keys)**

**Goal:** Build the right panel: file metadata + per-file activity + stubbed Share when a file is selected; workspace info + relocated API keys when nothing is selected.

**Requirements:** R10, R11, R12, R13, R3, R15

**Dependencies:** U2

**Files:**

- Create: `packages/app/app/components/RightPanel.vue` (+ small sub-blocks: `FileMeta`, `FileActivity`, `ShareStub`, `WorkspaceInfo`)
- Modify: `packages/app/app/components/ApiKeys.vue` (re-theme; embed in the workspace-context state)
- Modify: `packages/app/app/pages/workspace.vue` (mount RightPanel; pass selection)
- Modify: `packages/app/app/composables/useTreehouseApi.ts` (helper to fetch + filter activity by path, if not done inline)
- Test: `packages/app/test/` (activity-filter util)

**Approach:**

- File selected → FileMeta (name/type/size/version from the `list` entry) + FileActivity (fetch `/changes`, filter to the file's path, show agent/human + relative time) + ShareStub (disabled "Sharing coming soon").
- No file → WorkspaceInfo (name, file count) + ApiKeys (moved out of the page body, re-themed).

**Patterns to follow:** existing `ApiKeys.vue`; `useTreehouseApi` calls; relative-time formatting kept simple.

**Test scenarios:**

- Covers AE4: a file written by both agent and human lists recent activity distinguishing agent vs human with timestamps (activity-filter returns only that path's events, newest first).
- Covers AE5: no selection → panel shows workspace info + API keys; selecting a file replaces it with that file's metadata.
- Edge: a file with no change events shows an empty activity state, not an error.

**Verification:** Right panel reflects selection; metadata + activity correct; API keys work from their new home; Share is visibly stubbed.

---

## System-Wide Impact

- **Interaction graph:** Pure frontend (`packages/app`); no API/server changes. Selection state in `workspace.vue` drives both center and right panes.
- **Unchanged invariants:** All Treehouse API endpoints, auth, and the read-only contract are unchanged — this is presentation only. No new mutations from the web UI.
- **API surface parity:** None — no endpoints added or changed.
- **Bundle/deploy:** New client deps (`@tailwindcss/typography` dev, `highlight.js`) must stay Worker-safe (no Node/WASM); highlight.js core + a light theme CSS keeps the bundle modest. Re-verify the Cloudflare build.
- **Integration coverage:** The HTML sandbox attributes and the activity filter are the behaviors worth explicit tests; the rest is visual.

---

## Risks & Dependencies

| Risk                                               | Mitigation                                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Light-theme sweep misses surfaces (half-dark UI)   | U1 converts the global shell + all non-workspace pages first; workspace surfaces are themed as rebuilt; verify via build + a visual pass of every route. |
| `v-html` XSS via markdown/HTML                     | Keep DOMPurify (≥3.4.x, patched for CVE-2026-0540) on markdown; HTML additionally isolated in `sandbox=""` `srcdoc` (no scripts).                        |
| iframe sandbox misconfig re-enabling scripts       | Empty `sandbox=""` only; an explicit test asserts no `allow-scripts`/`allow-same-origin`.                                                                |
| highlight.js/typography bloating the Worker bundle | Import highlight.js core + selected languages only; typography is a dev-time CSS plugin; re-check `pnpm --filter app build` size.                        |
| Per-file activity feed grows large                 | v1 filters client-side and caps display; a server-side path filter is a noted follow-up if needed.                                                       |

---

## Documentation / Operational Notes

- No runtime/ops impact (static SPA asset change). Update `README.md`/`packages/app/AGENTS.md` if the component layout conventions change materially.

---

## Phased Delivery

- **Phase 1 — Frame:** U1 (light theme), U2 (3-pane shell + resolver + folder view). After this the layout + navigation + theme are in place with stub viewers.
- **Phase 2 — Viewers:** U3 markdown, U4 HTML, U5 text/code, U6 image+binary (independent; can land in any order once U2 exists).
- **Phase 3 — Context:** U7 right panel (metadata, activity, share stub, relocated keys).

---

## Sources & References

- **Origin document:** [docs/brainstorms/treehouse-web-ui-requirements.md](docs/brainstorms/treehouse-web-ui-requirements.md)
- Strategy: `STRATEGY.md` (web/render/share track; "win on product experience")
- Current UI: `packages/app/app/pages/workspace.vue`, `components/FileTree.vue`, `components/FileViewer.vue`, `components/ApiKeys.vue`, `composables/useTreehouseApi.ts`, `utils/treehouse.ts`
- External (2026): `@tailwindcss/typography` v4 `@plugin`; highlight.js (core + per-language); MDN/web.dev iframe `sandbox`/`srcdoc`; DOMPurify CVE-2026-0540 (≥3.4.x).