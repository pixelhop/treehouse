<script setup lang="ts">
import "highlight.js/styles/github.css";
import { codeLanguage } from "~/utils/codeLanguage";
import hljs from "~/utils/hljs";
import { formatMinifiedJson } from "~/utils/jsonFormat";

const props = defineProps<{ source: string; path: string; contentType: string }>();

const language = computed(() => codeLanguage(props.path, props.contentType));

// Minified JSON (an API dump, an agent's export) is one enormous line. Lay it
// out for reading; the file itself is untouched, and the editor shows it as is.
const shown = computed(
  () => (language.value === "json" && formatMinifiedJson(props.source)) || props.source,
);

// When a language is known, hljs returns escaped, highlighted HTML (safe for
// v-html). Otherwise we fall back to plain text interpolation in the template.
const highlighted = computed(() => {
  if (!language.value || !shown.value) return null;
  try {
    return hljs.highlight(shown.value, { language: language.value }).value;
  } catch {
    return null;
  }
});
</script>

<template>
  <!-- Long lines wrap rather than scroll sideways, keeping their indentation;
       `anywhere` also breaks an unbroken token such as a URL or a hash. -->
  <pre
    class="hljs flex-1 overflow-auto rounded-lg border border-border p-4 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
  ><!-- eslint-disable-next-line vue/no-v-html --><code v-if="highlighted" v-html="highlighted" /><code v-else>{{ shown }}</code></pre>
</template>