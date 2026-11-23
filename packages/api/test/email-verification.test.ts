import { describe, expect, it, vi } from "vite-plus/test";
import "./env";

// Email verification, end to end through the real auth config, in-process.
// Verification is switched on here the way a deployment with a Postmark token
// would have it, and the outgoing email is captured instead of sent, so the
// test can follow the link in it like a person would.

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("../server/utils/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/utils/email")>()),
  sendEmail: vi.fn(async (message: { to: string; subject: string; text: string }) => {
    sent.push(message);
  }),
}));

process.env.REQUIRE_EMAIL_VERIFICATION = "true";
const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const { oauthResumeURL } = await import("../../app/app/utils/oauthFlow");
const db = usePrismaClient();

const API = (process.env.BETTER_AUTH_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const APP = (process.env.APP_URL ?? "http://localhost:3000").split(",")[0]!.trim();
const PASSWORD = "correct-horse-battery";

function call(path: string, init: RequestInit & { body?: string } = {}) {
  return auth.handler(
    new Request(`${API}/api/auth${path}`, {
      ...init,
      headers: { "content-type": "application/json", origin: APP, ...init.headers },
    }),
  );
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

function newEmail() {
  return `verify${Date.now()}_${Math.round(Math.random() * 1e9)}@example.test`;
}

async function signUp(email: string, callbackURL: string, extra: Record<string, unknown> = {}) {
  return call("/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, name: "Verify Me", callbackURL, ...extra }),
  });
}

function signIn(email: string) {
  return call("/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD }),
  });
}

/** The verification link in the last email sent to `email`. */
function linkFor(email: string): URL {
  const message = sent.findLast((m) => m.to === email);
  const match = message?.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`no verification email for ${email}`);
  return new URL(match[0]);
}

describe("email verification", () => {
  it("sign-up sends a link instead of signing in, and sign-in waits for it", async () => {
    const email = newEmail();
    const res = await signUp(email, `${APP}/email-verified?next=%2Fplans`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string | null }).token).toBeNull();
    expect(cookieOf(res)).not.toContain("session_token");

    expect(sent.findLast((m) => m.to === email)?.subject).toBe("Confirm your email for Treehouse");
    const link = linkFor(email);
    expect(link.origin + link.pathname).toBe(`${API}/api/auth/verify-email`);

    const early = await signIn(email);
    expect(early.status).toBe(403);
    expect(((await early.json()) as { code?: string }).code).toBe("EMAIL_NOT_VERIFIED");
    expect(cookieOf(early)).not.toContain("session_token");
  });

  it("the link verifies, signs in, and continues to the callback", async () => {
    const email = newEmail();
    const callback = `${APP}/email-verified?next=%2Fplans`;
    await signUp(email, callback);

    const res = await auth.handler(new Request(linkFor(email)));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(callback);
    expect(cookieOf(res)).toContain("session_token");

    const user = await db.user.findUnique({ where: { email } });
    expect(user?.emailVerified).toBe(true);
    const later = await signIn(email);
    expect(later.status).toBe(200);
  });

  it("an existing address gets the same answer and no email", async () => {
    const email = newEmail();
    await signUp(email, `${APP}/email-verified`);
    const before = sent.length;

    const again = await signUp(email, `${APP}/email-verified`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { token: string | null }).token).toBeNull();
    expect(sent.length).toBe(before);
  });

  it("a bad link lands on the callback with an error, not signed in", async () => {
    const email = newEmail();
    const callback = `${APP}/email-verified?next=%2Fplans`;
    await signUp(email, callback);
    const link = linkFor(email);
    link.searchParams.set("token", "not-a-real-token");

    const res = await auth.handler(new Request(link));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/email-verified");
    expect(location.searchParams.get("error")).toBeTruthy();
    expect(cookieOf(res)).not.toContain("session_token");
  });

  it("asking for a fresh link sends one", async () => {
    const email = newEmail();
    await signUp(email, `${APP}/email-verified`);
    const before = sent.filter((m) => m.to === email).length;

    const res = await call("/send-verification-email", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: `${APP}/email-verified?next=%2Fworkspace` }),
    });
    expect(res.status).toBe(200);
    expect(sent.filter((m) => m.to === email).length).toBe(before + 1);
    const fresh = linkFor(email);
    expect(fresh.searchParams.get("callbackURL")).toBe(`${APP}/email-verified?next=%2Fworkspace`);
  });

  it("mid-OAuth, the link carries on to the agent's consent page", async () => {
    const reg = await call("/oauth2/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "Verify Agent",
        redirect_uris: ["http://127.0.0.1:53682/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (reg.status !== 201) throw new Error(`register ${reg.status}: ${await reg.text()}`);
    const { client_id } = (await reg.json()) as { client_id: string };

    // An agent starts the authorization with nobody signed in, and is sent to
    // the app's sign-in page with a signed query.
    const authorize = new URL(`${API}/api/auth/oauth2/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "http://127.0.0.1:53682/callback",
      scope: "openid profile email offline_access",
      state: "xyz",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: `${API}/api/mcp`,
      // "Authenticate afresh": the provider never counts an existing session
      // as fresh enough for this, so the resume must not carry it.
      max_age: "0",
    }).toString();
    const start = await auth.handler(new Request(authorize));
    const login = new URL(
      start.status === 302
        ? (start.headers.get("location") ?? "")
        : ((await start.json()) as { url: string }).url,
    );
    expect(login.pathname).toBe("/sign-in");
    const pageQuery = Object.fromEntries(login.searchParams);

    // Signing up from that page: the auth client forwards the signed query, and
    // the page asks for the link to resume the authorization.
    const email = newEmail();
    const res = await signUp(email, oauthResumeURL(pageQuery, API), {
      oauth_query: login.search.slice(1),
    });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).not.toContain("session_token");

    const verified = await auth.handler(new Request(linkFor(email)));
    expect(verified.status).toBe(302);
    const resume = new URL(verified.headers.get("location") ?? "");
    expect(resume.origin + resume.pathname).toBe(`${API}/api/auth/oauth2/authorize`);
    expect(resume.searchParams.has("sig")).toBe(false);

    const next = await auth.handler(
      new Request(resume, { headers: { cookie: cookieOf(verified) } }),
    );
    const consent = new URL(
      next.status === 302
        ? (next.headers.get("location") ?? "")
        : ((await next.json()) as { url: string }).url,
    );
    expect(consent.origin + consent.pathname).toBe(`${APP}/oauth/consent`);
  });
});