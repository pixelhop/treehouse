<script setup lang="ts">
// External-file drop zone for uploads. Distinct from the in-tree node drag
// (FileTree/useFileTreeUi), which moves existing nodes — this only reacts to OS
// file drags (dataTransfer "Files") and to the Upload button (openPicker). Files
// land in `destDir`; name collisions are resolved once per drop.
import type { UploadStrategy } from "~/composables/useWorkspaceData";
import { uploadPath } from "~/utils/upload";

const props = defineProps<{ destDir: string; disabled?: boolean }>();
const ws = useWorkspaceData();

const fileInput = ref<HTMLInputElement | null>(null);
// Counter, not a boolean — dragenter/leave also fire on child elements.
const dragDepth = ref(0);
const dragging = computed(() => dragDepth.value > 0);
const pending = ref<File[] | null>(null);
const collisions = ref<string[]>([]);
const progress = ref<{ done: number; total: number } | null>(null);

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
function onDragEnter(e: DragEvent) {
  if (hasFiles(e)) {
    e.preventDefault();
    if (!props.disabled) dragDepth.value += 1;
  }
}
function onDragOver(e: DragEvent) {
  if (hasFiles(e)) e.preventDefault();
}
function onDragLeave() {
  if (dragDepth.value > 0) dragDepth.value -= 1;
}
function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth.value = 0;
  intake(Array.from(e.dataTransfer?.files ?? []));
}

function openPicker() {
  fileInput.value?.click();
}
function onPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  intake(files);
}

function intake(files: File[]) {
  // The drag handlers still claim the drop when disabled: left alone, the
  // browser would navigate away to the dropped file.
  if (props.disabled || !files.length) return;
  const existing = new Set(ws.entries.value.map((x) => x.path));
  const collided = files
    .map((f) => uploadPath(props.destDir, f.name))
    .filter((p) => existing.has(p));
  if (collided.length) {
    pending.value = files;
    collisions.value = collided;
  } else {
    void run(files, "keep-both");
  }
}

async function resolve(strategy: UploadStrategy) {
  const files = pending.value ?? [];
  pending.value = null;
  collisions.value = [];
  await run(files, strategy);
}
function cancel() {
  pending.value = null;
  collisions.value = [];
}

async function run(files: File[], strategy: UploadStrategy) {
  progress.value = { done: 0, total: files.length };
  try {
    const result = await ws.uploadFiles(files, props.destDir, strategy, (done, total) => {
      progress.value = { done, total };
    });
    if (result?.failures.length) {
      window.alert(
        `${result.failures.length} file(s) failed to upload:\n${result.failures.map((f) => f.path).join("\n")}`,
      );
    }
  } catch (err) {
    window.alert(`Upload failed: ${(err as Error).message}`);
  } finally {
    progress.value = null;
  }
}

defineExpose({ openPicker });
</script>

<template>
  <div
    class="relative flex min-h-0 flex-1 flex-col"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <input ref="fileInput" type="file" multiple class="hidden" @change="onPicked" />
    <slot />

    <!-- Drag highlight -->
    <div
      v-if="dragging"
      class="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent"
    >
      Drop to upload{{ destDir ? ` to ${destDir}` : "" }}
    </div>

    <!-- Collision resolution -->
    <div
      v-if="pending"
      class="absolute inset-x-2 bottom-2 z-20 rounded-md border border-border bg-surface p-3 text-sm shadow-lg"
    >
      <p class="mb-2 text-fg">
        {{ collisions.length }} file{{ collisions.length === 1 ? "" : "s" }} already exist here.
      </p>
      <div class="flex flex-wrap gap-1.5">
        <button
          type="button"
          class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent/90"
          @click="resolve('keep-both')"
        >
          Keep both
        </button>
        <button
          type="button"
          class="rounded-md border border-border px-2.5 py-1 text-xs text-fg hover:bg-surface-2"
          @click="resolve('overwrite')"
        >
          Overwrite
        </button>
        <button
          type="button"
          class="rounded-md border border-border px-2.5 py-1 text-xs text-fg hover:bg-surface-2"
          @click="resolve('skip')"
        >
          Skip existing
        </button>
        <button
          type="button"
          class="ml-auto rounded-md px-2.5 py-1 text-xs text-fg-muted hover:text-fg"
          @click="cancel"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- Progress -->
    <div
      v-if="progress"
      class="absolute inset-x-2 bottom-2 z-20 rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg-muted shadow-lg"
    >
      Uploading {{ progress.done }} / {{ progress.total }}…
    </div>
  </div>
</template>