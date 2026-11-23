<script setup lang="ts">
// The comment overlay for the reading view. It WRAPS MarkdownViewer rather than
// extending it: the share/portal pages render that same viewer, and comments are
// for workspace members only (KD7). Keeping every comment import on this side of
// the boundary makes portal safety structural — there is no prop to get wrong.
import { useQueryClient } from "@tanstack/vue-query";
import IconComment from "~icons/solar/chat-round-line-linear";
import IconPoint from "~icons/solar/add-circle-linear";
import type { RefRewriteContext } from "~/utils/markdownRefs";
import { opDisplay } from "~/utils/changeOps";
import { useComments, useCommentUi } from "~/composables/useComments";
import {
  blockStartOffset,
  buildTextIndex,
  capturePoint,
  captureRange,
  type DomTextIndex,
  indexOffsetAt,
  locatePoint,
  locateQuote,
  resolveSpan,
  spanForSelection,
  type TextSpan,
} from "~/utils/commentHighlights";

const props = defineProps<{
  workspaceId: string;
  path: string;
  source: string;
  mode: "rendered" | "source";
  /** The version these bytes came from — stated with every create (KTD10). */
  version: number;
  /** Relative-reference resolution, passed straight through to the viewer. */
  refs?: RefRewriteContext | null;
}>();

// Starting a comment is a write. In a read-only workspace the affordances are
// withdrawn rather than left lit to fail on click — the same rule AppSidebar
// applies to the file controls. Reading and existing highlights are untouched.
const wsData = useWorkspaceData();
const billingReadOnly = computed(() => wsData.usage.value?.billing.readOnly === true);

const ui = useCommentUi();
const qc = useQueryClient();
const workspaceId = computed<string | undefined>(() => props.workspaceId);
const path = computed<string | undefined>(() => props.path);
const comments = useComments(workspaceId, path);

// Opening a different file clears the focused thread and any drafts; re-opening
// the same one (an edit-mode toggle, a poll, a re-render) keeps them.
watch(path, (p) => ui.resetForPath(p), { immediate: true });

// --- Live updates ----------------------------------------------------------
// The reading view never refreshed itself before, so a thread posted by an agent
// (or a rewrite of the file underneath us) would sit unseen. Poll the change
// feed with comment events opted in; comment traffic refreshes the thread list
// silently, a content change gets a banner and lets the reader decide.
const fileChanged = ref(false);
useChangeFeedPoll(
  workspaceId,
  computed(() => props.mode === "rendered"),
  (events) => {
    let commentTraffic = false;
    for (const e of events) {
      if (e.path !== props.path) continue;
      const op = opDisplay(e.op);
      if (op.group === "comment") commentTraffic = true;
      else if (op.changesContent) fileChanged.value = true;
    }
    if (commentTraffic) void comments.refresh();
  },
  5000,
  { includeComments: true },
);
// New bytes are on screen — whatever the banner was warning about has arrived.
// Keyed on the path as well as the version: this component is reused across
// file navigation, so a changed v1 file followed by a different v1 file left
// the first file's warning standing over the second one's text.
watch(
  () => [props.path, props.version] as const,
  () => (fileChanged.value = false),
);

async function reloadFile() {
  fileChanged.value = false;
  await qc.invalidateQueries({ queryKey: ["entries"] });
  await comments.refresh();
}

// --- Overlay ---------------------------------------------------------------

const host = ref<HTMLElement | null>(null);
let index: DomTextIndex | null = null;
// Where each painted thread sits, for click hit-testing.
const painted = new Map<string, TextSpan>();

interface Marker {
  id: string;
  top: number;
}
interface Gutter {
  key: number;
  top: number;
  offset: number;
}
/** Height of the gutter control, in px — used to centre it on the first line. */
const GUTTER_SIZE = 20;
const pointMarkers = ref<Marker[]>([]);
const gutters = ref<Gutter[]>([]);
// Which single gutter control is currently revealed. Pointer devices set it on
// hover; a tap sets it too, so the affordance exists without hover.
const activeGutter = ref<number | null>(null);
const selectionButton = ref<{ left: number; top: number } | null>(null);
let pendingSpan: TextSpan | null = null;

// Highlight names are global to the document, so they're cleared on unmount.
const HL = "th-comment";
const HL_ACTIVE = "th-comment-active";

type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => unknown;
/**
 * The CSS Custom Highlight API, or null where it isn't available. Painting over
 * `v-html` output without mutating it is exactly what it exists for; without it
 * the threads simply don't paint (the panel still lists every one of them).
 */
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

function domRange(idx: DomTextIndex, span: TextSpan): Range | null {
  const dom = resolveSpan(idx, span);
  if (!dom) return null;
  const range = document.createRange();
  range.setStart(dom.start.node, dom.start.offset);
  range.setEnd(dom.end.node, dom.end.offset);
  return range;
}

