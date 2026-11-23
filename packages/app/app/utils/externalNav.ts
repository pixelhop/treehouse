import { isDesktopShell } from "./runtimeSurface";

/**
 * Send the user to a URL outside the app — Stripe Checkout or the billing
 * portal.
 *
 * A plain `location.href` is right in a browser and silently WRONG inside the
 * desktop shell: `hardenWebContents` (packages/desktop/src/windows.ts) allow-lists
 * in-window navigation to the app and API origins and calls `preventDefault()` on
 * everything else. Assigning `location` there does nothing at all — no error, no
 * navigation, just a button that appears broken.
 *
 * `window.open` is also denied as a window, but its handler passes safe https
 * URLs to the system browser, which is where a payment page belongs anyway: it is
 * the surface with the user's password manager, Apple Pay and a visible address
 * bar to check before typing a card number into it.
 *
 * The workspace UI picks the change up on its own when the shell window regains
 * focus — the usage query refetches on focus for exactly this reason.
 *
 * Returns how it left: `"redirected"` means this document is on its way out and
 * the caller must not navigate again (a client-side route change would cancel
 * the redirect), `"external"` means the page stayed put and the caller still owns
 * where the user is standing.
 */
export function openBillingUrl(url: string): "redirected" | "external" {
  if (isDesktopShell()) {
    window.open(url, "_blank", "noopener");
    return "external";
  }
  window.location.href = url;
  return "redirected";
}