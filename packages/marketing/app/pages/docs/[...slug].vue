<script lang="ts" setup>
// Every docs URL: the /docs home, section hubs (/docs/files) and pages. URLs
// mirror the content tree, so the page is looked up by its exact path; a
// folder's index.md is the hub at the folder URL. Prerendered at build (see
// nuxt.config) - the Worker never queries content.
import {
  DOCS_ROOT,
  buildDocsTree,
  docsAreaForPath,
  docsAreaTree,
  docsBreadcrumbs,
  docsDocumentTitle,
  docsPrevNext,
  docsRelease,
  docsTocHeadings,
  findDocsNode,
  flattenDocsTree,
  isIgnoredDocPath,
  isListedDoc,
  normalizeDocsPath,
  resolveRelatedDocs,
} from "~/utils/docs-tree";

definePageMeta({
  layout: "docs",
});

const route = useRoute();
const path = normalizeDocsPath(route.path);

const [{ data: page }, { data: pages }] = await Promise.all([
  useAsyncData(`docs.page.${path}`, () => queryCollection("docs").path(path).first()),
  useDocsIndex(),
]);

if (!page.value || isIgnoredDocPath(path)) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}

const doc = page.value;
const allPages = computed(() => pages.value ?? []);
const release = docsRelease(doc);
const tree = computed(() => buildDocsTree(allPages.value));

// A hub lists its public children (pages and sub-section hubs) automatically.
// The docs home is the exception: its body is a curated landing page.
const children = computed(() =>
  path === DOCS_ROOT ? [] : (findDocsNode(tree.value, path)?.children ?? []),
);
// Prev/next walks the page's own area (Docs or Agents), never across.
const neighbours = computed(() =>
  docsPrevNext(flattenDocsTree(docsAreaTree(tree.value, docsAreaForPath(path))), path),
);
const breadcrumbs = computed(() => docsBreadcrumbs(allPages.value, path));

// Public pages only link to public pages; early-access pages may point at
// each other.
const related = computed(() =>
  resolveRelatedDocs(allPages.value, doc.related).filter(
    (link) =>
      release !== "public" ||
      allPages.value.some(
        (other) => normalizeDocsPath(other.path) === link.path && isListedDoc(other),
      ),
  ),
);

const headings = computed(() => docsTocHeadings(doc.body?.toc?.links));

const updatedLabel = computed(() => {
  if (!doc.updated) return "";
  const date = new Date(`${doc.updated}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
});

useDocsHead({
  title: docsDocumentTitle(doc),
  description: doc.description,
  updated: doc.updated,
  path,
  noindex: release !== "public",
});
</script>

<template>
  <div class="flex min-w-0 flex-auto">
    <main class="min-w-0 max-w-3xl flex-auto px-4 pb-24 pt-10 sm:px-6 lg:pl-10 lg:pr-0 xl:px-14">
      <article>
        <DocsHeaderPage
          :title="doc.title"
          :description="doc.description"
          :breadcrumbs="breadcrumbs"
        />

        <DocsReleaseBanner :release="release" />

        <DocsContent>
          <ContentRenderer :value="doc" />
        </DocsContent>

        <DocsChildList :items="children" />

        <DocsRelated :links="related" />

        <p v-if="updatedLabel" class="mt-12 text-sm text-fg-subtle">
          Last updated
          <time :datetime="doc.updated ?? undefined">{{ updatedLabel }}</time>
        </p>

        <DocsPrevNext v-if="release === 'public'" :prev="neighbours.prev" :next="neighbours.next" />
      </article>
    </main>

    <DocsToc :headings="headings" />
  </div>
</template>