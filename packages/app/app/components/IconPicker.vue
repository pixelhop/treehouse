<script setup lang="ts">
import { Icon } from "@iconify/vue";
import { uploadedIconHash } from "shared";
import { ICON_ACCEPT, IconImageError, prepareIconImage } from "~/utils/iconImage";
import { WORKSPACE_COLOR_KEYS, workspaceColorClass } from "~/utils/workspaceColors";

const props = defineProps<{
  icon: string | null;
  color?: string | null;
  hideColor?: boolean;
  /** Offer the Upload tab (workspaces only — file/folder icons are glyphs). */
  allowUpload?: boolean;
  /** The current image icon's URL — either the stored one or a local preview of
   *  an image the parent is holding but hasn't uploaded yet. */
  imageUrl?: string | null;
}>();
const emit = defineEmits<{
  "update:icon": [string | null];
  "update:color": [string];
  /** A prepared square PNG for the parent to upload on save; null clears it. */
  "update:image": [Blob | null];
  /** True while an image is being decoded and squared up. Preparation is async,
   *  so a parent that saves during it would save without the pick. */
  "update:preparing": [boolean];
}>();

const hasImage = computed(() => !!props.imageUrl || uploadedIconHash(props.icon) !== null);
const tab = ref<"emoji" | "icon" | "upload">(
  hasImage.value ? "upload" : props.icon?.includes(":") ? "icon" : "emoji",
);

const EMOJI = [
  "🌳",
  "📁",
  "📂",
  "🗂️",
  "📝",
  "📄",
  "📊",
  "📈",
  "🚀",
  "💡",
  "🔥",
  "⭐",
  "✅",
  "🎯",
  "🧠",
  "🔧",
  "🎨",
  "📦",
  "💾",
  "🌐",
  "🔒",
  "🏷️",
  "📌",
  "🗓️",
  "💬",
  "👥",
  "🤖",
  "⚙️",
  "🧪",
  "🐛",
  "📚",
  "🏠",
];

const query = ref("");
const results = ref<string[]>([]);
const searching = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;

watch(query, (q) => {
  clearTimeout(timer);
  controller?.abort(); // cancel an in-flight search so a slow one can't clobber
  if (!q.trim()) {
    results.value = [];
    return;
  }
  timer = setTimeout(async () => {
    controller = new AbortController();
    searching.value = true;
    try {
      const r = await $fetch<{ icons?: string[] }>("https://api.iconify.design/search", {
        query: { query: q, prefix: "solar", limit: 48 },
        signal: controller.signal,
      });
      results.value = r.icons ?? [];
    } catch {
      // Ignore aborts; a real failure just yields no results.
    } finally {
      searching.value = false;
    }
  }, 250);
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  controller?.abort();
});

// --- upload -----------------------------------------------------------------
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const uploadError = ref<string | null>(null);
const preparing = ref(false);

// Decoding is async, so a second pick (or a Remove) can land while the first is
// still working. Only the newest attempt may report — otherwise a slow first
// image overwrites the one the user actually chose, or reappears after removal.
let attempt = 0;

watch(preparing, (v) => emit("update:preparing", v));

