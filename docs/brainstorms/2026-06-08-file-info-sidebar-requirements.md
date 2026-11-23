---
date: 2026-06-08
topic: file-info-sidebar
---

# File Information Sidebar Redesign

## Summary

Redesign the workspace's right-hand file-info sidebar around a single, data-dense
**timeline** that shows every change to a file with the human behind it and their
named agent ("Alex · via 'Claude Code'"), a version chip, the operation, and the
time. Past versions become viewable and restorable (non-destructively), conflicted
copies are surfaced for resolution, and the metadata block is rebuilt as one
consistent typographic system with richer, genuinely useful stats and quick actions.

## Problem Frame

The current sidebar is two thin, near-duplicate panels. `FileMeta.vue` renders a
plain definition list (name, path, type, size, version) in mixed sizes and weights.
`FileActivity.vue` renders a flat change list whose only identity signal is a coarse
`agent`/`human` badge — you cannot tell _which_ teammate, or which of their agents,
touched a file. There is no way to see or recover a previous version, even though
the system retains every version's bytes.

This bites hardest for Treehouse's core scenario: teams where each person runs
agents against a shared workspace. When a file changes unexpectedly, the question is
always "who — or whose agent — did this, and can I get the previous version back?"
Today the sidebar can answer neither. The data to answer both largely already
exists; it just isn't captured at write time or surfaced in the UI.

## Key Decisions

- **Unified timeline.** Collapse the separate activity feed and version history into
  one timeline. They are the same underlying `ChangeEvent` data; two lists is
  redundant in a ~320px panel. Write events are restorable versions; move / delete /
  conflict events render in the same stream as non-restorable entries.

- **Restore is non-destructive.** Restoring an old version writes its bytes back as a
  _new_ version (a new entry at the head of the timeline), never a destructive reset.
  This matches the file service's existing "never lose data" philosophy (conflicted
  copies, resurrection-over-loss).

- **Attribution = human + named agent.** Each change resolves to the human owner and,
  when an agent made it, that agent's name. The link already exists — an API key's
  `referenceId` points at the creating user, and the key carries a `name` and an
  `actorType`. The change feed must start recording which key acted so both can be
  resolved.

- **Forward-only, no backfill.** Person-level attribution and restorable version
  history begin working the moment this ships. Change events written before then keep
  today's coarse `agent`/`human` badge with no person, and versions written before
  then are not restorable (their version→content mapping was never stored). This is
  accepted, not a gap to backfill.

- **Metadata is one typographic system.** Replace the mixed fonts/sizes with a single
  dense, scannable block; monospace is reserved for path/identifier values only.

## Actors

- A1. **Team member (human)** — owns and edits workspace files, runs agents, reviews
  a file's history, restores previous versions, resolves conflicted copies.
- A2. **Agent** — acts on a human's behalf via a named, workspace-scoped API key;
  writes, moves, and deletes files. Its actions attribute back to its owning human.
- A3. **File service / change feed** — the system that records attributed change
  events and is the single write path for restores.

## Requirements

### Timeline & attribution

- R1. The sidebar presents a single timeline of a file's change events (newest
  first), replacing the separate metadata-activity and version-history lists.
- R2. Each timeline entry shows: the operation (write / move / delete / conflict),
  the version (where applicable), the actor, and both a relative and exact timestamp
  (exact on hover or secondary line).
- R3. Each entry attributes the change to a human. When an agent made the change, the
  entry also names the agent (e.g. "Alex · via 'Claude Code'") and visually
  distinguishes agent-made from human-made changes.
- R4. Change events that predate this feature, or any event lacking recorded actor
  identity, fall back to the existing coarse `agent`/`human` label with no person.
- R5. The timeline handles a file with no recorded changes, a single version, and
  long histories (many entries) without layout breakage.

### Version history & restore

- R6. A user can view a previous version of a file's contents from its timeline entry.
- R7. A user can restore a previous version. Restore writes that version's bytes back
  as a new version at the head of the timeline and records a new attributed change
  event; it never overwrites or deletes history.
- R8. Restore is only offered for versions whose content can be located. Versions
  written before this feature shipped are shown in the timeline but are not
  restorable.
- R9. Restore respects the file service's version CAS: if the file changed between
  the user opening the panel and confirming the restore, the restore still applies
  as a new version on top of current (consistent with the never-lose-data rule), and
  the user is not silently working against a stale base.

### Conflicted copies

- R10. When a file has conflicted copies (created by the file service on stale
  writes), the sidebar surfaces their presence and count for the selected file.
- R11. A user can navigate from the surfaced conflict to the conflicted copy/copies
  to compare and resolve them.

### Metadata & file stats

- R12. The metadata header renders as one consistent typographic system — uniform
  label/value treatment, monospace reserved for path/identifier values.
- R13. The header shows core metadata densely: name, path, type, size, current
  version.
- R14. The header includes richer stats where cheaply available: created date and
  original author, line/word count for text and markdown, and image dimensions /
  preview for images.
- R15. The header surfaces a last-synced/last-changed signal so users can see file
  freshness at a glance.

### Quick actions

- R16. The sidebar offers quick actions on the selected file: copy path and
  download (current version, and a historical version from its timeline entry).
  Link sharing is covered by the Sharing group below.

### Sharing

