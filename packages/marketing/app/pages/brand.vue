<script setup lang="ts">
import treehouseLogo from "design/assets/logo/treehouse.svg";
import treehouseMono from "design/assets/logo/treehouse-mono.svg";
import treehouseReverse from "design/assets/logo/treehouse-reverse.svg";
import appIconUrl from "design/assets/logo/app-icon.svg";
import treelineUrl from "design/assets/motif/treeline.svg";
import leafFieldUrl from "design/assets/motif/leaf-field.svg";
import canopyUrl from "design/assets/motif/canopy.svg";
import sprigUrl from "design/assets/motif/leaf-sprig.svg";
import sproutUrl from "design/assets/motif/sprout.svg";
import branchUrl from "design/assets/motif/branch-divider.svg";
import paintedIllo from "design/assets/raster/treehouse-illustration.webp";
import {
  presets as promptPresets,
  blocks as promptBlocks,
  recipes,
  expandRecipe,
} from "design/prompts";

useHead({ title: "Brand — Treehouse" });

// A few representative composed prompts to document the generation system live.
const exampleJobs = ["hero-treehouse", "mascot-pose", "invitation-card"].flatMap((id) => {
  const recipe = recipes.find((r: { id: string }) => r.id === id);
  return recipe ? expandRecipe(recipe).slice(0, 1) : [];
});

const copiedId = ref<string | null>(null);
// Copying a second prompt before the first confirmation expires would otherwise
// let the older timer clear the newer "Copied ✓".
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyPrompt(job: { id: string; prompt: string }) {
  try {
    await navigator.clipboard.writeText(job.prompt);
    copiedId.value = job.id;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedId.value = null), 1600);
  } catch {
    /* clipboard unavailable — no-op */
  }
}
onUnmounted(() => clearTimeout(copiedTimer));

const brandColors = [
  {
    name: "Leaf",
    hex: "#2E7D58",
    note: "The brand green. Primary actions, links, focus.",
  },
  { name: "Leaf Deep", hex: "#235F44", note: "Hover/active Leaf; heavyweight fills." },
  { name: "Moss", hex: "#6BA368", note: "Secondary green. Positive accents, human attribution." },
  {
    name: "Sage",
    hex: "#A8C5A1",
    note: "Soft decorative green. Rings, treeline backs, large tints.",
  },
  { name: "Mist", hex: "#DDE8D9", note: "Sage tint. Chips, hovers, quiet interactive surfaces." },
  { name: "Cream", hex: "#F7F4EC", note: "The canvas. Page background everywhere." },
  {
    name: "Parchment",
    hex: "#EFE9DC",
    note: "Tonal section background; the pause between sections.",
  },
  { name: "Wood", hex: "#C89A5B", note: "Warm accent. Branches, planks, decoration only." },
  { name: "Bark", hex: "#8A6B47", note: "Deep wood. Foreground on wood tints." },
  { name: "Charcoal", hex: "#2B2F33", note: "Foreground. Never pure black." },
  { name: "Sky", hex: "#D6E6F7", note: "Airy backdrop tint behind illustration." },
  { name: "Sky Deep", hex: "#5B8DD9", note: "Informational accent; agent attribution." },
  { name: "White", hex: "#FFFFFF", note: "Cards and panels on cream." },
];

const canopyColors = [
  { name: "Canopy Light", hex: "#ADB158" },
  { name: "Canopy", hex: "#8E9C4C" },
  { name: "Canopy Deep", hex: "#74894A" },
];

const semanticColors = [
  { token: "primary", maps: "leaf", use: "Primary actions, identity, focus" },
  { token: "secondary", maps: "parchment", use: "Tonal sections, wells" },
  { token: "accent", maps: "mist", use: "Hovers, chips, selected rows" },
  { token: "canvas", maps: "cream", use: "Page background" },
  { token: "surface", maps: "white", use: "Cards, panels, inputs" },
  { token: "success", maps: "#3E8E5E", use: "Confirmations, healthy states" },
  { token: "warning", maps: "#B8862E", use: "Attention without failure" },
  { token: "error", maps: "#C0473A", use: "Errors, destructive actions" },
  { token: "agent", maps: "sky deep", use: "Agent-attributed activity" },
  { token: "human", maps: "moss", use: "Human-attributed activity" },
];

