---
version: alpha
name: Treehouse
description: Brand and design system for Treehouse — the shared file workspace where humans and agents work together. Light theme only for now; the app's theme switcher is a separate concern.
colors:
  leaf: "#2E7D58"
  leaf-deep: "#235F44"
  moss: "#6BA368"
  sage: "#A8C5A1"
  mist: "#DDE8D9"
  cream: "#F7F4EC"
  parchment: "#EFE9DC"
  wood: "#C89A5B"
  bark: "#8A6B47"
  charcoal: "#2B2F33"
  sky: "#D6E6F7"
  sky-deep: "#5B8DD9"
  white: "#FFFFFF"
  primary: "{colors.leaf}"
  secondary: "{colors.parchment}"
  accent: "{colors.mist}"
  canvas: "{colors.cream}"
  surface: "{colors.white}"
  on-surface: "{colors.charcoal}"
  success: "#3E8E5E"
  warning: "#B8862E"
  error: "#C0473A"
  agent: "{colors.sky-deep}"
  human: "{colors.moss}"
typography:
  display:
    fontFamily: Fraunces
    fontSize: 88px
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: -0.015em
  headline-xl:
    fontFamily: Fraunces
    fontSize: 56px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Fraunces
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Nunito Sans
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.25
  headline-sm:
    fontFamily: Nunito Sans
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.3
  body-lg:
    fontFamily: Nunito Sans
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: Nunito Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: Nunito Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  label-md:
    fontFamily: Nunito Sans
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.3
  label-eyebrow:
    fontFamily: Nunito Sans
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.14em
  mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: 0px
  sm: 6px
  md: 10px
  lg: 16px
  xl: 24px
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
  4xl: 96px
  gutter: 24px
  margin: 32px
  container-max: 1280px
components:
  button-primary:
    backgroundColor: "{colors.leaf}"
    textColor: "{colors.white}"
    rounded: "{rounded.full}"
    padding: 12px 22px
    typography: "{typography.label-md}"
  button-primary-hover:
    backgroundColor: "{colors.leaf-deep}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.charcoal}"
    border: 1px solid {colors.mist}
    rounded: "{rounded.full}"
    padding: 12px 22px
    typography: "{typography.label-md}"
  button-secondary-hover:
    backgroundColor: "{colors.mist}"
  chip:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.leaf-deep}"
    rounded: "{rounded.full}"
    padding: 4px 12px
    typography: "{typography.body-sm}"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.charcoal}"
    border: 1px solid #E5E0D2
    rounded: "{rounded.md}"
    padding: 10px 14px
    typography: "{typography.body-md}"
  input-focus:
    ring: "{colors.leaf}"
  card:
    backgroundColor: "{colors.white}"
    border: 1px solid #E5E0D2
    rounded: "{rounded.lg}"
    padding: 24px
  activity-row-agent:
    accentColor: "{colors.sky-deep}"
  activity-row-human:
    accentColor: "{colors.moss}"
---

# Treehouse · design.md

Treehouse is a home for humans and agents — a shared file workspace where both
kinds of teammates read, write, and grow a body of work together. This document
is the single source of truth for how Treehouse looks, sounds, and feels —
written so both humans and AI agents can read it, follow it, and validate
against it.

The YAML frontmatter above is the machine-readable spec. The implementation
lives in [`packages/design/`](./packages/design/) — if the two disagree, this
document wins.

The companion `/brand` page on the marketing site is the live visual reference.
View it locally with `vp run marketing#dev`, then open `/brand`.

## Overview

**Voice.** Warm, plainspoken, quietly confident. Treehouse explains itself the
way a good host shows you around: here's your room, here's where things live,
make yourself at home. No enterprise jargon, no breathless AI hype.

**Feel.** A craft cabin with good wifi. Cream paper, deep greens, warm wood.
Soft corners, gentle shadows, things that look hand-built and looked-after.
Calm by default — the work is the star, the brand is the setting.

**Metaphor.** The treehouse. A structure built _in_ a living thing: the tree
grows (your files, your shared context), the house gives it rooms (workspaces,
folders, keys). Humans and agents climb the same ladder and share the same
rooms. Growth motifs (leaf, sprout, canopy) express the living half; built
motifs (planks, ladders, signposts) express the structure half.

