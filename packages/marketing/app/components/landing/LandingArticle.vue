<script setup lang="ts">
// One comparison page or guide. The structure is fixed so every page has the
// same honest shape: the short answer first, the table, the long version, the
// sources and the date they were checked. Only the copy lives in the content
// file. The table stacks into labelled cards on a phone rather than scrolling
// sideways, so a reader never loses which column they're in.
import { useLandingHead } from "~/composables/landing";
import { formatCheckedDate, landingJsonLd, type LandingPage } from "~/utils/landing";

const props = defineProps<{
  page: LandingPage;
  /** The rendered content document, for ContentRenderer. */
  doc: Record<string, unknown>;
}>();

const checked = computed(() => formatCheckedDate(props.page.lastChecked));

// Here rather than in useLandingPage: head entries are removed when the component
// that made them unmounts, and an awaiting composable has no component by then,
// so the article's title and canonical would stay on the homepage after leaving.
useLandingHead({
  title: props.page.seoTitle || props.page.title,
  description: props.page.description,
  path: props.page.path,
  updated: props.page.lastChecked,
  jsonLd: landingJsonLd(props.page, useRuntimeConfig().public.siteUrl),
});
</script>

<template>
  <article>
    <div class="mx-auto w-full max-w-3xl px-6 pb-16 pt-12 md:pt-16">
      <nav aria-label="Breadcrumb" class="text-sm font-semibold text-fg-subtle">
        <NuxtLink to="/compare" class="transition-colors hover:text-fg">{{
          page.kind === "guide" ? "Guides" : "Compare"
        }}</NuxtLink>
        <span aria-hidden="true" class="mx-2">/</span>
        <span>{{ page.cardTitle }}</span>
      </nav>

      <p class="label-eyebrow mt-8">{{ page.eyebrow }}</p>
      <h1 class="font-display type-headline mt-3 font-semibold text-leaf-deep">{{ page.title }}</h1>
      <p class="mt-5 text-lg leading-relaxed text-fg-muted">{{ page.description }}</p>

      <SignupCta :cta="page.cta" :path="page.path" placement="hero" class="mt-8" />

      <section class="mt-12" aria-labelledby="short-answer">
        <h2 id="short-answer" class="text-2xl font-bold text-fg">The short answer</h2>
        <ul class="mt-4 space-y-3 text-[1.0625rem] leading-relaxed">
          <li v-for="line in page.summary" :key="line" class="flex gap-3">
            <span class="mt-2.5 size-1.5 flex-none rounded-full bg-moss" aria-hidden="true" />
            <span>{{ line }}</span>
          </li>
        </ul>
      </section>

      <section v-if="page.comparison?.length" class="mt-12" aria-labelledby="at-a-glance">
        <h2 id="at-a-glance" class="text-2xl font-bold text-fg">At a glance</h2>
        <table class="compare-table mt-5 w-full border-collapse text-[0.9375rem] leading-relaxed">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Topic</span></th>
              <th scope="col">Treehouse</th>
              <th scope="col">{{ page.competitor }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in page.comparison" :key="row.label">
              <th scope="row">{{ row.label }}</th>
              <td data-label="Treehouse">{{ row.treehouse }}</td>
              <td :data-label="page.competitor">{{ row.them }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <DocsContent class="mt-12">
        <ContentRenderer :value="doc" />
      </DocsContent>

      <section v-if="page.faq?.length" class="mt-14" aria-labelledby="faq">
        <h2 id="faq" class="text-2xl font-bold text-fg">Questions people ask</h2>
        <dl class="mt-5 space-y-6">
          <div v-for="item in page.faq" :key="item.question">
            <dt class="font-bold text-fg">{{ item.question }}</dt>
            <dd class="mt-1.5 leading-relaxed text-fg-muted">{{ item.answer }}</dd>
          </div>
        </dl>
      </section>

      <section
        v-if="page.sources?.length"
        class="mt-14 border-t border-border/70 pt-8"
        aria-labelledby="sources"
      >
        <h2 id="sources" class="text-lg font-bold text-fg">Sources</h2>
        <p class="mt-2 text-sm leading-relaxed text-fg-subtle">
          Everything here about {{ page.competitor || "other products" }} comes from these pages, as
          they read on the date below. Products and prices change, so check them before you decide.
        </p>
        <ul class="mt-3 space-y-1.5 text-sm">
          <li v-for="source in page.sources" :key="source.url">
            <a :href="source.url" rel="nofollow noopener" class="text-primary underline">{{
              source.label
            }}</a>
          </li>
        </ul>
      </section>

      <p class="mt-8 text-sm text-fg-subtle">
        Last checked <time :datetime="page.lastChecked">{{ checked }}</time>
      </p>
    </div>

    <SignupCta :cta="page.endCta" :path="page.path" placement="end" />
  </article>
</template>

<style scoped>
.compare-table :is(th, td) {
  border-top: 1px solid var(--border);
  padding: 0.875rem 1rem 0.875rem 0;
  text-align: left;
  vertical-align: top;
}

.compare-table thead th {
  border-top: 0;
  font-weight: 700;
  color: var(--color-leaf-deep);
}

.compare-table tbody th {
  width: 24%;
  font-weight: 700;
}

.compare-table td {
  width: 38%;
  color: var(--fg-muted);
}

@media (max-width: 639px) {
  .compare-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .compare-table :is(tbody, tr, tbody th, td) {
    display: block;
    width: auto;
  }

  .compare-table tr {
    border-top: 1px solid var(--border);
    padding-block: 1rem;
  }

  .compare-table :is(tbody th, td) {
    border-top: 0;
    padding: 0;
  }

  .compare-table td {
    margin-top: 0.625rem;
  }

  .compare-table td::before {
    display: block;
    content: attr(data-label);
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--color-leaf-deep);
  }
}
</style>