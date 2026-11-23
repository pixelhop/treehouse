<script setup lang="ts">
/**
 * Scenes for the features bento — one per card.
 *
 * Not class-for-class lifts (a menubar dropdown, a comment thread, ciphertext
 * and two browser windows have no single app component to borrow at this
 * size), but drawn in the app's own palette (data-demo-theme) where they show
 * the app, so they sit in the cards the way the real fragments do. They are
 * deliberately expressive rather than framed: elements tilt, overlap, and
 * bleed off the card edge — the card's own overflow-hidden does the cropping.
 * Each card's copy carries the facts; nothing is drawn the product doesn't do.
 *
 * Non-interactive and out of the accessibility tree, like the window above.
 */
import IconLock from "~icons/solar/lock-keyhole-minimalistic-linear";
import IconRefresh from "~icons/solar/refresh-linear";
import IconFolder from "~icons/solar/folder-bold-duotone";
import IconImage from "~icons/solar/gallery-linear";
import { DEMO_THEMES } from "~/composables/useDemoWorkspace";
import { vReveal } from "~/composables/reveal";

defineProps<{ id: "sync" | "comments" | "encryption" | "portal" | "html" | "themes" }>();

// Themes scene only: which tile the pointer is over, reported up so the card
// around the scene can repaint itself in that theme's palette.
const hoverTheme = defineModel<string | null>("hoverTheme", { default: null });

// Fixed tilts, the format-chip trick from the index page: scattered on a desk
// rather than filed, and stable across renders. Keyed by theme id.
const THEME_TILTS: Record<string, number> = {
  treehouse: -3,
  light: 2,
  dark: -2,
  dracula: 4,
  nord: -4,
  "solarized-light": 3,
  "rose-pine": -2,
};

// The sync scene's ambient story: the second folder finishes syncing, rests,
// and starts again. Under reduced motion the loop never runs — the scene just
// shows the finished state.
const syncing = ref(true);
let syncLoop: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    syncing.value = false;
    return;
  }
  syncLoop = setInterval(() => (syncing.value = !syncing.value), 3600);
});
onBeforeUnmount(() => clearInterval(syncLoop));
</script>

