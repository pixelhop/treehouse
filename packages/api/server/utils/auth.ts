import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { jwt, organization } from "better-auth/plugins";
import { usePrismaClient } from "db";
import { stripeBillingPlugin } from "./billing";
import { consentClaim } from "./connection-claim";
import { withInferredApplicationType } from "./oauth-registration";
import { resetPasswordEmail, sendEmail, verifyEmailEmail } from "./email";
import { assertCanAddMember } from "./limits";
import { createWorkspaceWithOrg, revokeWorkspaceKeysForMember } from "./workspace";

// Give every new user a personal workspace on sign-up, so onboarding (and CLI
// device-linking) has something to point at immediately — without this, a fresh
// account has no workspace and the picker is empty. Runs in the user-create
// transaction's `after` hook.
//
// `createWorkspaceWithOrg` also mints the workspace's hidden 1:1 organization
// (the thing that actually carries its member list) and seeds its files. The
// workspace is named "<Name>'s Workspace" rather than "Default": the switcher is
// flat and cross-team now, so several workspaces all called "Default" would be
// indistinguishable.
async function provisionForNewUser(user: { id: string; name?: string | null }): Promise<void> {
  await createWorkspaceWithOrg({
    userId: user.id,
    name: user.name ? `${user.name}'s Workspace` : "My Workspace",
  });
}

// Email verification is required wherever email can actually be sent: a
// deployment with a Postmark token (staging, production, a self-host that set
// one up). Without a token nothing can be delivered, so requiring it would lock
// everyone out; local dev and the server-backed test suites run that way.
// REQUIRE_EMAIL_VERIFICATION=true|false overrides it, e.g. to try the flow
// locally, where the link is printed to the API console instead of sent.
const requireEmailVerification = process.env.REQUIRE_EMAIL_VERIFICATION
  ? process.env.REQUIRE_EMAIL_VERIFICATION === "true"
  : Boolean(process.env.POSTMARK_SERVER_TOKEN);

// Sign-up's two optional extras, which come from an unauthenticated form and
// can also be changed later through /update-user, so both paths clean them here:
//
// - `heardAbout`, the answer to "How did you hear about Treehouse?": free text,
//   so it is trimmed, capped and stored as null when blank. Anything past the
//   cap is noise, not an answer.
// - `marketingOptIn`, the "send me product news" checkbox: anything but a real
//   `true` is a no. Opting in records when (`marketingOptInAt`), as the record
//   of consent; opting out clears it.
const HEARD_ABOUT_MAX = 200;
export function cleanHeardAbout(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, HEARD_ABOUT_MAX);
  return trimmed || null;
}

export function cleanUserInput<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = { ...data };
  if ("heardAbout" in data) out.heardAbout = cleanHeardAbout(data.heardAbout);
  if ("marketingOptIn" in data) {
    const optedIn = data.marketingOptIn === true;
    out.marketingOptIn = optedIn;
    out.marketingOptInAt = optedIn ? new Date() : null;
  }
  return out as T;
}

