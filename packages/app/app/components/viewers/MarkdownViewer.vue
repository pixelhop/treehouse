<script setup lang="ts">
import DOMPurify from "dompurify";
import { splitFrontMatter } from "~/utils/frontmatter";
import { parseFrontMatter } from "~/utils/frontmatterData";
import {
  internalLinkTarget,
  type RefRewriteContext,
  rewriteMarkdownRefs,
} from "~/utils/markdownRefs";
import { openIntent } from "~/utils/tabs";
import { markdownRenderer } from "~/utils/wikilinks";

// `refs` enables relative-reference resolution (images → raw-bytes URLs, links
// → the page that displays the target file). Optional so the component still
// works standalone; without it references render as-authored.
const props = defineProps<{
  source: string;
  mode: "rendered" | "source";
  refs?: RefRewriteContext | null;
}>();

// Fires once the rendered document is in the DOM, and again whenever it
// re-renders. A caller that decorates the output (highlighting a passage, say)
// waits for this rather than a tick: when the viewer is loaded lazily, a tick
// after setting `source` can land before the viewer exists.
const emit = defineEmits<{ rendered: [] }>();
onMounted(() => emit("rendered"));
onUpdated(() => emit("rendered"));

// Peel the front-matter block off before rendering. Markdown has no concept of
// front matter, so feeding it to marked turns the leading `---` block into a
// thematic break + setext heading (garbled). We render the parsed block as a
// card instead, and only the body goes through marked.
const split = computed(() => splitFrontMatter(props.source));
const frontMatter = computed(() =>
  split.value.frontMatter ? parseFrontMatter(split.value.frontMatter) : null,
);
// A block that is present but unparseable: peel it anyway (never dump raw YAML
// into the body) and surface a hint to use source mode.
const unparsed = computed(() => split.value.frontMatter !== "" && frontMatter.value === null);

// Sanitize rendered markdown — an agent (subject to prompt injection) or a
// compromised account could write malicious HTML/JS into a file, so never feed
// raw marked output to v-html. DOMPurify is kept ≥3.4.x (CVE-2026-0540).
// Only the body goes through marked (front matter is peeled above). Reference
// rewriting runs strictly AFTER sanitization (it only swaps resolved src/href
// values, so it can't reintroduce anything the sanitizer stripped).
const rendered = computed(() => {
  if (props.mode !== "rendered" || !split.value.body) return "";
  const safe = DOMPurify.sanitize(markdownRenderer.parse(split.value.body) as string);
  return props.refs ? rewriteMarkdownRefs(safe, props.refs) : safe;
});

// Plain left-clicks on internal links navigate in-app; modified/middle clicks
// and external/fragment links keep native behavior (hrefs are real URLs) —
// except that with tabs on, a ⌘/Ctrl- or middle click on a workspace link
// opens it in a tab rather than a browser tab.
const tabs = useWorkspaceTabs();
function openInTab(e: MouseEvent): boolean {
  if (e.defaultPrevented) return false;
  const intent = openIntent(e);
  if (intent === "here") return false;
  const href = (e.target as Element | null)?.closest?.("a[href]")?.getAttribute("href") ?? "";
  if (!href.startsWith("/w/") || !tabs.openHref(href, intent)) return false;
  e.preventDefault();
  return true;
}
function onAuxClick(e: MouseEvent) {
  if (e.button === 1) openInTab(e);
}

function onClick(e: MouseEvent) {
  if (openInTab(e)) return;
  const target = internalLinkTarget(e);
  if (!target) return;
  e.preventDefault();
  void navigateTo(target);
}
</script>

<template>
  <div v-if="mode === 'rendered'">
    <FrontMatterCard v-if="frontMatter" :data="frontMatter" />
    <p
      v-else-if="unparsed"
      class="mb-6 rounded-lg border border-border bg-surface-2/50 px-4 py-3 text-sm text-fg-subtle"
    >
      Front matter couldn't be parsed — switch to source view to see it.
    </p>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <article class="prose max-w-none" @click="onClick" @auxclick="onAuxClick" v-html="rendered" />
  </div>
  <pre
    v-else
    class="flex-1 overflow-auto rounded-lg border border-border bg-app p-4 text-sm text-fg"
  ><code>{{ source }}</code></pre>
</template>

<style scoped>
/* Rendered markdown arrives via v-html, which scoped styles only reach through
   :deep. A wikilink that names no file is inert, so it reads as a muted,
   non-interactive placeholder rather than a broken link. */
.prose :deep(a.wikilink-unresolved) {
  color: var(--th-fg-subtle);
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--th-fg-subtle) 60%, transparent);
  cursor: default;
}
</style>