<template>
  <div v-reveal aria-hidden="true" class="fd-root select-none">
    <!-- ============ Synced without thinking ============ -->
    <!-- The menubar dropdown, with a huge ghosted sync glyph bleeding off the
         card corner behind it — the one moving part on the whole grid. -->
    <template v-if="id === 'sync'">
      <div class="relative">
        <IconRefresh
          class="feature-spin-slow pointer-events-none absolute -bottom-14 -right-12 size-52 text-mist"
        />
        <div
          data-demo-theme="treehouse"
          class="relative overflow-hidden rounded-xl border border-th-border bg-th-surface text-th-fg shadow-md"
        >
          <div class="flex items-center gap-2 border-b border-th-border px-3.5 py-2.5">
            <span
              class="size-2 shrink-0 rounded-full transition-colors duration-500"
              :class="syncing ? 'bg-th-accent' : 'bg-th-human'"
            />
            <span class="text-sm font-semibold">Treehouse</span>
            <Transition name="fd-swap" mode="out-in">
              <span v-if="syncing" key="working" class="ml-auto text-xs text-th-fg-muted"
                >Syncing…</span
              >
              <span v-else key="done" class="ml-auto text-xs text-th-fg-muted">All synced</span>
            </Transition>
          </div>
          <div class="space-y-0.5 p-2">
            <div class="flex items-center gap-2.5 rounded-md px-2 py-2">
              <IconFolder class="size-4.5 shrink-0 text-th-fg-subtle" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">~/Treehouse/Phoenix</span>
              <svg viewBox="0 0 16 16" class="size-4 shrink-0 text-th-human" fill="none">
                <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6" />
                <path
                  d="m5 8.2 2 2 4-4.4"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="shrink-0 text-[11px] text-th-fg-muted">Just now</span>
            </div>
            <div class="flex items-center gap-2.5 rounded-md px-2 py-2">
              <IconFolder class="size-4.5 shrink-0 text-th-fg-subtle" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">~/Treehouse/Home</span>
              <Transition name="fd-swap" mode="out-in">
                <span v-if="syncing" key="working" class="flex shrink-0 items-center gap-2">
                  <IconRefresh class="feature-spin size-4 shrink-0 text-th-accent" />
                  <span class="text-[11px] text-th-fg-muted">2 files</span>
                </span>
                <span v-else key="done" class="flex shrink-0 items-center gap-2">
                  <svg viewBox="0 0 16 16" class="size-4 shrink-0 text-th-human" fill="none">
                    <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6" />
                    <path
                      d="m5 8.2 2 2 4-4.4"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  <span class="text-[11px] text-th-fg-muted">Just now</span>
                </span>
              </Transition>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ Comments agents can answer ============ -->
    <!-- A document being read, with the thread floating over it like a note
         pinned to the page — tilted, and cropped by the card's right edge. -->
    <template v-else-if="id === 'comments'">
      <div class="relative sm:pb-2">
        <div
          data-demo-theme="treehouse"
          class="rounded-xl border border-th-border bg-th-surface p-5 text-sm leading-relaxed text-th-fg-muted shadow-sm sm:p-6 sm:pr-80"
        >
          <p class="font-display text-lg font-semibold text-th-fg">Launch plan</p>
          <p class="mt-3">
            The pieces are finally in place — the beta build is stable and the onboarding flow holds
            up.
          </p>
          <p class="mt-3 text-th-fg">
            …so we'll
            <span class="fd-highlight rounded-sm px-1 py-0.5"
              >ship the beta to the first ten teams</span
            >
            in March, and open the waitlist the week after.
          </p>
          <p class="mt-3">Pricing follows once the first cohort has settled in.</p>
        </div>
        <div
          data-demo-theme="treehouse"
          class="fd-thread mt-4 rounded-xl border border-th-border bg-th-surface p-4 text-th-fg shadow-lg sm:absolute sm:-right-8 sm:top-6 sm:mt-0 sm:w-80 sm:-rotate-2"
        >
          <div class="space-y-3 text-sm">
            <div class="flex items-start gap-2.5">
              <span
                class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-th-human/15 text-[11px] font-bold text-th-human"
                >J</span
              >
              <p class="min-w-0 leading-snug">
                <span class="font-semibold">Jozef</span>
                <span class="text-th-fg-muted"> Ten feels low — check the waitlist?</span>
              </p>
            </div>
            <div class="flex items-start gap-2.5">
              <span
                class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-th-agent/15 text-[11px] font-bold text-th-agent"
                >S</span
              >
              <p class="min-w-0 leading-snug">
                <span class="font-semibold">Scout</span>
                <span
                  class="mx-1 rounded bg-th-agent/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-th-agent"
                  >agent</span
                >
                <span class="text-th-fg-muted">43 teams waiting — raised it in the draft.</span>
              </p>
            </div>
            <p
              class="flex items-center gap-2 border-t border-th-border pt-3 text-xs font-medium text-th-fg-muted"
            >
              <svg viewBox="0 0 16 16" class="size-4 shrink-0 text-th-human" fill="none">
                <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6" />
                <path
                  d="m5 8.2 2 2 4-4.4"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              Resolved by Scout
            </p>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ Encrypted at rest ============ -->
    <!-- Drawn for the dark card: a badge, then the workspace dissolving into
         ciphertext that fades out and runs off the card. -->
    <template v-else-if="id === 'encryption'">
      <div>
        <span
          class="inline-flex items-center gap-2 rounded-full bg-cream/10 px-3.5 py-1.5 text-xs font-bold text-cream ring-1 ring-cream/15"
        >
          <IconLock class="size-4" />
          AES-256-GCM
        </span>
        <div class="mt-6 space-y-1.5 font-mono text-xs leading-relaxed">
          <p class="whitespace-nowrap text-cream/90">Q3-strategy.md · v8 · 41 KB</p>
          <p class="fd-hex whitespace-nowrap text-cream/30">
            9f2b c41d 8ae0 77c3 51fa 0d92 be64 a8f1 3c07 d5b9 62e8 4afd
          </p>
          <p class="fd-hex whitespace-nowrap text-cream/25">
            62e8 4afd 1b30 aa17 40de 913c 7f5b cc28 e6a4 0b91 05c9 f83e
          </p>
          <p class="fd-hex whitespace-nowrap text-cream/20">
            05c9 f83e 2d47 b1a6 98f0 3e6c d24a 71b8 5c0f e992 8b3d 6f21
          </p>
          <p class="fd-hex whitespace-nowrap text-cream/15">
            8b3d 6f21 c4e7 0a95 d1f8 47bc 92e3 5a06 b7d4 1c8f 3a71 e05d
          </p>
          <p class="fd-hex whitespace-nowrap text-cream/10">
            3a71 e05d 94cb 28f6 61a9 d3e0 7b42 f815 c96d 2e58 71fa 0b44
          </p>
        </div>
      </div>
    </template>

    <!-- ============ Share a folder, get a portal ============ -->
    <!-- The client's view: a browser window carrying the workspace's own
         identity, cropped by the card's bottom edge. -->
    <template v-else-if="id === 'portal'">
      <div
        data-demo-theme="treehouse"
        class="overflow-hidden rounded-xl border border-th-border bg-th-surface text-th-fg shadow-lg"
      >
        <div class="flex items-center gap-2 border-b border-th-border bg-th-surface-2 px-3 py-2">
          <span class="flex shrink-0 gap-1.5">
            <span class="size-2 rounded-full bg-th-border" />
            <span class="size-2 rounded-full bg-th-border" />
            <span class="size-2 rounded-full bg-th-border" />
          </span>
          <span
            class="min-w-0 flex-1 truncate rounded-full bg-th-surface px-3 py-1 text-xs text-th-fg-muted"
            >trytree.house/s/hbR2qK9v</span
          >
        </div>
        <div class="flex">
          <div class="w-40 shrink-0 space-y-1 border-r border-th-border bg-th-surface-2 p-2.5">
            <div class="flex items-center gap-2 pb-1.5">
              <span
                class="grid size-6 shrink-0 place-items-center rounded-md bg-amber-600 text-xs leading-none"
                >☕️</span
              >
              <span class="min-w-0 truncate text-xs font-semibold">Harbour Coffee</span>
            </div>
            <p class="rounded-md bg-th-surface px-2 py-1.5 text-xs font-medium">Brand refresh</p>
            <p class="px-2 py-1 text-xs text-th-fg-muted">Menu photos</p>
            <p class="px-2 py-1 text-xs text-th-fg-muted">Launch plan</p>
            <p class="px-2 py-1 text-xs text-th-fg-muted">Contracts</p>
          </div>
          <div class="min-w-0 flex-1 space-y-2.5 p-4">
            <p class="font-display text-base font-semibold">Brand refresh</p>
            <div class="h-2 rounded-full bg-th-surface-2" />
            <div class="h-2 w-11/12 rounded-full bg-th-surface-2" />
            <div class="grid h-16 place-items-center rounded-lg bg-th-surface-2">
              <IconImage class="size-5 text-th-fg-subtle" />
            </div>
            <div class="h-2 w-4/5 rounded-full bg-th-surface-2" />
            <div class="h-2 rounded-full bg-th-surface-2" />
            <div class="h-2 w-2/3 rounded-full bg-th-surface-2" />
          </div>
        </div>
      </div>
    </template>

    <!-- ============ HTML that just serves ============ -->
    <!-- An uploaded report rendering as a real page, cropped mid-chart by the
         card's bottom edge. -->
    <template v-else-if="id === 'html'">
      <div
        data-demo-theme="treehouse"
        class="overflow-hidden rounded-xl border border-th-border bg-th-surface text-th-fg shadow-lg"
      >
        <div class="flex items-center gap-2 border-b border-th-border bg-th-surface-2 px-3 py-2">
          <span class="flex shrink-0 gap-1.5">
            <span class="size-2 rounded-full bg-th-border" />
            <span class="size-2 rounded-full bg-th-border" />
            <span class="size-2 rounded-full bg-th-border" />
          </span>
          <span
            class="min-w-0 flex-1 truncate rounded-full bg-th-surface px-3 py-1 text-xs text-th-fg-muted"
            >trytree.house/s/4Bq8Ld3n/report.html</span
          >
        </div>
        <div class="flex items-center justify-between border-b border-th-border px-4 py-2">
          <span class="text-xs font-bold">Q3 report</span>
          <span class="flex gap-3 text-[11px] text-th-fg-muted">
            <span>Summary</span>
            <span class="font-semibold text-th-accent">Numbers</span>
            <span>Next</span>
          </span>
        </div>
        <div class="space-y-3 p-4">
          <div class="grid grid-cols-3 gap-2">
            <div class="rounded-lg bg-th-surface-2 p-2.5">
              <p class="text-[10px] text-th-fg-muted">Revenue</p>
              <p class="text-sm font-bold text-th-accent">+38%</p>
            </div>
            <div class="rounded-lg bg-th-surface-2 p-2.5">
              <p class="text-[10px] text-th-fg-muted">Signups</p>
              <p class="text-sm font-bold">1,204</p>
            </div>
            <div class="rounded-lg bg-th-surface-2 p-2.5">
              <p class="text-[10px] text-th-fg-muted">Churn</p>
              <p class="text-sm font-bold">−0.8%</p>
            </div>
          </div>
          <div class="flex h-20 items-end gap-1.5">
            <span
              v-for="(h, i) in [18, 30, 22, 42, 34, 56, 46, 70]"
              :key="i"
              class="fd-bar flex-1 rounded-t"
              :class="i === 7 ? 'bg-th-accent' : 'bg-th-accent/25'"
              :style="{ height: `${h}px`, '--fd-delay': `${0.2 + i * 0.06}s` }"
            />
          </div>
        </div>
      </div>
    </template>

    <!-- ============ Your house, your colours ============ -->
    <!-- The seven real palettes as little app windows, scattered at the same
         fixed jaunty angles the format chips use. Hover straightens one. -->
    <template v-else>
      <div class="flex flex-wrap justify-center gap-3 py-2" @pointerleave="hoverTheme = null">
        <!-- The entrance lives on a wrapper so its stagger delay never slows
             the tile's own hover response. Pointerenter per tile, pointerleave
             on the container, so moving between tiles never flashes back to
             the card's resting palette. -->
        <div
          v-for="(t, i) in DEMO_THEMES"
          :key="t.id"
          class="fd-tile"
          :style="{ '--fd-delay': `${0.1 + i * 0.07}s` }"
          @pointerenter="hoverTheme = t.id"
        >
          <div
            :data-demo-theme="t.id"
            class="theme-tile w-24 rounded-lg border border-th-border bg-th-app p-1.5 shadow-sm"
            :style="{ '--tilt': `${THEME_TILTS[t.id] ?? 0}deg` }"
          >
            <div class="overflow-hidden rounded-md border border-th-border bg-th-surface">
              <div class="flex gap-1 border-b border-th-border px-1.5 py-1">
                <span class="size-1 rounded-full bg-th-border" />
                <span class="size-1 rounded-full bg-th-border" />
                <span class="size-1 rounded-full bg-th-border" />
              </div>
              <div class="space-y-1 p-1.5">
                <div class="flex items-center gap-1">
                  <span class="size-1.5 shrink-0 rounded-full bg-th-accent" />
                  <span class="h-1 w-full rounded-full bg-th-fg/60" />
                </div>
                <div class="h-1 w-3/4 rounded-full bg-th-fg-muted/50" />
                <div class="h-1 w-1/2 rounded-full bg-th-fg-muted/40" />
              </div>
            </div>
            <p class="mt-1 truncate text-center text-[9px] font-bold text-th-fg-muted">
              {{ t.label }}
            </p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * The folder mid-sync, and its giant ghosted echo behind the panel. Slow
 * enough to read as working rather than busy; gone under reduced motion.
 */
