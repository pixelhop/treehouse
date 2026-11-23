<script setup lang="ts">
import treehouseLogo from "design/assets/logo/treehouse.svg";
import leafFieldUrl from "design/assets/motif/leaf-field.svg";
import heroArt from "design/assets/raster/hero-treehouse.webp";
import openSourceArt from "design/assets/raster/opensource-flag.webp";
import foliageArt from "design/assets/raster/foliage-overhang.webp";
import tierSeedling from "design/assets/raster/tier-seedling.webp";
import tierGrove from "design/assets/raster/tier-grove.webp";
import tierForest from "design/assets/raster/tier-forest.webp";
import syncFolderArt from "design/assets/raster/sync-folder.webp";
import brainToGoArt from "design/assets/raster/brain-to-go.webp";
// Highlighted at build time — see build/snippets.ts.
import snippets from "virtual:treehouse-snippets";
import { vReveal } from "~/composables/reveal";

const GITHUB_URL = "https://github.com/pixelhop/treehouse";
const CONTACT_URL = "mailto:info@pixelhop.io?subject=Treehouse%20for%20our%20team";

const appUrl = useRuntimeConfig().public.appUrl;
const signUpUrl = `${appUrl}/sign-up`;

// A section link from another page (/#agents) arrives before this page has
// rendered, so the router has nothing to scroll to. Finish the job here.
const route = useRoute();
onMounted(() => {
  if (route.hash) document.getElementById(route.hash.slice(1))?.scrollIntoView();
});

// What teams use Treehouse for, led by the shared second brain. Plain links
// into the sections that show each one, rather than bullets or chips competing
// with the call to action.
const heroUses = [
  { label: "A shared second brain", to: "#everyone" },
  { label: "Client portals", to: "#sharing" },
  { label: "Company OS", to: "#workspace" },
];

// The two things that set Treehouse apart from a team vault on disk: the whole
// team gets in however they work (the browser above all), and anything in it can
// be handed to someone outside. This band carries the first; #sharing the second.
const doors = [
  {
    title: "In the browser",
    body: "Teammates who'd never install anything sign in and get the whole workspace: every file, folder and comment, in any browser.",
  },
  {
    title: "On your computer",
    body: "The Mac app keeps an ordinary folder in step with everyone else's. Open it in Obsidian, Finder or your editor.",
  },
  {
    title: "In your agents",
    body: "Claude Code, Cowork and Codex work in the synced folder, or connect over MCP. What they write reaches the whole team in seconds.",
  },
] as const;

// The forced choice: a second brain is easy for one person and hard for a
// team. Naming what each side costs is what makes the resolution land.
const tradeoff = [
  {
    label: "A personal vault",
    good: "Obsidian, or a folder of notes. Plain files you own, and your agents can work in them.",
    costs: [
      "It lives on one person's computer",
      "Teammates need the same app and setup",
      "Nothing you can send a client",
      "No record of who changed what",
    ],
  },
  {
    label: "A shared wiki",
    good: "Notion or Confluence. The whole team is in, with comments and sharing.",
    costs: [
      "Pages are blocks, not files",
      "Agents work through a rate-limited API",
      "Your agent can't grep it",
      "Leaving means waiting on an export",
    ],
  },
];

// What the third option gives back: the vault's files, the wiki's team, and the
// sharing neither of them does well.
const resolution = ["Plain files on disk", "The team in the browser", "Any file shared by link"];

// Each card carries a fragment of the real share panel — see ShareDemo.vue.
const sharing = [
  {
    demo: "link",
    title: "A link, not an export",
    body: "Share a file or a whole folder as a URL. Markdown renders, folders list themselves, and the page always reflects what's in the workspace right now.",
  },
  {
    demo: "locked",
    title: "Locked down as far as you need",
    body: "Public and unguessable, password-gated, or members-only. Revoking is instant — every read re-checks, so a pulled link dies even for someone who already passed the password.",
  },
  {
    demo: "version",
    title: "Pin a version, or stay live",
    body: "Point a permalink at the exact bytes you sent, so the thing you shared keeps saying what it said. Or leave it live and let it track the work.",
  },
] as const;

// The quick tour. Agents, portability and sharing get whole sections of their
// own; these are the everyday features that don't — chosen with the same rule
// as everywhere else on the page: only things that ship today. (Search exists
// but isn't where we want it yet, so it deliberately isn't here.) The cards
// are hand-laid as an asymmetric bento — spans, surfaces and internal layouts
// differ per card, so a v-for would obscure more than it saves. The drawn
// scenes live in FeatureDemo.vue.

// Hovering a theme tile repaints the whole themes card in that palette — the
// card demonstrates the feature on itself. Null = the card's resting look.
const themeHover = ref<string | null>(null);

// The walk-away test, shown rather than argued. The hash-suffixed filenames are
// what a block-workspace export actually looks like; the point lands harder as a
// file listing than as a sentence about lock-in.
const messyExport = [
  { depth: 0, name: "Export-", hash: "8f2b1c9a-4d1e", tail: ".zip" },
  { depth: 1, name: "Untitled ", hash: "3f2a9c1b8e4d", tail: ".md" },
  { depth: 1, name: "Meeting notes ", hash: "88a1f07c92e0", tail: ".md" },
  { depth: 1, name: "Roadmap ", hash: "4d1e6b3a", tail: "/" },
  { depth: 2, name: "Untitled Database ", hash: "e0c3a17f", tail: ".csv" },
  { depth: 1, name: "Screenshot (1)", hash: "", tail: ".png" },
];

const tidyTree = [
  { depth: 0, name: "~/Treehouse/Phoenix", dir: true },
  { depth: 1, name: "Briefs", dir: true },
  { depth: 1, name: "Research", dir: true },
  { depth: 1, name: "Design", dir: true },
  { depth: 1, name: "PRD.md", dir: false },
  { depth: 1, name: "Roadmap.pdf", dir: false },
];

// Tilts are fixed per chip rather than random, so the scatter is the same on
// every render and hover has a resting angle to return from.
const formats = [
  { ext: ".md", tilt: -5 },
  { ext: ".pdf", tilt: 3 },
  { ext: ".png", tilt: -2 },
  { ext: ".csv", tilt: 4 },
  { ext: ".excalidraw", tilt: -3 },
  { ext: ".txt", tilt: 2 },
  { ext: ".jpg", tilt: -4 },
  { ext: ".json", tilt: 5 },
  { ext: ".svg", tilt: -1 },
  { ext: ".docx", tilt: 3 },
  { ext: ".heic", tilt: -4 },
  { ext: ".mp4", tilt: 2 },
];

