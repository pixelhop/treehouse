// Resolves a change event's actorId (a user id) to a display name + avatar for
// the activity timeline, and lists members for the board's assignee picker.
// Cached per workspace via vue-query; the map is keyed by user id so lookups
// are O(1) per timeline row.
import { useQuery } from "@tanstack/vue-query";
import type { WorkspaceMember } from "~/composables/useTreehouseApi";

export function useWorkspaceMembers(workspaceId: Ref<string | undefined>) {
  const api = useTreehouseApi();

  const membersQuery = useQuery({
    queryKey: computed(() => ["members", workspaceId.value]),
    queryFn: () => api.getMembers(workspaceId.value as string).then((r) => r.members),
    enabled: computed(() => !!workspaceId.value),
    staleTime: 5 * 60 * 1000,
  });

  const list = computed(() => membersQuery.data.value ?? []);

  const byId = computed(() => {
    const map = new Map<string, WorkspaceMember>();
    for (const m of membersQuery.data.value ?? []) map.set(m.id, m);
    return map;
  });

  return { byId, list };
}