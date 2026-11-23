---
date: 2026-09-30
topic: folder-board-view
---

# Folder Board View — Requirements

## Summary

Add a folder-level **Board view**: a Trello-style set of columns where each
markdown file directly inside the folder is a card, placed in the column named by
its `status` front-matter key. Dragging a card to another column rewrites that
file's `status`; dragging within a column rewrites a per-card `order`. The board
is the calendar's twin — same folder-as-collection grain, same "a drag is a real
front-matter edit" write path, same README declaration — so an agent moves a card
by editing one line of a file.

---

## Problem Frame

Teams using Treehouse already track work as one markdown file per item, and our
own docs recommend a `status: draft` / `status: ready` convention agents
understand. Nothing in the app shows that state, so the natural way to work the
material — see what's in flight, drag a card along — lives in Trello or Notion,
away from the files the team and its agents actually share. The calendar proved
the pattern for time; a board is the same pattern for workflow stage.

---

## Key Decisions

- **Columns are a front-matter key, not subfolders.** A card's column is its
  `status` value. Moving a card never moves the file, so relative links, share
  links and paths agents remember stay valid, and one flat folder can be a
  calendar (by `date`) and a board (by `status`) at once. Subfolder-per-column was
  considered and rejected for those reasons.

- **The column key is `status`.** Fixed for v1; a configurable key is deferred.

- **Column order is declared in the README.** `columns: [backlog, doing, done]` in
  the folder's `README.md`/`index.md` front matter sets which columns exist and
  their order. The UI's column actions write to that list, so board configuration
  stays in a plain, agent-readable file.

- **Card order is a per-card `order` number, written lazily.** Only a
  within-column reorder writes it, and only to the dragged file, so each drag is
  one file under the existing per-file version CAS. Cards without `order` sort
  after ordered ones (then by title). A README-held order list was rejected as a
  conflict hotspot.

- **Cards without a `status` go in a collapsible "No status" lane.** It sits at
  the left edge, collapsed by default to a narrow strip with a count, and appears
  only when it has cards. The folder's default page (README/index) is never a
  card. Dragging a card out of the lane sets its `status`; dragging a card into it
  removes the key.

- **Unknown values get a column, not hidden.** A `status` not listed in `columns`
  (e.g. an agent writes `blocked`) renders as an extra column after the declared
  ones, marked as not in the board's columns, with a one-click **Add to columns**
  that appends it to the README list.

- **Hybrid discovery, like the calendar.** The Board view is offered automatically
  when any child carries `status`, and `view: board` in the README makes the
  folder open on it. Unlike the calendar, a declared board renders even with zero
  cards — otherwise a freshly created board would be invisible.

- **`assignee` is free text, resolved to members when it matches.** Not restricted
  to workspace members: an agent, a client, or someone not yet invited is a
  legitimate assignee. When the value matches a workspace member it renders as
  their avatar and name; otherwise as a neutral initials chip with the raw text.
  The in-app picker writes the member's **display name**, not their user id, so
  the file stays readable to people and agents (and no opaque id or email leaks
  through a share link).

- **A drag reuses the front-matter edit path.** Same accepted cost as the
  calendar: untouched files stay byte-identical; a moved file's front-matter block
  is re-serialized (key order/comments may normalize).

---

## Requirements

**Board view & discovery**

- R1. A folder offers a Board view whenever at least one child markdown file
  carries `status`, or its default page declares `view: board`.
- R2. `view: board` in the default page's front matter makes the folder open on
  the board. A declared board renders its columns even with no cards.
- R3. The folder view switcher gains **Board** alongside the default page,
  **Files** and **Calendar**.
- R4. Only markdown files directly in the folder are cards; the default page,
  non-markdown files and subfolders are not.

**Columns**

- R5. Declared `columns` render in their listed order, including empty ones.
- R6. A `status` value not in `columns` renders as an extra column after the
  declared ones, visibly marked, with an **Add to columns** action that appends
  it to the README's `columns`.
- R7. Without a `columns` declaration, columns are derived from the values
  present, in order of first appearance (sorted by title).
- R8. Cards without `status` appear in a collapsible **No status** lane, shown
  only when non-empty and collapsed by default.
- R9. **Add column** appends to `columns` (creating the README, or its front
  matter, when absent). Removing a column is allowed only when it's empty.
  Renaming a column rewrites `columns` and the `status` of every card in it, after
  a confirmation that states how many files will change.

**Cards**

- R10. A card shows its `title` (or file name), and, when present: `tags` as
  chips, `due` (else `date`) as a date chip, `assignee` (R17), a checklist count
  derived from `- [ ]`/`- [x]` lines in the body, and the file's comment count.
- R11. Activating a card opens the file in a right-hand drawer (reader, editor
  and Metadata form) with the board still visible; the drawer can expand to the
  full file view.
- R12. **Add card** at the foot of a column asks for a title and creates
  `<slug>.md` with `title` and `status` set to that column (suffixing the slug on
  a name clash).
- R13. Each card has a **Move to…** menu listing the columns, as the keyboard and
  phone alternative to dragging.

**Moving & ordering**

- R14. Dragging a card to another column rewrites its `status`; dropping into No
  status removes the key.
- R15. Reordering within a column writes `order` on the dragged card only, as a
  value between its new neighbours'.
- R16. Every move goes through the standard file service (version CAS, conflicted
  copy on a stale write). A conflicted copy that lands on the board is shown with
  a "conflicted copy" badge.

