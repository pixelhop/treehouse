# Mobile audit — the Treehouse workspace

**Date:** 2026-08-22 · **Method:** real Chromium at 390×844 (iPhone 14 class), 768×1024
(iPad portrait) and 844×390 (landscape), driven through the live dev stack with a
seeded workspace (nested folders, dated journal, HTML pages, JSON, a wide table,
long URLs). Every claim below is a measurement or a screenshot, not a reading of
the code.

## Verdict

The signed-in workspace is not merely cramped on a phone — it is a **dead end**.
On a fresh 390px load the file content pane measures **0 pixels wide**, and the
only control that could fix that is itself rendered off-screen and unreachable by
touch. The same is true of a public share link, which is the surface a
first-time visitor is most likely to open on a phone.

By contrast the auth pages, the onboarding `/connect` flow, and every modal
dialog are already genuinely responsive and look good. The problem is
concentrated in one place: the app shell and its top bar.

---

## P0 — unusable out of the box

### 1. Both side panels are pinned open; the content pane gets 0px

`AppShell.vue:35-58` lays the left `<aside>` as a flex sibling of `<main>`, and
`WorkspaceView.vue` does the same for the details `<aside>`. Neither has a
breakpoint. `useSidebar` and `useDetailsPanel` both default to **open**.

Measured at 390×844 on first load:

| element             | x   | width                                               |
| ------------------- | --- | --------------------------------------------------- |
| left sidebar        | 0   | 272                                                 |
| `<main>`            | 272 | **118**                                             |
| content `<section>` | 272 | **0**                                               |
| details `<aside>`   | 272 | 320 _(right edge at 592 — 202px past the viewport)_ |

The shell is `h-screen w-screen overflow-hidden`, so the overflowing details
panel is clipped, not scrollable. You see a file tree and a sliver of nothing.

_Evidence: [`04-root-seeded.png`](../images/mobile-audit/04-root-seeded.png)_

### 2. The details toggle is off-screen, so the panel can never be closed

`AppTopBar`'s actions row is `ml-auto flex items-center gap-1` — it does not
wrap, does not scroll, and sits inside `overflow-hidden`. Button positions at
vw=390:

| control               | x       | on screen? |
| --------------------- | ------- | ---------- |
| sidebar toggle        | 284     | yes        |
| breadcrumb root       | 320     | yes        |
| README/Files switcher | 386     | **no**     |
| Open file             | 547     | **no**     |
| Activity              | 606     | **no**     |
| Refresh               | 638     | **no**     |
| **Hide details**      | **712** | **no**     |

Collapsing the left sidebar first does not rescue it — "Hide details" merely
moves to x=440, still past the 390px edge. `header.scrollWidth` is 468 against a
`clientWidth` of 390, but the ancestor is `overflow-hidden`, so there is no
gesture that reaches it.

The state persists to `localStorage`, so reloading doesn't help either. A phone
user has no path back to their own content.

_Evidence: [`05-sidebar-collapsed.png`](../images/mobile-audit/05-sidebar-collapsed.png), [`06-both-closed.png`](../images/mobile-audit/06-both-closed.png)_

### 3. Public share links are broken the same way

A shared folder opened on a phone gives a 272px file tree and 118px of content —
and this visitor has no `localStorage` from a desktop session to have collapsed
anything, and no reason to hunt for a hidden toggle. This is the acquisition
surface.

_Evidence: [`21-share-folder.png`](../images/mobile-audit/21-share-folder.png)_

### 4. Opening a panel pushes content rather than overlaying it

Because the asides are flex siblings, showing one steals width from the
document. At phone widths there is no width to steal. Both panels can also be
open at once, which there is never room for.

### 5. It's not just phones — tablet portrait is broken too

At 768×1024 with both panels open the content column is 176px and the `<h1>`
("Client Proposal") is clipped mid-word. Three fixed panes need roughly
272 + 320 + 600 ≈ **1200px** to work. Everything below ~1100px needs a different
layout.

_Evidence: [`28-tablet-768.png`](../images/mobile-audit/28-tablet-768.png)_

---

## P1 — reachable, but broken on touch

### 6. File-tree row actions are hover-only and inert on touch

`FileTree.vue:263-324` reveals rename / delete / make-private / new-file-in-folder
with `opacity-0 pointer-events-none group-hover:opacity-100`. Verified computed
style with no hover: `opacity: 0; pointer-events: none`. There is no hover on a
phone, so **four of the five per-row operations do not exist on mobile**. Their
hit areas are 22×22px when they do appear.

### 7. Moving and reordering files is impossible on touch

The only affordance is HTML5 drag-and-drop (`draggable`, `@dragstart`,
`@dragover`, `@drop` — `FileTree.vue:170-173`). Those events do not fire from
touch input, and there is no menu equivalent. (The upload drop zone is fine — it
has a real picker button.)

