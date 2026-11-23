/**
 * Serve /docs from Workers Static Assets, with `Accept: text/markdown`
 * negotiation.
 *
 * The docs are prerendered, and Cloudflare normally serves prerendered files
 * before the Worker runs - so nuxt-ai-ready's runtime negotiation never sees a
 * docs request, and an agent asking for markdown at a page URL gets HTML.
 * wrangler.jsonc routes /docs through the Worker first (`run_worker_first`),
 * and this middleware answers from the ASSETS binding itself: the page's `.md`
 * twin when the client prefers markdown, the prerendered file otherwise. The
 * content database is never touched at runtime.
 *
 * A no-op wherever there is no ASSETS binding (prerender, `nuxt dev`), so the
 * normal Nuxt pipeline renders the docs there.
 */
import type { H3Event } from "h3";
import { isLandingPath } from "../../app/utils/landing";
import { docsPrefersMarkdown } from "../utils/docs-negotiation";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

function assetsBinding(event: H3Event): AssetsBinding | undefined {
  const context = event.context as { cloudflare?: { env?: { ASSETS?: AssetsBinding } } };
  return context.cloudflare?.env?.ASSETS;
}

export default defineEventHandler(async (event) => {
  const assets = assetsBinding(event);
  if (!assets) return;

  const path = event.path.split("?")[0] ?? "";
  if (path !== "/docs" && !path.startsWith("/docs/") && !isLandingPath(path)) return;
  if (event.method !== "GET" && event.method !== "HEAD") return;

  // Only page URLs negotiate; files (.md twins, images, the search index) are
  // served as they are.
  const isPage = !/\.[a-z0-9]+$/i.test(path);
  const markdown = isPage && docsPrefersMarkdown(getRequestHeader(event, "accept"));
  const url = getRequestURL(event);
  if (markdown) url.pathname = `${path.replace(/\/+$/, "")}.md`;

  const response = await assets.fetch(new Request(url, { method: event.method }));
  // Unknown URLs fall through to Nuxt's 404 page.
  if (response.status === 404) return;

  const headers = new Headers(response.headers);
  if (isPage) headers.append("Vary", "Accept");
  return new Response(response.body, { status: response.status, headers });
});