<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

// Agents connected over OAuth: each is one app's sign-in, named by the user on
// the consent screen. Renaming changes the label on its future changes;
// disconnecting stops it on its next request.
const api = useTreehouseApi();
const qc = useQueryClient();
const errorMsg = ref<string | null>(null);

const query = useQuery({
  queryKey: ["mcp-connections"],
  queryFn: () => api.listConnections().then((r) => r.connections),
});
const connections = computed(() => query.data.value ?? []);

const editingId = ref<string | null>(null);
const draft = ref("");
function startRename(id: string, current: string) {
  editingId.value = id;
  draft.value = current;
}

const renameMutation = useMutation({
  mutationFn: ({ id, name }: { id: string; name: string }) => api.renameConnection(id, name),
  onSuccess: () => {
    editingId.value = null;
    void qc.invalidateQueries({ queryKey: ["mcp-connections"] });
  },
  onError: (e) => {
    errorMsg.value = (e as Error).message;
  },
});
function saveRename(id: string) {
  errorMsg.value = null;
  renameMutation.mutate({ id, name: draft.value.trim() });
}

const disconnectMutation = useMutation({
  mutationFn: (id: string) => api.disconnectConnection(id),
  onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-connections"] }),
  onError: (e) => {
    errorMsg.value = (e as Error).message;
  },
});
function disconnect(id: string, name: string) {
  if (!confirm(`Disconnect ${name}? It stops working straight away and has to sign in again.`))
    return;
  errorMsg.value = null;
  disconnectMutation.mutate(id);
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
</script>

<template>
  <div class="space-y-2">
    <p class="text-sm font-medium text-fg">Connected agents</p>
    <div
      v-if="errorMsg"
      class="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
    >
      {{ errorMsg }}
    </div>
    <div v-if="query.isPending.value" class="text-sm text-fg-subtle">Loading…</div>
    <ul v-else-if="connections.length" class="divide-y divide-border text-sm">
      <li v-for="c in connections" :key="c.id" class="flex items-center justify-between gap-3 py-2">
        <form
          v-if="editingId === c.id"
          class="flex min-w-0 flex-1 items-center gap-2"
          @submit.prevent="saveRename(c.id)"
        >
          <input
            v-model="draft"
            maxlength="80"
            aria-label="Connection name"
            class="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          />
          <button type="submit" class="text-xs font-medium text-accent">Save</button>
          <button type="button" class="text-xs text-fg-muted" @click="editingId = null">
            Cancel
          </button>
        </form>
        <template v-else>
          <div class="min-w-0">
            <p class="truncate text-fg">{{ c.name }}</p>
            <p class="truncate text-xs text-fg-subtle">
              <template v-if="c.clientName && c.clientName !== c.name"
                >{{ c.clientName }} · </template
              >Connected {{ dateFmt.format(new Date(c.connectedAt)) }}
            </p>
          </div>
          <div class="flex shrink-0 gap-3 text-xs">
            <button
              type="button"
              class="text-fg-muted hover:text-fg"
              @click="startRename(c.id, c.name)"
            >
              Rename
            </button>
            <button type="button" class="text-danger" @click="disconnect(c.id, c.name)">
              Disconnect
            </button>
          </div>
        </template>
      </li>
    </ul>
    <p v-else class="text-sm text-fg-subtle">
      None yet. Agents you connect show up here under the name you give them.
    </p>
  </div>
</template>