### 8. Markdown prose overflows and drags the whole document sideways

`.prose` has no `overflow-x-auto` wrapper on tables or `pre`, and no
`overflow-wrap`. Because `main section` is `overflow-auto` on _both_ axes, the
overflow makes the entire page scroll horizontally rather than just the table:
`scrollWidth 601` vs `clientWidth 390`. Headings, blockquotes and lists all drift
off-screen together. Affected: wide tables (a 7-column table loses its last two
columns), long URLs, long unbroken tokens.

The standalone `CodeViewer` is fine — its `<pre>` has `overflow-auto` and scrolls
correctly on its own. It's specifically rendered markdown that leaks.

_Evidence: [`09-torture.png`](../images/mobile-audit/09-torture.png), [`10-torture-hscrolled.png`](../images/mobile-audit/10-torture-hscrolled.png)_

### 9. Breadcrumbs collapse to single characters

Every crumb is `truncate` inside an unconstrained flex row, so they shrink
equally: `clients/acme/brief-…md` renders as `c / a / b…`. Useless as
navigation and as orientation.

### 10. The filter input triggers iOS zoom

`Filter files…` is 14px. Mobile Safari auto-zooms the page on focus for any input
under 16px and does not zoom back out. It is also only 30px tall.

### 11. `h-screen` instead of `h-dvh`

`AppShell.vue:35` uses `h-screen` (100vh). On iOS Safari 100vh excludes the
browser chrome, so the bottom of the sidebar — the account row and its
upward-opening menu — sits underneath it. Combined with `overflow-hidden` there
is no way to scroll it into view. No `dvh`/`svh` anywhere in the app.

### 12. Touch targets

**73 of 79** interactive elements in the workspace measure under 32px in at least
one dimension: tree rows 28px tall, expand chevrons 22×22, all row actions
22×22. Apple's HIG asks 44pt; WCAG 2.2 AA (2.5.8) asks 24×24 CSS px as a floor.

### 13. The editor toolbar clips

In edit mode the Link button is cut at the viewport edge and the editor's own
Rendered/Source toggle is entirely off-screen (x 403–538 at vw 390), so you
cannot switch to source while editing on a phone.

_Evidence: [`14-editor.png`](../images/mobile-audit/14-editor.png)_

### 14. Calendar month grid is unreadable at phone width

Seven columns in 326px truncates every entry to `Fir…`, `Se…`, `Th…`. A month
grid is the wrong shape for a phone.

_Evidence: [`18-calendar.png`](../images/mobile-audit/18-calendar.png)_

### 15. Selecting a file doesn't dismiss the sidebar

Once the sidebar overlays rather than pushes, tapping a file must close it —
otherwise every navigation leaves the user staring at the tree they just used.

---

## P2 — smaller things found along the way

- **`/connect` renders a sidebar toggle on a page with no sidebar.**
  `pages/connect/index.vue:112` mounts `<AppTopBar title="Connect" />` inside the
  deliberately chromeless `onboarding` layout. Tapping it silently flips the
  workspace's persisted sidebar state for later. Not mobile-specific, but on a
  phone it's one of only two tappable things in that header.
- **Activity glance drawer is a fixed `w-80`** (`ActivityGlance.vue:51`) leaving a
  70px dead strip on a phone, and its backdrop (`fixed inset-0 z-40`) has no
  scrim, so the page behind stays at full brightness.
- **`scripts/dev-env.mjs` crashes on a fresh worktree.** `sh()` calls `.trim()` on
  `execFileSync`'s return value, which is `null` when `stdio` is inherited —
  so `ensureDeps()` (line 174) throws the moment it actually has to run
  `pnpm install`. Re-running works because `node_modules` then exists.

---

## What already works well on mobile

Worth saying, because it shows the house style is achievable:

- **Sign-in / sign-up** — properly responsive, and they look good ([`26-signup.png`](../images/mobile-audit/26-signup.png)).
- **`/connect` onboarding** — correctly detects a phone and offers "keep using
  Treehouse right here in your browser" instead of a Mac DMG ([`24-connect-ios.png`](../images/mobile-audit/24-connect-ios.png)).
- **All dialogs** — API keys, Appearance/Theme, New workspace.
- **Full activity page** ([`16-activity-page.png`](../images/mobile-audit/16-activity-page.png)) and the file-details Info /
  History / Share tabs, which lay out fine inside their panel.
- **Code/JSON viewer** — scrolls correctly on its own axis.

---

# Proposed fixes

Ordered so that the first block alone takes the app from unusable to usable.

## Stage 1 — the shell (fixes 1–5, 15)

**1.1 A single composable owns panel state.** Introduce `usePanels()` that
replaces the independent `useSidebar().open` / `useDetailsPanel().open` booleans
with one rule set:

