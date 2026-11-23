// Workspace-wide activity feed: a polled vue-query over the recent change-feed
// window (newest-first by seq). Unlike useChangeFeedPoll (which only runs while
// a file is being edited), this polls whenever a workspace surface is open so
// the unread badge stays fresh on an idle workspace. Reads only — the watermark
// lives in useActivityWatermark.
import { useQuery } from "@tanstack/vue-query";
import type { Ref } from "vue";
import type { FeedEvent, RecoveryOperationInfo } from "~/utils/activity";

// Recent window size and poll cadence (tunables — see the plan's Open Questions).
const ACTIVITY_LIMIT = 200;
const POLL_MS = 15_000;

export function useActivityFeed(workspaceId: Ref<string | undefined>) {
  const api = useTreehouseApi();

  // Opted into comment events (KTD5) — review chatter is workspace activity, and
  // R13 says a comment shows up here. The key carries the opt so this window can
  // never be served to (or from) an un-opted reader's cache: the per-file History
  // tab and the share dialog read the same route without comments.
  const query = useQuery({
    queryKey: ["activity", "with-comments", workspaceId],
    queryFn: () => api.changesRecentWithComments(workspaceId.value as string, ACTIVITY_LIMIT),
    enabled: computed(() => !!workspaceId.value),
    refetchInterval: POLL_MS,
    staleTime: 0,
  });

  const events = computed<FeedEvent[]>(() => query.data.value?.changes ?? []);
  const head = computed(() => query.data.value?.head ?? 0);
  // Recovery operations behind events in the window, by id, for the feed labels.
  const operations = computed(
    () =>
      new Map<string, RecoveryOperationInfo>(
        (query.data.value?.operations ?? []).map((o) => [o.id, o]),
      ),
  );

  return {
    events,
    head,
    operations,
    loading: query.isPending,
    error: computed(() => (query.error.value as Error | null)?.message ?? null),
    refetch: () => query.refetch(),
  };
}