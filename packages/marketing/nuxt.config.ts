import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineNuxtModule } from "nuxt/kit";
import { snippetHighlighter } from "./build/snippets";
import { parse as parseYaml } from "yaml";
import { docsPrerenderRoutes, readDocsFiles } from "./server/lib/docs-files";
import { landingPrerenderRoutes } from "./server/lib/landing-files";

// Marketing site for Treehouse. Same stack and deployment target as
// packages/app: Nuxt 4, Tailwind v4 via the Vite plugin, Cloudflare Workers.
// The marketing pages stay client-rendered (SPA) until the vite-plus SSR
// pipeline is proven out for them; the docs are the exception - they are
// server-rendered and prerendered to static HTML at build (see routeRules).

// Docs routes come from the markdown on disk (content/docs/**): nested URLs,
// folder index.md hubs at the folder URL, /docs itself. Docs ship
// prerender-only - @nuxt/content v3 is SQLite-backed, and querying it on the
// Workers runtime would need a bound D1 database. Rendering every page to
// static HTML at build (Node, where SQLite works) keeps the Worker free of a
// content DB. See server/lib/docs-files.ts and .agent/docs/public-docs.md.
const docsFiles = readDocsFiles();

// The Treehouse agent skill, published by nuxt-ai-ready at
// /.well-known/agent-skills/. The module insists the configured description
// matches the file's frontmatter exactly, so it is read from the file.
const TREEHOUSE_SKILL = "skills/treehouse/SKILL.md";
function skillDescription(file: string): string {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
  const description = (parseYaml(frontmatter) as { description?: unknown } | null)?.description;
  return typeof description === "string" ? description : "";
}

const siteUrl = new URL(process.env.NUXT_PUBLIC_SITE_URL || "https://trytree.house").origin;

