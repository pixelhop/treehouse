// Treehouse illustration prompt system
// ----------------------------------------------------------------------------
// One source of truth for generating on-brand raster art (gpt-image / nano
// banana / gemini) that matches the Treehouse logo world and the painterly
// brand-board illustrations. The brand page imports this to document the
// system; scripts/generate-illustrations.mjs imports it to actually render.
//
// A full prompt is composed from reusable BLOCKS + a render PRESET + a per-asset
// SUBJECT. Keep the blocks stable so every asset reads as one family; vary only
// the subject. See design.md "Motifs & Illustration → Raster illustration slots".

/** Brand palette, illustration-relevant subset. name → hex. */
export const palette = {
  leaf: "#2E7D58",
  "leaf-deep": "#235F44",
  moss: "#6BA368",
  sage: "#A8C5A1",
  mist: "#DDE8D9",
  cream: "#F7F4EC",
  parchment: "#EFE9DC",
  wood: "#C89A5B",
  bark: "#8A6B47",
  charcoal: "#2B2F33",
  sky: "#D6E6F7",
  // canopy olives — illustration foliage only
  "canopy-light": "#ADB158",
  canopy: "#8E9C4C",
  "canopy-deep": "#74894A",
};

/**
 * Reusable prompt fragments. Compose these — never restate the style ad hoc, or
 * assets drift apart. Each is a self-contained clause that reads cleanly when
 * concatenated with ". " between blocks.
 */
export const blocks = {
  /** The colour instruction. Always include. */
  palette:
    "Colour palette — use only these warm, muted tones: cream background #F7F4EC, " +
    "deep leaf green #2E7D58 and #235F44, soft moss green #6BA368, pale sage #A8C5A1, " +
    "olive canopy greens #ADB158 #8E9C4C #74894A for foliage, warm timber #C89A5B and " +
    "deep bark brown #8A6B47 for wood, soft charcoal #2B2F33 for the darkest accents " +
    "(never pure black), and a hint of pale sky blue #D6E6F7. Saturation stays gentle; " +
    "nothing neon, nothing garish",

  /** The Treehouse universe. Include for any scene/object set in the world. */
  world:
    "Set in the Treehouse world: a cosy hand-built wooden treehouse nestled in a big " +
    "leafy tree — vertical timber-plank walls, a pitched plank roof with a little ridge, " +
    "an arched front door and a four-pane window with warm light inside, a railed platform " +
    "deck, a simple leaning ladder, and a thick gnarled trunk with a flared root base. The " +
    "canopy is a soft, rounded cloud of olive-green leaves. Everything looks crafted, " +
    "well-loved and snug — a cabin in the branches with good wifi",

  /** The sprout-bot mascot character sheet. Include for any mascot art. */
  mascot:
    "The mascot is Sprout-bot: a small, friendly, rounded robot with a smooth matte " +
    "cream-white egg-shaped body, short stubby arms and legs, and a dark rounded face-visor " +
    "showing two soft glowing leaf-green dot eyes and no mouth. A single tiny green sprout of " +
    "two leaves grows from the top of its head. It reads as calm, curious and helpful — a " +
    "gentle little gardener, never sleek, militaristic or robotic-scary",

  /** Framing, background, composition. Always include. */
  technical:
    "Centred composition with generous negative space, the subject sitting on a plain flat " +
    "cream #F7F4EC background (or transparent), grounded only by a soft pale-sage shadow " +
    "ellipse if needed. Friendly, calm, rounded shapes throughout; soft corners, nothing " +
    "sharp or machine-perfect. High craft, cohesive, single clear subject",

  /**
   * Atmosphere & depth — the favoured art direction (from the hills-nano-2
   * reference). Include for wide scenes, landscapes and section transitions to
   * get the warm, sunny, deep look rather than a flat or muted one.
   */
  atmosphere:
    "Bright, warm, sunny light with a gentle golden haze. Strong atmospheric perspective: a " +
    "crisp, richly saturated foreground that fades through progressively paler, mistier and " +
    "warmer layers into a soft cream haze toward the horizon, giving real depth. Every form " +
    "clearly three-dimensional — brighter sunlit tops, softly shaded undersides, and soft cast " +
    "shadows grounding each element. Any trees are individual, charming, rounded lollipop trees " +
    "with little visible trunks, dotted at varying sizes (larger in front, tiny and faded " +
    "behind) — never flat blobs or a solid mass. Calm, panoramic and serene",

  /** Things to avoid. Always include. */
  negatives:
    "Do not include: any text, words, letters, numbers, logos, watermarks or signatures; " +
    "UI elements, buttons or frames; photographic realism, lens flare or harsh shadows; " +
    "pure black, neon or steely blue-grey colours; cluttered or busy backgrounds; cut-off " +
    "edges or multiple disconnected subjects; heavy paper/canvas texture, visible brush " +
    "strokes, grain, or a grungy, muted, faded or vintage-print look",
};