// The tier copy lives here; the prices and limits do not. Both come from the
// API's public `/api/plans` (usePlanPrices), the same numbers the app's plan
// picker shows and checkout charges, so this page cannot drift from Stripe.
const tiers = [
  {
    slug: "seedling",
    name: "Seedling",
    art: tierSeedling,
    blurb: "Free for one person. Try it with a small project — or a small robot.",
    cta: "Start for free",
    highlight: false,
  },
  {
    slug: "grove",
    name: "Grove",
    art: tierGrove,
    blurb: "For teams. Invite your colleagues, and let the agents pull their weight.",
    cta: "Start with Grove",
    highlight: true,
  },
  {
    slug: "forest",
    name: "Forest",
    art: tierForest,
    blurb: "For teams whose workspaces have grown into a whole canopy.",
    cta: "Start with Forest",
    highlight: false,
  },
] as const;

const { plans, loading: plansLoading } = usePlanPrices();

const pricedTiers = computed(() =>
  tiers.map((t) => {
    const offer = plans.value.find((p) => p.slug === t.slug);
    return {
      ...t,
      ...planCardPrice(t.slug, offer),
      features: [...(offer ? planLimitLines(offer) : []), "Unlimited agent keys"],
    };
  }),
);

// Each line is something the self-hosting docs back up. Storage especially:
// R2 and local disk are the tested routes, so the page doesn't promise more.
const openChecks = [
  "Self-hosted, your clients' files stay on infrastructure you control",
  "Or let us run it for you — same codebase",
  "File contents in your own Cloudflare R2 bucket, or on disk",
  "Metadata in a Postgres you control",
  "Open source — audit every line before you trust it",
];

// Hero depth. The art drifts down slowest (furthest away), the copy rises
// gently against it, so scrolling separates the two planes. The art carries a
// small base scale so its travel never exposes an edge.
const heroSection = ref<HTMLElement | null>(null);
const heroArtEl = ref<HTMLElement | null>(null);
const heroCopy = ref<HTMLElement | null>(null);
const heroFoliage = ref<HTMLElement | null>(null);

// The art is masked, so it can't be over-sized to give travel headroom without
// dragging the mask's fade stops out of place. Instead it plays the far plane —
// barely moving, its travel comfortably inside the 1.12 base scale (20px of
// bleed at the 336px mobile height, 43px at desktop). The foreground foliage
// carries the depth, and the copy rises gently against both.
useParallax(heroSection, [
  { el: heroArtEl, speed: 0.06, max: 18 },
  { el: heroCopy, speed: -0.05, max: 44 },
  // Negative speed outruns the page, which is what reads as "close". It only
  // ever travels upward and off the top, so it needs no bleed headroom.
  { el: heroFoliage, speed: -0.16, max: 130 },
]);

// A quieter echo of the same idea further down the page. The flag art drifts
// inside its panel as the band passes; travel stays well inside the 1.18 scale.
const openSection = ref<HTMLElement | null>(null);
const openArtEl = ref<HTMLElement | null>(null);

useParallax(openSection, [{ el: openArtEl, speed: 0.05, max: 26 }]);
</script>

