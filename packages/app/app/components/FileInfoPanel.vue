<script setup lang="ts">
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { dirOf, viewerKind, withoutMarkdownExtension } from "shared";
import IconInfo from "~icons/solar/info-circle-linear";
import IconHistory from "~icons/solar/history-2-linear";
import IconShare from "~icons/solar/share-linear";
import IconChat from "~icons/solar/chat-round-line-linear";
import IconEye from "~icons/solar/eye-linear";
import IconRestore from "~icons/solar/rewind-back-linear";
import IconDots from "~icons/solar/menu-dots-bold";
import type { CommentThreadView, FileEntry } from "~/composables/useTreehouseApi";
import { buildTextIndex, locateQuote } from "~/utils/commentHighlights";
import type { ChangeEvent } from "~/utils/activity";
import {
  actorDisplay,
  conflictedCopiesFor,
  exactTime,
  fileActivity,
  isRestorable,
  relativeTime,
} from "~/utils/activity";
import { basename, friendlyType, prettyBytes, textStats } from "~/utils/format";
import { baseContentType } from "~/utils/treehouse";
import { MediaViewer, VIEWERS } from "~/utils/viewers";
import { splitFrontMatter } from "~/utils/frontmatter";
import type { FrontMatterData } from "~/utils/frontmatterData";
import { loadFrontMatterData } from "~/utils/frontmatterFields";

const props = defineProps<{ entry: FileEntry; workspaceId: string }>();

const tab = ref<"info" | "history" | "share" | "comments">("info");
const viewOnly = useWorkspaceData().viewOnly;

const api = useTreehouseApi();
const qc = useQueryClient();
const { byId: membersById } = useWorkspaceMembers(toRef(props, "workspaceId"));

const fileName = computed(() => basename(props.entry.path));
const contentType = computed(() => baseContentType(props.entry.contentType));
const kind = computed(() => viewerKind(props.entry.contentType, props.entry.path));

const changesQuery = useQuery({
  queryKey: computed(() => ["changes", props.workspaceId]),
  queryFn: () => api.changes(props.workspaceId).then((r) => r.changes),
});
const entriesQuery = useQuery({
  queryKey: computed(() => ["entries", props.workspaceId]),
  queryFn: () => api.list(props.workspaceId),
});

// "Linked from": notes whose [[wikilinks]] or relative links reach this file,
// filtered server-side to what this member may read. Keyed on the newest change
// too, so an edit anywhere in the workspace (a note gaining or losing a link)
// refreshes it with the feed.
const latestChange = computed(() => changesQuery.data.value?.[0]?.id ?? "");
const linksQuery = useQuery({
  queryKey: computed(() => ["links", props.workspaceId, props.entry.path, latestChange.value]),
  queryFn: () => api.links(props.workspaceId, props.entry.path),
  placeholderData: (prev) => (prev?.path === props.entry.path ? prev : undefined),
  // Each request indexes more, and finishing indexing is no change the feed
  // would report, so keep asking until the answer is complete.
  refetchInterval: (query) => (query.state.data?.complete === false ? 2_000 : false),
});
const backlinks = computed(() => linksQuery.data.value?.backlinks ?? []);
const tags = computed(() => (linksQuery.data.value?.tags ?? []).map((tag) => ({ tag })));

// A tag opens the sidebar's search on it: tags have no page of their own, so
// they don't take sidebar space nobody asked for.
const treeUi = useFileTreeUi();
const panels = usePanels();
function browseTag(tag: string) {
  treeUi.filterQuery.value = `#${tag}`;
  if (!panels.sidebarOpen.value) panels.toggleSidebar();
}
// How another note would link here: the file's name, as a wikilink.
const wikilinkName = computed(() => withoutMarkdownExtension(fileName.value));

const loading = computed(() => changesQuery.isPending.value);
const events = computed(() => fileActivity(changesQuery.data.value ?? [], props.entry.path));
const pathEventsAsc = computed(() => [...events.value].reverse());
const created = computed(() => {
  const first = pathEventsAsc.value[0];
  return first && first.version === 1 ? first : null;
});
const lastChanged = computed(() => events.value[0] ?? null);
const conflicts = computed(() =>
  conflictedCopiesFor(
    (entriesQuery.data.value?.entries ?? []).map((e) => e.path),
    props.entry.path,
  ),
);