// Swap nuxt-ai-ready's content lookup (which stringifies the stored body with
// MDC components left in) for ours, which flattens components into plain
// markdown and adds the H1, release notice, hub children and related links.
// Registered after nuxt-ai-ready in `modules`, so this nitro:config hook runs
// after the module's and its virtual wins. The module's contract is one export,
// `lookupContentPage(event, path) -> { markdown, title, description, updatedAt } | null`;
// re-check it when bumping nuxt-ai-ready.
const docsMarkdownTwins = defineNuxtModule({
  meta: { name: "docs-markdown-twins" },
  setup(_options, nuxt) {
    const lookup = fileURLToPath(new URL("./server/lib/docs-content.ts", import.meta.url));
    nuxt.hook("nitro:config", (nitroConfig) => {
      nitroConfig.virtual = nitroConfig.virtual || {};
      nitroConfig.virtual["#ai-ready-virtual/content-lookup.mjs"] =
        `export { lookupContentPage } from ${JSON.stringify(lookup)};`;
    });
  },
});

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  // On so the docs can be server-rendered; every non-docs route opts back out
  // to client-only rendering in routeRules below.
  ssr: true,
  routeRules: {
    "/**": { ssr: false },
    "/docs": { ssr: true },
    "/docs/**": { ssr: true },
    // Comparison pages and guides: prerendered like the docs, because search
    // engines and AI answers need the words in the HTML. One guide so far, so
    // /guides has no hub of its own yet.
    "/compare": { ssr: true },
    "/compare/**": { ssr: true },
    "/guides": { redirect: "/compare" },
    "/guides/**": { ssr: true },
    // Every public doc in full, for agents. Not a page, so keep it out of
    // search indexes (the .md twins are for agents too, but Workers Static
    // Assets serves them without these headers; see .agent/docs/public-docs.md).
    "/llms-docs.txt": {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": "noindex",
      },
    },
  },
  site: {
    url: siteUrl,
    name: "Treehouse",
  },
  runtimeConfig: {
    public: {
      // Canonical origin for docs links, markdown twins and llms files.
      // NUXT_PUBLIC_SITE_URL overrides it for preview deploys.
      siteUrl,
      // Where the CTAs send people. Override with NUXT_PUBLIC_APP_URL to point
      // at a local or preview app instead of production.
      appUrl: "https://app.trytree.house",
      // Where the homepage reads live plan prices (GET /api/plans). CI sets
      // NUXT_PUBLIC_API_URL for the app build; the same value is right here.
      apiUrl: process.env.NUXT_PUBLIC_API_URL || "https://api.trytree.house",
      // PostHog. Unset key = analytics fully off (no requests, no storage) —
      // the default for local dev and CI. The host is our OWN /ph proxy
      // (server/routes/ph/[...path].ts), not posthog.com, so tracker blockers
      // cannot silently delete the funnel data this site exists to produce.
      posthog: {
        key: process.env.NUXT_PUBLIC_POSTHOG_KEY || "",
        host: process.env.NUXT_PUBLIC_POSTHOG_HOST || "/ph",
      },
      // Sidekick, Pixelhop's affiliate programme (plugins/sidekick.client.ts).
      // No programme = no script, no footer link: the default for local dev,
      // CI and PR previews. Production sets the programme slug and the cookie
      // domain, so the referral cookie reaches app and api subdomains.
      sidekick: {
        programme: process.env.NUXT_PUBLIC_SIDEKICK_PROGRAMME || "",
        scriptUrl:
          process.env.NUXT_PUBLIC_SIDEKICK_SCRIPT_URL || "https://partners-api.pixelhop.io/sk.js",
        portalUrl: process.env.NUXT_PUBLIC_SIDEKICK_PORTAL_URL || "https://partners.pixelhop.io",
        cookieDomain: process.env.NUXT_PUBLIC_SIDEKICK_COOKIE_DOMAIN || "",
      },
      // The Chat Thing support bot behind the "Ask Treehouse" button
      // (components/ChatLauncher.client.vue). No bot id = no button, nothing
      // loaded. The bot's setup lives in chat-thing/support-bot.md. The id is
      // public (it ships in the page); override it to point a preview at a
      // different bot, or set it to "" to turn the button off.
      chatThing: {
        botId: process.env.NUXT_PUBLIC_CHAT_THING_BOT_ID ?? "b7bf167d-0140-4f3a-b661-7058b7c6af31",
        scriptUrl: "https://chatthing.ai/chat-widget.js",
      },
    },
  },
  // `shared` ships raw TypeScript (no build step), so Vite must transpile it.
  // Matches packages/app.
  build: { transpile: ["shared"] },
  css: ["~/assets/css/main.css"],
  vite: {
    plugins: [tailwindcss(), snippetHighlighter()],
  },
  experimental: { appManifest: false },
  // Distinct dev port so api (3010) / app (3000) / marketing can run together.
  devServer: { port: 3030 },
  // Flat component names, matching packages/app. The docs' MDC components
  // (::callout and friends) and Prose overrides must be global so @nuxt/content
  // can resolve them by name at render time.
  components: [
    { path: "~/components/content", global: true, pathPrefix: false },
    { path: "~/components", pathPrefix: false },
  ],
  modules: [
    // Solar icons via unplugin-icons, matching packages/app.
    ["unplugin-icons/nuxt", { autoInstall: false }],
    "@nuxt/content",
    "nuxt-ai-ready",
    // Must stay after nuxt-ai-ready (overrides its content lookup virtual).
    docsMarkdownTwins,
  ],
  content: {
    // Node 22's built-in SQLite, so the build needs no native addon.
    experimental: { sqliteConnector: "native" },
    build: {
      markdown: {
        // A bundled theme (content only accepts bundled names): Everforest's
        // warm sage-on-charcoal sits closest to the brand code panel used by
        // the homepage snippets (build/snippets.ts).
        highlight: {
          theme: "everforest-dark",
          langs: ["bash", "json", "yaml", "toml", "markdown", "typescript", "javascript", "http"],
        },
        toc: { depth: 3 },
      },
    },
  },
  // nuxt-ai-ready gives every docs page a `.md` twin (flattened by
  // server/utils/docs-markdown.ts) and injects `<link rel="alternate"
  // type="text/markdown">`. Its own `/llms.txt` is a flat, undescribed dump, so
  // server/middleware/llms-txt.ts serves a curated index instead, and
  // `/llms-docs.txt` (server/routes) is the whole manual in one file.
  //
  // `Accept: text/markdown` on a docs page URL is answered by
  // server/middleware/docs-assets.ts (docs requests run the Worker first; see
  // wrangler.jsonc), because prerendered pages otherwise never reach the
  // module's runtime negotiation.
  aiReady: {
    mdreamOptions: { minimal: true },
    // The Treehouse agent skill, published at /.well-known/agent-skills/.
    agentSkills: {
      skills: [
        {
          source: "local",
          name: "treehouse",
          description: skillDescription(TREEHOUSE_SKILL),
          file: TREEHOUSE_SKILL,
        },
      ],
    },
  },
  app: {
    head: {
      title: "Treehouse — A home for humans and agents",
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          name: "description",
          content:
            "Treehouse is a shared file workspace where humans and agents build, ship, and grow together.",
        },
        // Social preview card for every page. The marketing pages are
        // client-rendered and link unfurlers don't run JS, so these must be in
        // the static head. Docs and landing pages override the title,
        // description and URL (composables/docs.ts) and inherit the image.
        // Source: scripts/og-image/og.html.
        { property: "og:site_name", content: "Treehouse" },
        { property: "og:type", content: "website" },
        { property: "og:url", content: `${siteUrl}/` },
        { property: "og:title", content: "Treehouse — A home for humans and agents" },
        {
          property: "og:description",
          content:
            "Treehouse is a shared file workspace where humans and agents build, ship, and grow together.",
        },
        { property: "og:image", content: `${siteUrl}/og.png` },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        {
          property: "og:image:alt",
          content: "Treehouse: your team's second brain, open to everyone",
        },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: `${siteUrl}/og.png` },
      ],
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    },
  },
  nitro: {
    preset: process.env.NITRO_PRESET ?? "cloudflare_module",
    cloudflare: {
      nodeCompat: true,
    },
    prerender: {
      // Docs are @nuxt/content markdown behind a dynamic [...slug], so their
      // concrete routes must be listed here - a `/docs/**` prerender routeRule
      // would not enumerate them. Each rendered page also queues its `.md` twin
      // (nuxt-ai-ready). Plus the static search index the Cmd+K palette fetches
      // and the two agent-facing llms files.
      routes: [
        ...docsPrerenderRoutes(docsFiles),
        ...landingPrerenderRoutes(),
        "/docs/search-index.json",
        "/llms.txt",
        "/llms-docs.txt",
      ],
      // The client-side content SQL dump trips the prerenderer; it is never
      // needed because docs are fully prerendered.
      ignore: ["/__nuxt_content"],
      crawlLinks: false,
    },
  },
});