**Assignees**

- R17. `assignee` accepts a string or a list of strings. A value that matches a
  workspace member's name (case-insensitive) renders as that member's avatar and
  name; any other value renders as an initials chip with the raw text.
- R18. The in-app assignee picker lists workspace members and writes their
  display name; free text can still be typed.

**Setup**

- R19. **New board** sits beside **New folder**: it asks for a name and creates
  the folder with a `README.md` carrying `title`, `view: board` and default
  columns `[To do, Doing, Done]`, then opens the empty board.
- R20. An existing folder's **⋯** menu offers **Show as board**, which writes
  `view: board` (and `columns`, seeded from existing `status` values or the
  defaults) into its README, creating the README when absent. Existing unstatused
  files land in No status, so triage is dragging them into columns.
- R21. Setting up by asking an agent ("make a board for X") produces exactly the
  same files and result as R19/R20 — no app-only state.

**Sharing, mobile, parity**

- R22. Share links show the board read-only: no drags, no Add card/column, drawer
  in read mode.
- R23. On a phone, the board shows one column at a time with column tabs;
  dragging is replaced by Move to….
- R24. An agent writing or changing `status`, `order` or `assignee` produces the
  same board as the equivalent human action.

**Agent onboarding & docs**

- R25. The bootstrap setup guide (`SEED_AGENTS` in `seed-content.ts`) describes
  boards in its "Treehouse conventions" section, and its structure step suggests
  a board for work-tracking folders (as it suggests calendars for dated ones).
- R26. The MCP server instructions (`mcp.ts`) list `view: board`, `columns`,
  `status`, `order` and `assignee` alongside the calendar keys.
- R27. A read-only MCP tool lists workspace members' display names (no emails), so
  an agent can assign a real person correctly.
- R28. Public docs: the front-matter reference, folder pages (or a new board
  page), the agent handbook, the MCP server reference, the "write your AGENTS.md"
  playbook, and the agent skill (`packages/marketing/skills/treehouse/SKILL.md`)
  are updated, and the agent callout listing the keys the app acts on is
  corrected. Screenshots regenerated.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R14.** Given `roadmap/` with `columns: [backlog, doing,
  done]` and `search.md` carrying `status: backlog`, when the board is opened and
  `search.md` is dragged to Doing, then its front matter reads `status: doing`, its
  body is byte-identical, and no sibling file changed.
- AE2. **Covers R6.** Given an agent writes `status: blocked` to a card, then a
  "blocked" column appears after Done, marked as undeclared; choosing **Add to
  columns** appends `blocked` to the README's `columns`.
- AE3. **Covers R8.** Given three files without `status`, then a collapsed "No
  status · 3" strip shows at the left; dragging one into Doing sets its status and
  the count drops to 2. With none left, the strip disappears.
- AE4. **Covers R15.** Given cards A, B, C in Doing, when C is dragged between A
  and B, then only C's file is written, and the column reads A, C, B.
- AE5. **Covers R17.** Given `assignee: [Zef, claude]` and a member named "Zef",
  then the card shows Zef's avatar and a "claude" initials chip.
- AE6. **Covers R2, R19.** When **New board** "Launch" is created, then a
  `Launch/README.md` exists with `view: board` and three columns, and the folder
  opens on an empty three-column board.
- AE7. **Covers R16.** Given a card is edited by an agent while a human drags it,
  then the human's move is kept as a conflicted copy, which appears on the board
  with a badge, and nothing is lost.

---

## Scope Boundaries

**Deferred for later**

- A configurable column key (`group_by:`).
- Swimlanes, WIP limits, column colours, card cover images, labels with colours.
- Bulk card actions, filtering and search within a board.
- Column labels distinct from values (`{ value, label }` objects).

**Outside this feature**

- Cross-folder or workspace-wide boards; the board is one folder.
- Validation or enforcement of `status` values; unknown values are shown, not
  rejected.
- Restricting `assignee` to members, or notifying assignees.

---

## Outstanding Questions

**Deferred to planning**

- **Loading cost.** `useFolderDates` reads every markdown child's bytes
  separately. Generalize it into one folder front-matter loader shared by the
  calendar and board, and decide whether a bulk endpoint (or front matter cached
  on the file record at write time) is needed before boards grow past ~50 cards.
- A folder-view registry (default page / Files / Calendar / Board each declaring
  when it applies and how it renders) in place of growing `resolveDefaultView`.
- The `order` representation (float midpoint vs. fractional-index string) and
  when to renumber.
- Whether the drawer is a new surface or a variant of the existing details panel.
- Whether the Board and Calendar share one card component.

---

## Sources / Research

- Calendar precedent: `docs/brainstorms/2026-06-12-folder-calendar-view-requirements.md`,
  `packages/app/app/composables/useFolderDates.ts`,
  `packages/app/app/composables/useCalendarReschedule.ts`,
  `resolveDefaultView` in `packages/app/app/utils/treehouse.ts`.
- Front-matter edit path: `setFrontMatterDate` in
  `packages/app/app/utils/frontmatterData.ts` (generalize to set any key).
- Existing `status` convention: `packages/marketing/content/docs/files/front-matter.md`.
- Members: `useWorkspaceMembers` (`id`, `name`, `image`).
- Agent onboarding surfaces: `packages/api/server/utils/seed-content.ts`,
  `packages/api/server/utils/mcp.ts`, `packages/marketing/skills/treehouse/SKILL.md`.