// Comments are markdown-only in v1 (R14) — the tab simply isn't there for other
// kinds. The thread list shares its query key with the viewer's overlay, so the
// badge count and the highlights can never disagree.
const commentable = computed(() => kind.value === "markdown");
const commentUi = useCommentUi();
const commentPath = computed(() => (commentable.value ? props.entry.path : undefined));
const threads = useComments(toRef(props, "workspaceId"), commentPath).threads;
const openComments = computed(() => threads.value.filter((t) => t.status === "open").length);

// The viewer asks for this tab when a thread is focused or a draft is started;
// it can't reach the tab state itself, so the request comes through shared state.
watch(
  () => commentUi.panelRequest.value,
  () => {
    if (commentable.value) tab.value = "comments";
  },
);
// The panel only mounts once it is open, so the request that opened it fired
// before the watcher above existed. Honour one still in flight.
if (
  commentable.value &&
  (commentUi.draft.value?.path === props.entry.path || commentUi.activeThreadId.value)
) {
  tab.value = "comments";
}
// A tab that doesn't exist for this file would render nothing at all.
watch(commentable, (ok) => {
  if (!ok && tab.value === "comments") tab.value = "info";
});

// Text-shaped kinds (the ones whose viewer reads the body) get word/line counts.
const isTextual = computed(() => VIEWERS[kind.value].needsBody);
const textQuery = useQuery({
  queryKey: computed(() => ["file-text", props.workspaceId, props.entry.path, props.entry.version]),
  queryFn: () => api.readFile(props.workspaceId, props.entry.path),
  enabled: computed(() => isTextual.value),
  staleTime: 60_000,
});
const counts = computed(() => {
  const text = textQuery.data.value;
  return isTextual.value && text != null ? textStats(text) : null;
});

// Parsed YAML front matter for markdown files, surfaced as a read-only metadata
// section in the Info tab. Lossless parse; null when absent/unparseable. The
// parser loads on demand, so the guard drops a parse that finishes after the
// panel has moved on to another file.
const frontMatter = ref<FrontMatterData | null>(null);
watch(
  [kind, () => textQuery.data.value],
  async ([k, text]) => {
    if (k !== "markdown" || text == null) {
      frontMatter.value = null;
      return;
    }
    const { parseFrontMatter } = await loadFrontMatterData();
    if (kind.value === k && textQuery.data.value === text) {
      frontMatter.value = parseFrontMatter(splitFrontMatter(text).frontMatter);
    }
  },
  { immediate: true },
);

const imageUrl = computed(() =>
  kind.value === "image" ? api.fileUrl(props.workspaceId, props.entry.path) : "",
);
const dimensions = ref<string | null>(null);
function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement;
  dimensions.value = `${img.naturalWidth}×${img.naturalHeight}`;
}

const copied = ref(false);
async function copyPath() {
  try {
    await navigator.clipboard.writeText(props.entry.path);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard can be blocked */
  }
}
const downloadUrl = computed(() =>
  api.fileUrl(props.workspaceId, props.entry.path, { download: true }),
);

// ---- Actor display (shared resolver; member name resolved from the org) ----
function memberName(e: ChangeEvent): string | null {
  return e.actorId ? (membersById.value.get(e.actorId)?.name ?? null) : null;
}
function actorOf(e: ChangeEvent) {
  return actorDisplay(e, memberName(e));
}