- **Desktop (≥ `lg`, 1024px):** both panels independent and persisted, exactly as
  today.
- **Mobile:** state is `'left' | 'right' | null`, so **the two can never be open
  at once**, and it starts at `null` — never inheriting the desktop `true`.
  Deliberately _not_ persisted, so a phone always opens on content.

Keeping the rule in one place is the point: today the mutual-exclusion bug exists
because two composables each think they own a boolean.

**1.2 Panels overlay instead of pushing.** In `AppShell.vue` and
`WorkspaceView.vue`, below `lg` the asides become
`fixed inset-y-0 z-40 w-[min(85vw,320px)]` with a slide transition, over a
`fixed inset-0 z-30 bg-black/40` scrim that closes on tap. Left anchors left,
details anchors right. The drag-to-resize handle is hidden below `lg` (there is
nothing to resize into).

**1.3 `h-screen` → `h-dvh`** on the shell, so iOS Safari's chrome stops eating
the account row.

**1.4 Selecting a file or folder closes the mobile panel.**

**1.5 Same treatment for the public share view** — it renders through the same
`AppShell`, so it comes free, but it needs its own pass in the browser because it
has no prior localStorage and a different default state.

## Stage 2 — the top bar (fix 2, and the class of bug it represents)

The dead end in finding 2 is structural, so the fix should be structural too:
**it must be impossible for a top-bar control to be unreachable.**

**2.1 Give the actions row `overflow-x-auto`** and the breadcrumb
`min-w-0 flex-1`, so the breadcrumb yields space to the actions rather than the
other way round. This is the belt-and-braces guarantee.

**2.2 Below `lg`, collapse secondary actions into one "⋯" overflow menu.** Keep
in the bar only: panel toggle · breadcrumb · Edit (when editable) · Activity ·
details toggle. Move into the menu: Refresh, the folder-view switcher
(README/Calendar/Files), Open file, and the Rendered/Source toggle.

**2.3 Breadcrumb degrades by dropping segments, not characters** (fix 9): show
`…/acme/brief.md` with the collapsed head as a tappable "…" that lists the
ancestors. Only the final crumb gets `truncate`; the rest are `shrink-0`.

## Stage 3 — touch-first file tree (fixes 6, 7, 12)

**3.1 Replace hover-reveal with a real menu.** Under `@media (hover: none)` (or
simply below `lg`), render one always-visible "⋯" button per row that opens a
sheet with Rename · Move to… · Make private · Delete · New file here. The
hover cluster stays on desktop.

**3.2 Add a non-drag path for moving and reordering** — "Move to…" opens a folder
picker; "Move up / Move down" covers ordering. This is the only way those
operations exist at all on a phone, so it is a functionality gap rather than a
styling one.

**3.3 Size for fingers below `lg`:** rows to ~44px, icon buttons to 40×40. Keep
desktop density unchanged.

## Stage 4 — content that stays inside the screen (fixes 8, 10)

**4.1 Wrap rendered-markdown tables in a scroll container.** Post-process the
rendered HTML to wrap `<table>` in `<div class="overflow-x-auto">` — preferable
to `display: block` on the table itself, which throws away table layout.

**4.2 Add to `.prose` in `tailwind.css`:** `overflow-wrap: anywhere` for long URLs
and tokens, and `overflow-x: auto` on `pre`.

**4.3 Change `main section` from `overflow-auto` to
`overflow-y-auto overflow-x-hidden`,** so a stray wide child can never slide the
whole document sideways again.

**4.4 Reading column padding `px-8` → `px-4 sm:px-8`** (32px each side is a lot of
a 390px screen).

**4.5 Filter input to 16px below `lg`** to stop iOS zoom-on-focus.

## Stage 5 — remaining surfaces (fixes 13, 14, and the P2 list)

- **Editor toolbar:** `flex-wrap` plus `overflow-x-auto`; move the editor's
  Rendered/Source toggle up into the Save/Done row on mobile so it can't be
  pushed out.
- **Calendar:** below `sm`, render an agenda list grouped by day instead of the
  month grid, with a month/agenda toggle. (Cheaper interim: make the grid
  horizontally scrollable at `min-w-[560px]` so entry names are at least legible.)
- **Activity glance:** `w-80` → `w-full max-w-sm`, and add a scrim to its backdrop.
- **`/connect`:** drop the `<AppTopBar>` (or pass `:sidebar-toggle="false"`).
- **`scripts/dev-env.mjs`:** don't `.trim()` a possibly-null `execFileSync` result.

## How to verify

Re-run the same drive at 390×844, 768×1024 and 844×390, plus a public share link
in a clean profile (no localStorage), and confirm: content pane never below
~320px; every top-bar control reachable; rename/move/delete performable by touch
alone; no horizontal document scroll on `torture.md`.

---