.feature-spin {
  animation: feature-spin 1.8s linear infinite;
}

.feature-spin-slow {
  animation: feature-spin 14s linear infinite;
}

@keyframes feature-spin {
  to {
    rotate: 360deg;
  }
}

/*
 * Theme tiles sit at fixed jaunty angles — scattered on a desk, same joke as
 * the format chips further up the page. Hovering one straightens and lifts it.
 */
.theme-tile {
  rotate: var(--tilt, 0deg);
  transition:
    rotate var(--duration-base) var(--ease-out-soft),
    translate var(--duration-base) var(--ease-out-soft),
    box-shadow var(--duration-base) var(--ease-out-soft);
}

.theme-tile:hover {
  rotate: 0deg;
  translate: 0 -3px;
  box-shadow: var(--shadow-md);
}

/*
 * Highlight sweep base state: the same 25% warning tint the static version
 * used, drawn as a gradient so its width can animate. Fully painted by
 * default — the swept-away state only exists when motion is welcome.
 */
.fd-highlight {
  background-image: linear-gradient(
    to right,
    color-mix(in srgb, var(--th-warning) 25%, transparent),
    color-mix(in srgb, var(--th-warning) 25%, transparent)
  );
  background-repeat: no-repeat;
  background-size: 100% 100%;
}