const typeScale = [
  {
    token: "display",
    spec: "Fraunces · 88 · 600",
    cls: "font-display font-semibold text-[56px] leading-[1.02] tracking-tight",
    sample: "Where great work grows",
  },
  {
    token: "headline-xl",
    spec: "Fraunces · 56 · 600",
    cls: "font-display font-semibold text-[44px] leading-[1.05] tracking-tight",
    sample: "A home for humans and agents",
  },
  {
    token: "headline-lg",
    spec: "Fraunces · 40 · 600",
    cls: "font-display font-semibold text-[36px] leading-[1.1] tracking-tight",
    sample: "Rooms for every kind of work",
  },
  {
    token: "headline-md",
    spec: "Nunito Sans · 24 · 700",
    cls: "font-bold text-2xl leading-snug",
    sample: "Share context, move faster",
  },
  {
    token: "headline-sm",
    spec: "Nunito Sans · 18 · 700",
    cls: "font-bold text-lg leading-snug",
    sample: "Agent playbooks",
  },
  {
    token: "body-lg",
    spec: "Nunito Sans · 18 · 400",
    cls: "text-lg leading-relaxed",
    sample:
      "Treehouse keeps your team and your agents working from the same set of files, with every change attributed.",
  },
  {
    token: "body-md",
    spec: "Nunito Sans · 16 · 400",
    cls: "text-base leading-relaxed",
    sample:
      "Two-way sync keeps local folders and workspaces in step, with conflicted copies instead of lost work.",
  },
  {
    token: "body-sm",
    spec: "Nunito Sans · 14 · 400",
    cls: "text-sm leading-relaxed",
    sample: "Updated 4 minutes ago by Scout.",
  },
  {
    token: "label-md",
    spec: "Nunito Sans · 14 · 600",
    cls: "text-sm font-semibold",
    sample: "Invite an agent",
  },
  {
    token: "label-eyebrow",
    spec: "Nunito Sans · 12 · 700 · +0.14em",
    cls: "label-eyebrow",
    sample: "MASCOT SYSTEM",
  },
  {
    token: "mono",
    spec: "JetBrains Mono · 14 · 400",
    cls: "font-mono text-sm",
    sample: "treehouse sync ./docs --watch",
  },
];

const smallMotifs = [
  {
    name: "Canopy",
    url: canopyUrl,
    use: "A tree crown in the logo's olive greens. Hero corners, empty states.",
  },
  {
    name: "Leaf sprig",
    url: sprigUrl,
    use: "An arcing stem with five leaves. Card corners, footers, list moments.",
  },
  {
    name: "Sprout",
    url: sproutUrl,
    use: "Two leaves rising from soil. Growth, onboarding, 'newly planted' moments.",
  },
];

const dos = [
  "Keep the canvas cream — white is for cards, not pages.",
  "Use pills for buttons and chips; soft corners everywhere else.",
  "Reserve Fraunces for 40px+ headlines and the wordmark.",
  "Color actors consistently: sky deep = agent, moss = human.",
  "Use one motif per viewport, as garnish.",
  "Maintain WCAG AA contrast (4.5:1 body, 3:1 large).",
];

const donts = [
  "Don't use wood or sky as button or text colors.",
  "Don't set body copy in Fraunces.",
  "Don't introduce a third font family or second icon set.",
  "Don't use pure black or cold grays — neutrals lean warm.",
  "Don't animate idle UI; growth animations fire on events, then rest.",
  "Don't redraw or restyle the logo — it ships as a finished illustration.",
];
</script>

