---
date: 2026-06-09
topic: relative-paths-folder-defaults
---

# Relative Paths & Folder Default Pages — Requirements

## Summary

Make relative references in rendered markdown work: images display the referenced workspace file's bytes, and links to other documents navigate in-app — in both the read-only viewer and the Tiptap editor. Folders containing a README.md, index.md, or index.html render that file as their default page, with a toggle back to the file listing.

---

## Problem Frame

Markdown is rendered with no reference rewriting, so a relative image like `![diagram](./diagram.png)` in a doc viewed at `/w/<workspaceId>/docs/readme.md` resolves browser-relative to the app route `/w/<workspaceId>/docs/diagram.png` — which serves the SPA's HTML, not the image bytes (those live at the API file endpoint). Images are broken everywhere relative paths are used. Relative document links half-work: they land on a valid app route but force a full page reload, and `./`/`..` resolution depends on trailing-slash luck. Folders are always presented as bare listings even when the author wrote a README intended as the folder's front page.

Agents and the sync CLI write ordinary portable markdown with relative references — exactly the content that breaks today.

---

## Key Decisions

- **Render-time resolution; source is never rewritten.** Relative references are resolved when displaying, not on save. Markdown files stay byte-identical and portable across the sync CLI, agents, and external tools.
- **Readme replaces the folder listing, with a toggle back.** The folder default page is the folder's view; a control switches between it and the file listing. Chosen over GitHub's stacked listing-plus-readme for a cleaner reading experience.
- **Default-page precedence: README.md > index.md > index.html, case-insensitive.** Matches the GitHub mental model and agent conventions; `index.html` reuses the existing sandboxed HTML viewer.
- **Viewer and editor parity for images.** The Tiptap editor resolves relative image sources the same way, avoiding "works when viewing, broken when editing."

---

## Requirements

**Reference resolution**

- R1. Relative image and media references in rendered markdown display the referenced workspace file's content.
- R2. References resolve against the directory of the file being rendered, supporting `./` and `../` segments; resolution never escapes the workspace root.
- R3. Root-absolute references (`/assets/logo.png`) resolve from the workspace root.
- R4. External references (`http(s):`, `mailto:`, etc.) pass through unchanged; external links open in a new tab.
- R5. Stored markdown is never modified by resolution; it applies only to what is displayed.

**Document links**

- R6. A relative link to a workspace file navigates in-app (SPA navigation, no full reload) to that file's page.
- R7. A relative link to a folder navigates to that folder's page, where default-page behavior applies.
- R8. A link to a path that doesn't exist navigates normally and shows the app's existing missing-file state.

**Editor**

- R9. The Tiptap markdown editor displays relative images using the same resolution rules; the stored reference remains the original relative path.

**Folder default page**

- R10. A folder containing a default-page file renders it as the folder's page; candidates are README.md, index.md, and index.html, matched case-insensitively, in that precedence.
- R11. The folder page offers a toggle between the default page and the file listing; the default page shows first on each visit.
- R12. A default page's relative references resolve against the folder it lives in.
- R13. index.html renders through the existing sandboxed HTML viewer.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given `docs/guide/intro.md` containing `![x](../assets/a.png)`, when rendered, then the image displays the content of `docs/assets/a.png`.
- AE2. **Covers R2.** Given a file at workspace root containing `![x](../../a.png)`, when rendered, then the reference is unresolvable and renders as a broken image — it is never clamped to a different file.
- AE3. **Covers R6.** Given `docs/intro.md` containing `[next](./setup.md)`, when the link is clicked, then the app navigates to `docs/setup.md` without a full page reload.
- AE4. **Covers R10.** Given a folder containing both `readme.md` and `index.md`, when the folder is opened, then `readme.md` renders as the default page.
- AE5. **Covers R7, R10.** Given a link `[api](./api/)` where `api/` contains a README.md, when clicked, then the folder page opens showing the README.
- AE6. **Covers R9.** Given a markdown file with `![x](./shot.png)` opened in the editor, when editing, then the image displays; saving leaves the reference as `./shot.png`.

---

## Scope Boundaries

- Relative assets _inside_ HTML files (including an index.html default page) remain unresolved — the sandboxed `srcdoc` iframe makes rewriting HTML internals a separate effort.
- No changes to storage, the file-service API, or the MCP server; this is a presentation-layer feature.
- In-document anchor links (`#heading`) are not addressed.

---

## Outstanding Questions

**Deferred to Planning**

- Placement and form of the readme/files toggle on the folder page, and whether the chosen view persists per folder or per session.
- Whether image resolution in the viewer happens via a custom marked renderer or a post-render pass (and the equivalent mechanism in Tiptap).
- Behavior of relative links whose target is a binary/media file (navigate to its viewer page vs. download) — default expectation is the viewer page.