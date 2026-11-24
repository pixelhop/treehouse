// Plausible for the marketing site and docs: page counts for every visitor.
//
// Unlike PostHog (plugins/posthog.client.ts) this is NOT behind the cookie
// banner. Plausible sets no cookies and writes nothing to the device; it counts a
// visit from a hash of IP + user agent that rotates daily, so it cannot follow
// anyone across days or sites. That is what lets it count the visitors who
// reject the banner, which PostHog never sees.
//
// Both the script and its events go through our own Worker (server/routes/pv/)
// instead of plausible.io, so tracker blockers do not silently drop the count.
// Single-page navigations are picked up by the script itself (it hooks the
// History API), so there is nothing to wire into the router.
//
// Off unless NUXT_PUBLIC_PLAUSIBLE_SCRIPT_ID is set, which only the production
// deploy does (.github/workflows/cloudflare.yml). The script is tied to the
// trytree.house site, so a preview or local visit would otherwise be counted
// as production traffic.
import {
  PLAUSIBLE_EVENT_PATH,
  PLAUSIBLE_SCRIPT_PATH,
  isPlausibleScriptId,
} from "../utils/plausible";

type PlausibleQueue = ((...args: unknown[]) => void) & {
  q?: unknown[][];
  o?: Record<string, unknown>;
  init?: (options?: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    plausible?: PlausibleQueue;
  }
}

export default defineNuxtPlugin(() => {
  const { scriptId } = useRuntimeConfig().public.plausible as { scriptId: string };
  if (!isPlausibleScriptId(scriptId)) return;

  // Plausible's own install snippet: queue calls made before the script loads,
  // and stash the init options for the script to read when it arrives.
  const plausible: PlausibleQueue =
    window.plausible ??
    ((...args: unknown[]) => {
      (plausible.q ??= []).push(args);
    });
  plausible.init ??= (options) => {
    plausible.o = options ?? {};
  };
  window.plausible = plausible;
  plausible.init({ endpoint: PLAUSIBLE_EVENT_PATH });

  const script = document.createElement("script");
  script.async = true;
  script.src = PLAUSIBLE_SCRIPT_PATH;
  document.head.appendChild(script);
});