// Technical rows, shown under the closed-by-default "File details".
const metaRows = computed(() => {
  const rows: { label: string; value: string }[] = [
    { label: "Path", value: props.entry.path },
    {
      label: "Type",
      value: `${friendlyType(contentType.value)} · ${prettyBytes(props.entry.size)}`,
    },
  ];
  if (dimensions.value) rows.push({ label: "Dimensions", value: dimensions.value });
  if (counts.value) {
    const { words, lines } = counts.value;
    rows.push({
      label: "Length",
      value: `${words.toLocaleString()} ${words === 1 ? "word" : "words"} · ${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}`,
    });
  }
  if (created.value) {
    const by = actorOf(created.value);
    const on = new Date(created.value.createdAt).toLocaleDateString();
    rows.push({ label: "Created", value: by.resolved ? `${on} · ${by.name}` : on });
  }
  return rows;
});

// The Info tab's opening lines: who edited the file last, then when and at which
// version — the same name-then-action order as a History row. Null only while
// history loads; an edit with no known author leads with the time instead.
const editedSummary = computed(() => {
  const e = lastChanged.value;
  if (!e) {
    // Loaded, but this file has no event in the history we hold (it can fall
    // outside the recent changes): still say which version this is.
    if (loading.value) return null;
    return {
      title: "",
      actor: null,
      primary: `Version ${props.entry.version}`,
      secondary: "No recent changes recorded",
    };
  }
  const actor = actorOf(e);
  const edited = `Edited ${relativeTime(e.createdAt)}`;
  const version = `v${props.entry.version}`;
  return {
    title: exactTime(e.createdAt),
    actor: actor.resolved ? { name: actor.name, isAgent: actor.isAgent } : null,
    primary: actor.resolved ? actor.name : edited,
    secondary: actor.resolved ? `${edited} · ${version}` : version,
  };
});

// Per-entry actions menu (which row's kebab is open).
const openMenuId = ref<string | null>(null);

// ---- Restore (two-step confirm) ----
const confirmingId = ref<string | null>(null);
const restoringId = ref<string | null>(null);
const restoreError = ref<string | null>(null);
function askRestore(e: ChangeEvent) {
  restoreError.value = null;
  confirmingId.value = e.id;
}
function cancelRestore() {
  confirmingId.value = null;
}
async function confirmRestore(e: ChangeEvent) {
  if (e.version == null) return;
  restoringId.value = e.id;
  restoreError.value = null;
  try {
    await api.restoreFile(props.workspaceId, props.entry.path, e.version);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["changes"] }),
      qc.invalidateQueries({ queryKey: ["entries"] }),
    ]);
    confirmingId.value = null;
  } catch (err) {
    restoreError.value = (err as Error).message ?? "Restore failed";
  } finally {
    restoringId.value = null;
  }
}

// ---- Version view sheet ----
const viewing = ref<ChangeEvent | null>(null);
const viewText = ref<string | null>(null);
const viewLoading = ref(false);
const viewError = ref<string | null>(null);
const viewKind = computed(() => (viewing.value ? viewerKind("", props.entry.path) : "binary"));
const viewImageUrl = computed(() =>
  viewing.value?.version != null
    ? api.fileVersionUrl(props.workspaceId, props.entry.path, viewing.value.version)
    : "",
);
const viewDownloadUrl = computed(() =>
  viewing.value?.version != null
    ? api.fileVersionUrl(props.workspaceId, props.entry.path, viewing.value.version, {
        download: true,
      })
    : "",
);
async function openView(e: ChangeEvent) {
  if (e.version == null) return;
  viewing.value = e;
  viewText.value = null;
  viewError.value = null;
  // Media versions load from their URL; only text-shaped kinds read the body.
  if (!VIEWERS[viewKind.value].needsBody) return;
  viewLoading.value = true;
  try {
    viewText.value = await api.readFileVersion(props.workspaceId, props.entry.path, e.version);
  } catch (err) {
    viewError.value = (err as Error).message ?? "Could not load this version";
  } finally {
    viewLoading.value = false;
  }
}
function closeView() {
  viewing.value = null;
}

function goToCopy(copyPath: string) {
  navigateTo(`/w/${props.workspaceId}/${copyPath}`);
}

