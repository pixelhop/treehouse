// The decision the auth middleware makes on every navigation, kept pure so it
// can be tested. See middleware/auth.ts for why it doesn't simply ask the API
// every time.

/** How long a confirmed session is trusted before it is re-checked in the background. */
export const SESSION_RECHECK_MS = 60_000;

/**
 * - `verify`: nobody is known to be signed in, so wait for the API to say.
 * - `recheck`: someone is, but it's been a while; let the navigation through and
 *   check in the background.
 * - `pass`: someone is, and it was confirmed recently.
 */
export type SessionGate = "verify" | "recheck" | "pass";

export function sessionGate(o: {
  signedIn: boolean;
  lastChecked: number;
  now: number;
}): SessionGate {
  if (!o.signedIn) return "verify";
  return o.now - o.lastChecked > SESSION_RECHECK_MS ? "recheck" : "pass";
}

/** Whether better-auth's session store already holds a signed-in user. */
export function storeHasUser(session: { get(): { data?: { user?: unknown } | null } } | undefined) {
  return Boolean(session?.get().data?.user);
}