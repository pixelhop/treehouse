<script setup lang="ts">
import { useMutation, useQueryClient } from "@tanstack/vue-query";

// Shared dialog for setting a file/folder's icon. Driven by ws.editingIconPath.
const ws = useWorkspaceData();
const api = useTreehouseApi();
const qc = useQueryClient();

const path = computed(() => ws.editingIconPath.value);
const icon = ref<string | null>(null);

// Seed from the node's current icon when the dialog opens.
watch(path, (p) => {
  icon.value = p ? (ws.icons.value[p] ?? null) : null;
});

const mutation = useMutation({
  mutationFn: (next: string | null) =>
    api.setNodeIcon(ws.workspaceId.value as string, path.value as string, next),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ["entries"] });
    ws.editingIconPath.value = null;
  },
});

const name = computed(() => path.value?.split("/").pop() ?? "");
function close() {
  ws.editingIconPath.value = null;
}
</script>

<template>
  <div
    v-if="path"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="close"
  >
    <div class="w-full max-w-sm space-y-4 rounded-xl border border-border bg-surface p-6 shadow-xl">
      <div>
        <p class="text-xs uppercase tracking-[0.2em] text-fg-subtle">Icon</p>
        <!-- ph-mask: this is the user-authored file or folder name. -->
        <h3 class="ph-mask truncate text-lg font-semibold text-fg" :title="path">{{ name }}</h3>
      </div>

      <IconPicker :icon="icon" hide-color @update:icon="icon = $event" />

      <div class="flex items-center justify-between pt-1">
        <button
          type="button"
          :disabled="mutation.isPending.value"
          class="rounded-md px-2 py-1.5 text-sm text-fg-muted transition hover:bg-surface-2 disabled:opacity-50"
          @click="mutation.mutate(null)"
        >
          Reset to default
        </button>
        <div class="flex gap-2">
          <button
            type="button"
            :disabled="mutation.isPending.value"
            class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition hover:bg-surface-2 disabled:opacity-50"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="mutation.isPending.value"
            class="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg transition hover:bg-accent/90 disabled:opacity-50"
            @click="mutation.mutate(icon)"
          >
            {{ mutation.isPending.value ? "Saving…" : "Save" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>