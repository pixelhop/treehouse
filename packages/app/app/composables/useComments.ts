// Comment state for the reading view, in two halves.
//
// SERVER state (the threads themselves) lives in vue-query under one key per
// (workspace, path), so the viewer overlay and the panel are looking at the
// same list rather than two lists that drift.
//
// INTERACTION state (which thread is focused, the pending create draft, reply
// drafts, tray expansion) is created once at the workspace-view level and
// provided down. It cannot live in either call site: the viewer, the editor and
// the panel are siblings, and toggling edit mode destroys the viewer outright —
// per-call-site state would lose the focused thread and the half-typed reply
// exactly when the user least expects it.
//
// Imports are explicit (not Nuxt auto-imports) so the state factory is
// exercisable in a plain unit test.
import { useInfiniteQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, inject, provide, ref, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type {
  CommentEntryView,
  CommentThreadView,
  CreateCommentResult,
} from "~/composables/useTreehouseApi";
// Relative, not `~/`: the state factory below is exercised in a plain unit test
// where the Nuxt alias does not exist (the type imports above are erased).
import { mergeThreadPages } from "../utils/commentHighlights";

/** A comment being written but not yet anchored on the server. */
export interface CommentDraft {
  path: string;
  kind: "range" | "point";
  /** Rendered-view text (empty for a point). The server re-derives its own. */
  quote: string;
  contextBefore: string;
  contextAfter: string;
  /** The version the rendered DOM came from — stated with every create (R15). */
  baseVersion: number;
  body: string;
  /** Last anchor failure, kept alongside the body so retry is one click. */
  error: string | null;
  occurrences: number | null;
  submitting: boolean;
  /**
   * When this draft was started. The panel watches it to focus the composer —
   * a counter rather than a boolean so starting a second draft on the same
   * passage still re-focuses.
   */
  startedAt: number;
}

export type NewDraft = Pick<
  CommentDraft,
  "path" | "kind" | "quote" | "contextBefore" | "contextAfter" | "baseVersion"
> & { body?: string };

export interface CommentUiState {
  activeThreadId: Ref<string | null>;
  draft: Ref<CommentDraft | null>;
  showResolved: Ref<boolean>;
  trayOpen: Ref<boolean>;
  /** Bumped when the viewer wants the right panel to show the comments tab. */
  panelRequest: Ref<number>;
  focusThread: (id: string | null) => void;
  startDraft: (d: NewDraft) => void;
  failDraft: (error: string, occurrences?: number) => void;
  clearDraft: () => void;
  composerFor: (threadId: string) => string;
  setComposer: (threadId: string, text: string) => void;
  clearComposer: (threadId: string) => void;
  /** Reply pages pulled in past the first one, by thread id. */
  entriesFor: (threadId: string) => CommentEntryView[];
  appendEntries: (threadId: string, entries: CommentEntryView[]) => void;
  resetForPath: (path: string | undefined) => void;
}

export function createCommentUiState(): CommentUiState {
  const activeThreadId = ref<string | null>(null);
  const draft = ref<CommentDraft | null>(null);
  const showResolved = ref(false);
  const trayOpen = ref(true);
  const panelRequest = ref(0);
  // Reply drafts by thread id. Keyed rather than component-local so a thread
  // re-rendering (a poll landed, someone else resolved it) can't eat the text.
  const composers = ref<Record<string, string>>({});
  // How far each thread has been read past its first page of replies. Lifted
  // for the same reason as the composers, and one more: the list refreshes
  // every few seconds, and a reader forty replies deep must not be dropped back
  // to twenty because a poll landed.
  const entries = ref<Record<string, CommentEntryView[]>>({});
  let currentPath: string | undefined;

  return {
    activeThreadId,
    draft,
    showResolved,
    trayOpen,
    panelRequest,
    focusThread(id) {
      activeThreadId.value = id;
      if (id) panelRequest.value += 1;
    },
    startDraft(d) {
      draft.value = {
        ...d,
        body: d.body ?? "",
        error: null,
        occurrences: null,
        submitting: false,
        startedAt: panelRequest.value + 1,
      };
      panelRequest.value += 1;
    },
    failDraft(error, occurrences) {
      if (!draft.value) return;
      draft.value.error = error;
      draft.value.occurrences = occurrences ?? null;
      draft.value.submitting = false;
    },
    clearDraft() {
      draft.value = null;
    },
    composerFor: (threadId) => composers.value[threadId] ?? "",
    setComposer(threadId, text) {
      composers.value = { ...composers.value, [threadId]: text };
    },
    clearComposer(threadId) {
      const next = { ...composers.value };
      delete next[threadId];
      composers.value = next;
    },
    entriesFor: (threadId) => entries.value[threadId] ?? [],
    appendEntries(threadId, page) {
      entries.value = {
        ...entries.value,
        [threadId]: [...(entries.value[threadId] ?? []), ...page],
      };
    },
    resetForPath(path) {
      // Same file (an edit-mode toggle, a re-render, a poll): keep everything.
      if (path === currentPath) return;
      currentPath = path;
      activeThreadId.value = null;
      draft.value = null;
      composers.value = {};
      entries.value = {};
      trayOpen.value = true;
    },
  };
}

const COMMENT_UI: InjectionKey<CommentUiState> = Symbol("treehouse.commentUi");

/** Install the shared interaction state (workspace view only). */
export function provideCommentUi(): CommentUiState {
  const state = createCommentUiState();
  provide(COMMENT_UI, state);
  return state;
}

/**
 * The shared interaction state, or a detached one when no provider is above us.
 * The fallback keeps a stray call site (a test harness, the share page's tree)
 * from throwing — it just gets state nobody else can see.
 */
export function useCommentUi(): CommentUiState {
  return inject(COMMENT_UI, null) ?? createCommentUiState();
}

/** One query key per (workspace, path) — the viewer and the panel share it. */
export function commentsQueryKey(workspaceId?: string, path?: string) {
  return ["comments", workspaceId, path] as const;
}

export interface UseComments {
  threads: ComputedRef<CommentThreadView[]>;
  /** How many threads the file has in total, loaded or not. */
  total: ComputedRef<number>;
  hasMore: Ref<boolean>;
  loadingMore: Ref<boolean>;
  loadMore: () => Promise<unknown>;
  /** Pull the next page of one thread's replies into the shared UI state. */
  loadMoreEntries: (threadId: string) => Promise<void>;
  loading: Ref<boolean>;
  error: ComputedRef<string | null>;
  refresh: () => Promise<unknown>;
  create: (draft: CommentDraft) => Promise<CreateCommentResult>;
  reply: (threadId: string, body: string) => Promise<void>;
  setResolved: (threadId: string, resolved: boolean) => Promise<void>;
}

export function useComments(
  workspaceId: Ref<string | undefined>,
  path: Ref<string | undefined>,
): UseComments {
  const api = useTreehouseApi();
  const qc = useQueryClient();
  const ui = useCommentUi();

  // Paged under the SAME key, as an infinite query rather than a key per page:
  // every extra page lands in the one cache entry the overlay, the panel and
  // the track-changes view already share, so loading more can't make them
  // disagree about which threads exist. It also survives the 5s poll — an
  // invalidate refetches every loaded page, so "show more" is not undone.
  const query = useInfiniteQuery({
    queryKey: computed(() => commentsQueryKey(workspaceId.value, path.value)),
    queryFn: ({ pageParam }) =>
      api.listComments(workspaceId.value as string, path.value as string, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled: computed(() => !!workspaceId.value && !!path.value),
    staleTime: 10_000,
  });
  const threads = computed(() => mergeThreadPages(query.data.value?.pages ?? []));

  async function invalidate() {
    await qc.invalidateQueries({
      queryKey: commentsQueryKey(workspaceId.value, path.value),
    });
    // Comment ops are change events too — the feed badge should notice.
    void qc.invalidateQueries({ queryKey: ["activity"] });
  }

  /**
   * Pull one thread's next page of replies. The offset is what is on screen for
   * that thread right now (its first page plus anything already pulled), read
   * fresh each time so a reply landing mid-flight shifts nothing — an overlap
   * is deduped where the two halves are merged.
   */
  async function loadMoreEntries(threadId: string) {
    const t = threads.value.find((x) => x.id === threadId);
    if (!t) return;
    const offset = t.entries.length + ui.entriesFor(threadId).length;
    const page = await api.listCommentEntries(workspaceId.value as string, threadId, offset);
    if (page.length) ui.appendEntries(threadId, page);
  }

  return {
    threads,
    // The freshest page states the count; before the first page lands, what we
    // have loaded is all there is to report.
    total: computed(() => query.data.value?.pages.at(-1)?.total ?? threads.value.length),
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => query.fetchNextPage(),
    loadMoreEntries,
    loading: query.isPending,
    error: computed(() => (query.error.value as Error | null)?.message ?? null),
    refresh: () =>
      qc.invalidateQueries({ queryKey: commentsQueryKey(workspaceId.value, path.value) }),

    async create(draft) {
      const res = await api.createComment(workspaceId.value as string, {
        path: draft.path,
        body: draft.body,
        kind: draft.kind,
        quote: draft.kind === "range" ? draft.quote : undefined,
        contextBefore: draft.contextBefore || undefined,
        contextAfter: draft.contextAfter || undefined,
        baseVersion: draft.baseVersion,
      });
      if (res.status === "created") await invalidate();
      return res;
    },

    async reply(threadId, body) {
      await api.replyToComment(workspaceId.value as string, threadId, body);
      await invalidate();
      // A reader who paged this thread open is looking at a tail the refreshed
      // list doesn't carry — including, now, their own reply. Pull it in, or
      // posting into a long thread looks like it did nothing.
      if (ui.entriesFor(threadId).length) await loadMoreEntries(threadId);
    },

    async setResolved(threadId, resolved) {
      await api.setCommentResolved(workspaceId.value as string, threadId, resolved);
      await invalidate();
    },
  };
}