// Per-user unread watermark for the activity feed. The persisted `lastSeenSeq`
// is shared across surfaces via the vue-query cache; the "new since you were
// here" divider is pinned per visit (frozen on advance) so it stays put while
// new events arrive above it. A fresh (unset) watermark seeds to the current
// head so existing history reads as already seen.
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import type { Ref } from "vue";
import { type FeedEvent, formatUnread, unreadCount } from "~/utils/activity";

interface ReadState {
  lastSeenSeq: number | null;
}

export function useActivityWatermark(
  workspaceId: Ref<string | undefined>,
  feed: { events: Ref<FeedEvent[]>; head: Ref<number> },
) {
  const api = useTreehouseApi();
  const qc = useQueryClient();

  const rsQuery = useQuery({
    queryKey: ["read-state", workspaceId],
    queryFn: () => api.getReadState(workspaceId.value as string),
    enabled: computed(() => !!workspaceId.value),
    staleTime: 60_000,
  });

  // Whether the persisted watermark has loaded. advance() must wait for this so
  // it freezes the divider at the real stored seq, not at head (cold-load race).
  const ready = computed(() => rsQuery.isSuccess.value);

  // The persisted watermark (null until the user has marked anything seen).
  const stored = computed<number | null>(() => rsQuery.data.value?.lastSeenSeq ?? null);

  // Client-side seed used only when nothing is persisted yet: the head at first
  // observation, so history counts as seen without writing on mere page load.
  const seeded = ref<number | null>(null);
  // The divider sits at the watermark, but freezes on the first advance of a
  // visit so it doesn't chase the head as new events arrive (R12, R19).
  const frozenDivider = ref<number | null>(null);

  // Reset and reseed in ONE watcher that observes the workspace. The seed and
  // the frozen divider are per-WORKSPACE facts, and this composable can outlive
  // a switch (the sidebar persists across /w/[id] routes while `workspaceId`
  // changes under it) — carrying them over would count one workspace's unread
  // against another's sequence numbers. Resetting from a SEPARATE watcher left
  // this one blind to the switch: between two cached workspaces whose
  // stored/isSuccess/head values compare equal it never re-fired, the watermark
  // sat at null (zero unread), and the NEXT event to arrive became the seed —
  // silently counted as already seen.
  watch(
    [workspaceId, stored, () => rsQuery.isSuccess.value, feed.head],
    ([id], old) => {
      if (old && id !== old[0]) {
        seeded.value = null;
        frozenDivider.value = null;
      }
      if (
        rsQuery.isSuccess.value &&
        stored.value == null &&
        seeded.value == null &&
        feed.head.value > 0
      ) {
        seeded.value = feed.head.value;
      }
    },
    { immediate: true },
  );

  // Effective watermark for unread/divider math: persisted, else the seed.
  const watermark = computed<number | null>(() => stored.value ?? seeded.value);

  const unread = computed(() => unreadCount(feed.events.value, watermark.value));
  const badge = computed(() => formatUnread(unread.value));

  const dividerSeq = computed<number | null>(() => frozenDivider.value ?? watermark.value);

  // Advance the watermark to the latest event (opening the full view, or an
  // explicit "mark all seen"). Pins the divider at the pre-advance position,
  // updates the shared cache optimistically, then persists.
  async function advance() {
    const id = workspaceId.value;
    if (!id || !ready.value) return; // wait for the stored watermark before freezing/advancing
    const target = Math.max(feed.head.value, watermark.value ?? 0);
    if (frozenDivider.value == null) frozenDivider.value = watermark.value ?? target;
    if (target <= (stored.value ?? -1)) return; // monotonic; nothing to do
    qc.setQueryData<ReadState>(["read-state", id], { lastSeenSeq: target });
    try {
      const res = await api.putReadState(id, target);
      qc.setQueryData<ReadState>(["read-state", id], { lastSeenSeq: res.lastSeenSeq });
    } catch {
      // Leave the optimistic value; a later refetch reconciles with the server.
    }
  }

  return { watermark, unread, badge, dividerSeq, ready, advance, markAllSeen: advance };
}