**Audience.** (a) Builders setting up shared workspaces for their teams and
their agents — they reward clarity and trustworthiness; (b) the agents
themselves, consuming the MCP and REST APIs — they reward predictability and
structure. Both reward calm over hype.

## Logo

The logo is the **illustrated treehouse** — a flat-vector scene of a wooden
house held in a leafy tree: the tree that grows, the house that shelters, the
ladder anyone can climb. It ships as a finished illustration
([`packages/design/assets/logo/treehouse.svg`](./packages/design/assets/logo/treehouse.svg))
and is never redrawn, restyled, or recolored.

Every variation is the same illustration — full color on cream, or a
single-color silhouette (with the house face knocked out) when color isn't
available. The wordmark is **Treehouse** set in soft Fraunces (`SOFT` 100,
display cut `opsz` 144, weight 650, tracking -0.02em — the `.wordmark` class).
No tagline in
any lockup; "A home for humans and agents" lives in adjacent copy.

### Forms

| Variant            | What it is                                         | Use when                                     |
| ------------------ | -------------------------------------------------- | -------------------------------------------- |
| **Primary logo**   | The illustrated treehouse, wordmark beneath/beside | Heroes, decks, anywhere with room to breathe |
| **Compact lockup** | Small illustration + Fraunces wordmark             | Nav bars, footers, dense chrome              |
| **Mono**           | Charcoal silhouette (`treehouse-mono.svg`)         | Single-color printing, stamps, embossing     |
| **Reverse**        | Cream silhouette (`treehouse-reverse.svg`)         | Dark and saturated surfaces                  |
| **App icon**       | The illustration on a cream tile (`app-icon.svg`)  | Home screens, dock, OS launchers, favicon    |

SVG sources: [`packages/design/assets/logo/`](./packages/design/assets/logo/).
`app-icon.svg`/`favicon.svg` are generated by wrapping `treehouse.svg` — edit
the logo, then re-wrap.

### Rules

- The full-color logo always sits on (or fades into) **cream** — never
  hard-cropped into a rectangle, never on photos or saturated fills.
- Clear space: **0.25×** the logo height on all sides.
- Below **~36px** (favicons aside), prefer the wordmark alone over a
  shrunken logo; the silhouettes hold up better than full color at small
  sizes when a mark is unavoidable.
- Never flip, rotate, recolor, or add effects. The mono/reverse silhouettes
  are the only approved recolors.

## Colors

A garden palette: greens carry identity, cream is the canvas, wood is warmth,
sky is air. Saturation lives in small doses — the canvas stays quiet.

- **Leaf (`#2E7D58`)** — the brand green. Primary actions, links,
  focus rings. The one color every screen should contain.
- **Leaf Deep (`#235F44`)** — hover/active states of Leaf; large filled
  surfaces that need more weight (app icon, footer).
- **Moss (`#6BA368`)** — the secondary green. Positive accents, human-actor
  attribution, illustration foliage mid-tone.
- **Sage (`#A8C5A1`)** — soft decorative green. Badge rings, illustration
  highlights, large tints at low opacity.
- **Mist (`#DDE8D9`)** — sage tint for surfaces. Chips, soft fills, hover
  backgrounds. The quiet interactive surface.
- **Cream (`#F7F4EC`)** — the canvas. Page background everywhere.
- **Parchment (`#EFE9DC`)** — tonal section background; the pause between
  cream sections. Never darker than this for a section background.
- **Wood (`#C89A5B`)** — warm accent. Branch motifs, illustration planks,
  small decorative moments. Never a button, never body text.
- **Bark (`#8A6B47`)** — deep wood. Foreground on wood tints, warm captions.
- **Charcoal (`#2B2F33`)** — foreground. Body copy, headlines, icon strokes.
  Use instead of pure black, which is too cold for this brand.
- **Sky (`#D6E6F7`)** — airy backdrop tint behind canopy illustrations and
  empty states.
- **Sky Deep (`#5B8DD9`)** — informational accent and **agent-actor
  attribution** (the change feed colors agent activity with it).
- **White (`#FFFFFF`)** — cards and panels sitting on cream.

### Canopy olives (illustration only)

