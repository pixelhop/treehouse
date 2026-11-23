<script setup lang="ts">
import IconFolder from "~icons/solar/folder-linear";

// "Where does this workspace sync to on this computer?" — a workspace property you set once
// and revisit rarely, so it belongs in the Customize dialog next to name, icon and
// colour, not in permanent sidebar real estate.
//
// Renders nothing in a browser: local folders don't exist there, and an
// explanatory empty state would be noise on the surface most people use.
//
// It sits BELOW the form's divider deliberately. Its actions are immediate — they
// open a native dialog and take effect on their own — whereas the fields above are
// staged until Save. Mixing the two in one visual group would imply Cancel could
// undo a folder move, which it cannot.
const props = defineProps<{ workspaceId: string }>();

const desktop = useDesktopFolders();
const busy = ref(false);
// A rejected action (IPC gone, native dialog failed) used to surface nowhere: the
// button simply re-enabled, which is indistinguishable from the user cancelling.
// The shell shows its own dialog for failures it can describe; this covers the ones
// that never reach it.
const error = ref("");

onMounted(() => {
  void desktop.refresh();
});

const folder = computed(() => desktop.folderFor(props.workspaceId));

async function run(action: (id: string) => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action(props.workspaceId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "That didn't work. Try again.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="desktop.available.value" class="border-t border-border pt-4">
    <p class="text-xs font-medium tracking-wide text-fg-subtle uppercase">Synced folder</p>

    <div v-if="folder" class="mt-2 flex items-center gap-2">
      <IconFolder class="h-4 w-4 shrink-0 text-fg-subtle" />
      <!-- ph-mask: the local folder name is user-authored filesystem data. -->
      <span
        class="ph-mask flex-1 truncate font-mono text-[13px] text-fg"
        :title="folder.folderName"
      >
        {{ folder.folderName }}
      </span>
      <span v-if="folder.paused" class="text-[11px] tracking-wide text-fg-subtle uppercase">
        paused
      </span>
      <button
        type="button"
        :disabled="busy"
        class="text-[13px] font-medium text-accent transition hover:opacity-80 disabled:opacity-50"
        @click="run(desktop.change)"
      >
        Change…
      </button>
      <button
        type="button"
        :disabled="busy"
        class="text-[13px] font-medium text-fg-muted transition hover:text-fg disabled:opacity-50"
        @click="run(desktop.reveal)"
      >
        Reveal
      </button>
    </div>

    <div v-else class="mt-2 flex items-center gap-3">
      <span class="flex-1 text-[13px] text-fg-muted"
        >Not syncing to a folder on this computer.</span
      >
      <button
        type="button"
        :disabled="busy"
        class="text-[13px] font-medium text-accent transition hover:opacity-80 disabled:opacity-50"
        @click="run(desktop.connect)"
      >
        Sync a folder…
      </button>
    </div>

    <!-- Always mounted, not `v-if`. A live region inserted at the moment it first
         has something to say is unreliable: several screen readers only watch
         regions that existed when they built their model, so the very first error —
         the one that matters — can go unannounced.

         Collapsed with `h-0 overflow-hidden` rather than `v-if`/`hidden`: it must
         stay in the accessibility tree to be watched, which `display:none` would
         undo, but it must not leave a blank line box under the row when there is
         nothing to say. -->
    <!-- ph-mask: native errors may echo a local filesystem path. -->
    <p
      role="status"
      aria-live="polite"
      class="ph-mask text-[13px] text-danger"
      :class="error ? 'mt-2' : 'h-0 overflow-hidden'"
    >
      {{ error }}
    </p>
  </div>
</template>