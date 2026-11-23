<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

// Restricted items nobody left in the workspace can reach. Owners see their names
// and can take one over; the claim shows in the activity feed.
const emit = defineEmits<{ error: [message: string] }>();

const api = useTreehouseApi();
const qc = useQueryClient();
const ws = useWorkspaceData();
const workspaceId = computed(() => ws.workspaceId.value);

const orphansQuery = useQuery({
  queryKey: computed(() => ["orphans", workspaceId.value]),
  queryFn: () => api.getOrphans(workspaceId.value as string).then((r) => r.orphans),
  enabled: computed(() => !!workspaceId.value),
});
const orphans = computed(() => orphansQuery.data.value ?? []);
const claimMutation = useMutation({
  mutationFn: (path: string) => api.claimOrphan(workspaceId.value as string, path),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ["orphans", workspaceId.value] });
    void qc.invalidateQueries({ queryKey: ["entries"] });
  },
  onError: (e) => emit("error", (e as Error).message),
});
function claim(path: string) {
  const question = `Take over ${path}? You'll be able to see everything in it, and the workspace's activity will show that you did.`;
  if (confirm(question)) claimMutation.mutate(path);
}
</script>

<template>
  <div v-if="orphans.length" class="space-y-2 border-t border-border pt-4">
    <p class="text-sm font-medium text-fg">Items nobody can reach</p>
    <p class="text-[13px] text-fg-subtle">
      Everyone with access to these has left. You can see their names only, until you take one over.
    </p>
    <ul class="divide-y divide-border text-sm">
      <li v-for="o in orphans" :key="o.path" class="flex items-center gap-3 py-2">
        <!-- ph-mask: user-authored path. -->
        <span class="ph-mask min-w-0 flex-1 truncate text-fg">{{ o.path }}</span>
        <button
          type="button"
          :disabled="claimMutation.isPending.value"
          class="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted transition hover:bg-surface-2 disabled:opacity-50"
          @click="claim(o.path)"
        >
          Take over
        </button>
      </li>
    </ul>
  </div>
</template>