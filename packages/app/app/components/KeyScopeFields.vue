<script setup lang="ts">
// What a key may do: read-only, and/or limited to one folder. Shared by key
// creation and the device approval screen, so the two offer the same thing and
// describe it the same way.
const access = defineModel<"write" | "read">("access", { required: true });
/** A folder, "" for the whole workspace, or null for every workspace (see `allWorkspaces`). */
const folder = defineModel<string | null>("folder", { required: true });
defineProps<{
  folders: string[];
  /** Also offer a key that isn't tied to one workspace. */
  allWorkspaces?: boolean;
}>();
</script>

<template>
  <div class="space-y-3 text-sm">
    <label class="block">
      <span class="mb-1 block text-fg-muted">Access</span>
      <select
        v-model="access"
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
      >
        <option value="write">Read and write</option>
        <option value="read">Read only</option>
      </select>
    </label>
    <label class="block">
      <span class="mb-1 block text-fg-muted">Reach</span>
      <select
        v-model="folder"
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
      >
        <option v-if="allWorkspaces" :value="null">All your workspaces</option>
        <option value="">{{ allWorkspaces ? "This workspace" : "The whole workspace" }}</option>
        <option v-for="f in folders" :key="f" :value="f">{{ f }}</option>
      </select>
    </label>
    <p class="text-xs text-fg-subtle">Never more than you can do yourself.</p>
  </div>
</template>