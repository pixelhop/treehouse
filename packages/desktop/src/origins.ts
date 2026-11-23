// Trusted-origin model for the shell. The workspace window loads a REMOTE web
// app; every security decision (navigation allow-list, trust-on-first-use) keys
// off which origins are trusted. This module is pure (no Electron) so the policy
// is unit-testable.

export interface TrustedOrigins {
  /** The web app origin the workspace window loads (the deployed SPA). */
  app: string;
  /** The API origin the SPA + daemon talk to (discovered via the well-known
   * descriptor, U4/U7). */
  api: string;
}

// The default hosted app origin. It (and any already-linked server) is trusted
// without prompting; ANY other origin must clear a trust-on-first-use
// confirmation (U7) before the shell loads it or mutates the allow-list.
// Overridable so dev / self-host builds can retarget — the exact value is a
// product config detail, not load-bearing to the security model.
export const DEFAULT_APP_ORIGIN = process.env.TREEHOUSE_APP_ORIGIN ?? "https://app.trytree.house";

/** The origin of a URL string, or null if it doesn't parse. */
export function normalizeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether an app origin is the built-in default hosted one (no TOFU needed). */
export function isDefaultOrigin(appOrigin: string): boolean {
  const o = normalizeOrigin(appOrigin);
  return o !== null && o === normalizeOrigin(DEFAULT_APP_ORIGIN);
}

/**
 * Trust-on-first-use gate: does this app origin need an explicit confirmation
 * before the shell loads it, mutates the navigation allow-list, or trusts its
 * descriptor? True for ANY origin that is neither the default hosted one nor an
 * already-linked server. Any web page can fire a `treehouse://` URL with an
 * attacker-controlled origin, so an unknown origin is untrusted input — the shell
 * must supply the trust signal a browser's address bar normally provides.
 */
export function needsTrustPrompt(appOrigin: string, linkedOrigins: string[] = []): boolean {
  if (isDefaultOrigin(appOrigin)) return false;
  const o = normalizeOrigin(appOrigin);
  if (o === null) return true; // unparseable → prompt (and it will fail validation)
  return !linkedOrigins.some((l) => normalizeOrigin(l) === o);
}