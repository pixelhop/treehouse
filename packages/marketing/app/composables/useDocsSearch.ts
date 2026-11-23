import type Fuse from "fuse.js";
import {
  DOCS_FUSE_OPTIONS,
  rankDocsSearch,
  type DocsSearchEntry,
  type DocsSearchResult,
} from "../utils/docs-search";

// Module-level cache so re-opening the palette never refetches the index or
// rebuilds Fuse. The index is a static build artifact, so it cannot change
// within a session. `fuse` is a shallowRef (not a plain let) so `results`
// recomputes when the lazy fetch resolves - otherwise typing before the first
// load completes would leave results empty until the next keystroke.
const loading = ref(false);
const fuse = shallowRef<Fuse<DocsSearchEntry> | null>(null);
let loadPromise: Promise<void> | null = null;

// Fuse is dynamically imported so its ~10KB gzip chunk is not pulled onto every
// docs-page mount - only when the palette is first opened (see `open()`). The
// options + ranking live in utils/docs-search.ts so the findability tests run
// the exact same search.
async function buildFuse(items: DocsSearchEntry[]) {
  const { default: FuseCtor } = await import("fuse.js");
  return new FuseCtor(items, DOCS_FUSE_OPTIONS);
}

/**
 * Client-side fuzzy search over the build-time docs index. The index is fetched
 * lazily on first `open()` (one static request), cached at module scope, and
 * queried word-by-word (see `rankDocsSearch`). Section-level results deep-link
 * to the matching heading.
 */
export function useDocsSearch() {
  const query = ref("");

  // A settled-successful load leaves loadPromise non-null, so it also serves as
  // the cache check; a failed load nulls it again so a later open() retries.
  async function open() {
    if (loadPromise) {
      return loadPromise;
    }

    loading.value = true;
    loadPromise = $fetch<DocsSearchEntry[]>("/docs/search-index.json")
      .then(async (data) => {
        fuse.value = await buildFuse(data ?? []);
      })
      .catch(() => {
        // Leave fuse null - the palette shows no results rather than throwing.
        // Allow a later open() to retry.
        loadPromise = null;
      })
      .finally(() => {
        loading.value = false;
      });

    return loadPromise;
  }

  const ready = computed(() => fuse.value !== null);

  const results = computed<DocsSearchResult[]>(() => {
    const term = query.value.trim();
    if (!term || !fuse.value) {
      return [];
    }
    return rankDocsSearch(fuse.value, term);
  });

  return { query, results, loading, ready, open };
}