async function accept(file: File | null | undefined) {
  if (!file) return;
  const mine = ++attempt;
  uploadError.value = null;
  preparing.value = true;
  try {
    const image = await prepareIconImage(file);
    if (mine === attempt) emit("update:image", image);
  } catch (e) {
    if (mine === attempt) {
      uploadError.value =
        e instanceof IconImageError ? e.message : "Couldn't use that image — try a PNG.";
    }
  } finally {
    if (mine === attempt) preparing.value = false;
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  void accept(e.dataTransfer?.files?.[0]);
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  void accept(input.files?.[0]);
  // Reset so re-picking the same file still fires a change event.
  input.value = "";
}

function removeImage() {
  attempt += 1; // an in-flight decode must not resurrect the removed image
  preparing.value = false;
  uploadError.value = null;
  emit("update:image", null);
  emit("update:icon", null);
}

/** Picking an emoji/icon replaces an image icon, so drop any pending upload. */
function chooseGlyph(value: string) {
  attempt += 1;
  preparing.value = false;
  if (hasImage.value) emit("update:image", null);
  emit("update:icon", value);
}
</script>

<template>
  <div class="space-y-3">
    <!-- tabs -->
    <div class="inline-flex rounded-md border border-border bg-app p-0.5 text-xs">
      <button
        type="button"
        class="rounded px-2.5 py-1 transition"
        :class="tab === 'emoji' ? 'bg-surface font-medium text-fg shadow-sm' : 'text-fg-muted'"
        @click="tab = 'emoji'"
      >
        Emoji
      </button>
      <button
        type="button"
        class="rounded px-2.5 py-1 transition"
        :class="tab === 'icon' ? 'bg-surface font-medium text-fg shadow-sm' : 'text-fg-muted'"
        @click="tab = 'icon'"
      >
        Icon
      </button>
      <button
        v-if="allowUpload"
        type="button"
        class="rounded px-2.5 py-1 transition"
        :class="tab === 'upload' ? 'bg-surface font-medium text-fg shadow-sm' : 'text-fg-muted'"
        @click="tab = 'upload'"
      >
        Upload
      </button>
    </div>

    <!-- emoji grid -->
    <div v-if="tab === 'emoji'" class="grid grid-cols-8 gap-1">
      <button
        v-for="e in EMOJI"
        :key="e"
        type="button"
        class="grid h-8 place-items-center rounded-md text-lg transition hover:bg-surface-2"
        :class="!hasImage && icon === e ? 'bg-accent/10 ring-1 ring-accent/40' : ''"
        @click="chooseGlyph(e)"
      >
        {{ e }}
      </button>
    </div>

    <!-- logo / image upload -->
    <div v-else-if="tab === 'upload'" class="space-y-2">
      <div
        class="flex items-center gap-3 rounded-lg border border-dashed px-3 py-3 transition"
        :class="dragging ? 'border-accent bg-accent/5' : 'border-border bg-app'"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <WorkspaceIcon
          v-if="imageUrl"
          :icon="icon"
          :color="color"
          :image-src="imageUrl"
          size="lg"
        />
        <div class="min-w-0 flex-1 text-xs text-fg-muted">
          <p v-if="preparing" class="text-fg">Preparing image…</p>
          <template v-else>
            <button
              type="button"
              class="font-medium text-accent hover:underline"
              @click="fileInput?.click()"
            >
              {{ imageUrl ? "Replace image" : "Choose an image" }}
            </button>
            <span> or drop one here</span>
            <p class="mt-0.5 text-fg-subtle">PNG, JPEG, GIF, WebP or SVG — squared up for you.</p>
          </template>
        </div>
        <button
          v-if="imageUrl"
          type="button"
          class="shrink-0 text-xs text-fg-muted transition hover:text-fg"
          @click="removeImage"
        >
          Remove
        </button>
      </div>
      <p v-if="uploadError" class="text-xs text-danger">{{ uploadError }}</p>
      <input ref="fileInput" type="file" class="hidden" :accept="ICON_ACCEPT" @change="onPick" />
    </div>

    <!-- icon search -->
    <div v-else class="space-y-2">
      <input
        v-model="query"
        type="search"
        placeholder="Search Solar icons…"
        class="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <p v-if="searching" class="text-xs text-fg-subtle">Searching…</p>
      <p v-else-if="query && !results.length" class="text-xs text-fg-subtle">No icons found.</p>
      <div v-else class="grid max-h-40 grid-cols-8 gap-1 overflow-auto">
        <button
          v-for="name in results"
          :key="name"
          type="button"
          :title="name"
          class="grid h-8 place-items-center rounded-md text-fg transition hover:bg-surface-2"
          :class="!hasImage && icon === name ? 'bg-accent/10 ring-1 ring-accent/40' : ''"
          @click="chooseGlyph(name)"
        >
          <Icon :icon="name" class="h-5 w-5" />
        </button>
      </div>
    </div>

    <!-- Colour swatches — hidden on the upload tab, where the tile takes its
         colours from the artwork and the palette would do nothing. -->
    <div v-if="!hideColor && tab !== 'upload'" class="flex items-center gap-1.5 pt-1">
      <button
        v-for="c in WORKSPACE_COLOR_KEYS"
        :key="c"
        type="button"
        :title="c"
        class="h-6 w-6 rounded-full transition"
        :class="[workspaceColorClass(c), color === c ? 'ring-2 ring-fg ring-offset-1' : '']"
        @click="emit('update:color', c)"
      />
    </div>
  </div>
</template>