<template>
  <div>
    <!-- ============ Hero ============ -->
    <section ref="heroSection" class="relative overflow-hidden">
      <FallingLeaves :count="10" :respawn="false" />
      <div
        class="relative mx-auto grid w-full max-w-7xl items-center gap-8 px-6 pb-10 pt-0 lg:grid-cols-[1.05fr_1fr] lg:pb-0 lg:pt-20"
      >
        <div ref="heroCopy" class="parallax relative z-10 -mt-24 pb-6 lg:mt-0 lg:pb-24">
          <span
            class="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1.5 pl-1.5 pr-4 text-xs font-bold uppercase tracking-[0.12em] text-fg-muted"
          >
            <img :src="treehouseLogo" alt="" class="size-6" />
            Open source · self-hostable
          </span>
          <h1 class="font-display type-display hero-title max-w-xl text-fg">
            Your team’s <br class="max-sm:hidden" />second brain, <br class="max-sm:hidden" /><em
              >open&nbsp;to&nbsp;everyone</em
            >
          </h1>
          <p class="mt-6 max-w-lg text-lg leading-relaxed text-fg-muted">
            One shared folder of plain files, synced to the whole team in seconds. Your team works
            in the Treehouse app, your agents work in the folder, and any file can be shared with a
            link.
          </p>
          <div class="mt-8 flex flex-wrap items-center gap-3">
            <a
              :href="signUpUrl"
              class="lift rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover hover:shadow-md"
              >Get started for free</a
            >
            <a
              href="#everyone"
              class="lift inline-flex items-center gap-2 rounded-full border border-border bg-surface px-6 py-3 text-sm font-semibold text-fg hover:border-sage hover:bg-mist hover:shadow-sm"
            >
              See how it works
            </a>
          </div>
          <p class="mt-4 text-sm text-fg-muted">
            Free for one person. Bring Claude Code, Cursor or the agent you already use.
          </p>

          <!-- A wrapping flex row: Vue drops the whitespace between the links,
               so inline text would have nowhere to break on a phone. -->
          <div
            class="mt-12 flex flex-wrap items-baseline gap-x-4 gap-y-1.5 text-sm text-fg-muted sm:gap-x-2"
          >
            <span class="w-full font-semibold text-fg sm:mr-1 sm:w-auto">Teams use it for</span>
            <template v-for="(u, i) in heroUses" :key="u.label">
              <span v-if="i" class="hidden text-sage sm:inline" aria-hidden="true">·</span>
              <a
                :href="u.to"
                class="whitespace-nowrap font-semibold text-leaf underline decoration-sage/60 underline-offset-4 hover:decoration-leaf"
                >{{ u.label }}</a
              >
            </template>
          </div>
        </div>

        <!--
          From lg the art leaves the grid flow and fills the section's full
          height, pinned to the viewport's right edge. Because it is absolute
          and capped at 52vw it can never reach the copy, however tall the
          section grows.
        -->
        <div
          class="hero-frame relative -mx-6 order-first overflow-hidden lg:absolute lg:inset-y-0 lg:order-none lg:mx-0 lg:w-[52vw] lg:right-[min(0px,calc(640px-50vw))]"
        >
          <img
            ref="heroArtEl"
            :src="heroArt"
            alt="Robots working together in a treehouse"
            class="parallax h-[15rem] w-full scale-[1.12] object-cover object-[58%_36%] sm:h-[22rem] lg:h-full lg:object-[70%_50%]"
          />
          <!--
            Near plane. Lives inside the art wrapper so it can only ever overlap
            the illustration, never the copy, at any breakpoint.
          -->
          <img
            ref="heroFoliage"
            :src="foliageArt"
            alt=""
            aria-hidden="true"
            class="parallax pointer-events-none absolute inset-x-0 top-0 -mt-24 w-full select-none lg:-mt-52"
          />
        </div>
      </div>
    </section>

    <!-- ============ App window ============ -->
    <!--
      The real interface, not a diagram: AppDemo renders the app's own chrome
      and palette. See the note at the top of that component before changing
      anything in it.
    -->
    <section id="workspace" class="relative scroll-mt-20">
      <div class="mx-auto w-full max-w-7xl px-6 pb-20 md:pb-28">
        <AppDemo />

        <p class="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-fg-muted">
          That's a team's second brain in the real web app: handbook, clients and ways of working as
          plain folders. Seven themes ship with it; try them.
        </p>
      </div>
    </section>

    <!-- ============ Everyone gets in ============ -->
    <!--
      The first differentiator, straight after the product shot: a second brain
      only works if the whole team uses it, and here each person comes in the way
      they already work. The browser leads because it is the door a vault on disk
      doesn't have.
    -->
    <section id="everyone" class="scroll-mt-20 border-b border-border/70">
      <div class="mx-auto w-full max-w-7xl px-6 pb-16 pt-4 md:pb-24 md:pt-8">
        <div class="mb-12 max-w-2xl">
          <p class="label-eyebrow mb-3">Everyone gets in</p>
          <h2 class="font-display type-headline mb-4 text-balance font-semibold">
            One folder, however each of you works
          </h2>
          <p class="text-lg leading-relaxed text-fg-muted">
            A second brain only works if the whole team uses it. Treehouse meets each person where
            they already are, and every change lands in the same files for everyone.
          </p>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <div
            v-for="d in doors"
            :key="d.title"
            class="min-w-0 rounded-2xl border border-border bg-surface p-7"
          >
            <h3 class="flex items-center gap-2.5 text-base font-bold">
              <span class="leaf-dot" /> {{ d.title }}
            </h3>
            <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ d.body }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ Sharing ============ -->
    <!--
      The second differentiator, so it comes before the feature tour. Sync and
      storage alone is Dropbox; being able to hand someone a URL to anything in
      the workspace is what makes it a workspace. The portal and HTML cards live
      here rather than in the tour, since both are things you share.
    -->
    <section id="sharing" class="scroll-mt-20 border-b border-border/70">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <div class="mb-12 max-w-2xl">
          <p class="label-eyebrow mb-3">Sharing</p>
          <h2 class="font-display type-headline mb-4 text-balance font-semibold">
            Share any file or folder as a link
          </h2>
          <p class="text-lg leading-relaxed text-fg-muted">
            Make a public link to a single doc or a whole folder, and that folder becomes a client
            portal, a project page or a little website. Whoever you send it to opens it in their
            browser: no account, no app, no invite.
          </p>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <div
            v-for="sh in sharing"
            :key="sh.title"
            class="flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-7"
          >
            <h3 class="flex items-center gap-2.5 text-base font-bold">
              <span class="leaf-dot" /> {{ sh.title }}
            </h3>
            <p class="mb-7 mt-2 text-sm leading-relaxed text-fg-muted">{{ sh.body }}</p>
            <!--
              The card's white surface and the app's --th-surface are the same
              white, so this sits flush — the only edges are the app's own.
            -->
            <ShareDemo :id="sh.demo" class="mt-auto" />
          </div>
        </div>

        <div class="mt-4 grid gap-4 lg:grid-cols-5">
          <!-- Portal — copy beside a browser window that runs off the card. -->
          <div
            v-reveal
            class="feature-card min-w-0 overflow-hidden rounded-2xl border border-border bg-surface p-7 pb-0 sm:p-8 sm:pb-0 lg:col-span-3"
          >
            <!-- Full height, with the window pinned to the bottom: the HTML card
                 beside it sets the row height, and the portal should still run
                 off the card's lower edge rather than float above it. -->
            <div
              class="grid h-full gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] sm:items-start"
            >
              <div class="min-w-0">
                <h3 class="flex items-center gap-2.5 text-base font-bold">
                  <span class="leaf-dot" /> Share a folder, get a portal
                </h3>
                <p class="mb-7 mt-2 text-sm leading-relaxed text-fg-muted">
                  A shared folder opens under your workspace's name, icon, and theme, with the
                  README up front and the machinery out of sight. A client portal you didn't have to
                  build.
                </p>
              </div>
              <FeatureDemo id="portal" class="-mb-2 sm:-mb-8 sm:-mr-3 sm:self-end" />
            </div>
          </div>

          <!-- HTML — the rendered report, cropped mid-chart. -->
          <div
            v-reveal
            class="feature-card min-w-0 overflow-hidden rounded-2xl border border-border bg-surface p-7 pb-0 lg:col-span-2"
            style="--reveal-delay: 100ms"
          >
            <h3 class="flex items-center gap-2.5 text-base font-bold">
              <span class="leaf-dot" /> HTML that just serves
            </h3>
            <p class="mt-2 max-w-md text-sm leading-relaxed text-fg-muted">
              Upload a page, or a whole little site, and it renders edge to edge with links and
              images intact. Living reports straight from a folder.
            </p>
            <FeatureDemo id="html" class="mt-7" />
          </div>
        </div>

        <div
          class="mt-4 flex flex-col items-start gap-4 rounded-2xl border border-leaf/30 bg-mist/40 p-7 sm:flex-row sm:items-center"
        >
          <span class="leaf-dot mt-1 shrink-0 sm:mt-0" />
          <p class="leading-relaxed text-fg">
            <span class="font-bold">Only a person can publish.</span>
            <span class="text-fg-muted">
              Agents can mint links that still require a login, but a public, no-login link can only
              ever be created from a human session — never from an agent key.
            </span>
          </p>
        </div>
      </div>
    </section>

    <!-- ============ Features ============ -->
    <!--
      Straight after the product shot, before any of the deep-dives: a visitor
      who has just seen the app wants to know what it does next, one claim per
      feature, at a glance. The deep-dives below are for the ones still reading.
    -->
    <section id="features" class="scroll-mt-20 border-b border-border/70">
      <!-- Light on top: the product shot above already closes on generous
           space of its own, on the same cream. -->
      <div class="mx-auto w-full max-w-7xl px-6 pb-16 pt-4 md:pb-24 md:pt-8">
        <div class="mb-12 max-w-2xl">
          <p class="label-eyebrow mb-3">What's inside</p>
          <h2 class="font-display type-headline mb-4 font-semibold">
            A folder on disk. A workspace everywhere else.
          </h2>
          <p class="text-lg leading-relaxed text-fg-muted">
            Everything you'd expect from a modern workspace, done the plain-files way — and a few
            things a folder has never done on its own.
          </p>
        </div>

        <!--
          Asymmetric on purpose: 4+2 / 2+4, one dark card, one tinted,
          and scenes that tilt and bleed off card edges. A uniform grid of
          equal framed miniatures read as a form, not a tour.
        -->
        <div class="grid gap-4 lg:grid-cols-6">
          <!-- Comments — the differentiator, so it gets the hero slot. -->
          <div
            v-reveal
            class="feature-card min-w-0 overflow-hidden rounded-2xl border border-border bg-surface p-7 sm:p-8 lg:col-span-4"
          >
            <h3 class="font-display text-2xl font-semibold text-leaf-deep">
              Comments agents can answer
            </h3>
            <p class="mt-2 max-w-lg text-sm leading-relaxed text-fg-muted">
              Select a sentence and start a thread. Teammates reply in the app, agents over MCP, and
              either can resolve. Comments stay pinned to the words they're about, even after a
              rewrite.
            </p>
            <FeatureDemo id="comments" class="mt-8" />
          </div>

          <!-- Encryption — the one dark card, same slab treatment as "the
               third option" panel further down. -->
          <div
            v-reveal
            class="feature-card min-w-0 overflow-hidden rounded-2xl bg-leaf-deep p-7 shadow-md ring-1 ring-inset ring-cream/10 lg:col-span-2"
            style="--reveal-delay: 100ms"
          >
            <h3 class="font-display text-2xl font-semibold text-cream">Encrypted at rest</h3>
            <p class="mt-2 text-sm leading-relaxed text-cream/75">
              Every file is encrypted before it reaches storage, each workspace under its own key. A
              stolen bucket holds gibberish, and a deleted workspace is unreadable for good.
            </p>
            <FeatureDemo id="encryption" class="mt-6" />
          </div>

          <!-- Sync -->
          <div
            v-reveal
            class="feature-card min-w-0 overflow-hidden rounded-2xl border border-border bg-surface p-7 lg:col-span-2"
          >
            <h3 class="font-display text-2xl font-semibold text-leaf-deep">
              Synced without thinking
            </h3>
            <p class="mt-2 text-sm leading-relaxed text-fg-muted">
              The menubar app keeps an ordinary folder on each machine in step with the workspace.
              There is no sync button to remember.
            </p>
            <FeatureDemo id="sync" class="mt-8" />
          </div>

          <!-- Themes — tinted card, scattered tiles. Hovering a tile paints
               the card itself in that theme: the demo is the feature. -->
          <div
            v-reveal
            :data-demo-theme="themeHover ?? undefined"
            class="feature-card min-w-0 overflow-hidden rounded-2xl border p-7 transition-colors duration-500 lg:col-span-4"
            :class="themeHover ? 'border-th-border bg-th-app' : 'border-border bg-mist/40'"
            style="--reveal-delay: 100ms"
          >
            <h3
              class="font-display text-2xl font-semibold transition-colors duration-500"
              :class="themeHover ? 'text-th-fg' : 'text-leaf-deep'"
            >
              Your house, your colours
            </h3>
            <p
              class="mt-2 max-w-md text-sm leading-relaxed transition-colors duration-500"
              :class="themeHover ? 'text-th-fg-muted' : 'text-fg-muted'"
            >
              Seven built-in themes, cream parchment to Rosé Pine, or create your own completely
              custom one. Every workspace gets its own icon and colour, and shared links arrive
              dressed to match.
            </p>
            <FeatureDemo id="themes" v-model:hover-theme="themeHover" class="mt-7" />
          </div>
        </div>
      </div>
    </section>

    <!-- ============ Trust ============ -->
    <TrustPanel />

    <!-- ============ The problem ============ -->
    <!--
      The forced choice, after the product rather than before it: by now the
      reader has seen what Treehouse does, and this is why it is built the way
      it is: a second brain is easy for one person and hard for a team.
    -->
    <section class="border-t border-border/70 bg-parchment/40">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <div class="mb-12 max-w-2xl">
          <p class="label-eyebrow mb-3">Why we built it</p>
          <h2 class="font-display type-headline mb-4 font-semibold">
            Right now you have to pick a side
          </h2>
          <p class="text-lg leading-relaxed text-fg-muted">
            A second brain of your own is easy. One the whole team can use is where it falls apart:
            keep your notes as files nobody else can reach, or move into a shared wiki that isn't
            files at all.
          </p>
        </div>

        <div class="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
          <div
            v-for="(t, i) in tradeoff"
            :key="t.label"
            class="min-w-0 rounded-2xl border border-border bg-surface p-7"
            :class="i === 1 ? 'lg:col-start-3' : ''"
          >
            <h3 class="font-display text-2xl font-semibold text-leaf-deep">{{ t.label }}</h3>
            <p class="mt-2 text-sm leading-relaxed text-fg-muted">{{ t.good }}</p>
            <p class="mt-6 text-[11px] font-bold uppercase tracking-[0.14em] text-fg-subtle">
              What it costs you
            </p>
            <ul class="mt-3 space-y-2">
              <li
                v-for="c in t.costs"
                :key="c"
                class="flex items-start gap-2.5 text-sm leading-relaxed text-fg"
              >
                <svg
                  viewBox="0 0 16 16"
                  class="mt-1 size-3.5 shrink-0 text-danger"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
                {{ c }}
              </li>
            </ul>
          </div>

          <!--
            Explicit row as well as column: sparse auto-placement will not
            backtrack to column 2 once the second card has claimed column 3, so
            without this the pill drops to a row of its own below both cards.
          -->
          <div
            class="relative flex items-center justify-center lg:col-start-2 lg:row-start-1 lg:px-4"
          >
            <span
              class="absolute inset-y-0 left-1/2 hidden w-px -translate-x-1/2 bg-border lg:block"
              aria-hidden="true"
            />
            <span
              class="relative rounded-full border border-border bg-canvas px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.14em] text-fg-muted"
              >or</span
            >
          </div>
        </div>

        <!--
          Both roads run into the same place. The curves leave from roughly the
          middle of each card above and meet at the centre of the panel below,
          so the layout makes the argument before the copy does.

          preserveAspectRatio="none" lets the viewBox stretch to whatever width
          the container ends up at — the x positions then track the card centres
          at every size. non-scaling-stroke keeps the lines from being stretched
          into wedges along with it, and has to sit on each path since
          vector-effect does not inherit.
        -->
        <div class="relative hidden h-16 lg:block" aria-hidden="true">
          <svg
            class="absolute inset-0 h-full w-full"
            viewBox="0 0 1000 64"
            preserveAspectRatio="none"
            fill="none"
          >
            <path
              v-for="x in [230, 770]"
              :key="`base-${x}`"
              class="converge-base"
              vector-effect="non-scaling-stroke"
              :d="`M${x} 0C${x} 46 500 18 500 64`"
            />
            <path
              v-for="(x, i) in [230, 770]"
              :key="`flow-${x}`"
              class="converge-flow"
              :class="i === 1 ? 'converge-flow-b' : ''"
              vector-effect="non-scaling-stroke"
              :d="`M${x} 0C${x} 46 500 18 500 64`"
            />
          </svg>
        </div>

        <div
          class="answer relative mx-auto max-w-3xl overflow-hidden rounded-[2rem] bg-leaf-deep px-8 py-12 text-center shadow-lg ring-1 ring-inset ring-cream/10 max-lg:mt-6 md:px-14"
        >
          <span class="answer-glow pointer-events-none absolute inset-0" aria-hidden="true" />
          <div class="relative">
            <img
              :src="treehouseLogo"
              alt=""
              aria-hidden="true"
              class="mx-auto mb-6 w-20 select-none"
            />
            <p class="label-eyebrow label-eyebrow-on-dark mb-3">The third option</p>
            <h3 class="font-display type-headline-sm font-semibold text-cream">
              Plain files the whole team can open
            </h3>
            <p class="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-cream/75">
              Your second brain stays a folder on every computer, with a web app for everyone else
              and the sharing, permissions and history that plain files never had.
            </p>
            <ul class="mt-8 flex flex-wrap justify-center gap-2.5">
              <li
                v-for="r in resolution"
                :key="r"
                class="flex items-center gap-2 rounded-full bg-cream/10 px-4 py-2 text-sm font-semibold text-cream ring-1 ring-cream/15"
              >
                <svg viewBox="0 0 16 16" class="size-4 shrink-0 text-sage" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6" />
                  <path
                    d="m5 8.2 2 2 4-4.4"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                {{ r }}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ For agents ============ -->
    <section
      id="agents"
      class="relative scroll-mt-20 overflow-hidden border-b border-border/70 bg-parchment/60"
    >
      <!--
        Brand texture behind the band. Sits at low opacity well clear of the
        copy, and is decorative so it stays out of the accessibility tree.
      -->
      <img
        :src="leafFieldUrl"
        alt=""
        aria-hidden="true"
        class="pointer-events-none absolute -right-24 -top-16 w-[38rem] max-w-none select-none opacity-[0.14]"
      />
      <div class="relative mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <p class="label-eyebrow mb-3">For agents</p>
        <h2 class="font-display type-headline mb-4 max-w-3xl font-semibold">
          Your agents already know how to use it
        </h2>
        <p class="mb-12 max-w-2xl text-lg leading-relaxed text-fg-muted">
          The second brain your team reads is the one your agents write to. They work on the files
          with the tools they already have, and everyone sees the change moments later.
        </p>

        <!--
          Two doors, one row: the synced folder for agents on your machine, and
          MCP for the ones that aren't.
        -->
        <div class="grid gap-4 lg:grid-cols-2">
          <!--
            The section's whole claim in one picture: a folder on your machine,
            looping to the cloud and back. Sits on the white card unknocked-out,
            since the generated backdrop is already the card's own surface.
          -->
          <div class="flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-6 sm:p-8">
            <div class="flex flex-col gap-6 sm:flex-row sm:items-center">
              <img
                :src="syncFolderArt"
                alt="A folder of files on your machine, syncing to and from the cloud"
                class="mx-auto h-52 w-auto shrink-0 select-none object-contain sm:mx-0 sm:h-60"
              />
              <div>
                <h3 class="text-base font-bold">Point your agent at the folder</h3>
                <p class="mt-2 text-sm leading-relaxed text-fg-muted">
                  Claude Code, Cowork, Codex, Cursor — any agent that works on files. It reads and
                  edits the workspace with ls, grep and whatever else it already reaches for.
                </p>
                <p class="mt-3 text-sm leading-relaxed text-fg-muted">
                  Everything it does syncs out to the rest of the team and the web app within
                  seconds, under your name. No plugin, no connector, no API key to wire up.
                </p>
              </div>
            </div>
          </div>

          <div class="flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-6">
            <h3 class="text-base font-bold">Give it a name of its own over MCP</h3>
            <p class="mb-4 mt-1 text-sm leading-relaxed text-fg-muted">
              For agents that don't live on your machine, or when you want an agent's changes
              labelled as its own and undoable in one step. It signs in through your browser.
            </p>
            <CodeBlock class="flex-1" :snippet="snippets.mcp" />
          </div>
        </div>
      </div>
    </section>

    <!-- ============ Second brain ============ -->
    <!--
      The first half of the own-your-data argument; the open-source band right
      after it is the second. This is the only part of the page addressed to the
      reader's own stuff rather than the team's, and the only one allowed to be
      silly — the argument for plain files is a serious one that survives being
      enjoyed.
    -->
    <section id="second-brain" class="relative scroll-mt-20 border-b border-border/70">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <div
          class="mb-12 flex flex-col gap-10 lg:flex-row lg:items-center lg:justify-between lg:gap-16"
        >
          <div class="max-w-2xl">
            <p class="label-eyebrow mb-3">Your second brain</p>
            <h2 class="font-display type-headline mb-4 font-semibold">
              Make your second brain portable
            </h2>
            <p class="text-lg leading-relaxed text-fg-muted">
              Everyone's building one — notes, research, half-finished thinking, the stuff you'd
              actually miss. Almost nobody asks what happens to it when the app it lives in gets
              acquired, pivots, or decides it's an AI company now. Yours is a folder. It'll still
              open in twenty years.
            </p>
          </div>
          <!--
            Stacked, the sticker leads: dropped below the lede it reads as a
            footnote to copy that has already finished making the point.
          -->
          <CoolAgainSeal
            class="size-40 shrink-0 self-start max-lg:order-first sm:size-52 lg:size-56 lg:self-auto"
          />
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <div class="flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-6 sm:p-7">
            <p class="label-eyebrow mb-4 text-fg-subtle">Leaving a block-based workspace</p>
            <ul class="mb-6 font-mono text-[13px] leading-relaxed">
              <li
                v-for="(r, i) in messyExport"
                :key="i"
                class="truncate py-0.5"
                :style="{ paddingLeft: `${r.depth * 18}px` }"
              >
                <span :class="r.depth === 0 ? 'font-bold text-fg' : 'text-fg-muted'">{{
                  r.name
                }}</span
                ><span class="text-danger">{{ r.hash }}</span
                ><span :class="r.depth === 0 ? 'font-bold text-fg' : 'text-fg-muted'">{{
                  r.tail
                }}</span>
              </li>
            </ul>
            <div class="mt-auto rounded-xl border border-border bg-parchment/60 p-3.5">
              <p class="font-mono text-[11px] font-bold text-fg-muted">Preparing your export…</p>
              <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-mist">
                <div class="h-full w-[38%] rounded-full bg-wood" />
              </div>
              <p class="mt-2.5 text-[11px] leading-relaxed text-fg-muted">
                This may take up to 24 hours. We'll email you a link when it's ready.
              </p>
            </div>
          </div>

          <div
            class="flex min-w-0 flex-col rounded-2xl border border-leaf/40 bg-surface p-6 shadow-sm sm:p-7"
          >
            <p class="label-eyebrow mb-4 text-leaf">Leaving Treehouse</p>
            <ul class="mb-6 font-mono text-[13px] leading-relaxed">
              <li
                v-for="(r, i) in tidyTree"
                :key="i"
                class="flex min-w-0 items-center gap-2 py-0.5"
                :style="{ paddingLeft: `${r.depth * 18}px` }"
              >
                <svg
                  v-if="r.dir"
                  viewBox="0 0 20 16"
                  class="size-3.5 shrink-0 fill-sage"
                  aria-hidden="true"
                >
                  <path
                    d="M1.5 3.5A2 2 0 0 1 3.5 1.5h4l2 2.2h7a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
                  />
                </svg>
                <span v-else class="size-3.5 shrink-0" aria-hidden="true" />
                <span
                  class="min-w-0 truncate"
                  :class="r.depth === 0 ? 'font-bold text-leaf-deep' : 'text-fg'"
                  >{{ r.name }}</span
                >
              </li>
            </ul>
            <div
              class="mt-auto flex items-start gap-3 rounded-xl border border-leaf/30 bg-mist/50 p-3.5"
            >
              <svg viewBox="0 0 16 16" class="mt-0.5 size-4 shrink-0 text-leaf" fill="none">
                <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6" />
                <path
                  d="m5 8.2 2 2 4-4.4"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <p class="text-[11px] leading-relaxed text-fg-muted">
                <span class="font-bold text-fg">There is no export.</span> It has been a folder on
                your disk the whole time — the same names, the same formats, ready before you asked.
              </p>
            </div>
          </div>
        </div>

        <div
          class="mt-4 grid gap-8 rounded-2xl border border-border bg-surface p-7 md:p-10 lg:grid-cols-[1fr_auto] lg:items-center"
        >
          <div class="min-w-0">
            <h3 class="font-display text-2xl font-semibold text-leaf-deep">
              Not one of these needs us to open it
            </h3>
            <p class="mt-2 max-w-xl text-sm leading-relaxed text-fg-muted">
              No proprietary block model, no database rows pretending to be a page. Just the formats
              your operating system already understands — and so does every tool you'll use next.
            </p>
            <!-- Held narrower than the column so the chips break into a couple
                 of even rows rather than one long line and a single orphan. -->
            <ul class="mt-6 flex max-w-xl flex-wrap gap-2.5">
              <li
                v-for="f in formats"
                :key="f.ext"
                class="format-chip rounded-lg border border-border bg-canvas px-3 py-1.5 font-mono text-sm font-bold text-leaf-deep shadow-sm"
                :style="{ '--tilt': `${f.tilt}deg` }"
              >
                {{ f.ext }}
              </li>
            </ul>
          </div>
          <!--
            The art keeps its own cream backdrop rather than being knocked out:
            this render's highlights sit at exactly the background's luminance,
            so any floodfill that clears the background also eats the top of the
            robot's head. A cream tile makes that a deliberate frame instead of
            a defect — and the asset is colour-matched to --brand-cream so the
            two surfaces meet without a seam.
          -->
          <div class="mx-auto shrink-0 rounded-2xl bg-canvas p-4 ring-1 ring-border/70">
            <img
              :src="brainToGoArt"
              alt="A small robot heading off with a folder under its arm and papers in its rucksack"
              class="h-44 w-auto select-none object-contain lg:h-56"
            />
          </div>
        </div>

        <!--
          The other half of the plain-files bargain. Owning the files is the easy
          part; getting them onto a second machine is where people end up
          running git against their own notes.
        -->
        <div
          class="mt-4 flex flex-col items-start gap-4 rounded-2xl border border-leaf/30 bg-mist/40 p-7 sm:flex-row sm:items-center"
        >
          <span class="leaf-dot mt-1 shrink-0 sm:mt-0" />
          <p class="leading-relaxed text-fg">
            <span class="font-bold">And no git.</span>
            <span class="text-fg-muted">
              Keeping a vault in sync across two machines usually means a paid add-on, a cloud
              folder that conflicts quietly, or a git plugin that asks you to resolve merge
              conflicts in your own notes. Treehouse syncs the folder both ways on its own — and the
              history you'd have kept git around for is already there.
            </span>
          </p>
        </div>

        <p class="mx-auto mt-10 max-w-2xl text-center text-lg leading-relaxed text-fg">
          <span class="font-bold">The exit test:</span> cancel tomorrow and nothing moves. The
          folder is still on your laptop, still named the way you named it, still opening in
          whatever you like next.
        </p>
      </div>
    </section>

    <!-- ============ Open source band ============ -->
    <section id="open-source" ref="openSection" class="scroll-mt-20">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <div
          class="grid overflow-hidden rounded-3xl border border-border bg-surface shadow-md lg:grid-cols-[300px_1fr_320px]"
        >
          <!--
            Its own overflow context: the image is over-sized and drifts inside
            the card, so the card's rounded corners keep clipping it.
          -->
          <div class="relative h-44 overflow-hidden lg:h-auto">
            <img
              ref="openArtEl"
              :src="openSourceArt"
              alt="A robot planting the Treehouse flag in a forest"
              class="parallax absolute inset-0 h-full w-full scale-[1.18] object-cover"
            />
          </div>
          <div class="p-8 md:p-10">
            <p class="label-eyebrow mb-3">Open by default</p>
            <h2 class="font-display type-headline-sm font-semibold">
              Open source, down to the roots
            </h2>
            <p class="mt-4 max-w-lg text-base leading-relaxed text-fg-muted">
              Putting agents to work shouldn't mean handing your clients' files to a closed box. Run
              Treehouse on your own ground, against your own bucket, and keep the data where your
              agreements say it lives — the hosted version is the same tree, just watered for you.
            </p>
            <div class="mt-6 flex flex-wrap items-center gap-3">
              <a
                :href="GITHUB_URL"
                class="inline-flex items-center gap-2 rounded-full bg-charcoal px-5 py-2.5 text-sm font-semibold text-cream transition-opacity hover:opacity-90"
              >
                <svg viewBox="0 0 16 16" class="size-4" fill="currentColor" aria-hidden="true">
                  <path
                    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                  />
                </svg>
                View on GitHub
              </a>
              <code class="font-mono text-xs text-fg-muted">git clone → pnpm dev → moved in</code>
            </div>
          </div>
          <ul class="space-y-3.5 border-t border-border/60 p-8 lg:border-l lg:border-t-0 lg:py-10">
            <li v-for="c in openChecks" :key="c" class="flex items-start gap-2.5 text-sm">
              <svg viewBox="0 0 16 16" class="mt-0.5 size-4 shrink-0 text-leaf" fill="none">
                <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6" />
                <path
                  d="m5 8.2 2 2 4-4.4"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="leading-snug text-fg-muted">{{ c }}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ============ Pricing ============ -->
    <section id="pricing" class="scroll-mt-20 border-b border-border/70 bg-parchment/60">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:py-24">
        <div class="mb-14 text-center">
          <p class="label-eyebrow mb-3">Pricing</p>
          <h2 class="font-display type-headline mx-auto max-w-2xl font-semibold">
            Simple, like a treehouse should be
          </h2>
          <p class="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-fg-muted">
            Pay for the humans. Agent keys are unlimited on every plan — agents are teammates, not
            seats.
          </p>
        </div>

        <div class="mx-auto grid max-w-5xl items-start gap-4 lg:grid-cols-3">
          <div
            v-for="t in pricedTiers"
            :key="t.name"
            class="lift-card relative rounded-2xl border bg-surface p-8"
            :class="
              t.highlight ? 'border-leaf shadow-lg lg:-my-3 lg:py-11' : 'border-border shadow-sm'
            "
          >
            <!--
              Not "Most popular": that is a claim about sales we have no
              evidence for yet. The card is emphasised because it is the plan
              built for a team, which is who Treehouse is for.
            -->
            <span
              v-if="t.highlight"
              class="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-primary-fg"
              >Built for teams</span
            >
            <!--
              The tiers are named after stages of growth; the art makes that
              literal and gives the row a progression to read along. Decorative —
              the tier name beside it already carries the meaning.
            -->
            <img
              :src="t.art"
              alt=""
              aria-hidden="true"
              class="tier-art mb-4 h-20 w-auto select-none object-contain object-left"
            />
            <h3 class="text-base font-bold">{{ t.name }}</h3>
            <p class="mt-3 flex min-h-12 items-baseline gap-2">
              <span
                v-if="t.price"
                class="font-display text-5xl font-semibold tracking-tight text-leaf-deep"
                >{{ t.price }}</span
              >
              <span
                v-else-if="plansLoading"
                class="inline-block h-12 w-24 animate-pulse rounded-lg bg-mist"
                aria-label="Loading price"
              />
              <span v-else class="text-sm text-fg-muted"
                >Priced per member. You'll see it when you choose a plan.</span
              >
              <span v-if="t.period" class="text-xs leading-tight text-fg-muted">{{
                t.period
              }}</span>
            </p>
            <p class="mt-1 min-h-5 text-xs text-fg-muted">{{ t.yearly }}</p>
            <p class="mt-3 min-h-10 text-sm leading-relaxed text-fg-muted">{{ t.blurb }}</p>
            <a
              :href="signUpUrl"
              class="lift mt-5 block rounded-full px-5 py-2.5 text-center text-sm font-semibold"
              :class="
                t.highlight
                  ? 'bg-primary text-primary-fg hover:bg-primary-hover'
                  : 'border border-mist bg-surface text-fg hover:bg-mist'
              "
              >{{ t.cta }}</a
            >
            <ul class="mt-6 space-y-2.5 border-t border-border/60 pt-6 text-sm">
              <li v-for="f in t.features" :key="f" class="flex items-start gap-2.5">
                <svg viewBox="0 0 16 16" class="mt-0.5 size-4 shrink-0 text-leaf" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6" />
                  <path
                    d="m5 8.2 2 2 4-4.4"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="leading-snug text-fg-muted">{{ f }}</span>
              </li>
            </ul>
          </div>
        </div>

        <p class="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-fg-muted">
          Every plan has every feature: sync, the MCP server and API, version history, comments and
          share links. Plans differ in how much a workspace holds and who can join it. Need
          something else?
          <a :href="CONTACT_URL" class="font-semibold text-leaf underline">Talk to us</a>.
        </p>

        <!-- Self-host strip -->
        <div
          class="lift-card mx-auto mt-8 flex max-w-5xl flex-col items-start justify-between gap-4 rounded-2xl border border-border bg-surface p-6 sm:flex-row sm:items-center md:px-8"
        >
          <div>
            <h3 class="text-base font-bold">Prefer your own ground?</h3>
            <p class="mt-1 max-w-xl text-sm leading-relaxed text-fg-muted">
              Self-hosting is free forever — unlimited workspaces, unlimited members, and whatever
              storage your bucket holds.
            </p>
          </div>
          <a
            :href="GITHUB_URL"
            class="lift shrink-0 rounded-full bg-charcoal px-5 py-2.5 text-sm font-semibold text-cream hover:opacity-90 hover:shadow-md"
            >Self-host from GitHub</a
          >
        </div>
      </div>
    </section>

    <!-- ============ Final CTA ============ -->
    <!--
      No bottom treatment of its own any more: the footer's scenic band picks up
      directly beneath this, so the page resolves into the landscape rather than
      stopping at a flat silhouette.
    -->
    <section class="relative overflow-hidden border-t border-border/70">
      <div class="relative mx-auto w-full max-w-7xl px-6 pb-20 pt-16 text-center md:pb-24 md:pt-24">
        <img :src="treehouseLogo" alt="" class="mx-auto mb-8 w-40" />
        <h2 class="font-display type-display mx-auto max-w-2xl font-semibold">Ready to move in?</h2>
        <p class="mx-auto mt-5 max-w-md text-lg leading-relaxed text-fg-muted">
          Plant a workspace for your team — and leave a key under the mat for your agents.
        </p>
        <div class="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a
            :href="signUpUrl"
            class="lift rounded-full bg-primary px-7 py-3.5 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover hover:shadow-md"
            >Get started for free</a
          >
          <a
            :href="GITHUB_URL"
            class="lift rounded-full border border-border bg-surface px-7 py-3.5 text-sm font-semibold text-fg hover:border-sage hover:bg-mist hover:shadow-sm"
            >Self-host from GitHub</a
          >
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/*
 * Parallax layers read their offset from --parallax-y, set by useParallax.
 * translate3d keeps the work on the compositor; the property defaults to 0 so
 * the layout is correct before any script runs and stays correct if it never
 * does. Scale composes on top for layers that carry one.
 */
