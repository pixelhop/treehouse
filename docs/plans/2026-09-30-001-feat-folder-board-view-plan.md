---
date: 2026-09-30
topic: folder-board-view
requirements: docs/brainstorms/2026-09-30-folder-board-view-requirements.md
status: complete
---

# Folder Board View — Plan

Build order is bottom-up: pure logic with tests first, then the shared loader and
write path, then the UI, then setup, agent surfaces and docs, and finally a
visual check on a seeded local stack. Each step ends in something checkable.

## Shape of the change

```
utils/board.ts                pure: card extraction, column building, ordering,
                              checklist, assignee resolution, card slugs, README
                              declaration edits
utils/frontmatterData.ts      setFrontMatterFields (generalizes setFrontMatterDate)
composables/useFolderFrontMatter.ts
                              replaces useFolderDates: one read per markdown child
                              feeds calendar entries AND board cards
composables/useFrontMatterWrite.ts
                              the CAS read-patch-write used by the calendar drag
                              and every board action (useCalendarReschedule
                              becomes a thin wrapper)
composables/useBoardActions.ts
                              move, create card, add/rename/remove column,
                              assign, enable board; workspace surface only
components/viewers/BoardView.vue
components/viewers/BoardCard.vue
components/BoardCardDrawer.vue
WorkspaceView / ShareView     Board in the folder switcher, full-width branch,
                              "Show as board" in ⋯
AppSidebar                    "New board"
api: utils/members.ts, mcp.ts list_members (both servers), instructions,
     seed-content.ts
docs + skill + screenshot seed
```

## Decisions made while planning

- **Capabilities are injected, as with the calendar.** `BoardView` gets an
  optional `actions` prop. The share view never constructs it, so a public board
  has no write path at all rather than a flag guarding one.
- **Status matching is case-insensitive and trimmed.** `status: doing` lands in a
  declared `Doing` column; the UI always writes the declared spelling. Undeclared
  values group case-insensitively, labelled by their first spelling seen.
- **Only string or number statuses count.** Anything else (a list, a map) is
  treated as no status rather than guessed at.
- **Order.** Cards with a numeric `order` sort first, ascending; the rest follow
  by title. A drop computes the midpoint of its neighbours' orders (or ±1 at an
  end). Dropping inside the unordered tail places the card at the end of the
  ordered run, because placing it mid-tail would require writing its neighbours
  too. **Move to…** clears `order`, so the card joins the column's tail.
- **Declared board with no `columns`.** Columns are derived from values present;
  an empty declared board shows only **Add column**.
- **README writes.** Enabling a board patches the existing default page's front
  matter (`view`, plus `columns` when absent), or creates `README.md` with
  `title`, `view` and `columns`. Adding, renaming and removing columns patch
  `columns` the same way.
- **Rename rewrites cards sequentially** after a confirm that states the count.
  Each card write is its own CAS; a conflict on one card is reported and the rest
  continue.
- **Drawer.** Reads the card with the existing `FileViewer` (front matter card
  included). **Open** navigates to the file; **Edit** navigates and opens the
  editor via `pendingEditPath`. In-drawer editing is deferred.

## Deferred from the requirements (stated in the PR)

- Comment counts on cards (R10): there is no per-path count endpoint, and one
  request per card is the wrong price. Needs a bulk count first.
- A bulk front-matter endpoint: the loader stays per-file for now, as the calendar
  does. Fine to ~50 cards.
- In-drawer editing (R11 asks for the editor in the drawer; v1 hands off to the
  file page).

## Steps

### 1. Pure logic (`utils/board.ts`, `utils/frontmatterData.ts`)

- `setFrontMatterFields(source, patch)` — `undefined` deletes a key, byte-identical
  return when nothing changes, creates a block when absent, throws on an
  unparseable block. `setFrontMatterDate` delegates to it.
