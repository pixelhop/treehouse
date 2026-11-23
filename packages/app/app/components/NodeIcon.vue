<script setup lang="ts">
import { Icon } from "@iconify/vue";
import IconFile from "~icons/solar/file-text-bold-duotone";
import IconFolder from "~icons/solar/folder-bold-duotone";

// Renders a file/folder's icon: a custom Iconify icon or emoji if set, else the
// default Solar folder/file. Size + colour come from the parent's class.
const props = defineProps<{ icon?: string | null; isDir: boolean }>();
const isIconify = computed(() => !!props.icon && props.icon.includes(":"));
</script>

<template>
  <Icon v-if="isIconify" :icon="icon || ''" />
  <span v-else-if="icon" class="grid place-items-center leading-none">{{ icon }}</span>
  <component :is="isDir ? IconFolder : IconFile" v-else />
</template>