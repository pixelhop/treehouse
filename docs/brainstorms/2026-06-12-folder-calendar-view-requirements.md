---
date: 2026-06-12
topic: folder-calendar-view
---

# Folder Calendar View — Requirements

## Summary

Add a folder-level **Calendar view** to the workspace browser. Child files that
carry a date in their front matter appear on a month calendar; dragging one to a
different day writes the new date back into that file. The view is offered
automatically wherever a folder has dated children, and a folder can optionally
declare it as its default presentation. The driving use case is a content
calendar — each file is a post whose body is the content itself.

---

## Problem Frame

Treehouse folders today present as a default page or a flat file listing. Neither
shows _when_ the files in a folder are meant to happen. The concrete case: a user
plans social content as one markdown file per post, and the natural way to work
that material is a calendar — see what publishes when, spot the gaps, and drag a
post to a new day to reschedule it. That workflow lives in Notion today, and the
reason to bring it to Treehouse is that the content is already plain dated files
the agent and the team share; the only thing missing is a view that arranges them
in time.

The pieces this needs already exist. Front matter is first-class metadata —
parsed, type-aware, with dates already formatted for reading and an editable
fields surface (`packages/app/app/utils/frontmatter.ts`, `FrontMatterFields.vue`).
Folders already switch between presentations (the default-page-vs-listing pattern
from the relative-paths/folder-defaults work). A calendar is a third folder view
reading dates that are already there, plus a drag that writes through the edit
path that already exists.

---

## Key Decisions

- **Calendar is a folder view, not a workspace database view.** It renders the
  files of one folder, alongside the existing listing — not a saved query that
  spans folders. The folder is the collection. This keeps the feature on the grain
  of Treehouse's file/folder model rather than importing Notion's database model.

- **Hybrid discovery: auto-offered, optionally declared.** A folder whose children
  carry a recognized date key automatically offers the Calendar view (zero-config,
  and an agent writing dated files gets it for free). A folder can also declare the
  Calendar as its default view, so a content folder opens straight into it. Pure
  auto-detect couldn't make a folder open as a calendar; pure declaration showed
  nothing until a config file existed — the hybrid keeps both properties.

- **Drag-to-reschedule reuses the front-matter edit path.** Moving a post to a new
  day re-serializes that file's front matter through the same write the fields
  surface uses. It therefore inherits that path's accepted cost: untouched files
  stay byte-identical, but a rescheduled file's YAML key order/quoting may normalize
  and comments may drop. A calendar drag is a real edit to the file's bytes, not a
  pure-view action.

- **Only dated files appear.** Undated files in a calendar folder (drafts, assets,
  the declaration file itself) do not show on the calendar; they remain in the
  listing. Scheduling a draft means giving it a date, after which it appears. There
  is no separate backlog/unscheduled tray in this version.

- **`date` is the publish-date key for v1.** The calendar reads a single `date` key
  in a file's front matter as the day it sits on. `start`/`end` are reserved for the
  later Gantt work and are not interpreted as ranges here.

---

## Requirements

**Calendar view & discovery**

- R1. A folder presents a Calendar view option alongside its file listing whenever
  at least one child file carries the recognized publish-date key in its front
  matter.
- R2. A folder can declare the Calendar as its default view, so opening the folder
  shows the calendar first; the listing remains reachable via the view control.
- R3. When no child carries a date, no Calendar option is offered and the folder
  behaves exactly as it does today.
- R4. The view control lets the user switch between the calendar and the listing
  within a folder.

**What the calendar shows**

- R5. Each dated child file appears as an entry on the day given by its publish-date
  front-matter key.
- R6. An entry shows enough to identify the file (its title or name) and opens that
  file when activated.
- R7. Multiple files on the same day are all shown for that day.
- R8. Undated child files never appear on the calendar; they remain in the listing.

**Rescheduling**

- R9. Dragging an entry to a different day writes the new date into that file's
  publish-date front-matter key, through the existing front-matter edit path.
- R10. A reschedule write goes through the standard file service, so it participates
  in the same versioning and stale-write handling as any other write; a human drag
  and an agent edit to the same file do not lose data.
- R11. Files whose date is never changed are left byte-identical; re-serialization
  happens only for a file actually rescheduled.

**Agent / human parity**

- R12. An agent setting or changing the publish-date key on a file produces the same
  calendar placement as a human dragging that file to that day. The calendar
  reflects the front-matter dates whoever wrote them.

---

## Acceptance Examples

- AE1. **Covers R1, R5.** Given a folder where `post-a.md` has `date: 2026-06-15`
  in its front matter, when the folder is opened, then a Calendar view is offered
  and `post-a.md` appears on June 15.
- AE2. **Covers R3, R8.** Given a folder of markdown files where none carries a
  date, when the folder is opened, then no Calendar option appears. When one file
  is later given a date, the option appears and only that file shows on the
  calendar.
- AE3. **Covers R9, R11.** Given `post-a.md` shown on June 15, when it is dragged to
  June 18, then its front matter records the new date and the file's body bytes are
  unchanged; a sibling that was not moved is left byte-identical.
- AE4. **Covers R2, R4.** Given a folder that declares the Calendar as its default,
  when opened, then the calendar shows first and the user can switch to the listing
  and back.
- AE5. **Covers R12.** Given an agent writes `date: 2026-06-20` into `post-b.md`,
  when the calendar is viewed, then `post-b.md` appears on June 20 with no human
  drag involved.

---

## Scope Boundaries

**Deferred for later**

- Gantt view, durations, and multi-day ranges (the `start`/`end` model). This
  version is point-in-time (one file, one day) only.
- A backlog/unscheduled tray and dragging undated drafts from it onto days.
  Scheduling in this version is done by giving a file a date.

**Outside this feature**

- Workspace-wide or cross-folder calendars (a Notion-style database view over a
  collection that spans folders). The calendar is scoped to a single folder.
- Schema, validation, or required-field enforcement on the date key — the app stays
  agnostic about front-matter meaning, consistent with the existing front-matter
  stance.

---

## Outstanding Questions

**Deferred to planning**

- The form of the folder-level declaration that pins the Calendar as default — e.g.
  a key in the folder README's front matter versus a small dedicated file. Align
  with the folder-default-page convention as the precedent.
- Whether the calendar recognizes any fallback date keys beyond `date`, or `date`
  only.
- Calendar granularity and navigation (month view assumed; week/agenda layouts,
  month-to-month paging).
- How a day with many entries renders (stacking, overflow, "+N more").
- Whether the chosen view (calendar vs listing) persists per folder or per session.
- Whether rescheduling is also possible from a non-calendar surface, or only by drag
  on the calendar.

---

## Sources / Research

- Front matter as first-class metadata: `docs/brainstorms/2026-06-09-markdown-front-matter-requirements.md`,
  `packages/app/app/utils/frontmatter.ts`, `packages/app/app/components/editors/FrontMatterFields.vue`.
- Folder view modes and convention-driven folder presentation:
  `docs/brainstorms/2026-06-09-relative-paths-folder-defaults-requirements.md`,
  `packages/app/app/components/viewers/FolderView.vue`.
- Single write path with version CAS and conflict handling (relevant to R10):
  `packages/api/server/utils/files.ts` (per `CLAUDE.md`).
- Strategy fit — agent-native parity and plain-portable-files (R12, presentation
  over rewriting): `STRATEGY.md`.