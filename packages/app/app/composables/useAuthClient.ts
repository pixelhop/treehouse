import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/vue";
import { inferAdditionalFields, organizationClient } from "better-auth/client/plugins";

/**
 * Builds the configured client. The `AuthClient` type is derived from this
 * (not from a bare `createAuthClient`) so the `organizationClient` plugin's
 * surface is reflected in the type the rest of the app consumes.
 */
function buildAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    fetchOptions: { credentials: "include" },
    // `oauthProviderClient` matters only mid-OAuth (an MCP client connecting):
    // the API sends the browser to /sign-in with a signed query, and this
    // forwards that query with the sign-in so the API can carry on to the
    // consent page instead of stopping at "signed in".
    //
    // `inferAdditionalFields` mirrors the user fields the API adds (see
    // `user.additionalFields` in packages/api/server/utils/auth.ts), so sign-up
    // accepts them and the session's user carries them.
    plugins: [
      organizationClient(),
      oauthProviderClient(),
      inferAdditionalFields({
        user: {
          heardAbout: { type: "string", required: false },
          marketingOptIn: { type: "boolean", required: false },
        },
      }),
    ],
  });
}

type AuthClient = ReturnType<typeof buildAuthClient>;

/**
 * Memoized better-auth Vue client.
 *
 * `baseURL` points at the API (a different origin than this app), and
 * `credentials: "include"` is required so the session cookie travels with every
 * cross-origin request. The `organizationClient` plugin stays registered because
 * better-auth's organization tables are what carry each workspace's member list
 * (one hidden organization per workspace) — but nothing in the UI calls
 * `authClient.organization.*` any more: organizations are never shown to users,
 * and member removal goes through the API's own DELETE route so the server-side
 * key-revocation hook fires.
 *
 * The client is cached on the Nuxt app instance (not a module global) so a
 * future switch to SSR can't leak one user's session into another request.
 */
export function useAuthClient(): AuthClient {
  const nuxtApp = useNuxtApp() as unknown as { _authClient?: AuthClient };

  if (!nuxtApp._authClient) {
    const {
      public: { apiUrl },
    } = useRuntimeConfig();

    nuxtApp._authClient = buildAuthClient(apiUrl);
  }

  return nuxtApp._authClient;
}