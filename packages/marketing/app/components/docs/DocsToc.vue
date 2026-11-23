<script lang="ts" setup>
// "On this page" for a docs article. Rendered by the docs page itself (not the
// layout) from the page's own TOC, so it is in the prerendered HTML - no
// ClientOnly, no hydration mismatch. The scroll-spy only runs after mount.
import { activeTocId, docsTocIds, type DocsTocHeading } from "~/utils/docs-tree";

const props = defineProps<{
  headings: DocsTocHeading[];
}>();

const activeId = ref("");
const allIds = computed(() => docsTocIds(props.headings));

function tocLink(heading: DocsTocHeading) {
  const active = heading.id === activeId.value;
  return {
    id: heading.id,
    title: heading.title,
    href: `#${heading.id}`,
    class: active ? "text-primary font-semibold" : "text-fg-muted hover:text-fg",
    ariaCurrent: active ? ("location" as const) : undefined,
  };
}

const items = computed(() =>
  props.headings.map((heading) => ({
    ...tocLink(heading),
    children: heading.children.map(tocLink),
  })),
);

// Scroll-spy: the active heading is the last one whose top has scrolled past
// the sticky header. One passive listener, rAF-throttled.
const HEADER_OFFSET = 110;
let frame = 0;
function headingTop(id: string): number | null {
  const el = document.getElementById(id);
  return el ? el.getBoundingClientRect().top : null;
}
function update() {
  frame = 0;
  activeId.value = activeTocId(allIds.value, headingTop, HEADER_OFFSET);
}
function onScroll() {
  if (!frame) frame = requestAnimationFrame(update);
}
onMounted(() => {
  update();
  window.addEventListener("scroll", onScroll, { passive: true });
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScroll);
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <div
    class="hidden xl:sticky xl:top-16 xl:-mr-6 xl:block xl:h-[calc(100vh-4rem)] xl:flex-none xl:overflow-y-auto xl:py-12 xl:pr-6"
  >
    <nav v-if="items.length" aria-labelledby="on-this-page-title" class="w-56">
      <h2 id="on-this-page-title" class="label-eyebrow">On this page</h2>
      <ol role="list" class="mt-4 space-y-2.5 text-sm">
        <li v-for="heading in items" :key="heading.id">
          <a :href="heading.href" :class="heading.class" :aria-current="heading.ariaCurrent">{{
            heading.title
          }}</a>
          <ol v-if="heading.children.length" role="list" class="mt-2 space-y-2 pl-4">
            <li v-for="child in heading.children" :key="child.id">
              <a :href="child.href" :class="child.class" :aria-current="child.ariaCurrent">{{
                child.title
              }}</a>
            </li>
          </ol>
        </li>
      </ol>
    </nav>
  </div>
</template>