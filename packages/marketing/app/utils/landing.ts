// Comparison pages and guides: pages written for people who aren't on Treehouse
// yet. Pure, so the routing rules and signup links are tested without Nuxt.
//
// Signups are measured with ordinary UTM tags on the signup link. The app's
// PostHog keeps them on every event, including the `$identify` at signup, even
// though it strips the query string from URLs (see shared/analytics.ts). A tag
// names the page, never the visitor, so it works for people who declined the
// marketing site's analytics. `.agent/docs/compare-pages.md` has the report.

const LANDING_SECTIONS = ["/compare", "/guides"];

/** Where on the page a signup link sits. Sent as `utm_content`. */
export type SignupPlacement = "hero" | "end" | "nav" | "twin";

export function isLandingPath(path: string): boolean {
  return LANDING_SECTIONS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Whether moving between two paths has to be a real page load (see the middleware). */
export function needsFullLoad(to: string, from: string): boolean {
  return to !== from && isLandingPath(to);
}

/** The page's name in reports: `/compare/obsidian` -> `compare-obsidian`. */
export function signupCampaign(path: string): string {
  const [section = "", slug] = path.split("/").filter(Boolean);
  return `${section.replace(/s$/, "")}-${slug ?? "hub"}`;
}

/** The signup URL for a link on `path`, tagged with the page and placement. */
export function signupHref(appUrl: string, path: string, placement: SignupPlacement): string {
  const params = new URLSearchParams({
    utm_source: "trytree.house",
    utm_medium: path.startsWith("/guides") ? "guide" : "compare",
    utm_campaign: signupCampaign(path),
    utm_content: placement,
  });
  return `${appUrl}/sign-up?${params}`;
}

/** "30 October 2026" from `2026-10-30`, or "" when the date can't be read. */
export function formatCheckedDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
}

export interface LandingCta {
  heading: string;
  body: string;
  label: string;
  note?: string;
}

export interface LandingRow {
  label: string;
  treehouse: string;
  them: string;
}

export interface LandingPageMeta {
  path: string;
  title: string;
  seoTitle?: string;
  description: string;
  kind: "comparison" | "guide";
  eyebrow: string;
  cardTitle: string;
  position: number;
  lastChecked: string;
}

export interface LandingPage extends LandingPageMeta {
  summary: string[];
  cta: LandingCta;
  endCta: LandingCta;
  competitor?: string;
  comparison?: LandingRow[];
  faq?: { question: string; answer: string }[];
  sources?: { label: string; url: string }[];
}

/** Metadata the hub and the llms index need; never the bodies. */
export const LANDING_META_FIELDS = [
  "path",
  "title",
  "seoTitle",
  "description",
  "kind",
  "eyebrow",
  "cardTitle",
  "position",
  "lastChecked",
] as const;

/**
 * Article, breadcrumbs and (when the page has one) the FAQ it shows. Only what
 * is on the page: no ratings, prices or offers, which go stale and which search
 * engines treat as claims to verify.
 */
export function landingJsonLd(page: LandingPage, siteUrl: string): Record<string, unknown> {
  const url = `${siteUrl}${page.path}`;
  const organization = { "@type": "Organization", name: "Treehouse", url: siteUrl };
  const section = {
    name: page.kind === "guide" ? "Guides" : "Compare",
    item: `${siteUrl}/compare`,
  };
  const graph: Record<string, unknown>[] = [
    {
      "@type": "Article",
      headline: page.title,
      description: page.description,
      url,
      mainEntityOfPage: url,
      dateModified: page.lastChecked,
      author: organization,
      publisher: organization,
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { name: "Treehouse", item: siteUrl },
        section,
        { name: page.cardTitle, item: url },
      ].map((crumb, index) => ({ "@type": "ListItem", position: index + 1, ...crumb })),
    },
  ];
  if (page.faq?.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: page.faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/** The `/compare` hub: the page itself, and the list it links to. */
export function hubJsonLd(pages: LandingPageMeta[], siteUrl: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Compare Treehouse",
    url: `${siteUrl}/compare`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: pages.map((page, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: page.title,
        url: `${siteUrl}${page.path}`,
      })),
    },
  };
}