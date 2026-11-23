import type { LocationQuery } from "vue-router";

// An MCP client's OAuth authorization passes through the sign-in, sign-up and
// consent pages carrying a query signed by the API (`sig` + the parameters it
// covers). While that query is on the URL, signing in or up does not navigate
// in the app: the API answers the sign-in with the next step of the
// authorization (the consent page) and the auth client follows it.

/** Whether this page was reached partway through an OAuth authorization. */
export function isOAuthFlow(query: LocationQuery): boolean {
  return typeof query.sig === "string" && query.sig.length > 0;
}

/** The same query, for links between sign-in and sign-up mid-flow. */
export function oauthFlowQuery(query: LocationQuery): LocationQuery | undefined {
  return isOAuthFlow(query) ? query : undefined;
}
// Parameters that can't go back to the authorize endpoint: the ones the API
// adds when it signs the query, and `max_age`. The person has just signed in by
// opening the link, which is as fresh as authentication gets, and the provider
// drops `max_age` after a sign-in for the same reason. Left in, `max_age=0`
// would never be satisfied and would send them back to the sign-in page.
const DROPPED_PARAMS = new Set(["sig", "exp", "max_age"]);

/**
 * Where an email-verification link should land when the account was created
 * partway through an OAuth authorization: back at the authorization itself.
 *
 * Verifying signs the person in (`autoSignInAfterVerification`), and the
 * authorize endpoint, seeing a session, continues to the consent page. The
 * signed query can't be reused for this: it expires after ten minutes, and
 * people read their email later than that. So the client's own parameters go
 * back unsigned, and the authorize endpoint checks them again as it would any
 * request. `login` and `create` are dropped from `prompt`, and `max_age` goes,
 * because the person has just done both; left in, they would send the browser
 * straight back to the sign-in or sign-up page.
 */
export function oauthResumeURL(query: LocationQuery, apiUrl: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (DROPPED_PARAMS.has(key) || key.startsWith("ba_")) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      if (typeof one === "string") params.append(key, one);
    }
  }
  const prompt = (params.get("prompt") ?? "")
    .split(" ")
    .filter((p) => p && p !== "login" && p !== "create");
  if (prompt.length) params.set("prompt", prompt.join(" "));
  else params.delete("prompt");
  return `${apiUrl.replace(/\/+$/, "")}/api/auth/oauth2/authorize?${params}`;
}
/**
 * Where the link in a verification email should land once it has signed the
 * person in: back into the authorization mid-OAuth, otherwise `next` in the
 * app, by way of the page that explains an expired link.
 */
export function verificationCallbackURL(
  query: LocationQuery,
  apiUrl: string,
  appOrigin: string,
  next: string,
): string {
  return isOAuthFlow(query)
    ? oauthResumeURL(query, apiUrl)
    : `${appOrigin}/email-verified?next=${encodeURIComponent(next)}`;
}