(Expanded during planning — the brainstorm originally scoped only a "copy
shareable link" quick action.)

- R18. A member deep link is available for the selected file or folder: it points
  at the item in the app and requires the opener to be a logged-in member of the
  workspace's org. Reuses existing auth; no new access surface.
- R19. An opt-in public link can be minted for a file or a folder. Public links
  are read-only, unguessable, and revocable, and grant access without login.
- R20. A public link can optionally be password-protected; the opener must supply
  the password before any shared content is served.
- R21. Link target is selectable: a file's link can be live (always latest) or a
  version permalink pinned to a specific timeline entry. Folder and public links
  resolve live.
- R22. Shares are manageable from the sidebar — create, list, and revoke — for the
  selected file or folder.
- R23. Public read is strictly scoped to the shared item (a single file, or a
  folder and its subtree) and is read-only — it never exposes content outside the
  shared path.

### Visual design

- R17. The redesigned panel reads as a single intentional design — consistent
  spacing, hierarchy, and theme-token usage — not a stack of unrelated sub-panels,
  and works across the existing theme set.

## Key Flows

- F1. **Inspect who changed a file**
  - **Trigger:** A team member selects a file whose content changed unexpectedly.
  - **Actors:** A1, A3
  - **Steps:** Sidebar loads the file's timeline; each entry resolves to a human
    (and agent name where applicable); the user scans newest-first to find the
    change and actor.
  - **Covered by:** R1, R2, R3, R4

- F2. **Restore a previous version**
  - **Trigger:** A team member decides a recent (agent-made) change was wrong.
  - **Actors:** A1, A3
  - **Steps:** User opens the relevant timeline entry, views the previous version,
    confirms restore; the service writes those bytes as a new version and records a
    new attributed event; the timeline updates with the restore at its head.
  - **Covered by:** R6, R7, R8, R9

- F3. **Notice and resolve a conflicted copy**
  - **Trigger:** Two writers (e.g. two agents) raced on the same file.
  - **Actors:** A1, A3
  - **Steps:** Sidebar shows the file has N conflicted copies; user navigates to a
    copy to compare and resolve.
  - **Covered by:** R10, R11

## Acceptance Examples

- AE1. **Pre-feature change.** Given a change event recorded before this feature
  shipped, when its timeline entry renders, then it shows the coarse `agent`/`human`
  label with no person and offers no restore action. (Covers R4, R8.)
- AE2. **Agent attribution.** Given an agent wrote a file using Alex's named key,
  when the entry renders, then it shows Alex as the human and names the agent, and is
  visually marked as agent-made. (Covers R3.)
- AE3. **Non-destructive restore.** Given a file at v5, when the user restores v3,
  then v3's bytes are written as v6, the timeline shows a restore entry at the head
  attributed to the acting user, and v4/v5 remain in history. (Covers R7.)
- AE4. **Restore under concurrent change.** Given the user opened the panel at v5 and
  the file advanced to v6 before they confirm restoring v3, when restore applies,
  then it lands as v7 on top of current rather than failing or clobbering v6. (Covers
  R9.)
- AE5. **Conflicted copies present.** Given a file has 2 conflicted copies, when the
  sidebar renders, then it shows the conflict count and a way to reach them. (Covers
  R10, R11.)
- AE6. **Binary file restore.** Given an image at v2, when the user restores v1, then
  the previous image bytes are restored as a new version without requiring a text
  diff. (Covers R6, R7.)

## Scope Boundaries

### Deferred for later

- **Version diff preview** — showing _what_ changed between two versions (text or
  visual). The natural next step once versions are restorable, but out of this pass.
- **Backfilling historical attribution / restorability** — reconstructing person
  identity or version→content mapping for changes written before this ships.

### Outside this pass's shape

- **Tabbed sidebar (Info / History split)** — rejected; history is the centerpiece
  and tab-switching adds friction in a narrow panel. The unified timeline stands in
  for it.
- **Share link expiry / time-bounded links** — revocation is in scope; automatic
  expiry is not (may follow later).

## Dependencies / Assumptions

- **Change events must record the acting credential.** Person + agent-name
  attribution depends on the change feed capturing which API key acted (so
  `referenceId` → human and key `name` → agent can be resolved). `ChangeEvent`
  already has an unused `actorId` field; today it is not populated.
- **A version→content mapping must be recorded on write.** Old version bytes are
  durably retained (content-addressed blobs are never overwritten in place), but
  there is currently no stored map from a file version to its content hash, so a past
  version's blob can't be located. Restore/view-old-version depends on recording this
  going forward (e.g. content hash on write events, or a small history record).
- **Restore reuses the existing file-service write path** so versioning, attribution,
  and the change feed stay consistent — it is not a separate mutation route.
- **Conflicted copies are already produced** by the file service on stale writes;
  this work surfaces and links them, and does not change how they are created.

## Outstanding Questions

### Resolve before planning

- How is a "shareable link" (R16) scoped and authorized — workspace-relative path
  link, or something that needs an access decision? Confirm what "link" means before
  building it.

### Deferred to planning

- Exact storage shape for the version→content mapping (new field on the change feed
  vs. a dedicated history record) — a planning/implementation decision.
- Whether non-write ops (move/delete/conflict) need any inline action in the timeline
  beyond display, or display-only is sufficient for v1.
- How richer stats (line/word counts, image dimensions) are computed and at what cost
  for large files — compute-on-read vs. recorded at write.