/**
 * Render presets — the two illustration registers in the brand. `painterly` is
 * the default for heroes, mascots and cards; `flat` matches the logo exactly.
 */
export const presets = {
  painterly: {
    label: "Painterly",
    blurb:
      "Soft 3D-rendered storybook art — rounded volumetric forms, gentle depth and warm " +
      "light, with smooth matte surfaces and no canvas texture. The default for heroes, " +
      "mascots, invitation and empty-state slots.",
    render:
      "Soft, clean stylised 3D-rendered storybook illustration: smooth matte surfaces and " +
      "rounded, volumetric forms with real depth and gentle modelling, like polished modern CGI " +
      "key art or a high-end picture-book render. Warm, bright, sunny directional light with soft " +
      "ambient occlusion and gentle gradients across each form — brighter sunlit tops, softly " +
      "shaded undersides, and soft cast shadows grounding each element; cosy and inviting, with a " +
      "clear sense of three-dimensional depth. Crisp and clean — no paper grain, no canvas " +
      "texture, no visible brush strokes, no grain, no grungy or vintage look. Warm, fresh, sunlit " +
      "colour. No hard outlines, no photo realism",
  },
  flat: {
    label: "Flat vector",
    blurb:
      "Logo-consistent flat vector — solid fills, no gradients, no outlines. For " +
      "logo-adjacent spot art and simple iconographic objects.",
    render:
      "Flat vector illustration with solid fills only — no gradients, no outlines, no texture. " +
      "Clean geometric shapes; foliage built from layered overlapping circles of olive green; " +
      "plank shading done with one flat highlight tone. Crisp, calm and minimal, matching the " +
      "Treehouse logo illustration exactly",
  },
};

/**
 * Art-direction north star. `assets/raster/art-direction-reference.png` (the
 * "hills-nano-2" render) is the agreed reference for the look we want — refer to
 * it when judging or refining new illustration. Its distinguishing qualities are
 * captured in the `painterly` preset and the `atmosphere` block; this note
 * records *why* it won so the intent survives prompt edits.
 */
export const artDirection = {
  reference: "assets/raster/art-direction-reference.png",
  wins: [
    "Warm, bright, sunny light with a gentle golden haze — not muted or grey.",
    "Strong atmospheric perspective: saturated crisp foreground fading through paler, " +
      "warmer, mistier layers into a cream horizon. Depth is the biggest differentiator.",
    "Every form clearly volumetric — sunlit tops, shaded undersides, soft cast shadows.",
    "Trees read as individual charming rounded lollipop trees with little trunks, dotted at " +
      "varying sizes for depth — never flat blobs or a solid green mass.",
    "Panoramic, calm, serene framing with generous cream sky.",
  ],
};

/**
 * Per-asset recipes. Each composes BLOCKS + PRESET + SUBJECT into a full prompt.
 * `needs` lists which world/mascot blocks to inject. `variants` lets one recipe
 * produce a set (e.g. the five mascot poses) by swapping the subject clause.
 */
