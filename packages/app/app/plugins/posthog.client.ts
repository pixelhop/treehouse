// PostHog: product analytics, session replay, error tracking and surveys.
//
// Treehouse stores people's private documents and encrypts their bytes at rest
// (packages/blob-io/src/blob-crypto.ts). Streaming those documents' names
// and contents to an analytics vendor would make that encryption theatre, so
// the privacy configuration below is the load-bearing part of this file, not
// boilerplate. Read the comments before changing any of it.
//
// Why hand-rolled rather than the official @posthog/nuxt module: that module
// passes `clientConfig` through `runtimeConfig.public`, which Nuxt serialises to
// JSON for the browser. Function-valued options are silently dropped in the
// process — including `before_send`, which is the only thing that keeps file
// paths out of `$current_url`. The module would have looked like it worked while
// leaking every file name in the product. (It also force-bundles posthog-node
// into the Cloudflare Worker, which this SPA has no use for.)
//
// Client-only (.client): posthog-js is browser-only and the app is an SPA.
import posthog, { type PostHog } from "posthog-js";
import {
  POSTHOG_UI_HOST,
  fileExtension,
  isReplayableRoute,
  redactEventProperties,
  redactUrl,
} from "shared";

/**
 * The subset of PostHog the app is allowed to call. Narrow on purpose: the
 * no-op stub returned when analytics is disabled has to implement it, and every
 * method added here is one more thing that must stay safe to call with no key,
 * no consent, and no network.
 */
export interface Analytics {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  identify: (distinctId: string, properties?: Record<string, unknown>) => void;
  group: (type: string, key: string, properties?: Record<string, unknown>) => void;
  captureException: (error: unknown, properties?: Record<string, unknown>) => void;
  reset: () => void;
  /** The real client, or null when analytics is disabled. Escape hatch for
   * feature flags and surveys; prefer the methods above. */
  client: PostHog | null;
}

/**
 * Attributes whose value is human-readable text and can therefore carry a file
 * name. Masked in session replay regardless of where they appear — an allow-list
 * of "safe" tooltips is a thing we would eventually get wrong, in the direction
 * that leaks.
 */
const TEXT_BEARING_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "alt",
  "placeholder",
  "value",
  // `download` is a bare FILENAME, not a URL — <a download="2026 Tax Return.md">.
  // Running it through redactUrl would parse it as a relative path and hand
  // back "/2026 Tax Return.md", leaking the very thing we are redacting.
  "download",
]);

/**
 * Attributes whose value is a URL, and which therefore carry a file name
 * whenever they point at a workspace route or an API file route. Redacted
 * rather than blanked, so stylesheet and asset URLs survive intact.
 */
const URL_BEARING_ATTRIBUTES = new Set(["href", "src", "action"]);

/** Analytics off. Every method is a no-op so callers never branch on "is it on?" —
 * that branch would otherwise spread through the codebase one component at a time. */
const disabled: Analytics = {
  capture: () => {},
  identify: () => {},
  group: () => {},
  captureException: () => {},
  reset: () => {},
  client: null,
};

