<script setup lang="ts">
// "Changes since you last looked" (R12), as track changes — never a source diff
// (KD6). The merge is markdown, so it goes through the SAME MarkdownViewer (and
// the same sanitizer) as the clean view: a heading still renders as a heading,
// an untouched bold word is still bold, and the only thing marked is words.
//
// Read-only by design: threads already on this file are pinned to the text they
// discuss, on whichever side of the change that text now lives, but nothing here
// starts a new comment — you comment on the document, not on a diff.
import IconBack from "~icons/solar/arrow-left-linear";
import { useComments, useCommentUi } from "~/composables/useComments";
import {
  buildTextIndex,
  type DomTextIndex,
  locatePoint,
  locateQuote,
} from "~/utils/commentHighlights";
import { buildTrackChanges } from "~/utils/trackChanges";

const props = defineProps<{
  workspaceId: string;
  path: string;
  /** The bytes the reader last saw. */
  base: string;
  /** The bytes on screen in the clean view. */
  current: string;
  /** Version labels for the header — display only, never the pin. */
  baseVersion: number | null;
  currentVersion: number | null;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const ui = useCommentUi();
const workspaceId = computed<string | undefined>(() => props.workspaceId);
const path = computed<string | undefined>(() => props.path);
const comments = useComments(workspaceId, path);

const changes = computed(() => buildTrackChanges(props.base, props.current));

// --- Comment overlay --------------------------------------------------------
// Same matcher as the reading view (U5): find the thread's text, don't trust an
// offset. The merged document holds both sides, so a thread whose words were
// rewritten pins to the deletion — which is exactly the text it was written on.

const host = ref<HTMLElement | null>(null);
const painted = new Map<string, { start: number; end: number }>();
const pointMarkers = ref<{ id: string; top: number }[]>([]);

const HL = "th-tc-comment";
const HL_ACTIVE = "th-tc-comment-active";

type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => unknown;
function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistry };
    Highlight?: HighlightCtor;
  };
  if (!g.CSS?.highlights || !g.Highlight) return null;
  return { registry: g.CSS.highlights, Highlight: g.Highlight };
}
function clearHighlights() {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete(HL);
  api.registry.delete(HL_ACTIVE);
}

function rangeFor(index: DomTextIndex, span: { start: number; end: number }): Range | null {
  if (span.end <= span.start || span.end > index.nodes.length) return null;
  const range = document.createRange();
  range.setStart(index.nodes[span.start]!, index.offsets[span.start]!);
  range.setEnd(index.nodes[span.end - 1]!, index.ends[span.end - 1]!);
  return range;
}

function repaint() {
  const root = host.value?.querySelector("article.prose") as HTMLElement | null;
  painted.clear();
  if (!root) {
    clearHighlights();
    pointMarkers.value = [];
    return;
  }
  const index = buildTextIndex(root);
  const hostRect = host.value!.getBoundingClientRect();
  const normal: Range[] = [];
  const active: Range[] = [];
  const points: { id: string; top: number }[] = [];

  for (const t of comments.threads.value) {
    if (t.status === "resolved") continue;
    if (t.anchorKind === "point") {
      const at = locatePoint(index, t);
      if (at === null || at >= index.nodes.length) continue;
      const caret = document.createRange();
      caret.setStart(index.nodes[at]!, index.offsets[at]!);
      caret.setEnd(index.nodes[at]!, index.ends[at]!);
      points.push({ id: t.id, top: caret.getBoundingClientRect().top - hostRect.top });
      continue;
    }
    // Current text first (it's still there when the thread survived the edit),
    // then the original — which is what a rewritten thread pins to.
    const span =
      (t.currentText
        ? locateQuote(index, {
            quote: t.currentText,
            contextBefore: t.contextBefore,
            contextAfter: t.contextAfter,
          })
        : null) ??
      locateQuote(index, {
        quote: t.quote,
        contextBefore: t.contextBefore,
        contextAfter: t.contextAfter,
      });
    if (!span) continue;
    const range = rangeFor(index, span);
    if (!range) continue;
    painted.set(t.id, span);
    (t.id === ui.activeThreadId.value ? active : normal).push(range);
  }

  const api = highlightApi();
  if (api) {
    if (normal.length) api.registry.set(HL, new api.Highlight(...normal));
    else api.registry.delete(HL);
    if (active.length) api.registry.set(HL_ACTIVE, new api.Highlight(...active));
    else api.registry.delete(HL_ACTIVE);
  }
  pointMarkers.value = points;
}

