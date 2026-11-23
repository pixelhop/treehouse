<script lang="ts" setup>
// Fenced code blocks in docs pages: the brand code panel from the homepage
// (CodeBlock.vue), with an optional filename label and a copy button. The
// markdown twin keeps plain fences, so nothing here needs a twin case.
import IconCopy from "~icons/solar/copy-linear";
import IconCheck from "~icons/solar/check-circle-linear";

const props = defineProps<{
  code?: string;
  language?: string | null;
  filename?: string | null;
  highlights?: number[];
  meta?: string | null;
  class?: string | null;
}>();

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try {
    await navigator.clipboard.writeText(props.code ?? "");
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard unavailable (insecure context); nothing sensible to do.
  }
}
onBeforeUnmount(() => clearTimeout(timer));

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "terminal",
  sh: "terminal",
  shell: "terminal",
  json: "json",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  http: "http",
  text: "text",
};
const label = computed(
  () =>
    props.filename || (props.language ? (LANGUAGE_LABELS[props.language] ?? props.language) : ""),
);
</script>

<template>
  <div class="code-block not-prose group relative my-6 overflow-hidden rounded-xl bg-charcoal">
    <div class="flex items-center gap-2 border-b border-cream/10 px-4 py-2">
      <span class="size-1.5 rounded-full bg-sage/50" aria-hidden="true" />
      <span class="text-[11px] font-bold uppercase tracking-[0.14em] text-cream/60">{{
        label || "code"
      }}</span>
      <button
        type="button"
        class="ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold text-cream/60 transition-colors hover:bg-cream/10 hover:text-cream"
        :aria-label="copied ? 'Copied' : 'Copy code'"
        @click="copy"
      >
        <component :is="copied ? IconCheck : IconCopy" aria-hidden="true" class="size-3.5" />
        {{ copied ? "Copied" : "Copy" }}
      </button>
    </div>
    <pre :class="['docs-pre', props.class]"><slot /></pre>
  </div>
</template>