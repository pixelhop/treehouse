<script setup lang="ts">
import IconGallery from "~icons/solar/gallery-bold-duotone";
import { basename } from "~/utils/format";

const props = defineProps<{ src: string; name: string }>();
// A failed load can mean more than a broken file — on a password-protected
// public share it is how an expired unlock cookie shows up, and the viewer
// needs the chance to re-raise its gate.
const emit = defineEmits<{ error: [] }>();

const fileName = computed(() => basename(props.name));
const failed = ref(false);

// Reset the error state when switching between images.
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <div class="flex h-full flex-col gap-3">
    <div
      class="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-border bg-app p-4"
    >
      <img
        v-if="!failed"
        :src="src"
        :alt="fileName"
        class="max-h-full max-w-full object-contain"
        @error="
          failed = true;
          emit('error');
        "
      />
      <div v-else class="space-y-2 text-center text-sm text-fg-muted">
        <IconGallery class="mx-auto h-10 w-10 text-fg-muted" />
        <p>Couldn't load this image.</p>
        <a :href="src" target="_blank" rel="noopener" class="text-accent hover:underline"
          >Open directly</a
        >
      </div>
    </div>
    <p class="truncate text-center text-xs text-fg-subtle" :title="fileName">{{ fileName }}</p>
  </div>
</template>