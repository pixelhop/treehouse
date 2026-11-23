<script setup lang="ts">
import type { TabView } from "~/utils/tabs";

// What right-clicking a tab offers. Acts on the shared tab state directly.
const props = defineProps<{ view: TabView; at: { x: number; y: number } }>();
const emit = defineEmits<{ close: [] }>();

const tabs = useWorkspaceTabs();
const sb = useSidebar();
const treeUi = useFileTreeUi();

const ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg transition hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40";

const id = computed(() => props.view.tab.id);
const onlyOne = computed(() => tabs.state.value.tabs.length <= 1);
const isLast = computed(() => tabs.state.value.tabs.at(-1)?.id === id.value);
const canReveal = computed(() => props.view.tab.kind === "path" && !props.view.gone);

async function copyLink() {
  try {
    await navigator.clipboard.writeText(new URL(props.view.tab.href, window.location.origin).href);
  } catch {
    // clipboard refused — nothing useful to say about it here
  }
}
function reveal() {
  if (!sb.open.value) sb.toggle();
  treeUi.locate(props.view.tab.path);
}
</script>

<template>
  <ModalSurface
    role="menu"
    label="Tab actions"
    placement="point"
    :at="at"
    :scrim="false"
    panel-class="w-56 rounded-xl p-1.5"
    @close="emit('close')"
  >
    <div class="contents" @click="emit('close')">
      <button type="button" :class="ROW" :disabled="onlyOne" @click="tabs.close(id)">
        Close tab <span class="ml-auto text-xs text-fg-subtle">⌥W</span>
      </button>
      <button type="button" :class="ROW" :disabled="onlyOne" @click="tabs.closeOthers(id)">
        Close other tabs
      </button>
      <button type="button" :class="ROW" :disabled="isLast" @click="tabs.closeRight(id)">
        Close tabs to the right
      </button>
      <hr class="my-1 border-border" />
      <button type="button" :class="ROW" @click="tabs.duplicate(id)">Duplicate tab</button>
      <button type="button" :class="ROW" @click="copyLink()">Copy link</button>
      <button v-if="canReveal" type="button" :class="ROW" @click="reveal()">
        Reveal in sidebar
      </button>
    </div>
  </ModalSurface>
</template>