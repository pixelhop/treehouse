<script setup lang="ts">
import { Icon } from "@iconify/vue";
import { uploadedIconHash } from "shared";
import { workspaceColorClass } from "~/utils/workspaceColors";

const props = withDefaults(
  defineProps<{
    icon?: string | null;
    color?: string | null;
    size?: "sm" | "md" | "lg";
    /** Needed to build the bytes URL for an uploaded image icon. */
    workspaceId?: string | null;
    /** Local preview (an object URL) that stands in for the stored image —
     *  used by the picker before the upload has happened. */
    imageSrc?: string | null;
  }>(),
  { size: "md" },
);

const api = useTreehouseApi();

// An Iconify name (e.g. "solar:folder-bold-duotone") contains a colon; anything
// else is treated as an emoji.
const isIconify = computed(() => !!props.icon && !isUpload.value && props.icon.includes(":"));
const isUpload = computed(() => uploadedIconHash(props.icon) !== null);

const sourceUrl = computed(
  () =>
    props.imageSrc ??
    (props.workspaceId ? api.workspaceIconUrl(props.workspaceId, props.icon) : null),
);

// If the bytes can't be fetched — offline, or a pointer that outlived its blob —
// fall back to the emoji/default tile. A broken-image glyph in the sidebar is
// worse than the icon the workspace wore before anyone uploaded anything. Reset
// on a new source so a fresh upload isn't judged by the last one's failure.
const broken = ref(false);
watch(sourceUrl, () => {
  broken.value = false;
});

const imageUrl = computed(() => (broken.value ? null : sourceUrl.value));

const tileClass = computed(
  () =>
    ({
      sm: "h-6 w-6 rounded-md text-sm",
      md: "h-8 w-8 rounded-lg text-lg",
      lg: "h-12 w-12 rounded-xl text-2xl",
    })[props.size],
);
</script>

<template>
  <!-- An uploaded logo brings its own colours: it sits on a plain light tile
       rather than the palette colour, so dark artwork and transparent PNGs stay
       legible in every theme. -->
  <span
    v-if="imageUrl"
    class="grid shrink-0 place-items-center overflow-hidden bg-white ring-1 ring-black/10"
    :class="tileClass"
  >
    <img
      :src="imageUrl"
      alt=""
      class="h-full w-full object-contain p-[7%]"
      @error="broken = true"
    />
  </span>
  <span
    v-else
    class="grid shrink-0 place-items-center text-white"
    :class="[workspaceColorClass(color), tileClass]"
  >
    <Icon v-if="isIconify" :icon="icon as string" class="h-1/2 w-1/2" />
    <!-- An upload with no way to resolve its URL falls back to the default,
         never to the raw "upload:<hash>" string. -->
    <span v-else-if="icon && !isUpload">{{ icon }}</span>
    <Icon v-else icon="solar:folder-bold-duotone" class="h-1/2 w-1/2" />
  </span>
</template>