<script setup lang="ts">
// The comments tab of the file panel: the composer for a pending draft, the
// open threads, the outdated/ambiguous tray, and resolved history. Threads are
// never removed here — resolve and reopen are the only state, so a reviewer can
// always go back and read what was said.
//
// All three groups render through ONE card loop. They diverged once, and the
// abridged copies quietly dropped the agent attribution off every reply in the
// tray — the one place a "who changed this?" answer matters most.
import IconResolve from "~icons/solar/chat-round-check-linear";
import IconReopen from "~icons/solar/restart-linear";
import IconTray from "~icons/solar/archive-minimalistic-linear";
import IconInfo from "~icons/solar/info-circle-linear";
import IconDots from "~icons/solar/menu-dots-bold";
import IconEye from "~icons/solar/eye-linear";
import IconChevron from "~icons/solar/alt-arrow-right-linear";
// Agents get a glyph rather than initials. Deliberately generic: the label is
// whatever the workspace key was named, so it may not be Claude — a vendor mark
// here would assert something the data doesn't know.
import IconAgent from "~icons/solar/stars-minimalistic-bold";
import { useComments, useCommentUi } from "~/composables/useComments";
import type { CommentAttribution, CommentThreadView } from "~/composables/useTreehouseApi";
import { exactTime, initials, relativeTime } from "~/utils/activity";
import {
  bucketThreads,
  normalizeForMatch,
  plainFromMarkdown,
  resolvedWithoutChanges,
  threadReplies,
} from "~/utils/commentHighlights";

const props = defineProps<{ workspaceId: string; path: string }>();
// The panel can't host a full-width reading sheet, so the file panel above it
// opens the pinned version (R9); this is the only thing it needs from here.
const emit = defineEmits<{ (e: "view-original", thread: CommentThreadView): void }>();

// Commenting is a write, so it answers to the same billing gate as file writes
// (AppSidebar's pattern). Threads stay readable — only the controls that would
// earn a 402 are withdrawn, and they say why rather than failing on click.
const ws = useWorkspaceData();
const billingReadOnly = computed(() => ws.usage.value?.billing.readOnly === true);
const readOnlyReason = "This workspace is read-only until its subscription is sorted out.";

const ui = useCommentUi();
const workspaceId = computed<string | undefined>(() => props.workspaceId);
const path = computed<string | undefined>(() => props.path);
const comments = useComments(workspaceId, path);
const { byId: membersById } = useWorkspaceMembers(workspaceId);

const buckets = computed(() => bucketThreads(comments.threads.value));

type Bucket = "open" | "tray" | "resolved";
type Row =
  | { kind: "tray-header"; key: string }
  | { kind: "resolved-header"; key: string }
  | { kind: "thread"; key: string; bucket: Bucket; t: CommentThreadView };

const rows = computed<Row[]>(() => {
  const b = buckets.value;
  const out: Row[] = b.open.map((t) => ({ kind: "thread", key: t.id, bucket: "open", t }) as Row);
  if (b.tray.length) {
    out.push({ kind: "tray-header", key: "tray" });
    if (ui.trayOpen.value) {
      out.push(...b.tray.map((t) => ({ kind: "thread", key: t.id, bucket: "tray", t }) as Row));
    }
  }
  if (b.resolved.length) {
    out.push({ kind: "resolved-header", key: "resolved" });
    if (ui.showResolved.value) {
      out.push(
        ...b.resolved.map((t) => ({ kind: "thread", key: t.id, bucket: "resolved", t }) as Row),
      );
    }
  }
  return out;
});

// The replies on screen per thread, and how many the server still has. Both
// halves are paged — the list response carries the first page of each thread,
// the rest is pulled in on demand — so they're stitched in one place.
const replies = computed(
  () => new Map(comments.threads.value.map((t) => [t.id, threadReplies(t, ui.entriesFor(t.id))])),
);
function repliesOf(t: CommentThreadView) {
  return replies.value.get(t.id) ?? { shown: t.entries, remaining: 0 };
}

// Same fallback rule the change feed uses (R22): a row never renders an empty
// actor, and an agent is labelled by the key that acted (agent events carry the
// owner's user id, so the name alone would read as the human).
function actorOf(a: CommentAttribution) {
  const isAgent = a.principal === "agent";
  const member = a.actorId ? membersById.value.get(a.actorId) : undefined;
  return {
    name: member?.name ?? (isAgent ? "agent" : "human"),
    isAgent,
    agentLabel: isAgent ? a.actorLabel : null,
  };
}

