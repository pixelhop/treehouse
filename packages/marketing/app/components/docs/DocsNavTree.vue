<script lang="ts" setup>
import { DOCS_ROOT, docsSectionPath, type DocsArea, type DocsTreeNode } from "~/utils/docs-tree";
import { docsSectionIcon } from "~/utils/docs-icons";
import type { DocsNavItem, DocsNavSectionView } from "./DocsNavSection.vue";

// The docs navigation list shared by the desktop sidebar and the mobile drawer.
// It shows one area's sections only (see DOCS_AREAS in utils/docs-tree).
// Section titles are links to their hub pages - deliberately not headings, so
// the article's <h1> is the first heading on the page.
//
// In an area with several sections each one collapses to its title: the current
// page's section starts expanded (server-rendered, so the prerendered HTML has
// it open) and the chevron toggles the rest. Collapsed lists stay in the HTML
// (v-show) so every docs link is still crawlable.

const props = defineProps<{
  tree: DocsTreeNode;
  area: DocsArea;
  currentPath: string;
}>();

function decorate(node: DocsTreeNode): DocsNavItem {
  return {
    path: node.path,
    label: node.label,
    current: node.path === props.currentPath,
    children: node.children.map(decorate),
  };
}

// An area rooted at the docs home lists its sections. An area rooted at a
// section hub (Agents) lists that hub's sub-sections (Connect, Agent handbook,
// API reference) as its sections, all expanded - there are few enough pages
// to show at once.
const sectionNodes = computed(() => {
  if (props.area.home === DOCS_ROOT) return props.tree.children;
  const subsections = props.tree.children.filter((child) => child.isHub);
  return subsections.length ? subsections : [props.tree];
});
const collapsible = computed(() => props.area.home === DOCS_ROOT && sectionNodes.value.length > 1);

const currentSection = computed(() => docsSectionPath(props.currentPath));
const expanded = ref<string[]>(currentSection.value ? [currentSection.value] : []);
// Moving to another section opens it and folds the rest back up; moving
// within a section keeps whatever the reader opened.
watch(currentSection, (section) => {
  expanded.value = section ? [section] : [];
});

function toggle(path: string) {
  const index = expanded.value.indexOf(path);
  if (index === -1) expanded.value.push(path);
  else expanded.value.splice(index, 1);
}

// The tree renders twice (desktop sidebar + mobile drawer), so list ids need a
// per-instance prefix to keep aria-controls unique.
const idPrefix = useId();

const sections = computed<DocsNavSectionView[]>(() =>
  sectionNodes.value.map((node) => {
    const item = decorate(node);
    return {
      ...item,
      icon: docsSectionIcon(node.path),
      inSection: node.path === currentSection.value,
      toggleable: collapsible.value && item.children.length > 0,
      expanded: !collapsible.value || expanded.value.includes(node.path),
      listId: `${idPrefix}-${node.path.replace(/[^a-z0-9]+/gi, "-")}`,
    };
  }),
);
</script>

<template>
  <nav :aria-label="`${area.title} navigation`" class="text-[0.9375rem] lg:text-sm">
    <ul role="list" :class="collapsible ? 'space-y-4' : 'space-y-8'">
      <DocsNavSection
        v-for="section in sections"
        :key="section.path"
        :section="section"
        @toggle="toggle(section.path)"
      />
    </ul>
  </nav>
</template>