.parallax {
  translate: 0 var(--parallax-y, 0px);
  will-change: translate;
}

/*
 * Features cards rise in the first time they scroll into view (v-reveal),
 * the second card of each bento row trailing its neighbour by --reveal-delay.
 * The hidden initial state lives inside this media query so reduced-motion
 * visitors — and anything that stops the observer firing — always see the
 * cards. The scenes inside choreograph themselves; see FeatureDemo.vue.
 */
@media (prefers-reduced-motion: no-preference) {
  .feature-card {
    opacity: 0;
    translate: 0 18px;
    transition:
      opacity 0.6s var(--ease-out-soft) var(--reveal-delay, 0s),
      translate 0.6s var(--ease-out-soft) var(--reveal-delay, 0s);
  }

  .feature-card[data-revealed] {
    opacity: 1;
    translate: 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .parallax {
    translate: none;
    will-change: auto;
  }
}

/*
 * The two roads converging on the answer panel. A faint solid line carries the
 * shape; a dashed one travels along it so the drawing reads as flow rather than
 * as a bracket. The two sides run half a cycle apart, which stops the pair from
 * pulsing in lockstep like a loading bar.
 */
.converge-base {
  stroke: var(--brand-sage);
  stroke-width: 1.5;
  stroke-opacity: 0.5;
}

.converge-flow {
  stroke: var(--brand-leaf);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-dasharray: 3 13;
  animation: converge-flow 2.6s linear infinite;
}

.converge-flow-b {
  animation-delay: -1.3s;
}

/* One dash period, so the loop has no seam. */
@keyframes converge-flow {
  to {
    stroke-dashoffset: -16;
  }
}

/*
 * A slow swell of light behind the answer. Opacity only — no transform, no
 * layout — so it costs a composite and nothing else.
 */
.answer-glow {
  background:
    radial-gradient(44% 56% at 50% -4%, rgba(133, 196, 129, 0.85), transparent 70%),
    radial-gradient(70% 80% at 50% 0%, rgba(107, 163, 104, 0.45), transparent 72%),
    radial-gradient(52% 64% at 50% 114%, rgba(168, 197, 161, 0.3), transparent 74%);
  animation: answer-breathe 8s var(--ease-in-out-soft) infinite;
}

@keyframes answer-breathe {
  0%,
  100% {
    opacity: 0.68;
  }
  50% {
    opacity: 1;
  }
}

/*
 * Format chips sit at a fixed jaunty angle each — scattered on a desk rather
 * than filed. Hovering one straightens and lifts it, which is the whole joke:
 * these are ordinary things you can pick up.
 */
.format-chip {
  rotate: var(--tilt, 0deg);
  transition:
    rotate var(--duration-base) var(--ease-out-soft),
    translate var(--duration-base) var(--ease-out-soft),
    box-shadow var(--duration-base) var(--ease-out-soft);
}

.format-chip:hover {
  rotate: 0deg;
  translate: 0 -3px;
  box-shadow: var(--shadow-md);
}

@media (prefers-reduced-motion: reduce) {
  .format-chip:hover {
    translate: none;
    rotate: none;
  }

  .converge-flow,
  .answer-glow {
    animation: none;
  }
}

/*
 * The art is pinned into the top-right corner at every width — a narrow sliver
 * on small screens, half the viewport from lg. Its top meets the header and its
 * right edge is the screen edge, so both are hard; only the left and bottom
 * dissolve into the cream the copy sits on.
 *
 * The dissolve lives on the frame, not on the image. The image is scaled and
 * translated for parallax, which would drag the fade stops out of position and
 * push them past the frame's clip — masking the frame keeps the blend fixed to
 * the layout and fades both planes together.
 */
.hero-frame {
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 52%, transparent 96%);
  -webkit-mask-composite: source-in;
  mask-image: linear-gradient(to bottom, black 0%, black 52%, transparent 96%);
  mask-composite: intersect;
}

@media (min-width: 1024px) {
  .hero-frame {
    -webkit-mask-image:
      linear-gradient(to right, transparent 0%, black 16%, black 100%),
      linear-gradient(to bottom, black 0%, black 82%, transparent 100%);
    mask-image:
      linear-gradient(to right, transparent 0%, black 16%, black 100%),
      linear-gradient(to bottom, black 0%, black 82%, transparent 100%);
  }
}
</style>