/** Anchor text for display: what a reader sees, not the raw markdown behind it. */
function preview(markdown: string, max = 110): string {
  const text = normalizeForMatch(plainFromMarkdown(markdown));
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** The quote to show for a thread: what it matches now, else what it matched then. */
function quoteOf(t: CommentThreadView): string {
  if (t.anchorKind === "point") return preview(t.contextAfter, 60) || "a point in the text";
  return preview(t.currentText || t.quote);
}

// --- Draft (create) ---------------------------------------------------------

const draft = computed(() => (ui.draft.value?.path === props.path ? ui.draft.value : null));

// Starting a comment in the document opens this composer; the reader's next act
// is always to type, so put the caret there rather than making them click into
// the panel they just summoned.
const draftBox = ref<HTMLTextAreaElement | null>(null);
watch(
  () => draft.value?.startedAt,
  (started) => {
    if (started) void nextTick(() => draftBox.value?.focus());
  },
  { immediate: true },
);

/**
 * Cmd/Ctrl+Enter posts. Plain Enter has to stay a newline — a comment is prose
 * and often more than one line.
 */
const isSubmit = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.key === "Enter";

function onDraftKeydown(e: KeyboardEvent) {
  if (!isSubmit(e)) return;
  e.preventDefault();
  void submitDraft();
}

const DRAFT_ERROR: Record<string, string> = {
  anchor_ambiguous: "That text appears more than once, so pinning it here would be a guess.",
  anchor_not_found:
    "That exact text isn’t in the saved file — selections that cross a table cell or a link often don’t line up.",
  base_version_conflict: "The file changed while you were writing, and the text has moved.",
};
const draftHint = computed(() => {
  const d = draft.value;
  if (!d?.error) return null;
  // Not an anchoring problem, so it must not borrow the anchoring advice:
  // re-selecting the passage can never clear a billing refusal. Reachable even
  // with the controls hidden — a lapse can land between opening the composer
  // and posting it.
  if (d.error === "workspace_read_only") {
    return `${readOnlyReason} Your comment is kept — renewing restores commenting.`;
  }
  const base = DRAFT_ERROR[d.error] ?? d.error;
  const count = d.occurrences ? ` (${d.occurrences} matches)` : "";
  return `${base}${count} Select the passage again — your comment is kept.`;
});

async function submitDraft() {
  const d = ui.draft.value;
  if (!d || !d.body.trim() || d.submitting) return;
  d.submitting = true;
  d.error = null;
  const res = await comments.create(d);
  if (res.status === "created") {
    ui.clearDraft();
    ui.focusThread(res.thread.id);
    return;
  }
  if (res.status === "ambiguous") ui.failDraft("anchor_ambiguous", res.occurrences);
  else if (res.status === "not_found_text") ui.failDraft("anchor_not_found");
  else if (res.status === "conflict") ui.failDraft("base_version_conflict");
  else ui.failDraft(res.error);
}

// --- Replies / resolution ---------------------------------------------------

const busyId = ref<string | null>(null);
const actionError = ref<string | null>(null);

// Per-card overflow menu (the FileInfoPanel history-row pattern). Secondary
// actions and the version metadata live here so the card itself stays a quote,
// a conversation, and the two actions the review loop actually uses.
const openMenuId = ref<string | null>(null);
// The tray's explanation is one sentence people need once, so it's opt-in
// rather than a permanent block above every outdated thread.
const trayInfoOpen = ref(false);

// A click-outside backdrop leaves keyboard users with no way out, so Escape
// closes the menu too.
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && openMenuId.value) openMenuId.value = null;
}

/** What the menu says about where this thread is pinned and whether it still matches. */
function anchorNote(t: CommentThreadView): string {
  const on = `Written on v${t.pinnedVersion}`;
  if (t.anchorStatus === "ambiguous") return `${on} · matches several places now`;
  if (t.anchorStatus === "outdated") return `${on} · text no longer in the document`;
  return on;
}