/* State swap in the sync scene: syncing ⇄ synced crossfade. */
.fd-swap-enter-active,
.fd-swap-leave-active {
  transition: opacity var(--duration-base) var(--ease-out-soft);
}

.fd-swap-enter-from,
.fd-swap-leave-to {
  opacity: 0;
}

/*
 * Scroll-in choreography, one-shot per scene (v-reveal). Every hidden initial
 * state sits inside this media query, so reduced-motion visitors and any
 * environment where the observer never fires see the finished scene
 * immediately. The sequence on the comments card is the section's hero
 * moment: the sentence highlights itself, then the thread settles onto the
 * page with its tilt.
 */
@media (prefers-reduced-motion: no-preference) {
  .fd-highlight {
    transition: background-size 0.7s var(--ease-out-soft) 0.35s;
  }

  .fd-root:not([data-revealed]) .fd-highlight {
    background-size: 0% 100%;
  }

  .fd-thread {
    transition:
      opacity 0.5s var(--ease-out-soft) 0.9s,
      translate 0.5s var(--ease-out-soft) 0.9s,
      rotate 0.5s var(--ease-out-soft) 0.9s;
  }

  .fd-root:not([data-revealed]) .fd-thread {
    opacity: 0;
    translate: 18px 14px;
    rotate: 0deg;
  }

  /* Report bars grow from the baseline, left to right. */
  .fd-bar {
    transform-origin: bottom;
    transition: scale 0.55s var(--ease-out-soft) var(--fd-delay, 0s);
  }

  .fd-root:not([data-revealed]) .fd-bar {
    scale: 1 0;
  }

  /* Theme tiles land on the desk one after another. */
  .fd-tile {
    transition:
      opacity 0.5s var(--ease-out-soft) var(--fd-delay, 0s),
      translate 0.5s var(--ease-out-soft) var(--fd-delay, 0s);
  }

  .fd-root:not([data-revealed]) .fd-tile {
    opacity: 0;
    translate: 0 12px;
  }

  /*
   * The ciphertext drifts, barely — a stream at rest. Different periods per
   * row so the block never moves as one.
   */
  .fd-hex {
    animation: fd-drift 26s var(--ease-in-out-soft) infinite alternate;
  }

  .fd-hex:nth-child(3) {
    animation-duration: 34s;
    animation-delay: -9s;
  }

  .fd-hex:nth-child(4) {
    animation-duration: 22s;
    animation-delay: -15s;
  }

  .fd-hex:nth-child(5) {
    animation-duration: 30s;
    animation-delay: -4s;
  }

  .fd-hex:nth-child(6) {
    animation-duration: 38s;
    animation-delay: -20s;
  }
}

@keyframes fd-drift {
  to {
    translate: -2.5rem 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .feature-spin,
  .feature-spin-slow {
    animation: none;
  }

  .theme-tile:hover {
    translate: none;
    rotate: var(--tilt, 0deg);
  }

  .fd-swap-enter-active,
  .fd-swap-leave-active {
    transition: none;
  }
}
</style>