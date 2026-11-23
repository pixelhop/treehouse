---
date: 2026-06-09
topic: markdown-front-matter
---

# Markdown Front Matter as First-Class Metadata

## Summary

Treat YAML front matter as first-class metadata instead of letting it leak into
the rendered body. The read-only markdown viewer parses the leading front-matter
block and renders it as a generic, type-aware **card** above the content, and the
editor gains a dedicated **fields surface** for editing those values outside the
WYSIWYG body. Source mode stays as the raw escape hatch.

## Problem Frame

The read-only viewer (`packages/app/app/components/viewers/MarkdownViewer.vue`)
feeds the entire raw file — front matter included — straight into `marked.parse`.
Markdown has no concept of front matter, so a leading `---` block is parsed as a
thematic break followed by a setext heading: the YAML keys collapse into one large,
garbled `<h2>` at the top of the document. Every markdown file that carries front
matter renders this way in the workspace file view.

The editor already solves the corruption half of this problem
(`packages/app/app/utils/frontmatter.ts` peels the block off as an opaque verbatim
string so tiptap can't mangle it), but it solves it by making the metadata
_invisible_ — visible only by flipping to raw source mode. So today the metadata is
either ugly (viewer) or hidden (editor), and never editable except as hand-typed
YAML. This matters most for Treehouse's core scenario: agents write structured
front matter into shared files, and humans need to read and adjust it without
touching raw YAML.

## Requirements

### Viewer card

- R1. The read-only markdown viewer must not render the leading front-matter block
  as body content. The block is split off before `marked.parse` so the rendered
  body begins at the real first line of content.
- R2. When a front-matter block is present, the viewer renders it as a card above
  the body. When absent, no card renders and the body is unchanged.
- R3. The card renders generically over whatever keys exist — nothing is silently
  dropped from a top-level scalar or array. Rendering is type-aware: scalars show
  as label/value, arrays render as chips, booleans and dates are formatted for
  reading.
- R4. Card values are rendered as text, never as HTML — a value written by an agent
  (subject to prompt injection) or a compromised account can never inject markup or
  script through the card. This preserves the existing viewer's sanitization stance.
- R5. Reading/parsing front matter for the card is lossless and never rewrites the
  file. Viewing a file leaves its bytes untouched.

### Editing front matter

- R6. The editor provides a dedicated fields surface for front-matter values that is
  separate from the WYSIWYG body editor. A human can read and change values there
  without hand-editing YAML.
- R7. Editing a value re-serializes the front-matter block on save. Values are
  preserved; key order and quoting may normalize and YAML comments may be dropped.
  This is accepted (see Key Decisions).
- R8. A file whose front matter is never edited keeps its bytes verbatim, exactly as
  today — re-serialization happens only when a human actually edits a field.
- R9. Source mode remains available and continues to edit the exact canonical bytes
  (front matter included), serving as the escape hatch for cases the fields surface
  does not cover.

## Key Decisions

- **Pretty card over sidebar (with sidebar as fallback).** The metadata renders as a
  header card above the content. Surfacing parsed fields in the FileInfoPanel sidebar
  was considered and is held as a fallback to adopt if the card does not feel right in
  practice — it is not being built now.
- **Generic, type-aware rendering over a curated schema.** Front matter in Treehouse is
  written freely by agents and humans; there is no fixed schema the app owns. A generic
  renderer is robust to any keys and won't silently hide fields a curated allow-list
  didn't anticipate.
- **Reformat-on-edit over strict byte-fidelity.** When a human edits a field we
  re-serialize the whole block rather than surgically patching the edited line. The
  values agents rely on are always preserved; the cost is that formatting and comments
  may not survive an edit. Untouched files are never reformatted, so the existing
  "agents can rely on the exact metadata" guarantee holds until a human chooses to
  change something.
- **Values as text, never HTML.** Consistent with the viewer's existing DOMPurify
  posture — the card is a read surface for untrusted content.

## Scope Boundaries

- Public-share markdown rendering is unchanged. The share page
  (`packages/app/app/pages/s/[token].vue`) currently shows markdown as plain
  monospace text, not rendered HTML, so the card does not apply there. Bringing the
  card (or any rendered view) to public shares is separate work.
- Front matter does not yet drive anything beyond display: file-list columns,
  search, filtering, and sorting on metadata are out of scope here.
- No schema definition, validation, or required-field enforcement — the app stays
  agnostic about what keys mean.
- No backfill or migration of existing files; behavior is forward-only and applies
  the moment a file is viewed or edited.

## Outstanding Questions

- KTD1. Nested / complex YAML values (objects, deep or mixed arrays): the working
  assumption is the card displays them read-only and editing those specific values
  defers to source mode, rather than building a nested-object form editor. Confirm the
  exact display and edit boundary during planning.
- KTD2. Whether the fields surface supports adding and removing keys, or only editing
  the values of keys that already exist. Add/remove is more capable but raises questions
  about key naming and ordering.
- KTD3. YAML parser/serializer choice for the app bundle (runs on the Cloudflare
  Workers runtime) — settled during planning, but worth flagging as it adds a
  dependency to the front-end bundle.