async function submitReply(t: CommentThreadView) {
  const body = ui.composerFor(t.id).trim();
  if (!body || busyId.value) return;
  busyId.value = t.id;
  actionError.value = null;
  try {
    await comments.reply(t.id, body);
    ui.clearComposer(t.id);
  } catch (err) {
    // The draft stays in the shared state, so a failed post loses nothing.
    actionError.value = (err as Error).message ?? "Reply failed";
  } finally {
    busyId.value = null;
  }
}

// Reading the rest of a long thread. Its own busy id, not `busyId`: pulling
// replies is a read, and it must not disable the Reply button of the thread the
// user is in the middle of answering.
const expandingId = ref<string | null>(null);
async function loadMoreReplies(t: CommentThreadView) {
  if (expandingId.value) return;
  expandingId.value = t.id;
  actionError.value = null;
  try {
    await comments.loadMoreEntries(t.id);
  } catch (err) {
    actionError.value = (err as Error).message ?? "Could not load more replies";
  } finally {
    expandingId.value = null;
  }
}

function onReplyKeydown(e: KeyboardEvent, t: CommentThreadView) {
  if (!isSubmit(e)) return;
  e.preventDefault();
  void submitReply(t);
}

async function toggleResolved(t: CommentThreadView) {
  if (busyId.value) return;
  busyId.value = t.id;
  actionError.value = null;
  try {
    await comments.setResolved(t.id, t.status === "open");
  } catch (err) {
    actionError.value = (err as Error).message ?? "Could not update this thread";
  } finally {
    busyId.value = null;
  }
}

// Threads are paged too (the server caps a list page), so the panel says how
// many are still behind rather than ending on a silent prefix of the file's
// comments. Loading a page adds to the shared thread cache, so the overlay in
// the document gains the same threads at the same moment.
const moreThreads = computed(() =>
  Math.max(0, comments.total.value - comments.threads.value.length),
);
const moreThreadsLabel = computed(() =>
  moreThreads.value === 1 ? "Show 1 more comment" : `Show ${moreThreads.value} more comments`,
);

function cardClass(row: Row & { kind: "thread" }): string {
  if (row.bucket === "resolved") return "border-border bg-surface-2/30";
  if (row.t.id === ui.activeThreadId.value) return "border-accent bg-surface-2/40";
  return row.bucket === "tray" ? "border-warning/40" : "border-border";
}
</script>