The logo's foliage uses a warmer olive trio: **Canopy Light `#ADB158`**,
**Canopy `#8E9C4C`**, **Canopy Deep `#74894A`** (plus the wood browns sampled
in the logo SVG). These are reserved for illustration and motifs — never UI
surfaces, text, or actions. They keep the illustrated world warm while the UI
stays in the emerald range.

### Semantic mapping

| Semantic     | Brand     | Use                                                      |
| ------------ | --------- | -------------------------------------------------------- |
| `primary`    | leaf      | Primary actions, identity, focus                         |
| `secondary`  | parchment | Tonal sections, wells                                    |
| `accent`     | mist      | Quiet interactive surface — hovers, chips, selected rows |
| `canvas`     | cream     | Page background                                          |
| `surface`    | white     | Cards, panels, inputs                                    |
| `on-surface` | charcoal  | Default text                                             |
| `success`    | #3E8E5E   | Confirmations, healthy states                            |
| `warning`    | #B8862E   | Attention without failure                                |
| `error`      | #C0473A   | Errors, destructive actions                              |
| `agent`      | sky deep  | Agent-attributed activity (keys with `actorType: agent`) |
| `human`      | moss      | Human-attributed activity                                |

The agent/human pair is load-bearing: Treehouse's change feed attributes every
event to an actor type, and these two colors are how the UI tells the story at
a glance. Keep them consistent everywhere actors appear.

## Typography

Two families, two roles, no exceptions.