- `toBoardCard(candidate, fm, body)`, `buildBoard(cards, declaredColumns)`,
  `orderForDrop(columnCards, index, draggedPath)`, `checklistCounts(body)`
  (ignores fenced code), `assigneeNames(value)`, `resolveAssignee(name, members)`,
  `cardFileName(title, existingNames)`, `boardDeclaration(...)` helpers,
  `resolveDefaultView` gains `"board"`.
- Tests: `packages/app/test/board.test.ts`, additions to the front-matter and
  treehouse tests.

### 2. Loader and write path

- `useFolderFrontMatter` reads each markdown child once and exposes
  `datedChildren`, `boardCards`, `hasStatusChildren`, `defaultPageFrontMatter`.
  Callers updated: WorkspaceView, ShareView.
- `useFrontMatterWrite().patch(path, patch)` — read with version, patch, CAS
  write, refresh; returns `ok | conflict | error` like reschedule.
- `useBoardActions()` built on it, plus `createFile` for new cards and READMEs.

### 3. Board UI

- `BoardView.vue`: header (title), notice banner, No status lane (collapsible,
  collapsed by default, only when non-empty), columns with count, undeclared
  marker + **Add to columns**, column menu (**Rename**, **Remove** when empty),
  **Add card** inline input, **Add column**, HTML5 drag with an insertion line,
  optimistic overrides cleared when props catch up (the calendar's pattern).
  Compact layout: column tabs, one column, no drag.
- `BoardCard.vue`: title, tags, due chip, assignees, checklist count, conflicted
  badge, ⋯ menu (**Move to…**, **Assign**).
- `BoardCardDrawer.vue`: right-hand overlay over the board area, Esc/scrim close.

### 4. Integrate

- Folder switcher gains **Board**; `view: board` opens on it; board takes a
  full-width branch in both WorkspaceView and ShareView (read-only there).
- ⋯ gains **Show as board** for a folder that isn't declared a board.
- Sidebar gains **New board** beside **New folder**.

### 5. Agent surfaces

- `server/utils/members.ts` shared by the members route and a new read-only
  `list_members` MCP tool (names and roles, no emails) on both the
  workspace-scoped and user-scoped servers. MCP test tool lists updated.
- `SERVER_INSTRUCTIONS` and `SEED_AGENTS` describe boards; seed test checked.

### 6. Docs

- New how-to `files/boards.md`; front-matter reference rows for `view: board`,
  `columns`, `status`, `order`, `assignee`, `due`, `tags`; agent callout
  corrected; folder pages cross-link; agent handbook table; MCP reference gains
  `list_members`; write-your-agents-md playbook; agent skill.
- Docs screenshot seed gains a board folder; `folder-board` screenshot captured.

### 7. Verify

- `vp check`, `vp test` (app + api unit tests; server-gated MCP tests run when the
  local API is up).
- Local stack on a throwaway database with the docs seed; drive the board in
  `agent-browser`: open, drag between columns, reorder, No status lane, add card,
  add column, undeclared column → **Add to columns**, drawer, Move to…, assign,
  **New board**, **Show as board**, phone width, public share read-only. Confirm
  file bytes after each write.
- Upload the screenshots to a Did It Though review for the PR with
  `npx @pixelhop/dit upload`.

## Changes during the build

- **New board moved into the sidebar's tree menu.** Placed beside New folder
  (R19), a fourth button squeezed that row's labels onto two lines. It now
  sits in the **⋯** menu next to the search box; existing folders use **Show as
  board** in the top bar.
- **Columns are 16rem, not 18rem**, so four or five fit beside the sidebar at a
  laptop width; the rest scroll sideways.
- **Assignee avatars sit side by side**, not overlapped: overlapping hid the
  initials.
- **`initials` renamed `assigneeInitials`.** Nuxt auto-imports utils by name,
  and the board's helper silently replaced the activity feed's own `initials`.
- **Share links show initials only.** A public share has no member list (by
  design), so assignees there never resolve to avatars.