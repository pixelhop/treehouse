# design

Treehouse brand and design system — tokens, fonts, and logo/motif assets.

The spec lives at [`/design.md`](../../design.md) (YAML frontmatter = machine-readable
tokens, prose = usage rules). This package is the implementation; if the two
disagree, `design.md` wins.

## Usage

```css
@import "design/tokens.css"; /* brand + semantic CSS variables */
@import "design/fonts.css"; /* Fraunces, Nunito Sans, JetBrains Mono */
```

Consumers on Tailwind v4 map the variables into utilities with `@theme inline`
— see `packages/marketing/app/assets/css/main.css` for the canonical mapping.

## Assets

- `assets/logo/` — the house+leaf mark in every approved form (outline, mono,
  reverse, filled, badge, app icon, favicon, lockup).
- `assets/motif/` — codeable brand motifs (canopy, leaf sprig, sprout, branch
  divider) for marketing surfaces.
- `assets/raster/` — AI-generated raster references (brand sheet, treehouse
  illustration). Source material for the illustration style; not for direct
  UI use except in designated illustration slots.

The live visual reference is the marketing site's `/brand` page
(`vp run marketing#dev`, then open `/brand`).