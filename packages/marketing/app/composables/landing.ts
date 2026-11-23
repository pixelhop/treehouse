import { useDocsHead } from "~/composables/docs";

/**
 * Head for a comparison page, guide or the hub: the docs' SEO meta, plus the
 * page's structured data. `title` is the whole document title, because these
 * pages have no title template. Serialised with `<` escaped so nothing in the
 * content can close the script tag.
 */
export function useLandingHead(page: {
  title: string;
  description: string;
  path: string;
  updated?: string;
  jsonLd: Record<string, unknown>;
}) {
  useDocsHead(page);
  useHead({
    htmlAttrs: { lang: "en-GB" },
    script: [
      {
        type: "application/ld+json",
        innerHTML: JSON.stringify(page.jsonLd).replace(/</g, "\\u003c"),
      },
    ],
  });
}