- **Fraunces** — the display voice. Warm, bookish, a little storybook; it's
  where the brand personality lives. Used **only** for: the wordmark, hero and
  section headlines (40px+). Weight 600; optical sizing on; always the soft
  cut (`SOFT` 100 — rounded serif ends that echo the logo's canopy), which
  `.font-display` applies. Never for body
  copy or UI controls.
- **Nunito Sans** — the workhorse. Every paragraph, label, button, input, and
  dense UI block. Headlines `headline-md` and below also use Nunito Sans —
  Fraunces under 40px reads as decoration.
- **JetBrains Mono** — code, file paths, API keys, technical labels. Never
  decorative.

### Scale and roles

| Token           | Family         | Size | Weight | Line | Role                               |
| --------------- | -------------- | ---- | ------ | ---- | ---------------------------------- |
| `display`       | Fraunces       | 88   | 600    | 1.02 | Hero headlines                     |
| `headline-xl`   | Fraunces       | 56   | 600    | 1.05 | Page H1, large section openers     |
| `headline-lg`   | Fraunces       | 40   | 600    | 1.1  | Section openers                    |
| `headline-md`   | Nunito Sans    | 24   | 700    | 1.25 | Card titles, in-page headings      |
| `headline-sm`   | Nunito Sans    | 18   | 700    | 1.3  | Sub-headings in dense UI           |
| `body-lg`       | Nunito Sans    | 18   | 400    | 1.6  | Long-form reading, lead paragraphs |
| `body-md`       | Nunito Sans    | 16   | 400    | 1.6  | Default UI body                    |
| `body-sm`       | Nunito Sans    | 14   | 400    | 1.55 | Secondary text, captions           |
| `label-md`      | Nunito Sans    | 14   | 600    | 1.3  | Buttons, form labels               |
| `label-eyebrow` | Nunito Sans    | 12   | 700    | 1.0  | Section labels, UPPERCASE, +0.14em |
| `mono`          | JetBrains Mono | 14   | 400    | 1.5  | Code, paths, keys                  |

### Pairing rules

- **display + body-lg** is the canonical marketing pairing.
- **headline-lg + body-md** is the section pairing.
- **headline-md + body-md/sm** is the UI pairing.
- Never stack two Fraunces levels back-to-back without body text between them.
- One display-scale element per screen, maximum.

## Layout

Treehouse uses a centered container (`1280px` max) with `24px` gutters and a
4px-base spacing scale; reach for the token, not a raw pixel value.

- Sections alternate **cream → parchment** for rhythm; separate with generous
  vertical padding (`3xl`/`4xl`), not heavy borders.
- Hairline borders are `#E5E0D2` — visible on both cream and white.
- Cards: white on cream, `24px` internal padding, `rounded.lg`, minimum `12px`
  gap between siblings.
- Rows and list items: height ≥ 44px for touch.

## Elevation & Depth

Treehouse is mostly flat; tonal layers (cream → parchment → white card) do the
work. Shadows are warm (charcoal-tinted, never blue) and reserved for things
that genuinely float:

- `shadow-sm` — inputs on focus, subtle lift
- `shadow-md` — popovers, dropdowns, hovered cards
- `shadow-lg` — modals, command palette
- `shadow-ring-leaf` — focus ring on primary actions

Never stack more than two shadow levels in a composition.

## Shapes

The shape language is **soft and hand-built**: nothing sharp, nothing
machine-perfect.

- Buttons and chips: **fully rounded** (`rounded.full`) — pill shapes, like
  worn wooden handles.
- Cards and panels: `rounded.lg` (16px). Inputs: `rounded.md` (10px).
- Avatars and dots: circles. The `leaf-dot` marker (a circle with one squared
  corner, rotated 45°) is the brand's tiny leaf-shaped bullet.
- Never use right-angle corners except inside code blocks.

## Components

Canonical patterns; live implementations in `packages/marketing/app/components/`.

### Buttons

- **Primary** — leaf fill, white text, pill. One per screen for the single
  most important action. Hover: leaf-deep.
- **Secondary** — white fill, mist border, charcoal text, pill. Hover: mist
  fill.
- **Text** — leaf-colored label, no background. Tertiary actions.
- Never a wood-colored or sky-colored button.

### Chips

- Default: mist fill, leaf-deep text, pill.
- Actor chips: a leading dot in `agent` (sky deep) or `human` (moss) +
  `body-sm` label. This is the canonical actor-attribution element.

### Inputs

- White fill, `#E5E0D2` border, `rounded.md`. Focus: 2px leaf ring, no shadow.
- Search inputs pair a leading icon with an optional trailing `⌘K` hint chip.

### Cards

- White surface, hairline border, `rounded.lg`, `24px` padding.
- Optional eyebrow at top in `label-eyebrow`. Title in `headline-md`.

### File rows (product UI)

The atomic unit of Treehouse UI: icon + filename in `mono` or `body-md` +
actor chip + relative time in `body-sm` muted. Agent-touched files get the
sky-deep dot, human-touched the moss dot.

### Code blocks

- Surface: charcoal with cream text at 85% opacity.
- Header strip: language tag in `label-eyebrow`, cream at 60%.
- Body: `mono`, `px-5 py-4`.

## Motifs & Illustration

Three scales of brand decoration. Use at most **one motif per viewport** —
motifs are garnish, not wallpaper — and never put a motif behind body text.

**Section motifs** — set a whole band of the page
(SVG in [`packages/design/assets/motif/`](./packages/design/assets/motif/)):

- **Treeline** (`treeline.svg`) — two layers of canopy scallops with a flat
  base. Pin full-bleed to the bottom edge of a section; the back layer is
  sage, the front moss. The canonical section transition.
- **Leaf field** (`leaf-field.svg`) — a static scatter of drifting leaves in
  the brand greens, canopy olive, and one wood accent. Background texture for
  feature bands.
- **Falling leaves** (interactive,
  [`FallingLeaves.vue`](./packages/marketing/app/components/brand/FallingLeaves.vue)) —
  physics-enabled leaves that flutter down, gust away from the pointer, and
  settle into a pile at the section floor. One per page, hero-scale moments
  only; renders a static scatter under `prefers-reduced-motion`.

**Accent motifs** — garnish a single card or moment:

- **Canopy** (`canopy.svg`) — a tree crown in the logo's olive greens. Hero
  corners, empty states.
- **Leaf sprig** (`leaf-sprig.svg`) — an arcing stem with five alternating
  leaves. Card corners, footers, list moments.
- **Sprout** (`sprout.svg`) — two leaves rising from a soil mound. Growth,
  onboarding, "newly planted" moments.
- **Branch divider** (`branch-divider.svg`) — a wood branch with three leaf
  clusters. Horizontal rule between marketing sections.

All motif leaves share one leaf shape — the brand leaf — so the system reads
as one plant. New motifs should reuse it.

**Raster illustration slots.** The painterly treehouse scenes and sprout-robot
mascots (see [`packages/design/assets/raster/`](./packages/design/assets/raster/))
are AI-generated raster art. They live only in designated slots: marketing
heroes, empty states, invitation/share cards. When generating more, match the
logo's flat-vector world: canopy olive greens, warm plank woods, cream
background, soft rounded shapes, friendly rounded robots with a sprout on the
head. Always on (or fading into) cream — never hard-cropped rectangles.

## Iconography

- **Library:** Solar (via Iconify / unplugin-icons), matching the app.
- **Style:** linear (outline) variants, warm and friendly, matching the illustration line work.
- **Color:** charcoal for neutral, leaf for interactive, `fg-muted` for
  decorative.
- Never mix icon families on the same screen.

## Motion

Motion is organic: things grow, settle, and sway — they don't snap or bounce.

| Token              | Value                          | Use                      |
| ------------------ | ------------------------------ | ------------------------ |
| `duration-fast`    | 140ms                          | Hover, focus             |
| `duration-base`    | 220ms                          | Default transitions      |
| `duration-slow`    | 360ms                          | Modals, page transitions |
| `duration-grow`    | 600ms                          | Sprout/grow reveals      |
| `ease-out-soft`    | cubic-bezier(0.22, 1, 0.36, 1) | Entrances                |
| `ease-in-out-soft` | cubic-bezier(0.65, 0, 0.35, 1) | State changes            |

Named animations: `grow-in` (scale from 0.92 + fade, transform-origin bottom —
for cards and sprout moments), `sway` (±2° rotation loop — only for idle
illustration foliage, never UI), `leaf-fall` (single celebratory drift —
reserved for big completions).

Reduce all motion to a ≤100ms fade under `prefers-reduced-motion: reduce`.

## Voice & copy

- **Write like a good host.** Short sentences, concrete nouns, warmth without
  exclamation marks.
- **Verbs we use:** _share, grow, organize, keep, sync, invite, plant, build._
- **Verbs we avoid:** _unlock, supercharge, revolutionize, empower, leverage._
- Agents are **teammates, not tools** — "invite your agents," never
  "deploy your agents."
- **Numbers beat adjectives.** "Synced 240 files in 4s" beats "lightning-fast
  sync."
- **Brand name:** always **Treehouse**. The tagline is "A home for humans and
  agents"; the working line for marketing is "Where great work grows."
- Eyebrow labels: UPPERCASE, tracked out, no leading punctuation.

## Do's and Don'ts

- Do keep the canvas cream — white is for cards, not pages.
- Do use pills for buttons and chips; soft corners everywhere else.
- Do reserve Fraunces for 40px+ headlines and the wordmark.
- Do color actor attribution consistently: sky deep = agent, moss = human.
- Do maintain WCAG AA contrast (4.5:1 body, 3:1 large text).
- Don't use wood or sky as button or text colors.
- Don't use more than one motif per viewport, or motifs behind body text.
- Don't introduce a third font family or a second icon set.
- Don't use pure black or pure-gray neutrals — every neutral leans warm.
- Don't animate idle UI; growth animations fire on events, then rest —
  falling leaves are the one ambient exception, hero-scale and one per page.
- Don't hard-crop raster illustrations into rectangles — they sit on cream.
- Don't redraw or restyle the logo illustration — it ships finished.

## Implementation reference

- **Tokens (CSS variables):** [`packages/design/src/tokens.css`](./packages/design/src/tokens.css)
- **Fonts:** [`packages/design/src/fonts.css`](./packages/design/src/fonts.css)
- **Logo SVGs:** [`packages/design/assets/logo/`](./packages/design/assets/logo/) — `treehouse.svg` is the logo; mono/reverse silhouettes and the app icon are derived from it
- **Motif SVGs:** [`packages/design/assets/motif/`](./packages/design/assets/motif/)
- **Interactive motif:** [`packages/marketing/app/components/brand/FallingLeaves.vue`](./packages/marketing/app/components/brand/FallingLeaves.vue)
- **Raster references:** [`packages/design/assets/raster/`](./packages/design/assets/raster/) — `logo-source.png` is the logo's source render
- **Live brand page:** [`packages/marketing/app/pages/brand.vue`](./packages/marketing/app/pages/brand.vue)

The app (`packages/app`) currently ships its own `[data-theme="treehouse"]`
preset in `tailwind.css` with near-miss values; aligning it to these tokens is
a follow-up.

When in doubt, this document is the spec. The implementation should be brought
into agreement, not the other way around.