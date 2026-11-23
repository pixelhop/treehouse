// Registers the PWA service worker — in real browsers only.
//
// The desktop shell loads this same app from the same origin (see
// packages/desktop/src/windows.ts), so an unconditional registration would
// install the service worker inside Electron too. That would silently change
// the shell's update behaviour: today every window open loads fresh from the
// network; with a SW the first launch after a deploy would serve the previous
// precached build. The shell has its own update story — keep the SW out of it.
// The gate lives in `shouldRegisterServiceWorker` (~/utils/pwa) so its branches
// are unit-testable; the shell declares itself in the user agent
// (`shellUserAgent` in packages/desktop/src/security.ts) exactly so this app
// can adapt. Presentation only, never security — the SW grants nothing.
//
// Registration is native (`navigator.serviceWorker.register`), not
// `virtual:pwa-register`: workbox-window did not deliver its `waiting` event
// for updates discovered by our poll (verified against a live browser), and a
// silent no-op updater is exactly the failure mode we can't have. The native
// lifecycle below is small and fully observable.
//
// Update policy, two independently gated layers (both in ~/utils/pwa, both
// unit-tested; a reload over a dirty editor would discard its buffer):
//   1. ACTIVATION — the worker is built prompt-style (no skipWaiting in
//      nuxt.config.ts), so a new build installs and WAITS; this tab requests
//      activation only while its own registry reports no unsaved work.
//   2. RELOAD — activation flips the controller in EVERY controlled tab, so
//      each tab (siblings included — they never posted SKIP_WAITING) reloads
//      itself on `controllerchange`, gated on its OWN registry at reload time.
//      That re-checks keystrokes typed in the async gap after activation was
//      requested, and it is what gets a sibling tab off the old build.
import { hasUnsavedWork } from "~/utils/unsavedWork";
import {
  makeReloadCoordinator,
  makeUpdateActivator,
  shouldRegisterServiceWorker,
} from "~/utils/pwa";

/** How often a long-lived tab checks the server for a new build. */
const UPDATE_POLL_MS = 60 * 60 * 1000;
/** How often a deferred (dirty-editor) activation re-checks for cleanliness. */
const DIRTY_RECHECK_MS = 30 * 1000;

export default defineNuxtPlugin(() => {
  if (!shouldRegisterServiceWorker(navigator.userAgent, "serviceWorker" in navigator)) return;

  // Layer 2: reload this tab when a new build takes control — whoever
  // requested it. First-install clientsClaim is distinguished by whether the
  // page already had a controller when it loaded.
  const coordinator = makeReloadCoordinator({
    hadControllerAtStart: navigator.serviceWorker.controller !== null,
    hasUnsavedWork,
    reload: () => window.location.reload(),
    recheckMs: DIRTY_RECHECK_MS,
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    coordinator.onControllerChange();
  });

  // Layer 1: request activation only while this tab is clean (activate when
  // clean, wait while dirty, stand down if the worker vanishes). The reload
  // itself is layer 2's decision — the registry is consulted again there.
  const activator = makeUpdateActivator({
    hasUnsavedWork,
    requestActivation: (worker) => {
      worker.postMessage({ type: "SKIP_WAITING" });
    },
    recheckMs: DIRTY_RECHECK_MS,
  });

  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      // A worker already waiting from an earlier session is a pending update.
      if (registration.waiting) activator.arm(() => registration.waiting);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // "installed" with an existing controller = an UPDATE now waiting.
          // Without a controller it is the very first install — nothing to do.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            activator.arm(() => registration.waiting);
          }
        });
      });

      // Workspace tabs stay open for days; without a poll, updates are only
      // discovered on navigation. `onLine === false` skips a doomed check as a
      // best effort, but it is advisory only — a rejection can still happen
      // online, so always catch it (an uncaught one is an unhandled rejection).
      setInterval(() => {
        if (navigator.onLine === false) return;
        registration.update().catch((err) => {
          console.warn("[pwa] service worker update check failed", err);
        });
      }, UPDATE_POLL_MS);
    })
    .catch((err) => {
      // A blocked, missing, or invalid worker otherwise fails silently and the
      // app just never works offline — leave a diagnostic.
      console.error("[pwa] service worker registration failed", err);
    });
});