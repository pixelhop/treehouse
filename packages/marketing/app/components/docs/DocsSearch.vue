<script lang="ts" setup>
// Cmd/Ctrl+K search palette over the build-time docs index (see
// useDocsSearch). Results deep-link to the matching section of a page.
import IconSearch from "~icons/solar/magnifer-linear";
import type { DocsSearchResult } from "~/utils/docs-search";

const { query, results, loading, open } = useDocsSearch();

const isOpen = ref(false);
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const opener = ref<HTMLElement | null>(null);

// ⌘ on Apple platforms, Ctrl elsewhere. Resolved on mount (navigator is
// client-only).
const modifierKey = ref("");
onMounted(() => {
  modifierKey.value = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform) ? "⌘" : "Ctrl ";
});

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openPalette();
  } else if (e.key === "Escape" && isOpen.value) {
    close();
  }
}
onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKeydown));

function openPalette() {
  opener.value = document.activeElement as HTMLElement | null;
  isOpen.value = true;
}

function close() {
  isOpen.value = false;
  opener.value?.focus?.();
}

// Lazily fetch the index the moment the palette opens, and focus the input.
watch(isOpen, async (value) => {
  if (!value) return;
  query.value = "";
  await nextTick();
  inputEl.value?.focus();
  await open();
});

// A fresh query always restarts selection at the top result.
watch(query, () => {
  activeIndex.value = 0;
});

function move(delta: number) {
  const count = decorated.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
}

async function select(url: string | undefined) {
  if (!url) return;
  isOpen.value = false;
  await navigateTo(url);
}

interface Segment {
  text: string;
  match: boolean;
}

// Split a string into matched / unmatched runs from Fuse's inclusive
// [start, end] `indices`, so matched substrings can be emphasised.
function highlight(text: string, indices: readonly [number, number][]): Segment[] {
  if (!indices?.length) return [{ text, match: false }];
  const sorted = [...indices].sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end < cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) segments.push({ text: text.slice(cursor, from), match: false });
    segments.push({ text: text.slice(from, end + 1), match: true });
    cursor = end + 1;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

function decorate(result: DocsSearchResult) {
  const indicesFor = (key: string) => result.matches?.find((m) => m.key === key)?.indices ?? [];
  return {
    url: result.item.url,
    titles: result.item.titles,
    titleSegments: highlight(result.item.title, indicesFor("title")),
    contentSegments: result.item.content
      ? highlight(result.item.content, indicesFor("content"))
      : [],
  };
}

const decorated = computed(() => results.value.map(decorate));
</script>

<template>
  <div>
    <button
      type="button"
      class="group flex size-10 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-mist hover:text-fg md:h-auto md:w-60 md:justify-start md:gap-2 md:border md:border-border md:bg-surface md:py-2 md:pl-3.5 md:pr-3 md:text-sm md:hover:border-sage md:hover:bg-surface"
      aria-label="Search docs"
      @click="openPalette"
    >
      <IconSearch aria-hidden="true" class="size-[1.125rem] flex-none" />
      <span class="hidden md:inline">Search docs</span>
      <kbd v-if="modifierKey" class="ml-auto hidden font-sans text-xs text-fg-subtle md:block"
        >{{ modifierKey }}K</kbd
      >
    </button>

    <Teleport to="body">
      <div v-if="isOpen" class="fixed inset-0 z-50">
        <div class="absolute inset-0 bg-charcoal/40 backdrop-blur-sm" @click="close" />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search documentation"
          class="absolute left-1/2 top-[12vh] w-[92vw] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
        >
          <div class="flex items-center gap-3 border-b border-border px-4">
            <IconSearch aria-hidden="true" class="size-5 flex-none text-fg-subtle" />
            <input
              ref="inputEl"
              v-model="query"
              type="text"
              placeholder="Search the docs"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search the docs"
              class="w-full bg-transparent py-4 text-[0.9375rem] text-fg outline-none placeholder:text-fg-subtle"
              @keydown.down.prevent="move(1)"
              @keydown.up.prevent="move(-1)"
              @keydown.enter.prevent="select(decorated[activeIndex]?.url)"
            />
            <kbd
              class="rounded-md border border-border px-1.5 py-0.5 font-sans text-[11px] text-fg-subtle"
              >Esc</kbd
            >
          </div>

          <div class="max-h-[60vh] overflow-y-auto">
            <p v-if="loading" class="px-4 py-8 text-center text-sm text-fg-muted">
              Loading the search index…
            </p>
            <p v-else-if="!query.trim()" class="px-4 py-8 text-center text-sm text-fg-muted">
              Search for a task, a feature or a question.
            </p>
            <p
              v-else-if="decorated.length === 0"
              class="px-4 py-8 text-center text-sm text-fg-muted"
            >
              Nothing matches “{{ query }}”.
            </p>
            <ul v-else role="listbox" aria-label="Results" class="py-2">
              <li
                v-for="(result, index) in decorated"
                :key="result.url"
                role="option"
                :aria-selected="index === activeIndex"
              >
                <a
                  :href="result.url"
                  :class="[
                    'block px-4 py-3',
                    index === activeIndex ? 'bg-mist' : 'hover:bg-mist/50',
                  ]"
                  @click.prevent="select(result.url)"
                  @mousemove="activeIndex = index"
                >
                  <span class="block text-sm font-semibold text-fg">
                    <template v-for="(seg, i) in result.titleSegments" :key="i">
                      <mark v-if="seg.match" class="bg-transparent text-primary">{{
                        seg.text
                      }}</mark
                      ><template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span v-if="result.titles.length" class="mt-0.5 block text-xs text-fg-subtle">
                    {{ result.titles.join(" › ") }}
                  </span>
                  <span
                    v-if="result.contentSegments.length"
                    class="mt-1 block truncate text-xs text-fg-muted"
                  >
                    <template v-for="(seg, i) in result.contentSegments" :key="i">
                      <mark v-if="seg.match" class="bg-transparent font-semibold text-fg">{{
                        seg.text
                      }}</mark
                      ><template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>