// The front-end runs on a different origin (Cloudflare) than this API (Railway),
// so requests are cross-origin. `trustedOrigins` + credentialed CORS (see
// middleware/cors.ts) let the session cookie flow between them. APP_URL may be a
// comma-separated list (prod app + Cloudflare preview URLs).
const trustedOrigins = (process.env.APP_URL ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// In production the app + API live on subdomains of one custom domain
// (app./api.yourdomain.com). Setting COOKIE_DOMAIN=.yourdomain.com shares the
// session cookie across them (same-site, so SameSite=Lax is enough). Left unset
// in local dev so cookies stay scoped to localhost.
const cookieDomain = process.env.COOKIE_DOMAIN;

// Renames the auth cookies. Staging (staging-api.trytree.house) sits under the
// same parent domain as production, so the browser sends it production's
// `.trytree.house` session cookie too. With the same name, staging would try to
// verify a production token against its own secret and sign the visitor out.
// Unset in production and local dev, which keeps the default name.
const cookiePrefix = process.env.AUTH_COOKIE_PREFIX || undefined;

// This API's public origin. better-auth mounts under /api/auth, so the OAuth
// issuer is `${apiOrigin}/api/auth`, and the MCP endpoint is the protected
// resource that OAuth access tokens are audience-bound to.
const apiOrigin = (process.env.BETTER_AUTH_URL ?? "http://localhost:3010").replace(/\/+$/, "");
export const MCP_RESOURCE = `${apiOrigin}/api/mcp`;

// Scopes an MCP client may ask for. There is no finer-grained Treehouse scope:
// a connection acts as the user across every workspace they belong to, exactly
// like a user-scoped API key. `offline_access` is what gets the client a
// refresh token, so a connection survives the hour-long access-token lifetime.
export const MCP_SCOPES = ["openid", "profile", "email", "offline_access"];

// The OAuth sign-in and consent screens are app pages, on the app's origin (the
// first APP_URL), not on this API.
const appOrigin = trustedOrigins[0] ?? "http://localhost:3000";

// Built once: constructing the plugin twice would register two Stripe clients
// and two webhook handlers. Null when STRIPE_SECRET_KEY is unset, which is what
// lets a self-hosted deployment run with no Stripe account at all.
const billing = stripeBillingPlugin();

export const auth = betterAuth({
  database: prismaAdapter(usePrismaClient(), { provider: "postgresql" }),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3010",
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins,
  // The jwt plugin's GET /token hands a session-cookie holder a signed JWT. Only
  // the OAuth provider needs the plugin (to sign access tokens and serve
  // /jwks), and better-auth's MCP docs disable this route alongside it.
  disabledPaths: ["/token"],
  advanced: {
    ...(cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } : {}),
    ...(cookiePrefix ? { cookiePrefix } : {}),
  },
  emailAndPassword: {
    enabled: true,
    // Until the link in the verification email is clicked, signing in fails
    // with EMAIL_NOT_VERIFIED (and the page asks for a fresh link). Sign-up no
    // longer signs the new account in, and answers an address that is already
    // registered exactly as it answers a new one, so it can't be used to find
    // out who has an account.
    requireEmailVerification,
    // Forgot-password flow: the client calls `requestPasswordReset({ email,
    // redirectTo })`; better-auth mints a token and calls this with a `url`
    // pointing at the API's reset endpoint, which then redirects to the app's
    // /reset-password page (carrying the token). Email delivery goes through
    // Postmark, or the dev console fallback when no token is set (see email.ts).
    sendResetPassword: async ({ user, url }) => {
      const { subject, html, text } = resetPasswordEmail(url);
      await sendEmail({ to: user.email, subject, html, text });
    },
  },
  emailVerification: {
    // Not awaited: sign-up answers an existing address without sending
    // anything, so waiting on Postmark here would make a new address
    // measurably slower and give the enumeration away. A failed send is logged
    // by sendEmail; the person can ask for another link.
    sendVerificationEmail: async ({ user, url }) => {
      const { subject, html, text } = verifyEmailEmail(url);
      void sendEmail({ to: user.email, subject, html, text }).catch(() => {});
    },
    // Off: a sign-in with the right password but an unverified address fails
    // with EMAIL_NOT_VERIFIED, and the sign-in page then asks for a new link
    // itself (POST /send-verification-email). better-auth's own resend would
    // need the sign-in to carry a callbackURL, and a sign-in that carries one
    // is answered with a redirect the auth client follows on every success.
    sendOnSignIn: false,
    // The link signs the person in and continues to its callbackURL, so the
    // email is the last step rather than a detour back to the sign-in form.
    autoSignInAfterVerification: true,
    // A day, not better-auth's hour: people sign up and read their email later.
    expiresIn: 60 * 60 * 24,
  },
  user: {
    additionalFields: {
      heardAbout: { type: "string", required: false, input: true },
      marketingOptIn: { type: "boolean", required: false, defaultValue: false, input: true },
      // Set by cleanUserInput, never by the client.
      marketingOptInAt: { type: "date", required: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({ data: cleanUserInput(user) }),
        after: async (user) => {
          await provisionForNewUser(user);
        },
      },
      update: {
        before: async (user) => ({ data: cleanUserInput(user) }),
      },
    },
  },
  hooks: {
    // MCP clients register without `application_type`; see oauth-registration.ts.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/oauth2/register" || !ctx.body) return;
      return { context: { body: withInferredApplicationType(ctx.body) } };
    }),
  },
  plugins: [
    organization({
      // Organizations are invisible machinery now — one per workspace, minted by
      // createWorkspaceWithOrg rather than through this plugin. So there is no
      // org-creation cap here; the workspace cap lives at that helper instead.
      //
      // When a member is removed (or leaves), revoke their workspace-scoped keys
      // so an ex-member's CLI/app daemon stops syncing (it lands in `auth-lost`).
      // Removing the member row alone would leave their keys live.
      organizationHooks: {
        // A workspace's member limit. Backstop for additions that go through
        // the plugin; the primary gate is this repo's own invite flow
        // (server/routes/api/invites), which creates Member rows directly.
        beforeAddMember: async ({ organization: org }) => {
          await assertCanAddMember(org.id);
        },
        afterRemoveMember: async ({ user, organization: org }) => {
          // Best-effort: a failed revocation must not block the removal itself,
          // but it leaves the ex-member's key live — so it must be visible.
          await revokeWorkspaceKeysForMember(user.id, org.id).catch((e) => {
            console.error(`failed to revoke workspace keys for removed member ${user.id}:`, e);
          });
        },
      },
    }),
    // Billing. Registered after `organization` because seat-based billing reads
    // org membership to set the Stripe quantity.
    ...(billing ? [billing] : []),
    // Non-cookie auth for agents (MCP) and the sync CLI. `enableMetadata`
    // lets each key carry `{ workspaceId, actorType }`; `enableSessionForAPIKeys`
    // makes `auth.api.getSession({ headers })` work with the `x-api-key` header,
    // so the same session-reading code serves cookies and keys alike.
    apiKey({
      enableMetadata: true,
      enableSessionForAPIKeys: true,
      // The apiKey plugin defaults to 10 verifications per key per DAY, which
      // would throttle the sync CLI and MCP agents (they authenticate on every
      // poll/list/write) into uselessness. These are data-plane credentials used
      // continuously, so disable per-key rate limiting; the device-code flow has
      // its own IP/user limits, and key minting stays cookie-gated.
      rateLimit: { enabled: false },
    }),
    // OAuth for MCP clients (Claude Code, claude.ai, ChatGPT, Cursor...). The
    // client discovers this server from the MCP endpoint's 401, registers itself
    // (dynamic client registration — these clients have no pre-shared id),
    // sends the user to the app's sign-in and consent pages, and gets a JWT
    // access token audience-bound to MCP_RESOURCE. The consent page is also
    // where the user names the connection; see server/utils/mcp-oauth.ts.
    jwt(),
    mcp({
      loginPage: `${appOrigin}/sign-in`,
      consentPage: `${appOrigin}/oauth/consent`,
      resource: MCP_RESOURCE,
      // Declared explicitly (the plugin would add it bare) because the resource
      // row is seeded at startup and Prisma on Postgres refuses a null
      // `allowedScopes`.
      resources: [{ identifier: MCP_RESOURCE, allowedScopes: MCP_SCOPES }],
      scopes: MCP_SCOPES,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Stamp each access token with the consent it was issued under, so a
      // token from before a Disconnect stays dead after a reconnect.
      extensions: [
        { claims: { accessToken: ({ user, client }) => consentClaim(user?.id, client.clientId) } },
      ],
    }),
  ],
});

export type Auth = typeof auth;