/** Screen rect of the character a point anchor sits before (for its marker). */
function caretRect(idx: DomTextIndex, at: number): DOMRect | null {
  const i = at < idx.nodes.length ? at : idx.nodes.length - 1;
  if (i < 0) return null;
  const range = document.createRange();
  range.setStart(idx.nodes[i]!, idx.offsets[i]!);
  range.setEnd(idx.nodes[i]!, idx.ends[i]!);
  return range.getBoundingClientRect();
}

function repaint() {
  const root = host.value?.querySelector("article.prose") as HTMLElement | null;
  painted.clear();
  if (!root || props.mode !== "rendered") {
    index = null;
    clearHighlights();
    pointMarkers.value = [];
    gutters.value = [];
    return;
  }
  index = buildTextIndex(root);
  const hostRect = host.value!.getBoundingClientRect();

  const normal: Range[] = [];
  const active: Range[] = [];
  const points: Marker[] = [];

  for (const t of comments.threads.value) {
    // Only threads the server could confidently re-attach are painted; the rest
    // live in the panel's tray with their original quote (R8/R17).
    if (t.status === "resolved" || t.anchorStatus !== "anchored") continue;

    if (t.anchorKind === "point") {
      const at = locatePoint(index, t);
      if (at === null) continue;
      const rect = caretRect(index, at);
      if (!rect) continue;
      // Markers live in the margin, at the anchored line's height — inline they
      // land on top of a list bullet and hide document content.
      points.push({ id: t.id, top: rect.top - hostRect.top });
      continue;
    }

    const span = locateQuote(index, {
      // `currentText` is this version's matching text; `quote` is the original.
      quote: t.currentText || t.quote,
      contextBefore: t.contextBefore,
      contextAfter: t.contextAfter,
    });
    if (!span) continue;
    const range = domRange(index, span);
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

  // One gutter affordance per top-level block, but only ever ONE of them is
  // visible: the block under the pointer, the one last tapped, or whichever has
  // keyboard focus. They all stay in the DOM so the control is tabbable and
  // reachable on touch (KTD10's requirement), while a document at rest shows
  // nothing — a column of dots down the margin was pure clutter.
  // A block whose margin already shows a point marker skips it: two controls
  // stacked in one 20px slot is a mess, and that block's conversation is one
  // click away on the marker.
  const next: Gutter[] = [];
  for (const el of Array.from(root.children)) {
    const offset = blockStartOffset(index, el);
    if (offset === null) continue;
    const box = el.getBoundingClientRect();
    const top = box.top - hostRect.top;
    if (points.some((p) => Math.abs(p.top - top) < 10)) continue;
    // Centre on the block's FIRST LINE, not its box: against a large heading a
    // box-top alignment sits noticeably above the letterforms.
    const cs = getComputedStyle(el);
    const lh = Number.parseFloat(cs.lineHeight);
    const line = Number.isFinite(lh) ? lh : Number.parseFloat(cs.fontSize) * 1.4;
    next.push({ key: offset, top: top + Math.max(0, (line - GUTTER_SIZE) / 2), offset });
  }
  gutters.value = next;
}

const schedule = () => void nextTick(repaint);

watch([() => props.source, () => props.mode, comments.threads, ui.activeThreadId], schedule, {
  immediate: true,
});
onMounted(() => {
  schedule();
  window.addEventListener("resize", schedule);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", schedule);
  clearHighlights();
});

// --- Creating ---------------------------------------------------------------

/** Reveal the gutter control for whichever block the pointer is over. */
function onPointerMove(e: PointerEvent) {
  if (!gutters.value.length) return;
  const hostRect = host.value?.getBoundingClientRect();
  if (!hostRect) return;
  const y = e.clientY - hostRect.top;
  // Nearest block whose control sits at or above the pointer — the same
  // top-down ordering the gutters were built in.
  let found: number | null = null;
  for (const g of gutters.value) {
    if (g.top - GUTTER_SIZE <= y) found = g.key;
    else break;
  }
  activeGutter.value = found;
}

function onPointerLeave() {
  activeGutter.value = null;
}

function onMouseUp() {
  const root = host.value?.querySelector("article.prose");
  const sel = window.getSelection();
  // Selecting text stays perfectly normal (copying is a read); only the offer
  // to comment on it goes away while the workspace is locked.
  if (billingReadOnly.value) {
    selectionButton.value = null;
    return;
  }
  if (!index || !root || !sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionButton.value = null;
    return;
  }
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    selectionButton.value = null;
    return;
  }
  const span = spanForSelection(index, range);
  if (!span) {
    selectionButton.value = null;
    return;
  }
  pendingSpan = span;
  const rect = range.getBoundingClientRect();
  const hostRect = host.value!.getBoundingClientRect();
  selectionButton.value = {
    left: rect.right - hostRect.left,
    top: rect.bottom - hostRect.top + 6,
  };
}