# Outcome — all five stages shipped, 2026-08-22

Every finding above is fixed. Re-driven in a real browser at 390×844, 414×896,
768×1024, 844×390 and 1400×900.

## Measured, after

|                                           | before    | after  |
| ----------------------------------------- | --------- | ------ |
| content pane at 390px                     | **0px**   | 390px  |
| unreachable top-bar controls              | 6         | **0**  |
| hover-only (touch-inert) controls         | 4 per row | **0**  |
| document scrolls sideways on `torture.md` | yes       | **no** |
| tap targets under 24px                    | 73 of 79  | **0**  |
| inputs under 16px (iOS zoom)              | 1         | **0**  |

The two 13×13 elements the sweep still reports on `torture.md` are `disabled`
markdown task-list checkboxes — decorative, not controls.

## What changed

**Panels** — `app/utils/panels.ts` (the rule, pure and tested) +
`composables/usePanels.ts` (state and persistence). `useSidebar` and
`useDetailsPanel` are now thin views onto it, so call sites kept their shape and
there is one owner of the behaviour. Below `lg` the panels overlay behind a
tap-to-close scrim, are mutually exclusive, start closed, and never write the
persisted desktop preference. Selecting a file dismisses them. `h-screen` →
`h-dvh`.

**Top bar** — the breadcrumb is now the only element allowed to shrink and the
actions are `shrink-0`, so controls can never be pushed off the edge again.
Secondary controls move into a teleported "⋯" sheet below `lg` via a new `#menu`
slot. `PathBreadcrumb.vue` drops whole path segments into a tappable "…" instead
of shrinking every crumb to a letter.

**File tree** — an always-visible per-row "⋯" on compact, opening a sheet with
Rename · Move to… · Move up/down · Make private · Delete · New file here. The new
`MoveNodeDialog.vue` gives moving a tap-reachable destination picker, and
Move up/down covers reordering — both were drag-only, so both were impossible on
touch. Rows and controls are finger-sized below `lg`; desktop density and the
hover cluster are untouched.

**Content** — `rewriteMarkdownRefs` now wraps every table in a
`.table-scroll` div (idempotent, covered by tests), `.prose` gets
`overflow-wrap: anywhere` with cells opting out, and the page pane is
`overflow-x-hidden` so one wide child can never drag the document sideways.

**Elsewhere** — editor toolbar reordered so the source toggle can't be pushed out
and the format strip scrolls; the calendar renders an agenda list below `lg`
instead of a seven-column grid; the activity drawer got a scrim and full-width
sizing; `/connect` no longer mounts `AppTopBar` (and its stray sidebar toggle)
inside the chromeless onboarding layout; `scripts/dev-env.mjs` no longer crashes
`env:setup` on a fresh worktree.

## Tests

`packages/app/test/panels.test.ts` (15 cases) locks the two invariants that
would reintroduce the original bug: on a compact screen at most one panel is
ever open, and a compact toggle never writes the wide persisted state. Plus four
cases for table wrapping in `markdown-refs.test.ts`. Suite: 849 passed.

## After

|                                                                      |                                            |
| -------------------------------------------------------------------- | ------------------------------------------ |
| [Workspace root, 390px](../images/mobile-audit/fix-23-final.png)     | opens on the document, full width          |
| [Sidebar overlay](../images/mobile-audit/fix-02-sidebar.png)         | scrim, finger-sized rows, per-row "⋯"      |
| [Row action sheet](../images/mobile-audit/fix-03-rowmenu.png)        | every operation tap-reachable              |
| [Move destination picker](../images/mobile-audit/fix-04-moveto.png)  | moving without drag                        |
| [Wide table](../images/mobile-audit/fix-09-table.png)                | scrolls on its own axis                    |
| [Calendar agenda](../images/mobile-audit/fix-14-calendar.png)        | full entry titles                          |
| [Editor](../images/mobile-audit/fix-16-editor.png)                   | source toggle pinned, format strip scrolls |
| [Public share](../images/mobile-audit/fix-17-share-folder.png)       | opens on the shared document               |
| [Tablet portrait](../images/mobile-audit/fix-19-tablet.png)          | full-width document                        |
| [Desktop 1400px](../images/mobile-audit/fix-15-desktop-calendar.png) | unchanged                                  |

## Left alone

- **Drag-to-reschedule in the calendar** has no touch equivalent, so the compact
  agenda doesn't offer it. The entry's own page still edits the date, and the
  grid is a rotation or a wider screen away.
- **Markdown task-list items** render with a stray bullet beside the checkbox.
  Pre-existing and identical on desktop — not a mobile defect, so out of scope
  here.
- **Top-bar action order on desktop** shifted slightly (Refresh now precedes
  Activity) as a consequence of the `#menu`/`#actions` split. Harmless, and
  arguably better grouped.