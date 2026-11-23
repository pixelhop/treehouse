<script setup lang="ts">
// Flat, ranked search results — what the sidebar shows instead of the tree while
// a query is active.
//
// Deliberately not a pruned tree. Pruning made a folder-name match unfurl its
// entire subtree, so a one- or two-character query mounted most of the workspace
// and unmounted it again on the next keystroke. A flat list is bounded by the
// result cap regardless of query, and it is the only shape where "best match"
// means anything — a tree has nowhere to put ranking.
import type { SearchResult } from "shared";

const props = defineProps<{
  results: SearchResult[];
  /** Index of the keyboard cursor. */
  activeIndex: number;
  /** The file that was already open before the search started, if any. */
  openPath: string | null;
  /** Path -> custom icon, for the rows that have one. */
  icons: Record<string, string>;
  /** Total matches before the result cap, so truncation can be reported. */
  totalMatches: number;
}>();

// The click rides along so a ⌘/Ctrl- or middle click can open a tab instead.
defineEmits<{ select: [node: { path: string; isDir: boolean }, e?: MouseEvent] }>();

// Warm the file under the pointer, and the one the keyboard cursor rests on —
// which is the top hit as you type, the one Enter opens. Both go through the
// hover-intent delay, so arrowing quickly through the list fetches nothing until
// it stops. A no-op on a public share (see usePrefetchFile).
const prefetch = usePrefetchFile();
watch(
  () => props.results[props.activeIndex]?.path,
  (path) => {
    if (path) prefetch.hover(path);
  },
  { immediate: true },
);

/** The parent folder of a path, shown dimmed so same-named files are distinguishable. */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Split a string into matched/unmatched runs for highlighting.
 *
 * Returns segments rather than markup on purpose: filenames are supplied by
 * anyone with write access — teammates, agents, a synced folder — so building an
 * HTML string and binding it with `v-html` would be stored XSS. The repo states
 * this convention in FrontMatterFields.vue and FrontMatterList.vue, and there is
 * an eslint `vue/no-v-html` rule. Segments bind as text nodes.
 */
function segments(text: string, positions: number[]): { text: string; hit: boolean }[] {
  const hits = new Set(positions.filter((i) => i >= 0 && i < text.length));
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i] as string, hit });
  }
  return out;
}

/**
 * Which string carries the highlight. When `matchedPath` is true the basename did
 * not match at all — the matched characters live in the path — so highlighting
 * the name would leave the row with nothing marked, which is exactly the case
 * where "why did this match?" is least obvious.
 */
function nameSegments(r: SearchResult) {
  return r.matchedPath ? [{ text: r.name, hit: false }] : segments(r.name, r.positions);
}
function pathSegments(r: SearchResult) {
  const parent = parentOf(r.path);
  if (!r.matchedPath) return [{ text: parent, hit: false }];
  // positions index the full path; the parent is its leading slice.
  return segments(parent, r.positions);
}

const rowId = (i: number) => `th-search-result-${i}`;
</script>

<template>
  <div>
    <ul id="th-search-listbox" role="listbox" aria-label="Search results" class="space-y-0.5">
      <li
        v-for="(r, i) in props.results"
        :id="rowId(i)"
        :key="r.path"
        role="option"
        :aria-selected="i === props.activeIndex"
      >
        <button
          type="button"
          class="group flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition"
          :class="[
            i === props.activeIndex ? 'bg-surface-2' : 'hover:bg-surface-2',
            r.path === props.openPath ? 'text-accent' : 'text-fg',
          ]"
          @click="$emit('select', { path: r.path, isDir: r.isDir }, $event)"
          @pointerenter="prefetch.hover(r.path)"
          @pointerleave="prefetch.leave(r.path)"
          @auxclick="
            $event.button === 1 && $emit('select', { path: r.path, isDir: r.isDir }, $event)
          "
        >
          <NodeIcon
            :icon="props.icons[r.path] ?? null"
            :is-dir="r.isDir"
            class="h-4 w-4 shrink-0 text-fg-subtle"
          />
          <!-- ph-mask: every result row is a user-authored file name plus its
               parent path, and the highlighted segments spell out the query
               too. Masking the whole label keeps the result COUNT and the
               hit/miss styling visible in a replay while the names stay
               unreadable. See app/plugins/posthog.client.ts. -->
          <span class="ph-mask min-w-0 flex-1 truncate text-sm">
            <span :class="r.path === props.openPath ? 'font-medium' : ''">
              <span
                v-for="(seg, si) in nameSegments(r)"
                :key="si"
                :class="seg.hit ? 'text-accent' : ''"
                >{{ seg.text }}</span
              >
            </span>
            <!-- Truncates at the end. `dir="rtl"` would put the ellipsis at the
                 start (arguably better, since the segment nearest the filename
                 carries the most meaning) but it renders LTR text in an RTL
                 context and reorders punctuation, so it is not worth the bug. -->
            <span v-if="parentOf(r.path)" class="ml-1.5 truncate text-xs text-fg-subtle">
              <span
                v-for="(seg, si) in pathSegments(r)"
                :key="si"
                :class="seg.hit ? 'text-accent' : ''"
                >{{ seg.text }}</span
              >
            </span>
          </span>
        </button>
      </li>
    </ul>

    <!-- Ranked search caps its results, so without this the user cannot tell 50
         of 400 from 50 of 50. There is no paging: narrowing the query is the
         intended escape, so say so. -->
    <p v-if="props.totalMatches > props.results.length" class="px-1 pt-2 text-xs text-fg-subtle">
      Showing {{ props.results.length }} of {{ props.totalMatches }} — narrow your search.
    </p>
  </div>
</template>