function startRangeDraft() {
  if (!index || !pendingSpan) return;
  ui.startDraft({
    path: props.path,
    kind: "range",
    ...captureRange(index, pendingSpan),
    baseVersion: props.version,
  });
  selectionButton.value = null;
  pendingSpan = null;
  window.getSelection()?.removeAllRanges();
}

function startPointDraft(offset: number) {
  if (!index) return;
  ui.startDraft({
    path: props.path,
    kind: "point",
    quote: "",
    ...capturePoint(index, offset),
    baseVersion: props.version,
  });
}

// --- Opening a painted thread ----------------------------------------------

function offsetFromPoint(x: number, y: number): number | null {
  if (!index) return null;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return indexOffsetAt(index, pos.offsetNode, pos.offset);
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return indexOffsetAt(index, range.startContainer, range.startOffset);
  return null;
}

function onClick(e: MouseEvent) {
  // Links belong to the viewer's own navigation handler.
  if ((e.target as HTMLElement | null)?.closest("a")) return;
  const at = offsetFromPoint(e.clientX, e.clientY);
  if (at === null) return;
  for (const [id, span] of painted) {
    if (at >= span.start && at < span.end) {
      ui.focusThread(id);
      return;
    }
  }
}
</script>

<template>
  <div class="relative">
    <!-- Non-blocking, like the editor's collision banner: the file moved on, and
         the reader decides when to catch up. -->
    <div
      v-if="fileChanged"
      class="mb-4 flex items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg"
    >
      <span class="min-w-0 flex-1">This file changed on the server.</span>
      <button
        type="button"
        class="shrink-0 font-medium text-accent hover:underline"
        @click="reloadFile"
      >
        Reload
      </button>
    </div>

    <div
      ref="host"
      class="relative"
      @mouseup="onMouseUp"
      @click="onClick"
      @pointermove="onPointerMove"
      @pointerdown="onPointerMove"
      @pointerleave="onPointerLeave"
    >
      <MarkdownViewer :source="source" :mode="mode" :refs="refs" />

      <div
        v-if="mode === 'rendered'"
        data-comment-ignore
        class="pointer-events-none absolute inset-0"
      >
        <!-- Point-comment affordance in the reading column's margin. Present for
             every block (so it is tabbable and works on touch) but only painted
             for the one the reader is actually pointing at or focused on. -->
        <button
          v-for="g in billingReadOnly ? [] : gutters"
          :key="`g${g.key}`"
          type="button"
          class="pointer-events-auto absolute -left-7 flex h-5 w-5 items-center justify-center rounded text-fg-subtle opacity-0 transition hover:bg-surface-2 hover:text-accent focus-visible:opacity-100"
          :class="activeGutter === g.key ? 'opacity-70' : ''"
          :style="{ top: `${g.top}px` }"
          title="Comment on this block"
          aria-label="Comment on this block"
          @click.stop="startPointDraft(g.offset)"
        >
          <IconPoint class="h-4 w-4" />
        </button>

        <!-- Point threads have no text to highlight, so they get a margin dot. -->
        <button
          v-for="m in pointMarkers"
          :key="`p${m.id}`"
          type="button"
          class="pointer-events-auto absolute -left-7 flex h-5 w-5 items-center justify-center rounded-full border transition"
          :class="
            m.id === ui.activeThreadId.value
              ? 'border-accent bg-accent text-accent-fg'
              : 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/30'
          "
          :style="{ top: `${m.top}px` }"
          title="Open this comment"
          aria-label="Open this comment"
          @click.stop="ui.focusThread(m.id)"
        >
          <IconComment class="h-2.5 w-2.5" />
        </button>

        <!-- Appears against a live selection; clicking it opens the composer. -->
        <button
          v-if="selectionButton"
          type="button"
          class="pointer-events-auto absolute z-10 flex -translate-x-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-fg shadow-lg transition hover:bg-surface-2"
          :style="{ left: `${selectionButton.left}px`, top: `${selectionButton.top}px` }"
          @click.stop="startRangeDraft"
          @mousedown.prevent
        >
          <IconComment class="h-3.5 w-3.5 text-accent" />
          Comment
        </button>
      </div>
    </div>
  </div>
</template>

<style>
/* Painted with the CSS Custom Highlight API so the rendered markdown is never
   mutated — no wrapper spans in `v-html` output, nothing for the sanitizer or
   the reference rewriter to trip over. Theme-driven via the --th-* tokens. */
::highlight(th-comment) {
  background-color: color-mix(in srgb, var(--th-accent) 16%, transparent);
}
::highlight(th-comment-active) {
  background-color: color-mix(in srgb, var(--th-accent) 34%, transparent);
}
</style>