export const recipes = [
  {
    id: "hero-treehouse",
    label: "Hero scene",
    use: "Marketing heroes, big empty states.",
    preset: "painterly",
    aspect: "16:9",
    needs: ["world", "mascot", "atmosphere"],
    subject:
      "A wide hero scene of the Treehouse: the full treehouse sitting in its big leafy tree, " +
      "with two or three Sprout-bots going about their work on the platform deck — one reading, " +
      "one carrying a small crate up the ladder, one tending a potted seedling. Warm late-afternoon " +
      "light, a few leaves drifting, distant soft green hills behind",
  },
  {
    id: "hills-band",
    label: "Rolling-hills transition",
    use: "Wide section transitions / page-edge bands (place full-bleed, fade the cream top).",
    preset: "painterly",
    aspect: "16:9",
    needs: ["atmosphere"],
    subject:
      "A wide, calm landscape band of lush rolling green hills receding into soft misty distance, " +
      "with the odd little cluster of rounded lollipop trees dotted across the hills. The sky above " +
      "the hills is plain flat cream #F7F4EC and completely empty so the image blends seamlessly " +
      "into a cream page. A serene, wide section-transition strip",
  },
  {
    id: "mascot-pose",
    label: "Mascot pose",
    use: "Feature rows, mascot system, spot moments.",
    preset: "painterly",
    aspect: "1:1",
    needs: ["mascot"],
    subject: "A single Sprout-bot, full body, centred, {pose}",
    variants: [
      { id: "focused", pose: "sitting cross-legged working intently at a small wooden laptop" },
      { id: "exploring", pose: "peering through a magnifying glass, curious and leaning forward" },
      { id: "sharing", pose: "holding out an open green book with both hands, offering it" },
      { id: "celebrating", pose: "arms raised in a happy little cheer, a sparkle or two nearby" },
      { id: "planting", pose: "kneeling to plant a tiny seedling into a small terracotta pot" },
    ],
  },
  {
    id: "spot-vignette",
    label: "Spot vignette",
    use: "Card corners, section accents.",
    preset: "painterly",
    aspect: "1:1",
    needs: ["world"],
    subject:
      "A small still-life vignette from the Treehouse world: {object}. Single object group, " +
      "softly lit, lots of cream space around it",
    variants: [
      {
        id: "folders",
        object: "a neat stack of labelled wooden folders on a timber shelf with a leaf sprig",
      },
      {
        id: "watering",
        object: "a warm copper watering can tipping a little water over a fresh green sprout",
      },
      {
        id: "signpost",
        object: "a friendly wooden signpost with two blank plank arrows and a leaf carved on top",
      },
      {
        id: "lantern",
        object: "a small glowing lantern hanging from a branch with a couple of leaves",
      },
    ],
  },
  {
    id: "invitation-card",
    label: "Invitation card",
    use: "Invite / share cards.",
    preset: "painterly",
    aspect: "3:2",
    needs: ["world", "mascot"],
    subject:
      "A welcoming scene for an invitation: the treehouse with a small green pennant flag flying " +
      "from the roof, and a Sprout-bot on the deck waving hello toward the viewer. Open, friendly, " +
      "lots of cream sky for copy to sit beside",
  },
  {
    id: "empty-state",
    label: "Empty state",
    use: "Empty lists, zero-data states.",
    preset: "painterly",
    aspect: "4:3",
    needs: [],
    subject:
      "A quiet, minimal empty-state illustration: a single small green sprout with two leaves " +
      "rising from a little mound of soil, or a bare wooden shelf with one leaf sprig. Calm, hopeful, " +
      "mostly empty cream space — a 'nothing here yet, but it will grow' feeling",
  },
  {
    id: "flat-spot",
    label: "Flat spot object",
    use: "Logo-adjacent flat objects.",
    preset: "flat",
    aspect: "1:1",
    needs: [],
    subject:
      "A single flat-vector object from the Treehouse world, logo-matched: {object}. Solid flat " +
      "fills, no outline, centred on cream",
    variants: [
      { id: "folder", object: "a wooden folder with a small green leaf tab" },
      { id: "key", object: "a stubby brass workspace key with a leaf-shaped bow" },
      { id: "ladder", object: "a short two-rail wooden ladder" },
      { id: "crate", object: "a small open timber crate with a sprout poking out" },
    ],
  },
];

const ASPECT_NOTE = {
  "1:1": "Square 1:1 composition.",
  "3:2": "Landscape 3:2 composition.",
  "4:3": "Landscape 4:3 composition.",
  "16:9": "Wide 16:9 landscape composition.",
};

function trimTrailingDots(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ".") end--;
  return s.slice(0, end);
}

/**
 * Compose a full prompt string from a render preset, a subject clause, and the
 * shared blocks. This is the canonical assembly order — keep it stable.
 *
 * @param {object} opts
 * @param {string} opts.subject            The per-asset subject clause.
 * @param {keyof typeof presets} [opts.preset="painterly"]
 * @param {Array<keyof typeof blocks>} [opts.needs=[]]  Extra blocks (world/mascot).
 * @param {keyof typeof ASPECT_NOTE} [opts.aspect]
 * @returns {string}
 */
export function composePrompt({ subject, preset = "painterly", needs = [], aspect }) {
  const p = presets[preset] ?? presets.painterly;
  const parts = [p.render, subject];
  for (const n of needs) if (blocks[n]) parts.push(blocks[n]);
  parts.push(blocks.palette, blocks.technical);
  if (aspect && ASPECT_NOTE[aspect]) parts.push(ASPECT_NOTE[aspect]);
  parts.push(blocks.negatives);
  // Tidy: ensure single ". " joins, no double periods.
  return parts.map((s) => trimTrailingDots(s.trim())).join(". ") + ".";
}

/**
 * Expand a recipe into one or more concrete { id, label, aspect, preset, prompt }
 * jobs — one per variant, or a single job if the recipe has no variants.
 */
export function expandRecipe(recipe) {
  const make = (subject, suffix, label) => ({
    id: suffix ? `${recipe.id}-${suffix}` : recipe.id,
    label,
    aspect: recipe.aspect,
    preset: recipe.preset,
    prompt: composePrompt({
      subject,
      preset: recipe.preset,
      needs: recipe.needs,
      aspect: recipe.aspect,
    }),
  });

  if (!recipe.variants?.length) return [make(recipe.subject, "", recipe.label)];

  return recipe.variants.map((v) => {
    // Fill the {pose}/{object} placeholder from whichever key the variant carries.
    const fill = v.pose ?? v.object ?? "";
    const subject = recipe.subject.replace(/\{\w+\}/, fill);
    return make(subject, v.id, `${recipe.label} · ${v.id}`);
  });
}

/** Every concrete job across all recipes. */
export function allJobs() {
  return recipes.flatMap(expandRecipe);
}