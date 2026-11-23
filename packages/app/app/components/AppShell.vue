<script setup lang="ts">
// Full-screen app shell: collapsible left sidebar, full-bleed main area. Used by
// the signed-in surfaces (via layouts/app.vue) and by the public share viewer, so
// a shared folder sits in the same frame as the workspace it came from.
// `sidebar: false` drops the aside entirely — a single-file share has no tree to
// put in it.
//
// Two layouts, one breakpoint (see usePanels):
//   wide    — the aside is a flex sibling of <main>, drag-resizable, and takes
//             layout width from the document.
//   compact — the aside is a fixed overlay above the document with a scrim, so
//             a 390px screen still gives the document all 390px of it.
withDefaults(defineProps<{ sidebar?: boolean }>(), { sidebar: true });

const sb = useSidebar();

const dragging = ref(false);
let startX = 0;
let startW = 0;

function onMove(e: MouseEvent) {
  sb.setWidth(startW + (e.clientX - startX));
}
function onUp() {
  dragging.value = false;
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
}
function onDown(e: MouseEvent) {
  dragging.value = true;
  startX = e.clientX;
  startW = sb.width.value;
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  e.preventDefault();
}
onBeforeUnmount(onUp);

// Compact: a fixed panel sized to the screen, not to the user's saved column
// width (which can exceed a phone's viewport). Wide: the saved width.
const asideStyle = computed(() =>
  sb.compact.value ? undefined : { width: `${sb.width.value}px` },
);
</script>

<template>
  <!-- h-dvh, not h-screen: on iOS Safari 100vh excludes the browser chrome, so
       the bottom of the shell (the account row and its upward-opening menu) sat
       underneath it with no way to scroll — the shell is overflow-hidden. -->
  <div class="flex h-dvh w-screen overflow-hidden bg-surface text-fg">
    <!-- Captures mouse events during a drag so resizing stays smooth over the
         sandboxed HTML iframe (which would otherwise swallow the events). -->
    <div v-if="dragging" class="fixed inset-0 z-50 cursor-col-resize" />

    <!-- Scrim behind a compact overlay panel. Tapping it closes — on a phone
         that's the gesture people reach for before hunting for a toggle. -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="sidebar && sb.compact.value && sb.open.value"
        class="fixed inset-0 z-30 bg-black/40 lg:hidden"
        @click="sb.close()"
      />
    </Transition>

    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      leave-active-class="transition-transform duration-150 ease-in"
      enter-from-class="-translate-x-full"
      leave-to-class="-translate-x-full"
    >
      <aside
        v-if="sidebar && sb.open.value"
        :class="
          sb.compact.value
            ? 'fixed inset-y-0 left-0 z-40 w-[min(86vw,20rem)] border-r border-border bg-surface-2 shadow-xl'
            : 'relative shrink-0 border-r border-border'
        "
        :style="asideStyle"
      >
        <slot name="sidebar" />
        <!-- drag-to-resize handle — wide layout only; an overlay has no column
             to resize, and the handle isn't reachable by touch anyway. -->
        <div
          v-if="!sb.compact.value"
          class="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize transition hover:bg-accent/40"
          :class="dragging ? 'bg-accent/60' : ''"
          @mousedown="onDown"
        />
      </aside>
    </Transition>

    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <slot />
    </main>
  </div>
</template>