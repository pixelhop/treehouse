// Plausible wiring that the browser plugin (plugins/plausible.client.ts) and the
// proxy routes (server/routes/pv/) must agree on.
//
// The paths are deliberately bland. Blocklists match on "plausible",
// "analytics", "stats" and "tracking" in a URL, and on Plausible's own
// `/js/pa-*.js` and `/api/event` shapes, so the proxy uses none of them.

/** Where the browser loads the script from: our proxy, not plausible.io. */
export const PLAUSIBLE_SCRIPT_PATH = "/pv/script.js";

/** Where the script sends pageviews. Passed to `plausible.init({ endpoint })`. */
export const PLAUSIBLE_EVENT_PATH = "/pv/event";

export const PLAUSIBLE_ORIGIN = "https://plausible.io";

/**
 * A per-site script id as Plausible issues them (`pa-` + a base64url-ish run).
 * Checked before it goes into an upstream URL, so a bad env value cannot turn
 * the script route into a fetch of some other path on plausible.io.
 */
export function isPlausibleScriptId(id: string): boolean {
  return /^pa-[A-Za-z0-9_-]{8,64}$/.test(id);
}