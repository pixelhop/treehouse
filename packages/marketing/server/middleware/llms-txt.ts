/**
 * Serve a curated `/llms.txt`, overriding nuxt-ai-ready's flat auto version.
 *
 * The module's llms.txt is a bare, undescribed list of every sitemap URL. We
 * replace it with a real llms.txt index: the facts an agent needs to connect,
 * then public docs grouped by docs section (absolute links to each page's
 * markdown twin, "title: description"), then a few resources.
 *
 * A middleware (not a `server/routes/*` file) is used because it runs before route
 * handlers and short-circuits the module's registered `/llms.txt` handler, and the
 * module's own prerender fetch passes through it - so the static file Cloudflare
 * serves is ours. The content query runs at prerender (Node); the route is
 * prerendered, so the Worker never hits this at runtime.
 */
import { docsSiteUrl, queryDocsMeta, queryLandingMeta } from "../lib/docs-content";
import { buildLlmsIndex, docsLlmsSections, type LlmsSection } from "../utils/docs-llms";
import { DOCS_SITE_DESCRIPTION, docsAgentFacts } from "../utils/docs-site";
import { landingLlmsSections } from "../utils/landing-markdown";

const RESOURCES_SECTION: LlmsSection = {
  title: "Resources",
  links: [
    {
      title: "Docs home",
      href: "/docs",
      description: "The Treehouse documentation, organised by task.",
    },
    {
      title: "Full docs",
      href: "/llms-docs.txt",
      description: "Every public docs page in full, as markdown, in one file.",
    },
  ],
};

export default defineEventHandler(async (event) => {
  if (event.path.split("?")[0] !== "/llms.txt") return;

  const [pages, landing] = await Promise.all([queryDocsMeta(event), queryLandingMeta(event)]);
  const siteUrl = docsSiteUrl(event);
  const body = buildLlmsIndex(
    {
      title: "Treehouse",
      description: DOCS_SITE_DESCRIPTION,
      url: siteUrl,
      details: docsAgentFacts(siteUrl),
    },
    [...docsLlmsSections(pages), ...landingLlmsSections(landing), RESOURCES_SECTION],
  );

  setResponseHeader(event, "content-type", "text/plain; charset=utf-8");
  return send(event, body);
});