<script setup lang="ts">
/**
 * A rotating stamp of approval for plain files, drawn as a die-cut vinyl
 * sticker with one corner lifting off the page.
 *
 * The page argues for local files in prose everywhere else; this says the same
 * thing with a straight face and a wink, and gives the second-brain section a
 * single piece of pure delight to anchor on.
 *
 * How the peel is put together:
 *
 *  - The sticker body is the *major* arc between the two peel points plus the
 *    chord that closes it, so the lifted corner is genuinely missing from the
 *    silhouette rather than covered over. Everything printed on the sticker is
 *    clipped to that body.
 *  - The flap is the same corner folded back inward, so it lies over the badge
 *    and hides the ring text beneath it — which is what sells it as paper
 *    rather than a bite taken out of a circle. It is a curl, not a mirror:
 *    tighter at the hinge, fuller at the tip.
 *  - A blurred copy of the flap, clipped to the body, is its cast shadow. That
 *    shadow is the whole illusion; without it the flap reads as a flat wedge.
 *
 * Only the ring text rotates. Spinning the whole badge would rotate the peel
 * and the folder with it; leaving them still makes the text look like it is
 * scrolling under the lifted corner.
 *
 * The badge carries no size of its own — the caller's class lands on the root
 * <svg>, so any sizing here would fight it depending on stylesheet order.
 *
 * `textLength` fixes the ring copy to the exact circumference rather than
 * hand-tuning letter-spacing until it happens to meet: the text always closes
 * the loop, whatever the font ends up measuring.
 */

// r=72 ring → 2πr, the length the ring text is stretched to fill.
const RING_LENGTH = 452;

// The two points where the sticker lifts, at 20° and 92° on the r=94 edge.
// Everything about the peel is derived from these, so they live here rather
// than being re-typed into each path.
const BODY = "M96.72 193.94A94 94 0 1 1 188.32 132.15Z";
const FLAP = "M188.32 132.15C149.66 134.11 108.55 152.19 96.72 193.94Z";
</script>

<template>
  <svg
    viewBox="0 0 200 200"
    class="cool-seal block select-none"
    role="img"
    aria-label="Local files are cool again"
  >
    <defs>
      <!--
        Clockwise from the top (sweep-flag 1), so the lettering sits upright
        where a reader starts rather than upside down.
      -->
      <path id="cool-seal-ring" fill="none" d="M100 28a72 72 0 1 1-.1 0" />

      <clipPath id="cool-seal-body"><path :d="BODY" /></clipPath>

      <!-- Printed face: lit from the top left, deepening into the peel. -->
      <radialGradient id="cool-seal-face" cx="32%" cy="24%" r="88%">
        <stop offset="0%" stop-color="#37906A" />
        <stop offset="55%" stop-color="#2E7D58" />
        <stop offset="100%" stop-color="#1C4E38" />
      </radialGradient>

      <!--
        The flap's underside. Bright along the fold where it still catches the
        light, dropping into shade as it curls away.
      -->
      <linearGradient
        id="cool-seal-flap"
        gradientUnits="userSpaceOnUse"
        x1="150.5"
        y1="177.9"
        x2="128.5"
        y2="145.2"
      >
        <stop offset="0%" stop-color="#FFFDF8" />
        <stop offset="45%" stop-color="#F2ECDD" />
        <stop offset="100%" stop-color="#CFC7B2" />
      </linearGradient>

      <!-- Vinyl sheen: a single soft highlight raked across the top left. -->
      <linearGradient id="cool-seal-gloss" x1="8%" y1="0%" x2="72%" y2="96%">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.26" />
        <stop offset="42%" stop-color="#FFFFFF" stop-opacity="0.04" />
        <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0" />
      </linearGradient>

      <filter id="cool-seal-lift" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#2B2F33" flood-opacity="0.22" />
      </filter>

      <filter id="cool-seal-cast" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="4" />
      </filter>
    </defs>

    <g filter="url(#cool-seal-lift)">
      <!-- Die-cut margin — the white vinyl border a real sticker is cut with. -->
      <path :d="BODY" fill="#FBF8F0" />

      <g clip-path="url(#cool-seal-body)">
        <circle cx="100" cy="100" r="86" fill="url(#cool-seal-face)" />

        <g class="cool-seal-ring">
          <!-- The family comes from the stylesheet: var() is not substituted in
               SVG presentation attributes, so setting it here would fall back. -->
          <text fill="#F7F4EC" font-size="12.5" font-weight="700" letter-spacing="0.5">
            <textPath
              href="#cool-seal-ring"
              startOffset="0"
              :textLength="RING_LENGTH"
              lengthAdjust="spacing"
            >
              LOCAL FILES ARE COOL AGAIN · LOCAL FILES ARE COOL AGAIN ·
            </textPath>
          </text>
        </g>

        <!-- Sits well inside the lettering rather than grazing its cap height. -->
        <circle cx="100" cy="100" r="59" fill="none" stroke="#F7F4EC" stroke-opacity="0.28" />
        <circle cx="100" cy="100" r="54" fill="#F7F4EC" />

        <!--
          A folder with something growing out of it.

          The sprout is drawn first so the stem can run on down behind the
          folder, and each leaf is seated far enough along the stem to overlap
          its stroke. Butting these parts up against each other instead leaves
          hairline seams that widen as the badge scales.
        -->
        <g transform="translate(100 78)">
          <path stroke="#6BA368" stroke-width="2.6" stroke-linecap="round" d="M0 20V-2" />
          <ellipse cx="-5" cy="4" rx="6.6" ry="4.3" fill="#6BA368" transform="rotate(-20 -5 4)" />
          <ellipse
            cx="5"
            cy="-1.5"
            rx="6.6"
            ry="4.3"
            fill="#A8C5A1"
            transform="rotate(20 5 -1.5)"
          />
        </g>
        <g transform="translate(100 104) scale(2.2) translate(-10 -8)">
          <path
            fill="#2E7D58"
            d="M1.5 3.5A2 2 0 0 1 3.5 1.5h4l2 2.2h7a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
          />
        </g>

        <!-- The flap's shadow, thrown back across the face it lifted off. -->
        <path
          :d="FLAP"
          fill="#143526"
          fill-opacity="0.5"
          filter="url(#cool-seal-cast)"
          transform="translate(-5 -6)"
        />

        <path :d="BODY" fill="url(#cool-seal-gloss)" />
      </g>

      <path :d="FLAP" fill="url(#cool-seal-flap)" />
      <!-- A hairline along the fold stops the flap from melting into the body. -->
      <path
        d="M188.32 132.15 96.72 193.94"
        stroke="#C9C0AA"
        stroke-width="0.8"
        stroke-opacity="0.7"
      />
    </g>
  </svg>
</template>

<style scoped>
.cool-seal text {
  font-family: var(--font-mono);
}

.cool-seal-ring {
  transform-box: view-box;
  transform-origin: 100px 100px;
  animation: cool-seal-spin 26s linear infinite;
}

.cool-seal:hover .cool-seal-ring {
  animation-duration: 7s;
}

@keyframes cool-seal-spin {
  to {
    rotate: 360deg;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cool-seal-ring,
  .cool-seal:hover .cool-seal-ring {
    animation: none;
  }
}
</style>