<template>
  <!-- Privacy contract: this subtree contains document quotes, historical context,
       and comment bodies, so PostHog replay must block it as one region. -->
  <div class="ph-no-capture space-y-2">
    <!-- Click-anywhere backdrop for an open thread menu (FileInfoPanel idiom). -->
    <div v-if="openMenuId" class="fixed inset-0 z-10" @click="openMenuId = null" />

    <!-- Pending draft. Never cleared by a failure: the anchor is the server's
         problem, the words are the user's (KTD10). -->
    <div v-if="draft" class="rounded-lg border border-accent/50 bg-surface-2/40 p-2.5">
      <p class="mb-1.5 text-xs text-fg-subtle">
        <template v-if="draft.kind === 'point'">Comment on this block</template>
        <template v-else>
          On “<span class="text-fg-muted">{{ preview(draft.quote, 90) }}</span
          >”
        </template>
      </p>
      <textarea
        ref="draftBox"
        v-model="draft.body"
        rows="3"
        placeholder="Add a comment…  (⌘↵ to post)"
        class="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        @keydown="onDraftKeydown"
      />
      <p
        v-if="draftHint"
        class="mt-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-fg"
      >
        {{ draftHint }}
      </p>
      <div class="mt-2 flex items-center gap-2">
        <button
          type="button"
          class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
          :disabled="!draft.body.trim() || draft.submitting"
          @click="submitDraft"
        >
          {{ draft.submitting ? "Posting…" : draft.error ? "Retry" : "Comment" }}
        </button>
        <button type="button" class="text-xs text-fg-subtle hover:text-fg" @click="ui.clearDraft()">
          Discard
        </button>
      </div>
    </div>

    <p v-if="comments.loading.value" class="text-sm text-fg-subtle">Loading comments…</p>
    <p v-else-if="comments.error.value" class="text-sm text-danger">{{ comments.error.value }}</p>
    <p v-else-if="!comments.threads.value.length && !draft" class="text-sm text-fg-subtle">
      No comments yet. Select text in the document, or use the ⊕ in the margin, to start one.
    </p>

    <p v-if="actionError" class="text-xs text-danger">{{ actionError }}</p>

    <template v-for="row in rows" :key="row.key">
      <!-- Outdated / ambiguous tray (R8, R17) -->
      <div v-if="row.kind === 'tray-header'" class="pt-1">
        <div class="flex items-center gap-1.5 text-xs font-medium text-warning">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            @click="ui.trayOpen.value = !ui.trayOpen.value"
          >
            <IconTray class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate">{{ buckets.tray.length }} no longer in the document</span>
          </button>
          <button
            type="button"
            class="shrink-0 rounded p-0.5 text-fg-subtle transition hover:bg-surface-2 hover:text-fg"
            :aria-expanded="trayInfoOpen"
            aria-label="What does this mean?"
            title="What does this mean?"
            @click="trayInfoOpen = !trayInfoOpen"
          >
            <IconInfo class="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            class="shrink-0 px-0.5 text-fg-subtle transition hover:text-fg"
            :aria-label="ui.trayOpen.value ? 'Collapse' : 'Expand'"
            @click="ui.trayOpen.value = !ui.trayOpen.value"
          >
            {{ ui.trayOpen.value ? "−" : "+" }}
          </button>
        </div>
        <p
          v-if="trayInfoOpen"
          class="mt-1.5 rounded-md border border-border bg-surface-2/50 px-2 py-1.5 text-xs text-fg-muted"
        >
          The text these were written about has changed, or now appears in several places, so they
          aren’t pinned to the document. Their original words are kept below, and each one can still
          be opened on the version it was written on.
        </p>
      </div>

      <!-- A disclosure, styled like one: bare text read as a label, not a
           control you could press. -->
      <button
        v-else-if="row.kind === 'resolved-header'"
        type="button"
        class="flex w-full items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-left text-xs font-medium text-fg-muted transition hover:bg-surface-2 hover:text-fg"
        :aria-expanded="ui.showResolved.value"
        @click="ui.showResolved.value = !ui.showResolved.value"
      >
        <IconChevron
          class="h-3.5 w-3.5 shrink-0 transition-transform"
          :class="ui.showResolved.value ? 'rotate-90' : ''"
        />
        {{ buckets.resolved.length }} resolved
        <span class="ml-auto text-fg-subtle">{{ ui.showResolved.value ? "Hide" : "Show" }}</span>
      </button>

      <div v-else class="rounded-lg border p-2.5 transition" :class="cardClass(row)">
        <!-- Card header: the quoted text, and everything else behind one menu.
             The quote is the thread's identity, so it gets the whole line; the
             version it was pinned to and the jump back to that version (R9) are
             secondary and were previously two extra rows of chrome per card. -->
        <div class="mb-2 flex items-start gap-1">
          <button
            type="button"
            class="min-w-0 flex-1 border-l-2 pl-2 text-left text-xs italic"
            :class="
              row.bucket === 'open'
                ? 'border-accent/50 text-fg-muted'
                : row.bucket === 'tray'
                  ? 'border-warning/50 text-fg-muted'
                  : 'border-border text-fg-subtle'
            "
            @click="ui.focusThread(row.t.id)"
          >
            {{ quoteOf(row.t) }}
          </button>
          <div class="relative shrink-0">
            <button
              type="button"
              class="rounded p-1 text-fg-subtle transition hover:bg-surface-2 hover:text-fg"
              title="Thread actions"
              aria-label="Thread actions"
              @click.stop="openMenuId = openMenuId === row.t.id ? null : row.t.id"
            >
              <IconDots class="h-3.5 w-3.5" />
            </button>
            <div
              v-if="openMenuId === row.t.id"
              class="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border border-border bg-surface text-xs shadow-lg"
            >
              <p class="border-b border-border px-2.5 py-2 text-fg-subtle">
                {{ anchorNote(row.t) }}
              </p>
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2.5 py-2 text-left text-fg hover:bg-surface-2"
                @click="((openMenuId = null), emit('view-original', row.t))"
              >
                <IconEye class="h-3.5 w-3.5 shrink-0" />
                View on v{{ row.t.pinnedVersion }}
              </button>
            </div>
          </div>
        </div>

        <div v-for="e in repliesOf(row.t).shown" :key="e.id" class="mb-2 flex items-start gap-2">
          <!-- An agent's avatar is a glyph, not initials: "via <key name>" as
               text wrapped the byline onto a second line on every agent reply,
               and the label is the same on all of them. It moves to the
               tooltip; the glyph and the agent tint carry it at a glance. -->
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
            :class="actorOf(e.author).isAgent ? 'bg-agent/15 text-agent' : 'bg-human/15 text-human'"
            :title="
              actorOf(e.author).agentLabel
                ? `${actorOf(e.author).name} · via ${actorOf(e.author).agentLabel}`
                : actorOf(e.author).name
            "
          >
            <IconAgent v-if="actorOf(e.author).isAgent" class="h-3.5 w-3.5" />
            <template v-else>{{ initials(actorOf(e.author).name) }}</template>
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-xs text-fg-subtle">
              <span
                class="font-medium"
                :class="row.bucket === 'resolved' ? 'text-fg-muted' : 'text-fg'"
                >{{ actorOf(e.author).name }}</span
              >
              <span :title="exactTime(e.createdAt)"> · {{ relativeTime(e.createdAt) }}</span>
            </p>
            <p
              class="whitespace-pre-wrap break-words text-sm"
              :class="row.bucket === 'resolved' ? 'text-fg-muted' : 'text-fg'"
            >
              {{ e.body }}
            </p>
          </div>
        </div>
        <!-- The rest of the thread. A count alone was a dead end: replies past
             the first page were unreachable to a reader who could see they
             existed. -->
        <button
          v-if="repliesOf(row.t).remaining > 0"
          type="button"
          class="mb-2 ml-8 rounded-md px-1.5 py-0.5 text-xs font-medium text-fg-subtle transition hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          :disabled="expandingId === row.t.id"
          @click="loadMoreReplies(row.t)"
        >
          {{
            expandingId === row.t.id
              ? "Loading…"
              : repliesOf(row.t).remaining === 1
                ? "Show 1 more reply"
                : `Show ${repliesOf(row.t).remaining} more replies`
          }}
        </button>

        <!-- Resolved: the stamp, plus the honest note when nothing changed. -->
        <p v-if="row.bucket === 'resolved'" class="text-xs text-fg-subtle">
          Resolved by
          <span class="text-fg-muted">{{
            row.t.resolvedBy ? actorOf(row.t.resolvedBy).name : "someone"
          }}</span>
          <span v-if="row.t.resolvedAtVersion != null"> at v{{ row.t.resolvedAtVersion }}</span>
          <span v-if="resolvedWithoutChanges(row.t)" class="text-warning">
            · resolved without changes</span
          >
        </p>

        <template v-if="row.bucket !== 'resolved' && !billingReadOnly">
          <textarea
            :value="ui.composerFor(row.t.id)"
            rows="2"
            placeholder="Reply…  (⌘↵ to post)"
            class="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
            @input="ui.setComposer(row.t.id, ($event.target as HTMLTextAreaElement).value)"
            @keydown="onReplyKeydown($event, row.t)"
          />
          <div class="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              class="rounded-md border border-border px-2 py-1 text-xs font-medium text-fg-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-50"
              :disabled="!ui.composerFor(row.t.id).trim() || busyId === row.t.id"
              @click="submitReply(row.t)"
            >
              Reply
            </button>
            <button
              type="button"
              class="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg-subtle transition hover:bg-surface-2 hover:text-success disabled:opacity-50"
              :disabled="busyId === row.t.id"
              @click="toggleResolved(row.t)"
            >
              <IconResolve class="h-3.5 w-3.5" />
              Resolve
            </button>
          </div>
        </template>
        <button
          v-else-if="!billingReadOnly"
          type="button"
          class="mt-1.5 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg-subtle transition hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          :disabled="busyId === row.t.id"
          @click="toggleResolved(row.t)"
        >
          <IconReopen class="h-3.5 w-3.5" />
          Reopen
        </button>
        <!-- Read-only: the thread stays fully readable, the writes do not. -->
        <p v-if="billingReadOnly" class="mt-1.5 text-xs text-fg-subtle">
          {{ readOnlyReason }}
        </p>
      </div>
    </template>

    <button
      v-if="comments.hasMore.value"
      type="button"
      class="w-full rounded-md border border-border px-2 py-1.5 text-xs font-medium text-fg-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-50"
      :disabled="comments.loadingMore.value"
      @click="comments.loadMore()"
    >
      {{ comments.loadingMore.value ? "Loading…" : moreThreadsLabel }}
    </button>
  </div>
</template>