const schedule = () => void nextTick(repaint);
watch([changes, comments.threads, ui.activeThreadId], schedule, { immediate: true });
onMounted(() => {
  schedule();
  window.addEventListener("resize", schedule);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", schedule);
  clearHighlights();
});

function onClick(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest("a")) return;
  const el = (e.target as HTMLElement | null)?.closest("ins, del");
  if (!el) return;
  // A marked run is the most likely thing a reader clicks; open the thread
  // sitting on it, if there is one.
  const text = el.textContent ?? "";
  for (const t of comments.threads.value) {
    if (!painted.has(t.id)) continue;
    if (text && (t.currentText ?? t.quote).includes(text.trim())) {
      ui.focusThread(t.id);
      return;
    }
  }
}
</script>

<template>
  <div class="flex h-full flex-col gap-4">
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-surface-2/40 px-3 py-2 text-sm"
    >
      <span class="font-medium text-fg">Changes since you last looked</span>
      <span v-if="baseVersion != null && currentVersion != null" class="text-xs text-fg-subtle">
        v{{ baseVersion }} → v{{ currentVersion }}
      </span>
      <template v-if="changes.status === 'changed'">
        <span class="flex items-center gap-1.5 text-xs text-fg-muted">
          <span class="th-legend th-ins">added</span>
          <span class="th-legend th-del">removed</span>
        </span>
      </template>
      <button
        type="button"
        class="ml-auto flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted transition hover:bg-surface-2 hover:text-fg"
        @click="emit('close')"
      >
        <IconBack class="h-3.5 w-3.5" />
        Back to the document
      </button>
    </div>

    <p v-if="changes.status === 'no_visible_changes'" class="text-sm text-fg-subtle">
      The file was saved again, but nothing you would read changed — only formatting or metadata
      moved.
    </p>

    <div v-else ref="host" class="relative" @click="onClick">
      <MarkdownViewer
        :source="changes.markdown"
        mode="rendered"
        :workspace-id="workspaceId"
        :path="path"
      />
      <div data-comment-ignore class="pointer-events-none absolute inset-0">
        <button
          v-for="m in pointMarkers"
          :key="`p${m.id}`"
          type="button"
          class="pointer-events-auto absolute -left-7 flex h-5 w-5 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-accent transition hover:bg-accent/30"
          :style="{ top: `${m.top}px` }"
          title="Open this comment"
          aria-label="Open this comment"
          @click.stop="ui.focusThread(m.id)"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-accent" />
        </button>
      </div>
    </div>
  </div>
</template>

<style>
/* Track-changes marks. Deliberately NOT a diff palette (no full-width green and
   red rows): a word that was added is tinted, a word that went is struck
   through, and everything else looks exactly like the document it is. */
.prose ins.th-ins,
.th-legend.th-ins {
  background-color: color-mix(in srgb, var(--th-success) 20%, transparent);
  color: inherit;
  text-decoration: none;
  border-radius: 0.2rem;
  padding: 0 0.15em;
}
.prose del.th-del,
.th-legend.th-del {
  background-color: color-mix(in srgb, var(--th-danger) 12%, transparent);
  color: var(--th-fg-muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--th-danger) 70%, transparent);
  border-radius: 0.2rem;
  padding: 0 0.15em;
}
.th-legend {
  font-size: 0.6875rem;
}
/* A whole code block that came or went — the only block that can't carry
   inline marks, so it says so with an edge instead. */
.prose pre.th-ins-block {
  border-left: 3px solid color-mix(in srgb, var(--th-success) 70%, transparent);
}
.prose pre.th-del-block {
  border-left: 3px solid color-mix(in srgb, var(--th-danger) 70%, transparent);
  opacity: 0.7;
}
::highlight(th-tc-comment) {
  background-color: color-mix(in srgb, var(--th-accent) 16%, transparent);
}
::highlight(th-tc-comment-active) {
  background-color: color-mix(in srgb, var(--th-accent) 34%, transparent);
}
</style>