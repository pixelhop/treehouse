<script setup lang="ts">
// "Copy page" menu for docs pages. Surfaces the page's `.md` twin five ways:
// copy the markdown, copy an agent-fetchable link, view the markdown, or open
// the page in ChatGPT / Claude. The markdown is fetched on click rather than
// inlined, so the prerendered HTML stays lean.
import IconCopy from "~icons/solar/copy-linear";
import IconChevron from "~icons/solar/alt-arrow-down-linear";
import { aiDeepLink, docMarkdownPath } from "~/utils/docs";

const route = useRoute();

const { open, root, trigger, close, onKeydown } = useDismissible();

// Real browser origin, resolved after mount so prerendering doesn't bake in the
// build-time origin. The menu only opens post-mount, so links are always ready.
const origin = ref("");
onMounted(() => {
  origin.value = window.location.origin;
});

const mdPath = computed(() => docMarkdownPath(route.path));
const mdAbsolute = computed(() => (origin.value ? `${origin.value}${mdPath.value}` : mdPath.value));
const chatgptUrl = computed(() => aiDeepLink("chatgpt", mdAbsolute.value));
const claudeUrl = computed(() => aiDeepLink("claude", mdAbsolute.value));

// One short-lived label per copy action: "Copied!" or "Couldn't copy".
type Flash = "copied" | "failed" | null;
const mdFlash = ref<Flash>(null);
const linkFlash = ref<Flash>(null);
const timers = new Map<typeof mdFlash, ReturnType<typeof setTimeout>>();
function flash(target: typeof mdFlash, value: Flash) {
  target.value = value;
  clearTimeout(timers.get(target));
  timers.set(
    target,
    setTimeout(() => (target.value = null), 2000),
  );
}
onBeforeUnmount(() => timers.forEach(clearTimeout));

async function copyMarkdown() {
  try {
    const res = await fetch(mdPath.value);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await navigator.clipboard.writeText(await res.text());
    flash(mdFlash, "copied");
  } catch {
    flash(mdFlash, "failed");
  }
}

async function copyAgentLink() {
  try {
    await navigator.clipboard.writeText(mdAbsolute.value);
    flash(linkFlash, "copied");
  } catch {
    flash(linkFlash, "failed");
  }
}

function label(state: Flash, idle: string) {
  if (state === "copied") return "Copied!";
  if (state === "failed") return "Couldn't copy";
  return idle;
}

const itemClass =
  "flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm text-fg-muted transition-colors hover:bg-mist hover:text-fg";
</script>

<template>
  <div ref="root" class="relative" @keydown="onKeydown">
    <button
      ref="trigger"
      type="button"
      class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm font-semibold text-fg-muted transition-colors hover:border-sage hover:text-fg"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <IconCopy aria-hidden="true" class="size-4" />
      Copy page
      <IconChevron
        aria-hidden="true"
        :class="['size-3.5 transition-transform', open ? 'rotate-180' : '']"
      />
    </button>

    <div
      v-if="open"
      role="menu"
      class="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-surface py-1.5 shadow-lg"
    >
      <button type="button" role="menuitem" :class="itemClass" @click="copyMarkdown">
        <span>{{ label(mdFlash, "Copy as Markdown") }}</span>
        <span class="font-mono text-xs text-fg-subtle">.md</span>
      </button>
      <button type="button" role="menuitem" :class="itemClass" @click="copyAgentLink">
        <span>{{ label(linkFlash, "Copy link for agents") }}</span>
        <span class="font-mono text-xs text-fg-subtle">URL</span>
      </button>
      <a
        :href="mdPath"
        target="_blank"
        rel="noopener"
        role="menuitem"
        :class="itemClass"
        @click="close"
      >
        View as Markdown
      </a>
      <div class="my-1.5 border-t border-border" />
      <a
        :href="claudeUrl"
        target="_blank"
        rel="noopener"
        role="menuitem"
        :class="itemClass"
        @click="close"
      >
        Open in Claude
      </a>
      <a
        :href="chatgptUrl"
        target="_blank"
        rel="noopener"
        role="menuitem"
        :class="itemClass"
        @click="close"
      >
        Open in ChatGPT
      </a>
    </div>
  </div>
</template>