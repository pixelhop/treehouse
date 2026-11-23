<script setup lang="ts">
import IconSoundwave from "~icons/solar/soundwave-bold-duotone";
import { basename, prettyBytes } from "~/utils/format";
import BinaryViewer from "./BinaryViewer.vue";

// Video and audio, played by the browser's own player straight from the file's
// URL. The bytes are never fetched into a blob first: the player asks for byte
// ranges as it goes (the API answers 206), so a long video starts at once and a
// jump to the middle costs only the bytes around it.
//
// No `crossorigin` attribute, deliberately. Without it the request carries the
// session cookie (or a share's unlock cookie) the way an <img> does. With it,
// the player would make a CORS request, which needs nothing it can't already do
// and fails outright on any origin the API doesn't list.
const props = defineProps<{
  src: string;
  /** Where the Download links point: a URL that saves the file, not one that plays it. */
  downloadHref: string;
  name: string;
  size: number;
  kind: "video" | "audio";
}>();
// As ImageViewer: a failed load on a password-protected share is how an expired
// unlock cookie shows up, so the share view needs to hear about it.
const emit = defineEmits<{ error: [] }>();

// "soundOnly": a video with no picture this browser can show. "failed": nothing
// played at all, so the file is offered as a download instead.
const state = ref<"playing" | "soundOnly" | "failed">("playing");
watch(
  () => props.src,
  () => {
    state.value = "playing";
  },
);

const fileName = computed(() => basename(props.name));
const prettySize = computed(() => (props.size > 0 ? prettyBytes(props.size) : null));
const showVideo = computed(() => props.kind === "video" && state.value === "playing");

// A browser that can't decode a video's picture (HEVC in a browser without it,
// say) doesn't fail the file: it drops the picture and plays the sound over a
// blank frame. A video file with no picture at all looks the same from here.
// Either way there is nothing to look at, so the sound gets the audio player
// and a line saying why.
function onVideoMetadata(e: Event) {
  const video = e.target as HTMLVideoElement;
  if (video.videoWidth === 0 && video.videoHeight === 0) state.value = "soundOnly";
}

function onFailed() {
  state.value = "failed";
  emit("error");
}
</script>

<template>
  <BinaryViewer
    v-if="state === 'failed'"
    :href="downloadHref"
    :name="name"
    :size="size"
    :note="`this browser couldn't play this ${kind}`"
  />
  <div v-else-if="showVideo" class="flex h-full flex-col gap-3">
    <div
      class="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-app p-4"
    >
      <video
        :src="src"
        controls
        playsinline
        preload="metadata"
        class="max-h-full max-w-full rounded-md"
        @loadedmetadata="onVideoMetadata"
        @error="onFailed"
      />
    </div>
    <p class="truncate text-center text-xs text-fg-subtle" :title="fileName">{{ fileName }}</p>
  </div>
  <div v-else class="flex flex-1 items-center justify-center">
    <div
      class="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-6 text-center shadow-sm"
    >
      <IconSoundwave class="mx-auto h-10 w-10 text-fg-muted" />
      <div>
        <p class="truncate font-medium text-fg" :title="fileName">{{ fileName }}</p>
        <p v-if="prettySize" class="text-sm text-fg-muted">{{ prettySize }}</p>
      </div>
      <audio :src="src" controls preload="metadata" class="w-full" @error="onFailed" />
      <p v-if="state === 'soundOnly'" class="text-sm text-fg-muted">
        Sound only. If this file has a picture, this browser can't show it:
        <a :href="downloadHref" class="text-accent hover:underline">download it</a>
        to watch.
      </p>
    </div>
  </div>
</template>