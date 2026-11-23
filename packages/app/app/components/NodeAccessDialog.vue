<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { WorkspaceMember } from "~/composables/useTreehouseApi";
import {
  accessDraft,
  draftGrants,
  draftIsOpen,
  memberLevel,
  nearestRestriction,
} from "~/utils/treehouse";

// Who can reach one file or folder, each person as Viewer or Editor. Driven by
// ws.editingAccess. The server is the rule (see node-access.put.ts): this mirrors
// it so the dialog never offers a save that would be refused.
const ws = useWorkspaceData();
const api = useTreehouseApi();
const qc = useQueryClient();
const session = useAuthClient().useSession();

const node = computed(() => ws.editingAccess.value);
const workspaceId = computed(() => ws.workspaceId.value as string);
const meId = computed(() => session.value.data?.user?.id ?? null);
const name = computed(() => node.value?.path.split("/").pop() ?? "");

const membersQuery = useQuery({
  queryKey: computed(() => ["members", ws.workspaceId.value]),
  queryFn: () => api.getMembers(workspaceId.value).then((r) => r.members),
  enabled: computed(() => !!node.value),
});
const members = computed(() => membersQuery.data.value ?? []);
// Saving writes a list of people, so it needs the real one: without it, an
// exclusion would be dropped and that person let in.
const canSave = computed(() => membersQuery.isSuccess.value);
const loadFailed = computed(() =>
  membersQuery.isError.value ? "Couldn't load the members." : null,
);

const levels = ref<Record<string, string>>({});
const everyone = ref("none");
const errorMsg = ref<string | null>(null);

/** The restriction on exactly this node. One above it is replaced, not edited. */
const current = computed(() =>
  node.value ? (ws.restrictions.value.find((r) => r.path === node.value?.path) ?? null) : null,
);

// Start from who can reach it now, which may come from a folder above: saving
// replaces that here, so someone shown as "No access" would really lose it.
function loadDraft() {
  errorMsg.value = null;
  const draft = accessDraft(ws.restrictions.value, node.value?.path, meId.value);
  everyone.value = draft.everyone;
  levels.value = draft.levels;
}
watch([node, members], loadDraft, { immediate: true });

const levelOf = (m: WorkspaceMember) => memberLevel(m, levels.value, everyone.value);

function close() {
  ws.editingAccess.value = null;
}
function saved() {
  void qc.invalidateQueries({ queryKey: ["entries"] });
  void qc.invalidateQueries({ queryKey: ["changes"] });
  close();
}
const fail = (e: unknown) => {
  errorMsg.value = (e as { statusMessage?: string }).statusMessage ?? (e as Error).message;
};

const saveMutation = useMutation({
  mutationFn: () =>
    api.setNodeAccess(workspaceId.value, {
      path: node.value?.path as string,
      kind: node.value?.isDir ? "folder" : "file",
      everyone: everyone.value,
      grants: draftGrants(members.value, levels.value, everyone.value),
    }),
  onSuccess: saved,
  onError: fail,
});
const liftMutation = useMutation({
  mutationFn: () =>
    api.setNodeAccess(workspaceId.value, { path: node.value?.path as string, restricted: false }),
  onSuccess: saved,
  onError: fail,
});
const busy = computed(() => saveMutation.isPending.value || liftMutation.isPending.value);

/** Nothing restricts it now, from here or a folder above. */
const isOpen = computed(() => !nearestRestriction(ws.restrictions.value, node.value?.path ?? ""));
const intro = computed(() =>
  isOpen.value
    ? "Everyone in the workspace can see and edit this. Restricting it applies to the workspace's owners too, and stops links to it working."
    : "Only the people chosen here can see it, including the workspace's owners. Links to it stop working.",
);
// Left open, an open item needs no restriction, so there is nothing to save.
// Lifting an existing one is "Open to everyone": the server knows whether a
// folder above, maybe one the caller can't see, would then govern it.
function save() {
  if (isOpen.value && draftIsOpen(members.value, levels.value, everyone.value)) close();
  else saveMutation.mutate();
}
</script>

<template>
  <div
    v-if="node"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="close"
  >
    <div class="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl">
      <div>
        <p class="text-xs tracking-[0.2em] text-fg-subtle uppercase">Who can access</p>
        <!-- ph-mask: this is the user-authored file or folder name. -->
        <h3 class="ph-mask truncate text-lg font-semibold text-fg" :title="node.path">
          {{ name }}
        </h3>
        <p class="mt-1 text-sm text-fg-muted">{{ intro }}</p>
      </div>

      <div
        v-if="errorMsg || loadFailed"
        class="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
      >
        {{ errorMsg ?? loadFailed }}
      </div>

      <ul class="max-h-64 divide-y divide-border overflow-auto text-sm">
        <NodeAccessRow
          v-for="m in members"
          :key="m.id"
          :member="m"
          :level="levelOf(m)"
          :is-me="m.id === meId"
          @change="levels[m.id] = $event"
        />
      </ul>

      <label class="flex items-center justify-between gap-3 text-sm">
        <span class="text-fg-muted">Everyone else</span>
        <select
          v-model="everyone"
          class="rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none"
        >
          <option value="none">No access</option>
          <option value="read">Viewer</option>
          <option value="write">Editor</option>
        </select>
      </label>

      <div class="flex items-center justify-between pt-1">
        <button
          v-if="current"
          type="button"
          :disabled="busy"
          class="rounded-md px-2 py-1.5 text-sm text-fg-muted transition hover:bg-surface-2 disabled:opacity-50"
          @click="liftMutation.mutate()"
        >
          Open to everyone
        </button>
        <span v-else />
        <div class="flex gap-2">
          <button
            type="button"
            :disabled="busy"
            class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-surface-2 disabled:opacity-50"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="busy || !canSave"
            class="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
            @click="save"
          >
            {{ saveMutation.isPending.value ? "Saving…" : "Save" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>