<script setup lang="ts">
import IconChevronDown from "~icons/solar/alt-arrow-down-linear";

// The top bar's path trail, shared by the workspace and the public share viewer.
//
// Every crumb used to be `truncate` in an unconstrained flex row, so they all
// shrank together: on a phone `clients/acme/brief-….md` rendered as `c / a / b…`,
// which is neither navigation nor orientation. A path degrades by dropping whole
// segments, not by shortening all of them — so on a compact screen this shows
// `root / … / leaf` and hands the dropped middle to a tappable "…".
export type Crumb = { name: string; path: string; isDir: boolean };

const props = withDefaults(
  defineProps<{
    /** Label for the trail's root (the workspace or share name). */
    rootLabel: string;
    crumbs: Crumb[];
    /** A file share's root is the document itself — a label, not a link. */
    rootClickable?: boolean;
    /** Tooltip for the last crumb, when selecting it does something of its own
     *  (the workspace uses it to show the open file in the tree). */
    leafTitle?: string;
  }>(),
  { rootClickable: true, leafTitle: undefined },
);

const emit = defineEmits<{ select: [crumb: Crumb | null] }>();

const compact = useCompactLayout();
const overflowOpen = ref(false);

// Collapse only when there is actually something to collapse: with one crumb
// there is no middle, and `root / … / leaf` would be longer than the path.
const collapsed = computed(() => compact.value && props.crumbs.length > 1);
const hidden = computed(() => (collapsed.value ? props.crumbs.slice(0, -1) : []));
const shown = computed(() => (collapsed.value ? props.crumbs.slice(-1) : props.crumbs));

watch(compact, (isCompact) => {
  if (!isCompact) overflowOpen.value = false;
});

function pick(crumb: Crumb | null) {
  overflowOpen.value = false;
  emit("select", crumb);
}
</script>

<template>
  <slot name="before" />

  <button
    v-if="rootClickable"
    type="button"
    class="shrink-0 rounded px-1.5 py-1 text-fg-muted transition hover:bg-surface-2"
    @click="pick(null)"
  >
    {{ rootLabel }}
  </button>
  <span v-else class="shrink-0 truncate px-1.5 py-1 font-medium text-fg">{{ rootLabel }}</span>

  <!-- The dropped middle of the path, still reachable. -->
  <template v-if="collapsed">
    <span class="shrink-0 text-fg-subtle">/</span>
    <button
      type="button"
      title="Show the rest of the path"
      aria-label="Show the rest of the path"
      class="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-1 text-fg-muted transition hover:bg-surface-2"
      :class="overflowOpen ? 'bg-surface-2 text-fg' : ''"
      @click="overflowOpen = !overflowOpen"
    >
      …
      <IconChevronDown class="h-3 w-3" />
    </button>
  </template>

  <!-- ph-mask on each crumb: these are user-authored folder names. The slashes
       and the chrome stay legible so the path's SHAPE is still readable in a
       replay. See app/plugins/posthog.client.ts for the masking contract. -->
  <template v-for="(c, i) in shown" :key="c.path">
    <span class="shrink-0 text-fg-subtle">/</span>
    <button
      type="button"
      class="ph-mask truncate rounded px-1.5 py-1 transition hover:bg-surface-2"
      :class="i === shown.length - 1 ? 'font-medium text-fg' : 'text-fg-muted'"
      :title="i === shown.length - 1 ? leafTitle : undefined"
      @click="pick(c)"
    >
      {{ c.name }}
    </button>
  </template>

  <slot name="after" />

  <!-- ModalSurface teleports this past the header's `overflow-hidden` (which
       would otherwise clip the very list this button exists to reveal) and makes
       it reachable by keyboard. No scrim: it's a small path list, not a blocking
       decision. -->
  <ModalSurface
    v-if="overflowOpen"
    role="menu"
    label="Rest of the path"
    placement="top-left"
    :scrim="false"
    panel-class="rounded-xl p-1"
    @close="overflowOpen = false"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-fg-muted transition hover:bg-surface-2"
      @click="pick(null)"
    >
      {{ rootLabel }}
    </button>
    <button
      v-for="(c, depth) in hidden"
      :key="c.path"
      type="button"
      class="ph-mask flex w-full items-center gap-2 rounded-md py-2 pr-2 text-left text-sm text-fg transition hover:bg-surface-2"
      :style="{ paddingLeft: `${0.5 + (depth + 1) * 0.75}rem` }"
      @click="pick(c)"
    >
      <span class="truncate">{{ c.name }}</span>
    </button>
  </ModalSurface>
</template>