export default defineNuxtPlugin((nuxtApp) => {
  const { key, host } = useRuntimeConfig().public.posthog as { key: string; host: string };

  // No key configured → do nothing at all. Not "initialise and opt out": we make
  // zero network requests and set zero storage. This is the default in local
  // dev, in CI, and on self-hosted instances.
  if (!key) {
    return { provide: { analytics: disabled } };
  }

  posthog.init(key, {
    api_host: host,
    // The proxy at `host` only serves PostHog's API. Toolbar and "view in
    // PostHog" links must resolve to the real product or they 404.
    ui_host: POSTHOG_UI_HOST,
    // Opt into PostHog's current default behaviours (history-based pageviews,
    // which is what an SPA needs) rather than the legacy ones.
    defaults: "2025-05-24",

    // --- Privacy: properties -------------------------------------------------
    // This app puts the user's file path in the URL (/w/:id/:path...), and
    // posthog-js stamps $current_url onto EVERY event — pageviews, autocapture,
    // exceptions, replay metadata. Redacting here is what stops file names
    // leaving the browser; DOM masking alone would not have caught any of it.
    before_send: (event) => {
      if (event) redactEventProperties(event.properties);
      return event;
    },
    // Client-side URL matching (replay triggers, survey display conditions)
    // reads window.location.href directly and does not see the rewrite above.
    // Point it at the redacted form so a survey can never be targeted at — and
    // therefore never reveal — a specific file path.
    get_current_url: redactUrl,

    // --- Privacy: autocapture ------------------------------------------------
    // Autocapture records the text of whatever was clicked. In a file browser
    // that text is a file name. Turning text and attribute capture off globally
    // is fail-SAFE: a new component cannot leak by forgetting to opt out.
    // Controls we actually want to identify carry an explicit, safe label via
    // data-ph-capture-attribute-action="…" instead.
    mask_all_text: true,
    mask_all_element_attributes: true,

    // --- Error tracking ------------------------------------------------------
    // Unhandled errors and rejections, so a broken deploy shows up as a spike
    // rather than as a support email three days later. Stack frames are made
    // readable by the source maps uploaded at build time (see nuxt.config.ts).
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
    },

    // Console output is a leak channel that NO DOM masking covers: rrweb records
    // console arguments verbatim, and the recording of them is switched on by a
    // PROJECT setting, not by this code — so leaving it to the default means the
    // privacy posture depends on a toggle in someone's PostHog account.
    //
    // This app logs things like `console.warn("Treehouse: query cache restore
    // failed", e)` (plugins/vue-query.client.ts), and its vue-query cache keys
    // are `["file-text", workspaceId, path, version]` — so a failed restore can
    // put a file path straight into a replay. Off, explicitly.
    //
    // Exceptions are not lost by this: they are captured separately, with stack
    // traces, by error tracking.
    enable_recording_console_log: false,

    // --- Privacy: session replay ---------------------------------------------
    // The contract, applied via CSS classes in the components themselves:
    //   .ph-no-capture → element becomes a grey box  (file CONTENTS)
    //   .ph-mask       → text becomes asterisks      (file NAMES)
    // Names are masked rather than blocked so the SHAPE of the tree survives:
    // "user scanned nine items, hesitated, opened the fourth" is most of what a
    // replay is for, and it costs nothing to know.
    session_recording: {
      // These settings can also be enabled remotely in the PostHog project.
      // Keep the local false overrides explicit: request bodies and headers can
      // contain document contents, API keys and other credentials, and URL
      // masking cannot make either payload safe to record.
      recordBody: false,
      recordHeaders: false,
      // Every input value, everywhere. Search boxes, rename fields and the
      // share-password prompt all take user content, and an allow-list of
      // "safe" inputs is a thing we would eventually get wrong.
      maskAllInputs: true,
      // Do not pull the user's own fonts and stylesheets in from remote origins
      // when rebuilding the replay — keeps the recording self-contained.
      collectFonts: false,
      // Text-bearing ATTRIBUTES are a second channel that `.ph-mask` does not
      // close: rrweb records every attribute verbatim, so a tooltip like
      // title="Actions for 2026 Tax Return.md" would sit in the replay DOM in
      // plaintext next to the span we carefully masked. Blanking them app-wide
      // is fail-safe, and the only cost is that tooltip text is unreadable
      // during playback — hover-only text we can live without.
      maskAttributeFn: (name, value) => {
        const attr = name.toLowerCase();
        if (TEXT_BEARING_ATTRIBUTES.has(attr)) return "*".repeat(value.length);
        // URL-bearing attributes carry file names too. The download button in
        // FileInfoPanel is the clear case: href="/api/workspaces/:id/files/
        // 2026 Tax Return.md" and download="2026 Tax Return.md". Redacting
        // rather than blanking keeps <link rel=stylesheet> and every /_nuxt/
        // asset intact — redactUrl passes through anything that isn't a
        // workspace or API file route — so the replay still renders with our
        // real CSS.
        if (URL_BEARING_ATTRIBUTES.has(attr)) return redactUrl(value);
        return value;
      },
      // The replay records URLs through a SEPARATE path from event properties:
      // rrweb's Meta event href, the `$url_changed` and `$pageview` custom
      // events inside the recording, and every captured network request. None
      // of it goes through `before_send`, so without this the file path would
      // sit in the replay's own address bar while every event property around
      // it was properly redacted. Confirmed by reading posthog-js's `_maskUrl`,
      // which returns the URL UNCHANGED when neither mask fn is configured.
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        name: redactUrl(request.name),
      }),
    },
  });

  // Stop replay on public share pages, and start it again when the user
  // navigates back into the product. Checked on every route change rather than
  // only at init because this is an SPA: a client-side navigation into /s/ does
  // not re-run this plugin.
  const router = useRouter();
  if (isReplayableRoute(router.currentRoute.value.path)) posthog.startSessionRecording();
  else posthog.stopSessionRecording();

  // STOP in `beforeEach`, START in `afterEach` — the asymmetry is load-bearing.
  //
  // `afterEach` runs once the incoming route has rendered, so stopping there
  // leaves rrweb a window in which the share page is already on screen and gets
  // recorded. Measured at the proxy, that window was worth ~1KB of replay data
  // POSTed while sitting on a public share page. Stopping in `beforeEach` closes
  // it: recording is off before the page paints.
  //
  // Starting stays in `afterEach` for the mirror-image reason — begin recording
  // once the product page is actually on screen, not while the previous route is
  // still up.
  router.beforeEach((to) => {
    if (!isReplayableRoute(to.path)) posthog.stopSessionRecording();
    // Returning nothing lets the navigation proceed; this guard only ever
    // switches recording off, and must never be able to block a route.
  });
  router.afterEach((to) => {
    if (isReplayableRoute(to.path)) posthog.startSessionRecording();
  });

  // Vue's own error handler is separate from window.onerror: a component that
  // throws during render is caught by Vue and would otherwise never reach
  // PostHog. `info` says which lifecycle hook it came from.
  nuxtApp.hook("vue:error", (error, _instance, info) => {
    posthog.captureException(error, { info });
  });

  // --- Identity ------------------------------------------------------------
  // Watching the session rather than hooking the sign-out buttons: there are two
  // of them today (layouts/default.vue and AppSidebar.vue) and any third one
  // added later would silently miss the reset, leaving the next user on a shared
  // machine stitched onto the previous user's identity.
  const session = useAuthClient().useSession();
  let identifiedAs: string | null = null;
  watch(
    () => session.value?.data,
    (data) => {
      const user = data?.user;
      if (!user) {
        // Signed out. reset() starts a fresh anonymous identity.
        if (identifiedAs !== null) {
          posthog.reset();
          identifiedAs = null;
        }
        return;
      }
      if (identifiedAs === user.id) return;
      identifiedAs = user.id;
      // Email and name are already ours — the user gave them to us to run the
      // product, and being able to answer "which customer hit this bug" is the
      // point. File names are the thing we do not send; a user's own identity
      // is not.
      // `heard_about` is sign-up's "How did you hear about Treehouse?", so
      // sign-ups and conversions can be broken down by where people came from.
      // `marketing_opt_in` is its product-news checkbox.
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
        ...(user.heardAbout ? { heard_about: user.heardAbout } : {}),
        marketing_opt_in: user.marketingOptIn === true,
      });

      // activeOrganizationId is added by the better-auth organization plugin at
      // runtime and isn't in the base session type.
      const orgId = (data?.session as { activeOrganizationId?: string | null } | undefined)
        ?.activeOrganizationId;
      if (orgId) posthog.group("organization", orgId);
    },
    { immediate: true },
  );

  // --- Product events --------------------------------------------------------
  // `file_opened` is captured from the route rather than from a click handler so
  // it counts every way a file gets opened — tree click, deep link, back button,
  // agent-generated link — instead of only the one path someone remembered to
  // instrument. The extension is derived HERE and the path is discarded; the
  // name never leaves the browser.
  router.afterEach((to) => {
    const match = /^\/w\/[^/]+\/(.+)$/.exec(to.path);
    if (!match) return;
    const tail = match[1]!;
    posthog.capture("file_opened", {
      extension: fileExtension(tail),
      depth: tail.split("/").length,
    });
  });

  const analytics: Analytics = {
    capture: (event, properties) => posthog.capture(event, properties),
    identify: (distinctId, properties) => posthog.identify(distinctId, properties),
    group: (type, groupKey, properties) => posthog.group(type, groupKey, properties),
    captureException: (error, properties) => posthog.captureException(error, properties),
    reset: () => posthog.reset(),
    client: posthog,
  };

  return { provide: { analytics } };
});