// ---- Original-version sheet (R9) -------------------------------------------
// The exact bytes a thread was written against, rendered read-only with the
// quoted passage highlighted where it actually sits. Served by thread id (the
// content-hash pin lives server-side); a 410 is TERMINAL — the version is gone,
// so the sheet says so and shows the quote as text. It must never fall back to
// the current bytes, because a highlight over different words is a lie.
const ORIGINAL_HL = "th-original";
const originalThread = ref<CommentThreadView | null>(null);
const originalText = ref<string | null>(null);
const originalVersion = ref<number | null>(null);
const originalLoading = ref(false);
const originalGone = ref(false);
const originalError = ref<string | null>(null);
const originalHost = ref<HTMLElement | null>(null);

function clearOriginalHighlight() {
  const registry = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS
    ?.highlights;
  registry?.delete(ORIGINAL_HL);
}

/** Paint the stored quote where it sits in the pinned bytes — or nowhere. */
function paintOriginal() {
  clearOriginalHighlight();
  const t = originalThread.value;
  const root = originalHost.value?.querySelector("article.prose") as HTMLElement | null;
  const g = globalThis as unknown as {
    CSS?: { highlights?: Map<string, unknown> };
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  if (!t || !root || !g.CSS?.highlights || !g.Highlight) return;
  const index = buildTextIndex(root);
  const span =
    t.anchorKind === "point"
      ? null
      : locateQuote(index, {
          quote: t.quote,
          contextBefore: t.contextBefore,
          contextAfter: t.contextAfter,
        });
  if (!span || span.end <= span.start || span.end > index.nodes.length) return;
  const range = document.createRange();
  range.setStart(index.nodes[span.start]!, index.offsets[span.start]!);
  range.setEnd(index.nodes[span.end - 1]!, index.ends[span.end - 1]!);
  g.CSS.highlights.set(ORIGINAL_HL, new g.Highlight(range));
  range.startContainer.parentElement?.scrollIntoView({ block: "center" });
}

async function openOriginal(t: CommentThreadView) {
  originalThread.value = t;
  originalText.value = null;
  originalVersion.value = null;
  originalGone.value = false;
  originalError.value = null;
  originalLoading.value = true;
  clearOriginalHighlight();
  const res = await api.readCommentPinnedContent(props.workspaceId, t.id);
  originalLoading.value = false;
  if (res.status === "gone") {
    originalGone.value = true;
    return;
  }
  if (res.status === "error") {
    originalError.value = res.message;
    return;
  }
  originalText.value = res.text;
  originalVersion.value = res.pinnedVersion ?? t.pinnedVersion;
  // The highlight is painted when the viewer reports it has rendered.
}

function closeOriginal() {
  clearOriginalHighlight();
  originalThread.value = null;
}
onBeforeUnmount(clearOriginalHighlight);
</script>

<template>
  <div class="space-y-3">
    <!-- Click-away backdrop for the per-version actions menu. -->
    <div v-if="openMenuId" class="fixed inset-0 z-10" @click="openMenuId = null" />

    <!-- No file-name heading: the top bar's breadcrumb already names the open
         file, and the Info tab states its full path. Repeating it here spent the
         panel's first line on something the screen had already said twice. -->

    <!-- Conflicted-copy alert (always visible, both tabs) -->
    <div
      v-if="conflicts.length"
      class="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs"
    >
      <p class="font-medium text-warning">
        {{ conflicts.length }} conflicted {{ conflicts.length === 1 ? "copy" : "copies" }}
      </p>
      <ul class="mt-1 space-y-0.5">
        <li v-for="c in conflicts.slice(0, 3)" :key="c">
          <button
            type="button"
            class="ph-mask truncate text-left text-fg-muted hover:underline"
            @click="goToCopy(c)"
          >
            {{ basename(c) }}
          </button>
        </li>
        <li v-if="conflicts.length > 3" class="text-fg-subtle">+{{ conflicts.length - 3 }} more</li>
      </ul>
    </div>

    <!-- Segmented tabs. Only the active one spells out its name: four labels do not
         fit the panel's width, and four bare icons leave the reader guessing. -->
    <div class="flex items-center gap-1 rounded-lg bg-surface-2 p-1">
      <button
        type="button"
        class="panel-tab"
        :class="tab === 'info' ? 'panel-tab-active' : ''"
        title="Info"
        aria-label="Info"
        :aria-pressed="tab === 'info'"
        @click="tab = 'info'"
      >
        <IconInfo class="h-4 w-4" />
        <span v-if="tab === 'info'">Info</span>
      </button>
      <button
        type="button"
        class="panel-tab"
        :class="tab === 'history' ? 'panel-tab-active' : ''"
        title="History"
        aria-label="History"
        :aria-pressed="tab === 'history'"
        @click="tab = 'history'"
      >
        <IconHistory class="h-4 w-4" />
        <span v-if="tab === 'history'">History</span>
        <span v-if="events.length" class="panel-tab-count">{{ events.length }}</span>
      </button>
      <button
        v-if="commentable"
        type="button"
        class="panel-tab"
        :class="tab === 'comments' ? 'panel-tab-active' : ''"
        title="Comments"
        aria-label="Comments"
        :aria-pressed="tab === 'comments'"
        @click="tab = 'comments'"
      >
        <IconChat class="h-4 w-4" />
        <span v-if="tab === 'comments'">Comments</span>
        <span v-if="openComments" class="panel-tab-count">{{ openComments }}</span>
      </button>
      <button
        v-if="!viewOnly"
        type="button"
        class="panel-tab"
        :class="tab === 'share' ? 'panel-tab-active' : ''"
        title="Share"
        aria-label="Share"
        :aria-pressed="tab === 'share'"
        @click="tab = 'share'"
      >
        <IconShare class="h-4 w-4" />
        <span v-if="tab === 'share'">Share</span>
      </button>
    </div>

    <!-- INFO -->
    <div v-if="tab === 'info'" class="space-y-3">
      <img
        v-if="imageUrl"
        :src="imageUrl"
        :alt="fileName"
        class="max-h-40 w-full rounded border border-border object-contain"
        @load="onImageLoad"
      />
      <FileInfoSummary
        :summary="editedSummary"
        :download-url="downloadUrl"
        :file-name="fileName"
        :copied="copied"
        @copy="copyPath"
      />
      <!-- ph-no-capture: front matter is FILE CONTENT (the document's own title,
           tags, dates) rendered here in the sidebar, outside FileViewer — so the
           viewer's own block does not cover it. See app/plugins/posthog.client.ts. -->
      <div v-if="frontMatter" class="ph-no-capture border-t border-border pt-3">
        <h4 class="panel-heading mb-2">Metadata</h4>
        <FrontMatterList :data="frontMatter" variant="sidebar" />
      </div>
      <TagChips :tags="tags" heading="Tags" title="Show notes tagged" @select="browseTag" />
      <!-- ph-no-capture: these are other files' paths, i.e. workspace content. -->
      <div class="ph-no-capture border-t border-border pt-3">
        <h4 class="panel-heading mb-2">
          Linked from<span v-if="backlinks.length" class="ml-1 normal-case">
            · {{ backlinks.length }}</span
          >
        </h4>
        <div
          v-if="linksQuery.isPending.value"
          class="h-5 w-2/3 animate-pulse rounded bg-surface-2"
        />
        <p v-else-if="linksQuery.isError.value" class="text-xs text-fg-subtle">
          Couldn’t load links.
        </p>
        <ul v-else-if="backlinks.length" class="space-y-1">
          <li v-for="p in backlinks" :key="p" class="flex min-w-0 items-center gap-2">
            <FileLink :path="p" :workspace-id="workspaceId" class="min-w-0 shrink" />
            <span
              v-if="dirOf(p)"
              class="ph-mask min-w-0 flex-1 truncate text-right text-[11px] text-fg-subtle"
              :title="p"
              >{{ dirOf(p) }}</span
            >
          </li>
        </ul>
        <p v-else class="text-xs text-fg-subtle">
          No notes link here yet. Write
          <code class="ph-mask rounded bg-surface-2 px-1 py-0.5 text-[11px] text-fg-muted"
            >[[{{ wikilinkName }}]]</code
          >
          in another note to link to it.
        </p>
        <p
          v-if="linksQuery.data.value?.complete === false"
          class="mt-1.5 text-[11px] text-fg-subtle"
        >
          Still indexing older notes, so this list may grow.
        </p>
      </div>
      <FileDetails :rows="metaRows" />
    </div>

    <!-- HISTORY (card per version) -->
    <div v-else-if="tab === 'history'" class="space-y-2">
      <div v-if="loading" class="space-y-2">
        <div v-for="n in 3" :key="n" class="h-14 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <p v-else-if="events.length === 0" class="text-sm text-fg-subtle">No recorded changes yet.</p>
      <div v-else class="space-y-2">
        <div v-for="e in events" :key="e.id" class="rounded-lg border border-border p-3">
          <ChangeEventRow :event="e" :workspace-id="workspaceId" :member-name="memberName(e)">
            <template v-if="isRestorable(e) && confirmingId !== e.id" #actions>
              <div class="relative">
                <button
                  type="button"
                  class="rounded p-1 text-fg-subtle transition hover:bg-surface-2 hover:text-fg"
                  title="Actions"
                  aria-label="Version actions"
                  @click.stop="openMenuId = openMenuId === e.id ? null : e.id"
                >
                  <IconDots class="h-4 w-4" />
                </button>
                <div
                  v-if="openMenuId === e.id"
                  class="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-md border border-border bg-surface text-xs shadow-lg"
                >
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2.5 py-2 text-fg hover:bg-surface-2"
                    @click="((openMenuId = null), openView(e))"
                  >
                    <IconEye class="h-3.5 w-3.5" />View
                  </button>
                  <button
                    v-if="!viewOnly"
                    type="button"
                    class="flex w-full items-center gap-2 px-2.5 py-2 text-fg hover:bg-surface-2"
                    @click="((openMenuId = null), askRestore(e))"
                  >
                    <IconRestore class="h-3.5 w-3.5" />Restore
                  </button>
                </div>
              </div>
            </template>
          </ChangeEventRow>
          <div v-if="confirmingId === e.id" class="mt-2 flex items-center gap-2 text-xs">
            <span class="text-fg-muted">Restore v{{ e.version }} as a new version?</span>
            <button
              type="button"
              class="th-btn th-btn-primary th-btn-sm"
              :disabled="restoringId === e.id"
              @click="confirmRestore(e)"
            >
              {{ restoringId === e.id ? "Restoring…" : "Confirm" }}
            </button>
            <button
              type="button"
              class="th-btn th-btn-quiet th-btn-sm"
              :disabled="restoringId === e.id"
              @click="cancelRestore"
            >
              Cancel
            </button>
          </div>
          <p v-if="confirmingId === e.id && restoreError" class="mt-1 text-xs text-danger">
            {{ restoreError }}
          </p>
        </div>
      </div>
    </div>

    <!-- COMMENTS -->
    <CommentsPanel
      v-else-if="tab === 'comments' && commentable"
      :workspace-id="workspaceId"
      :path="entry.path"
      @view-original="openOriginal"
    />

    <!-- SHARE -->
    <FileShare
      v-else-if="tab === 'share'"
      :workspace-id="workspaceId"
      :path="entry.path"
      kind="file"
      :version="entry.version"
      :content-type="entry.contentType"
    />

    <!-- Original-version sheet: the bytes a thread was written on (R9) -->
    <div
      v-if="originalThread"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="closeOriginal"
    >
      <div
        class="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
      >
        <div class="flex items-start justify-between gap-3 border-b border-border px-4 py-2.5">
          <div class="min-w-0 text-sm">
            <!-- ph-mask: user-authored file name in the original-version sheet. -->
            <span class="ph-mask font-medium text-fg">{{ fileName }}</span>
            <span class="ml-2 font-mono text-xs text-fg-subtle"
              >v{{ originalVersion ?? originalThread.pinnedVersion }}</span
            >
            <span class="ml-2 text-xs text-fg-subtle">the version this comment was written on</span>
          </div>
          <button type="button" class="text-fg-subtle hover:text-fg" @click="closeOriginal">
            ✕
          </button>
        </div>
        <!-- ph-no-capture: this body contains pinned file bytes (including the
             terminal quote fallback), so replay must treat it as one opaque region. -->
        <div ref="originalHost" class="ph-no-capture min-h-0 flex-1 overflow-auto px-6 py-5">
          <p v-if="originalLoading" class="text-sm text-fg-subtle">Loading…</p>
          <!-- Terminal: the bytes are gone for good. Say it plainly and show the
               quote as text — never highlight over a different version. -->
          <div v-else-if="originalGone" class="space-y-3">
            <p class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-fg">
              This version is no longer available.
            </p>
            <blockquote
              v-if="originalThread.quote"
              class="border-l-2 border-border pl-3 text-sm italic text-fg-muted"
            >
              {{ originalThread.quote }}
            </blockquote>
          </div>
          <p v-else-if="originalError" class="text-sm text-danger">{{ originalError }}</p>
          <LazyMarkdownViewer
            v-else-if="originalText != null"
            :source="originalText"
            mode="rendered"
            :workspace-id="workspaceId"
            :path="entry.path"
            @rendered="paintOriginal"
          />
        </div>
        <div class="border-t border-border px-4 py-2.5 text-xs text-fg-subtle">
          Read-only. Comments and edits belong to the current version.
        </div>
      </div>
    </div>

    <!-- Version-view sheet -->
    <div
      v-if="viewing"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="closeView"
    >
      <div
        class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
      >
        <div class="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div class="text-sm">
            <!-- ph-mask: user-authored file name in the version-view sheet. -->
            <span class="ph-mask font-medium text-fg">{{ fileName }}</span>
            <span class="ml-2 font-mono text-xs text-fg-subtle">v{{ viewing.version }}</span>
            <span class="ml-2 text-xs text-fg-subtle">{{ exactTime(viewing.createdAt) }}</span>
          </div>
          <button type="button" class="text-fg-subtle hover:text-fg" @click="closeView">✕</button>
        </div>
        <!-- ph-no-capture: every version renderer below can expose file bytes,
             whether as text, an image, a binary link, or a fallback state. -->
        <div class="ph-no-capture min-h-0 flex-1 overflow-auto p-4">
          <p v-if="viewLoading" class="text-sm text-fg-subtle">Loading…</p>
          <p v-else-if="viewError" class="text-sm text-danger">{{ viewError }}</p>
          <img
            v-else-if="viewKind === 'image'"
            :src="viewImageUrl"
            :alt="`v${viewing.version}`"
            class="mx-auto max-h-full"
          />
          <!-- Video keeps a fixed-height stage so a tall picture fits the sheet. -->
          <div
            v-else-if="viewKind === 'video' || viewKind === 'audio'"
            class="flex flex-col"
            :class="viewKind === 'video' ? 'h-[60vh]' : ''"
          >
            <component
              :is="MediaViewer"
              :kind="viewKind"
              :src="viewImageUrl"
              :download-href="viewDownloadUrl"
              :name="entry.path"
              :size="0"
            />
          </div>
          <a
            v-else-if="viewKind === 'binary'"
            :href="viewDownloadUrl"
            class="text-sm text-accent underline"
            >Download v{{ viewing.version }}</a
          >
          <pre v-else class="whitespace-pre-wrap break-words font-mono text-xs text-fg">{{
            viewText
          }}</pre>
        </div>
        <div v-if="isRestorable(viewing)" class="border-t border-border px-4 py-2.5 text-right">
          <button
            v-if="!viewOnly"
            type="button"
            class="th-btn th-btn-primary"
            @click="
              () => {
                const v = viewing;
                closeView();
                if (v) askRestore(v);
              }
            "
          >
            <IconRestore class="h-4 w-4" />
            Restore this version
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
<style>
/* The stored quote, painted where it sits in the pinned bytes. Same mechanism
   as the reading view's overlay (the rendered markdown is never mutated), and
   deliberately its own highlight name so the two can't clear each other. */
::highlight(th-original) {
  background-color: color-mix(in srgb, var(--th-accent) 30%, transparent);
}
</style>