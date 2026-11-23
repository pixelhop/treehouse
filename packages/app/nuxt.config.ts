import tailwindcss from "@tailwindcss/vite";
import { posthogSourceMapCredentials, uploadPosthogSourceMaps } from "./scripts/posthog-sourcemaps";

const sourceMapCredentials = posthogSourceMapCredentials(process.env);

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  ssr: false,
  app: {
    head: {
      // Treehouse favicon set (generated from the branding illustration).
      // favicon.ico is multi-resolution (16/32/48); the PNGs cover modern
      // browsers and the home-screen icon on iOS.
      link: [
        { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
        { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" },
        { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
        // PWA manifest, linked statically rather than via the module's client
        // plugin (disabled — see the `pwa` block). Filename is the module's
        // stable default.
        { rel: "manifest", href: "/manifest.webmanifest" },
      ],
      meta: [
        // Matches the manifest theme_color (brand cream) for browser UI tinting.
        { name: "theme-color", content: "#F7F4EC" },
      ],
    },
  },
  css: ["~/assets/css/tailwind.css"],
  vite: {
    plugins: [tailwindcss()],
  },
  experimental: { appManifest: false },
  // Flat component names (basename, no directory prefix) so nested components
  // like components/viewers/CodeViewer.vue resolve as <CodeViewer>. Basenames
  // are unique across the components tree.
  components: [{ path: "~/components", pathPrefix: false }],
  // Solar icons via unplugin-icons — compiled to inline SVG components at build
  // time (zero runtime, Worker-safe). Import as `~icons/solar/<name>`. The set
  // is pinned via the @iconify-json/solar devDependency for reproducible builds.
  modules: ["@pinia/nuxt", ["unplugin-icons/nuxt", { autoInstall: false }], "@vite-pwa/nuxt"],
  // Installable PWA (phone home-screen install; offline app shell). The service
  // worker is NOT auto-registered: plugins/pwa.client.ts registers it in real
  // browsers only, so the desktop shell keeps loading straight from the network
  // and never grows a second (SW-cached) update path.
  pwa: {
    // Prompt-style updates: a new worker installs and WAITS; the plugin
    // activates it (SKIP_WAITING → reload) only when no editor holds unsaved
    // work. Immediate activation (skipWaiting/clientsClaim) would reload a
    // long-lived tab over a dirty buffer and discard it.
    registerType: "prompt",
    injectRegister: false,
    client: { registerPlugin: false },
    manifest: {
      name: "Treehouse",
      short_name: "Treehouse",
      description: "A shared file workspace for you and your agents.",
      display: "standalone",
      // Brand canvas cream (design.md `colors.cream`) so the installed app's
      // splash/title bar match the app background.
      theme_color: "#F7F4EC",
      background_color: "#F7F4EC",
      icons: [
        { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
        { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
        {
          src: "/maskable-icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    workbox: {
      // Prompt-style pair: NO skipWaiting (a new worker waits for the plugin's
      // deliberate SKIP_WAITING message), but clientsClaim on — once activated,
      // the worker must take control of open tabs or the activation's reload
      // never fires and the tab keeps running the old build indefinitely
      // (verified empirically: without it, controllerchange never arrives).
      clientsClaim: true,
      cleanupOutdatedCaches: true,
      // SPA: unknown navigations get the cached app shell…
      navigateFallback: "/",
      // …except server-rendered routes that must hit the network: the
      // deployment descriptor (see server/routes/.well-known) and anything
      // API-shaped on this origin.
      navigateFallbackDenylist: [/^\/\.well-known\//, /^\/api\//],
      globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
    },
  },
  // `shared` ships raw TypeScript (no build step), so Vite must transpile it.
  build: { transpile: ["shared"] },
  runtimeConfig: {
    public: {
      // Overridden at runtime by NUXT_PUBLIC_API_URL. `||`, not `??`: an empty
      // value means "not configured", not "use the empty string". With `??` an
      // empty NUXT_PUBLIC_API_URL baked apiUrl:"", which makes the app request
      // `/api/...` against its OWN origin instead of the API, and 500s the
      // /.well-known/treehouse route — while looking nothing like the localhost
      // default the deploy preflight scans for.
      apiUrl: process.env.NUXT_PUBLIC_API_URL || "http://localhost:3010",
      // PostHog. Unset key = analytics fully off: the client plugin returns a
      // no-op stub and the browser makes no requests at all. That is the
      // default for local dev, CI, and self-hosted instances, none of which
      // should need a PostHog account or should be polluting the real project.
      //
      // The host is our OWN /ph proxy (server/routes/ph/[...path].ts), not
      // posthog.com — see that file for why. Overridable so a self-hosted
      // instance can point at its own PostHog.
      posthog: {
        key: process.env.NUXT_PUBLIC_POSTHOG_KEY || "",
        host: process.env.NUXT_PUBLIC_POSTHOG_HOST || "/ph",
      },
      // "What's new" release notes from Hopdate (components/WhatsNew.vue). The
      // project key is public: it only reads published entries. Empty = the
      // sidebar row is hidden, which is the default for local dev, CI and
      // self-hosted instances.
      // Workspace tabs (components/WorkspaceTabs.vue). On by default, with a
      // toggle in the account menu to turn them off. `opt-in` starts them off
      // with the toggle offered; `off` hides them. See useTabsEnabled.
      tabs: process.env.NUXT_PUBLIC_TABS || "on",
      hopdate: {
        apiUrl: process.env.NUXT_PUBLIC_HOPDATE_API_URL || "https://api.hopdate.pixelhop.io",
        projectKey: process.env.NUXT_PUBLIC_HOPDATE_PROJECT_KEY || "",
      },
    },
  },
  // "hidden" generates source maps but emits no //# sourceMappingURL comment,
  // so they are uploaded to PostHog for readable stack traces without being
  // discoverable by anyone reading the deployed bundle. The upload hook below
  // deletes them from the output afterwards, so we never serve our own source.
  sourcemap: { client: sourceMapCredentials ? "hidden" : false },
  hooks: {
    // Inject a build id into the bundles and upload the maps to PostHog, so
    // exceptions resolve to real .vue files and line numbers instead of
    // chunk-a1b2c3.js:1:48210.
    //
    // No-ops without both upload credentials. Upload failures do not fail the
    // build, but source-map cleanup failures do: publishing our source is worse
    // than losing a deploy.
    "nitro:build:public-assets": () => {
      if (!sourceMapCredentials) return;
      uploadPosthogSourceMaps({
        ...sourceMapCredentials,
        dir: ".output/public",
        host: process.env.NUXT_PUBLIC_POSTHOG_UPLOAD_HOST || "https://eu.posthog.com",
      });
    },
  },
  // Deployment target: Cloudflare Workers (static-asset SPA).
  // Override with NITRO_PRESET=node-server for a plain Node build if needed.
  nitro: {
    preset: process.env.NITRO_PRESET ?? "cloudflare_module",
    cloudflare: {
      nodeCompat: true,
    },
    // Prerender the SPA shell to a static index.html. Required by the PWA
    // service worker: its navigation fallback is bound to "/", and Workbox can
    // only bind to a URL that exists in the precache manifest — without this
    // the shell is rendered at runtime by the worker and the SW throws
    // `non-precached-url` on every offline navigation.
    prerender: { routes: ["/"] },
  },
});