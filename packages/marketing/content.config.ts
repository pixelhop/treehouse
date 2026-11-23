import { defineCollection, defineContentConfig, z } from "@nuxt/content";
import { DOCS_PAGE_TYPES, DOCS_PLANS, DOCS_RELEASES } from "./app/utils/docs-tree";
import { docsContentExcludes } from "./server/lib/docs-files";

const cta = z.object({
  heading: z.string(),
  body: z.string(),
  label: z.string(),
  note: z.string().optional(),
});

// Public docs frontmatter - the contract in .agent/docs/public-docs.md. The docs
// content tests (test/docs/content.test.ts) enforce the stricter rules this
// schema can't express (description length, unique positions, link targets).
export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: "page",
      source: {
        include: "docs/**/*.md",
        // Unreleased pages are dropped from production (main-branch) builds
        // before they reach the content database - see docsContentExcludes.
        exclude: docsContentExcludes(),
      },
      schema: z.object({
        title: z.string(),
        navTitle: z.string().optional(),
        seoTitle: z.string().optional(),
        description: z.string(),
        type: z.enum(DOCS_PAGE_TYPES),
        position: z.number(),
        // ISO date (YYYY-MM-DD) of the last meaningful content change; feeds the
        // "Last updated" line and the twins.
        updated: z.string(),
        plans: z.array(z.enum(DOCS_PLANS)).optional(),
        release: z.enum(DOCS_RELEASES).default("public"),
        related: z.array(z.string()).optional(),
      }),
    }),
    // Comparison pages and guides, for people who aren't on Treehouse yet. The
    // contract is in .agent/docs/compare-pages.md; test/compare/content.test.ts
    // enforces the rules on claims that this schema can't express.
    pages: defineCollection({
      type: "page",
      source: { include: "pages/**/*.md", prefix: "/" },
      schema: z.object({
        title: z.string(),
        seoTitle: z.string(),
        description: z.string(),
        kind: z.enum(["comparison", "guide"]),
        eyebrow: z.string(),
        cardTitle: z.string(),
        // Order on the hub and in llms.txt, most important reader first.
        position: z.number(),
        // ISO date every claim on the page was last checked against its source.
        lastChecked: z.string(),
        summary: z.array(z.string()),
        cta,
        endCta: cta,
        competitor: z.string().optional(),
        comparison: z
          .array(z.object({ label: z.string(), treehouse: z.string(), them: z.string() }))
          .optional(),
        faq: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
        sources: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
      }),
    }),
  },
});