<template>
  <div>
    <!-- ============ Hero ============ -->
    <section class="relative overflow-hidden border-b border-border/70">
      <FallingLeaves :count="16" class="z-0" />
      <img
        :src="treelineUrl"
        alt=""
        class="pointer-events-none absolute inset-x-0 bottom-0 z-0 w-full"
      />
      <div
        class="relative z-10 mx-auto grid w-full max-w-7xl items-center gap-12 px-6 pb-28 pt-16 md:grid-cols-[1.2fr_1fr] md:pb-36 md:pt-20"
      >
        <div>
          <p class="label-eyebrow mb-5">Brand &amp; design system</p>
          <h1
            class="font-display max-w-2xl text-5xl font-semibold leading-[1.04] tracking-tight text-fg md:text-7xl"
          >
            A home for humans <span class="text-leaf">and agents</span>.
          </h1>
          <p class="mt-6 max-w-xl text-lg leading-relaxed text-fg-muted">
            The living reference for how Treehouse looks, sounds, and feels. The spec lives in
            <code class="font-mono text-sm text-bark">/design.md</code>; the tokens and assets in
            <code class="font-mono text-sm text-bark">packages/design</code>. If they disagree, the
            document wins.
          </p>
          <p class="mt-4 text-sm text-fg-subtle">
            (The leaves are real — move your pointer through them.)
          </p>
        </div>
        <img
          :src="treehouseLogo"
          alt="The Treehouse logo — a wooden house in a leafy tree"
          class="mx-auto w-full max-w-sm md:max-w-md"
        />
      </div>
    </section>

    <!-- ============ Logo ============ -->
    <section class="border-b border-border/70 bg-parchment/60">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <p class="label-eyebrow mb-3">Logo</p>
        <h2 class="font-display mb-4 text-4xl font-semibold tracking-tight">The treehouse</h2>
        <p class="mb-10 max-w-2xl leading-relaxed text-fg-muted">
          The logo is the illustrated treehouse — a whole little world: the tree that grows, the
          house that shelters, the ladder anyone can climb. Every variation is the same
          illustration: full color on cream, single-color silhouettes when color isn't available. It
          is never redrawn or restyled.
        </p>

        <div class="grid gap-4 md:grid-cols-3">
          <!-- Primary logo -->
          <div
            class="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-10 md:col-span-2 md:row-span-2"
          >
            <img :src="treehouseLogo" alt="Treehouse logo" class="w-full max-w-xs md:max-w-sm" />
            <span class="wordmark text-5xl text-leaf-deep">Treehouse</span>
            <p class="mt-4 text-sm text-fg-subtle">
              Primary logo &amp; wordmark — heroes, decks, anywhere with room to breathe
            </p>
          </div>

          <!-- Compact lockup -->
          <div
            class="flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-surface p-8"
          >
            <BrandLockup :size="52" />
            <p class="text-sm text-fg-subtle">Compact lockup — nav bars, footers, dense chrome</p>
          </div>

          <!-- App icon -->
          <div
            class="flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-surface p-8"
          >
            <img
              :src="appIconUrl"
              alt="Treehouse app icon"
              class="size-20 rounded-[22.6%] shadow-md"
            />
            <p class="text-sm text-fg-subtle">App icon &amp; favicon — cream tile</p>
          </div>

          <!-- Silhouette forms -->
          <div
            class="grid grid-cols-2 overflow-hidden rounded-2xl border border-border md:col-span-3"
          >
            <div class="flex flex-col items-center justify-center gap-4 bg-surface p-8">
              <img :src="treehouseMono" alt="Monochrome Treehouse logo" class="h-36" />
              <p class="text-xs text-fg-subtle">Mono — single-color printing, stamps, embossing</p>
            </div>
            <div class="flex flex-col items-center justify-center gap-4 bg-leaf-deep p-8">
              <img :src="treehouseReverse" alt="Reverse Treehouse logo" class="h-36" />
              <p class="text-xs text-cream/70">Reverse — dark and saturated surfaces</p>
            </div>
          </div>
        </div>

        <ul class="mt-8 grid gap-2 text-sm text-fg-muted md:grid-cols-2">
          <li>· The full-color logo always sits on (or fades into) cream — never hard-cropped.</li>
          <li>· Clear space: 0.25× the logo height on all sides.</li>
          <li>· Below ~36px (favicons aside), prefer the wordmark alone over a shrunken logo.</li>
          <li>· Never flip, rotate, recolor, or add effects — silhouettes are the only recolor.</li>
        </ul>
      </div>
    </section>

    <!-- ============ Colors ============ -->
    <section class="border-b border-border/70">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <p class="label-eyebrow mb-3">Color</p>
        <h2 class="font-display mb-4 text-4xl font-semibold tracking-tight">A garden palette</h2>
        <p class="mb-10 max-w-2xl leading-relaxed text-fg-muted">
          Greens carry identity, cream is the canvas, wood is warmth, sky is air. Saturation lives
          in small doses — the canvas stays quiet.
        </p>

        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="c in brandColors"
            :key="c.name"
            class="overflow-hidden rounded-2xl border border-border bg-surface"
          >
            <div class="h-24" :style="{ background: c.hex }" />
            <div class="p-4">
              <div class="flex items-baseline justify-between gap-2">
                <h3 class="text-sm font-bold">{{ c.name }}</h3>
                <code class="font-mono text-xs text-fg-subtle">{{ c.hex }}</code>
              </div>
              <p class="mt-1.5 text-xs leading-relaxed text-fg-muted">
                {{ c.note }}
              </p>
            </div>
          </div>

          <!-- Canopy olives — illustration-only trio -->
          <div
            class="overflow-hidden rounded-2xl border border-border bg-surface sm:col-span-3 lg:col-span-3"
          >
            <div class="flex h-24">
              <div
                v-for="c in canopyColors"
                :key="c.name"
                class="flex-1"
                :style="{ background: c.hex }"
              />
            </div>
            <div class="p-4">
              <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h3 class="text-sm font-bold">Canopy olives</h3>
                <code
                  v-for="c in canopyColors"
                  :key="c.hex"
                  class="font-mono text-xs text-fg-subtle"
                  >{{ c.hex }}</code
                >
              </div>
              <p class="mt-1.5 text-xs leading-relaxed text-fg-muted">
                The logo's foliage greens. Illustration and motif use only — never UI surfaces,
                text, or actions.
              </p>
            </div>
          </div>
        </div>

        <h3 class="mb-4 mt-14 text-lg font-bold">Semantic roles</h3>
        <div class="overflow-hidden rounded-2xl border border-border bg-surface">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border bg-parchment/60">
                <th class="px-5 py-3 font-bold">Token</th>
                <th class="px-5 py-3 font-bold">Maps to</th>
                <th class="px-5 py-3 font-bold">Use</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in semanticColors"
                :key="s.token"
                class="border-b border-border/60 last:border-0"
              >
                <td class="px-5 py-3 font-mono text-xs">{{ s.token }}</td>
                <td class="px-5 py-3 text-fg-muted">{{ s.maps }}</td>
                <td class="px-5 py-3 text-fg-muted">{{ s.use }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Actor attribution callout -->
        <div
          class="mt-8 flex flex-col gap-4 rounded-2xl border border-border bg-surface p-6 md:flex-row md:items-center md:justify-between"
        >
          <div>
            <h3 class="text-base font-bold">Actor attribution is load-bearing</h3>
            <p class="mt-1 max-w-xl text-sm leading-relaxed text-fg-muted">
              The change feed attributes every event to a human or an agent. These two colors tell
              that story at a glance — keep them consistent everywhere actors appear.
            </p>
          </div>
          <div class="flex shrink-0 gap-3">
            <span
              class="inline-flex items-center gap-2 rounded-full bg-mist px-4 py-1.5 text-sm font-semibold text-leaf-deep"
            >
              <span class="size-2 rounded-full bg-agent" /> Scout · agent
            </span>
            <span
              class="inline-flex items-center gap-2 rounded-full bg-mist px-4 py-1.5 text-sm font-semibold text-leaf-deep"
            >
              <span class="size-2 rounded-full bg-human" /> Jozef · human
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ Typography ============ -->
    <section class="border-b border-border/70 bg-parchment/60">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <p class="label-eyebrow mb-3">Typography</p>
        <h2 class="font-display mb-4 text-4xl font-semibold tracking-tight">
          Two families, two roles
        </h2>
        <p class="mb-10 max-w-2xl leading-relaxed text-fg-muted">
          <strong class="font-display">Fraunces</strong> is the display voice — warm, bookish, only
          ever at 40px and above. <strong>Nunito Sans</strong> is the workhorse for everything else.
          <code class="font-mono text-sm text-bark">JetBrains Mono</code> for code and paths. Never
          a fourth.
        </p>

        <div class="mb-10 grid gap-4 md:grid-cols-3">
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <p class="font-display text-7xl font-semibold text-leaf">Aa</p>
            <h3 class="mt-4 text-base font-bold">Fraunces</h3>
            <p class="mt-1 text-sm text-fg-muted">
              Display 600 · wordmark, heroes, section openers
            </p>
          </div>
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <p class="text-7xl font-bold text-fg">Aa</p>
            <h3 class="mt-4 text-base font-bold">Nunito Sans</h3>
            <p class="mt-1 text-sm text-fg-muted">Body, UI, labels, eyebrows — the workhorse</p>
          </div>
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <p class="font-mono text-7xl text-bark">Aa</p>
            <h3 class="mt-4 text-base font-bold">JetBrains Mono</h3>
            <p class="mt-1 text-sm text-fg-muted">Code, file paths, API keys — never decorative</p>
          </div>
        </div>

        <div class="overflow-hidden rounded-2xl border border-border bg-surface">
          <div
            v-for="t in typeScale"
            :key="t.token"
            class="flex flex-col gap-2 border-b border-border/60 px-6 py-5 last:border-0 md:flex-row md:items-baseline md:gap-8"
          >
            <div class="w-44 shrink-0">
              <code class="font-mono text-xs text-leaf">{{ t.token }}</code>
              <p class="mt-0.5 text-xs text-fg-subtle">{{ t.spec }}</p>
            </div>
            <p :class="t.cls" class="min-w-0 truncate text-fg">
              {{ t.sample }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ Motifs & illustration ============ -->
    <section class="border-b border-border/70">
      <div class="mx-auto w-full max-w-7xl px-6 pt-16 md:pt-24">
        <p class="label-eyebrow mb-3">Motifs &amp; illustration</p>
        <h2 class="font-display mb-4 text-4xl font-semibold tracking-tight">The living layer</h2>
        <p class="mb-10 max-w-2xl leading-relaxed text-fg-muted">
          Three scales of decoration: <strong>section motifs</strong> (treeline, leaf field, falling
          leaves) set a whole band of the page; <strong>accent motifs</strong> (canopy, sprig,
          sprout, branch) garnish a single card or moment; <strong>raster slots</strong> hold
          painterly illustration. One motif per viewport — garnish, not wallpaper.
        </p>

        <!-- Interactive falling leaves demo -->
        <div class="relative mb-4 overflow-hidden rounded-2xl border border-border bg-surface">
          <FallingLeaves :count="18" :floor-padding="16" />
          <div class="pointer-events-none relative px-8 py-16 md:px-12 md:py-20">
            <p class="label-eyebrow mb-2">Interactive</p>
            <h3 class="font-display text-3xl font-semibold tracking-tight">Falling leaves</h3>
            <p class="mt-2 max-w-md text-sm leading-relaxed text-fg-muted">
              Physics-enabled leaves flutter down, gust away from your pointer, and settle into a
              pile. For heroes and big empty states — one per page, and it rests when
              <code class="font-mono text-xs">prefers-reduced-motion</code> asks.
            </p>
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <!-- Leaf field -->
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <div class="flex h-44 items-center justify-center rounded-xl bg-canvas">
              <img :src="leafFieldUrl" alt="Leaf field motif" class="h-full w-full object-cover" />
            </div>
            <h3 class="mt-4 text-sm font-bold">Leaf field</h3>
            <p class="mt-1 text-xs leading-relaxed text-fg-muted">
              Static scatter of drifting leaves. Background texture for feature bands when the
              interactive version is too much.
            </p>
          </div>

          <!-- Accent motifs -->
          <div class="grid grid-cols-3 gap-4">
            <div
              v-for="m in smallMotifs"
              :key="m.name"
              class="flex flex-col rounded-2xl border border-border bg-surface p-5"
            >
              <div class="flex h-24 items-center justify-center">
                <img :src="m.url" :alt="`${m.name} motif`" class="max-h-full" />
              </div>
              <h3 class="mt-3 text-sm font-bold">{{ m.name }}</h3>
              <p class="mt-1 text-xs leading-relaxed text-fg-muted">{{ m.use }}</p>
            </div>
          </div>
        </div>

        <!-- Branch divider in context -->
        <div class="my-10 flex justify-center">
          <img :src="branchUrl" alt="Branch divider motif" class="w-full max-w-xl" />
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <div class="overflow-hidden rounded-2xl border border-border bg-sky/40 p-6">
            <img
              :src="paintedIllo"
              alt="Painterly treehouse illustration"
              class="mx-auto max-h-64"
            />
            <p class="mt-4 text-xs leading-relaxed text-fg-muted">
              <strong>Raster slot — painterly illustration.</strong> Soft 3D-rendered storybook
              scenes for heroes, empty states, and invitation cards — rounded volumetric forms, warm
              light, smooth matte surfaces (no canvas texture). Always sitting on (or fading into)
              cream.
            </p>
          </div>
          <div class="flex flex-col justify-center rounded-2xl border border-border bg-surface p-8">
            <h3 class="text-base font-bold">Generating more illustration</h3>
            <p class="mt-2 text-sm leading-relaxed text-fg-muted">
              New raster art is AI-generated to match this world. Every prompt is composed from a
              fixed <strong>style DNA</strong> plus one <strong>render preset</strong> and a
              per-asset subject, so the whole set reads as one family.
            </p>
            <p class="mt-3 text-xs leading-relaxed text-fg-muted">
              Source of truth:
              <code class="font-mono text-xs">packages/design/src/prompts/</code>. Generate with
              <code class="font-mono text-xs"
                >node packages/design/scripts/generate-illustrations.mjs</code
              >
              (needs an OpenRouter key). Pass
              <code class="font-mono text-xs">--ref &lt;image&gt;</code>
              to recreate or restyle from an existing illustration (image-to-image). Outputs land in
              cream raster slots — never hard-cropped rectangles.
            </p>
          </div>
        </div>

        <!-- ===== Prompt system: presets + style DNA + example recipes ===== -->
        <div class="mt-12 pb-16 md:pb-0">
          <p class="label-eyebrow mb-3">Prompt system</p>
          <h3 class="font-display mb-2 text-3xl font-semibold tracking-tight">
            A repeatable recipe
          </h3>
          <p class="mb-8 max-w-2xl leading-relaxed text-fg-muted">
            Two render registers, one shared world. Pick a preset, drop in a subject, and the
            generator stitches in the palette, framing and guardrails for you.
          </p>

          <!-- Render presets -->
          <div class="grid gap-4 md:grid-cols-2">
            <div
              v-for="(p, key) in promptPresets"
              :key="key"
              class="rounded-2xl border border-border bg-surface p-6"
            >
              <p class="label-eyebrow mb-1">{{ key }}</p>
              <h4 class="font-display text-xl font-semibold tracking-tight">{{ p.label }}</h4>
              <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ p.blurb }}</p>
            </div>
          </div>

          <!-- Style DNA blocks -->
          <div class="mt-4 rounded-2xl border border-border bg-canvas p-6 md:p-8">
            <p class="label-eyebrow mb-4">Style DNA — woven into every prompt</p>
            <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div v-for="(text, name) in promptBlocks" :key="name">
                <dt class="mb-1 text-sm font-bold capitalize">{{ name }}</dt>
                <dd class="text-xs leading-relaxed text-fg-muted">{{ text }}</dd>
              </div>
            </dl>
          </div>

          <!-- Example composed prompts with copy -->
          <p class="label-eyebrow mb-3 mt-8">Example recipes</p>
          <div class="space-y-3">
            <div
              v-for="job in exampleJobs"
              :key="job.id"
              class="rounded-2xl border border-border bg-surface p-5"
            >
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h4 class="text-sm font-bold">{{ job.label }}</h4>
                  <p class="mt-0.5 text-xs text-fg-muted">{{ job.preset }} · {{ job.aspect }}</p>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded-full border border-border px-4 py-1.5 text-xs font-semibold transition-colors hover:bg-mist"
                  @click="copyPrompt(job)"
                >
                  {{ copiedId === job.id ? "Copied ✓" : "Copy prompt" }}
                </button>
              </div>
              <p class="mt-3 font-mono text-[11px] leading-relaxed text-fg-muted">
                {{ job.prompt }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Treeline as a real section edge -->
      <div class="relative mt-12 h-32 md:h-40">
        <img
          :src="treelineUrl"
          alt="Treeline motif marking the section edge"
          class="absolute inset-x-0 bottom-0 w-full"
        />
      </div>
    </section>

    <!-- ============ Components ============ -->
    <section class="border-b border-border/70 bg-parchment/60">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <p class="label-eyebrow mb-3">Components</p>
        <h2 class="font-display mb-10 text-4xl font-semibold tracking-tight">Building blocks</h2>

        <div class="grid gap-4 md:grid-cols-2">
          <!-- Buttons -->
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <h3 class="mb-5 text-base font-bold">Buttons — always pills</h3>
            <div class="flex flex-wrap items-center gap-3">
              <button
                class="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover"
              >
                Plant your workspace
              </button>
              <button
                class="rounded-full border border-mist bg-surface px-6 py-3 text-sm font-semibold text-fg transition-colors hover:bg-mist"
              >
                Invite an agent
              </button>
              <button
                class="px-2 py-3 text-sm font-semibold text-leaf transition-colors hover:text-leaf-deep"
              >
                Learn more
              </button>
            </div>
            <p class="mt-5 text-xs leading-relaxed text-fg-muted">
              One primary per screen. Hover deepens — leaf to leaf-deep. Never a wood or sky button.
            </p>
          </div>

          <!-- Chips + input -->
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <h3 class="mb-5 text-base font-bold">Chips &amp; inputs</h3>
            <div class="mb-4 flex flex-wrap gap-2">
              <span class="rounded-full bg-mist px-3.5 py-1 text-sm font-semibold text-leaf-deep"
                >Research</span
              >
              <span
                class="inline-flex items-center gap-2 rounded-full bg-mist px-3.5 py-1 text-sm font-semibold text-leaf-deep"
              >
                <span class="size-2 rounded-full bg-agent" /> Sage · agent
              </span>
              <span
                class="rounded-full border border-border bg-surface px-3.5 py-1 text-sm font-semibold text-fg-muted"
                >Archive</span
              >
            </div>
            <div
              class="flex items-center gap-3 rounded-[10px] border border-border bg-surface px-4 py-2.5 ring-leaf transition-shadow focus-within:ring-2"
            >
              <svg class="size-4 text-fg-subtle" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
                <path
                  d="m20 20-3.5-3.5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
              <input
                type="text"
                name="brand-demo-search"
                placeholder="Search the workspace…"
                class="w-full bg-transparent text-sm outline-none placeholder:text-fg-subtle"
              />
              <kbd
                class="rounded-md border border-border bg-parchment px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
                >⌘K</kbd
              >
            </div>
          </div>

          <!-- File rows -->
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <h3 class="mb-5 text-base font-bold">File rows</h3>
            <ul class="divide-y divide-border/60 text-sm">
              <li class="flex items-center gap-3 py-3">
                <span class="font-mono text-xs text-bark">md</span>
                <span class="flex-1 font-semibold">PRD.md</span>
                <span class="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                  <span class="size-2 rounded-full bg-agent" /> Scout
                </span>
                <span class="text-xs text-fg-subtle">15m</span>
              </li>
              <li class="flex items-center gap-3 py-3">
                <span class="font-mono text-xs text-bark">pdf</span>
                <span class="flex-1 font-semibold">Market_Report.pdf</span>
                <span class="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                  <span class="size-2 rounded-full bg-human" /> Jozef
                </span>
                <span class="text-xs text-fg-subtle">2h</span>
              </li>
              <li class="flex items-center gap-3 py-3">
                <span class="font-mono text-xs text-bark">md</span>
                <span class="flex-1 font-semibold">Launch_Plan.md</span>
                <span class="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                  <span class="size-2 rounded-full bg-agent" /> Sage
                </span>
                <span class="text-xs text-fg-subtle">2d</span>
              </li>
            </ul>
            <p class="mt-4 text-xs leading-relaxed text-fg-muted">
              The atomic unit of Treehouse UI — name, actor dot, relative time.
            </p>
          </div>

          <!-- Code block -->
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <h3 class="mb-5 text-base font-bold">Code blocks</h3>
            <div class="overflow-hidden rounded-xl bg-charcoal">
              <div class="flex items-center justify-between border-b border-cream/10 px-4 py-2">
                <span class="text-[11px] font-bold uppercase tracking-[0.14em] text-cream/60"
                  >shell</span
                >
                <span class="inline-flex items-center gap-1.5 text-[11px] text-cream/60">
                  <span class="size-1.5 rounded-full bg-moss" /> synced
                </span>
              </div>
              <pre
                class="overflow-x-auto px-5 py-4 font-mono text-sm leading-relaxed text-cream/85"
              ><code>$ treehouse sync ./docs --watch
→ workspace: marketing  (leafy-grove-42)
← 240 files in sync · watching</code></pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ Voice & guardrails ============ -->
    <section>
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <p class="label-eyebrow mb-3">Guardrails</p>
        <h2 class="font-display mb-4 text-4xl font-semibold tracking-tight">
          Write like a good host
        </h2>
        <p class="mb-10 max-w-2xl leading-relaxed text-fg-muted">
          Short sentences, concrete nouns, warmth without exclamation marks. Agents are teammates,
          not tools — <em>invite</em> your agents, never <em>deploy</em> them. Numbers beat
          adjectives: “synced 240 files in 4s” beats “lightning-fast sync.”
        </p>

        <div class="grid gap-4 md:grid-cols-2">
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <h3 class="mb-4 text-base font-bold text-success">Do</h3>
            <ul class="space-y-2.5 text-sm leading-relaxed text-fg-muted">
              <li v-for="d in dos" :key="d" class="flex gap-2.5">
                <span class="mt-1.5 leaf-dot shrink-0" /> {{ d }}
              </li>
            </ul>
          </div>
          <div class="min-w-0 rounded-2xl border border-border bg-surface p-7">
            <h3 class="mb-4 text-base font-bold text-danger">Don't</h3>
            <ul class="space-y-2.5 text-sm leading-relaxed text-fg-muted">
              <li v-for="d in donts" :key="d" class="flex gap-2.5">
                <span class="mt-2 size-1.5 shrink-0 rounded-full bg-danger/60" />
                {{ d }}
              </li>
            </ul>
          </div>
        </div>

        <div class="mt-10 flex justify-center">
          <img :src="branchUrl" alt="" class="w-full max-w-lg opacity-80" />
        </div>
      </div>
    </section>
  </div>
</template>