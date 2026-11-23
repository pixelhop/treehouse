import { describe, expect, it } from "vite-plus/test";
import "./env";

// Sign-up's optional extras, stored on the user: "How did you hear about
// Treehouse?" and the product-news checkbox. Both arrive from an
// unauthenticated form, so what is stored is checked here, not just that
// something is.

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

const API = (process.env.BETTER_AUTH_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const APP = (process.env.APP_URL ?? "http://localhost:3000").split(",")[0]!.trim();

async function signUpWith(heardAbout: unknown, extra: Record<string, unknown> = {}) {
  const email = `heard${Date.now()}_${Math.round(Math.random() * 1e9)}@example.test`;
  const res = await auth.handler(
    new Request(`${API}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP },
      body: JSON.stringify({
        email,
        password: "correct-horse-battery",
        name: "Heard",
        heardAbout,
        ...extra,
      }),
    }),
  );
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return { user, cookie };
}

describe("heardAbout", () => {
  it("stores the answer, trimmed", async () => {
    expect((await signUpWith("  friend ")).user.heardAbout).toBe("friend");
    expect((await signUpWith("other: Hacker News")).user.heardAbout).toBe("other: Hacker News");
  });

  it("stores nothing for a blank or missing answer", async () => {
    expect((await signUpWith("   ")).user.heardAbout).toBeNull();
    expect((await signUpWith(undefined)).user.heardAbout).toBeNull();
  });

  it("caps a long answer", async () => {
    expect((await signUpWith("x".repeat(5000))).user.heardAbout).toHaveLength(200);
  });

  it("cleans an answer changed later through /update-user the same way", async () => {
    const { user, cookie } = await signUpWith("search");
    const res = await auth.handler(
      new Request(`${API}/api/auth/update-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP, cookie },
        body: JSON.stringify({ heardAbout: "y".repeat(5000) }),
      }),
    );
    expect(res.status).toBe(200);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.heardAbout).toHaveLength(200);
  });
});

function updateUser(cookie: string, body: Record<string, unknown>) {
  return auth.handler(
    new Request(`${API}/api/auth/update-user`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, cookie },
      body: JSON.stringify(body),
    }),
  );
}

describe("marketingOptIn", () => {
  it("is off unless ticked, with no consent time", async () => {
    const { user } = await signUpWith(undefined);
    expect(user.marketingOptIn).toBe(false);
    expect(user.marketingOptInAt).toBeNull();
  });

  it("ticking it records when", async () => {
    const before = Date.now();
    const { user } = await signUpWith(undefined, { marketingOptIn: true });
    expect(user.marketingOptIn).toBe(true);
    expect(user.marketingOptInAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("the client can't set the consent time itself", async () => {
    const email = `heard${Date.now()}_${Math.round(Math.random() * 1e9)}@example.test`;
    const res = await auth.handler(
      new Request(`${API}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP },
        body: JSON.stringify({
          email,
          password: "correct-horse-battery",
          name: "Heard",
          marketingOptInAt: "2020-01-01T00:00:00Z",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });

  it("opting out later clears the consent time, and opting back in sets a new one", async () => {
    const { user, cookie } = await signUpWith(undefined, { marketingOptIn: true });
    expect((await updateUser(cookie, { marketingOptIn: false })).status).toBe(200);
    const out = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(out.marketingOptIn).toBe(false);
    expect(out.marketingOptInAt).toBeNull();

    expect((await updateUser(cookie, { marketingOptIn: true })).status).toBe(200);
    const back = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(back.marketingOptIn).toBe(true);
    expect(back.marketingOptInAt).not.toBeNull();
  });

  it("an unrelated profile change leaves consent alone", async () => {
    const { user, cookie } = await signUpWith(undefined, { marketingOptIn: true });
    const at = user.marketingOptInAt;
    expect((await updateUser(cookie, { name: "Renamed" })).status).toBe(200);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.marketingOptIn).toBe(true);
    expect(after.marketingOptInAt).toEqual(at);
  });
});