// The service-worker registration decision, as a pure function so the
// branches are unit-testable (the Nuxt plugin wrapping it is not).
// From `shared`, not `~/`: this util is imported by plain unit tests, where the
// Nuxt alias does not resolve.
import { isDesktopShellUserAgent } from "shared";

/**
 * Whether this page should register the PWA service worker.
 *
 * False inside the desktop shell — Electron has its own update story, and a SW
 * would add a second, cached one (first launch after a deploy would show the
 * previous build). False when the browser has no serviceWorker API at all.
 */
export function shouldRegisterServiceWorker(
  userAgent: string | null | undefined,
  hasServiceWorkerApi: boolean,
): boolean {
  if (isDesktopShellUserAgent(userAgent)) return false;
  return hasServiceWorkerApi;
}

/** The one thing the activator needs from a waiting ServiceWorker. */
export interface WaitingWorkerLike {
  postMessage(message: unknown): void;
}

/**
 * The update-activation policy: activate a waiting service worker the moment
 * no surface holds unsaved work, re-checking every `recheckMs` until the edit
 * is saved or discarded. Activating reloads the page, so activating over a
 * dirty buffer would discard it — that is the invariant this loop protects.
 *
 * `arm` is idempotent while a deferral is pending, and the loop stands down
 * without activating if the waiting worker disappears (another tab activated
 * it, or a newer update superseded it) — the next `updatefound` re-arms.
 */
export function makeUpdateActivator(deps: {
  hasUnsavedWork: () => boolean;
  requestActivation: (worker: WaitingWorkerLike) => void;
  recheckMs: number;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending = false;

  return {
    get pending() {
      return pending;
    },
    arm(getWaiting: () => WaitingWorkerLike | null) {
      if (pending) return;
      pending = true;
      const settle = () => {
        clearInterval(timer);
        pending = false;
      };
      const attempt = () => {
        const waiting = getWaiting();
        if (!waiting) {
          settle();
          return;
        }
        if (deps.hasUnsavedWork()) return;
        settle();
        deps.requestActivation(waiting);
      };
      timer = setInterval(attempt, deps.recheckMs);
      attempt();
    },
  };
}
/**
 * The per-tab reload policy for service-worker updates. Activating a waiting
 * worker changes the controller for EVERY controlled tab, so every tab —
 * including siblings that never posted SKIP_WAITING — must treat a controller
 * change as "a new build took over" and reload itself, or it silently keeps
 * running the old build forever. Each tab gates its own reload on its own
 * unsaved-work registry, and the dirty check happens HERE, at reload time, not
 * back when activation was requested — keystrokes typed in the async gap
 * between SKIP_WAITING and controllerchange are re-consulted.
 *
 * The one controller change that must NOT reload is the very first install:
 * clientsClaim gives an uncontrolled page a controller without any new build
 * involved. `hadControllerAtStart` distinguishes the two.
 */
export function makeReloadCoordinator(deps: {
  hadControllerAtStart: boolean;
  hasUnsavedWork: () => boolean;
  reload: () => void;
  recheckMs: number;
}) {
  let claimed = deps.hadControllerAtStart;
  let pending = false;
  let reloaded = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const attempt = () => {
    if (deps.hasUnsavedWork()) return;
    clearInterval(timer);
    pending = false;
    // Reload exactly once, no matter how many controller changes arrive.
    reloaded = true;
    deps.reload();
  };

  return {
    get pending() {
      return pending;
    },
    /** Wire to `navigator.serviceWorker`'s "controllerchange" event. */
    onControllerChange() {
      if (!claimed) {
        claimed = true;
        return;
      }
      if (pending || reloaded) return;
      pending = true;
      timer = setInterval(attempt, deps.recheckMs);
      attempt();
    },
  };
}