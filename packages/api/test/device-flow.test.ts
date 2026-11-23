import { describe, expect, it } from "vite-plus/test";
import "./env";

// Route-level integration test for the device-code onboarding flow against a
// RUNNING api dev server (start with `pnpm --filter api dev`, or nitro on :3001).
// Gated on reachability so `vp test` stays green without a server.

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3001";
const serverUp = await fetch(`${BASE}/api/health`)
  .then((r) => r.ok)
  .catch(() => false);

const { auth } = await import("../server/utils/auth");
const { usePrismaClient } = await import("db");
const db = usePrismaClient();

// Mint a real session in-process (asResponse exposes the Set-Cookie) and reuse
// the cookie against the HTTP routes. Done in-process to skip the HTTP origin/
// CSRF check on the auth sign-up endpoint, which is irrelevant to this flow.
async function signUpHttp() {
  const stamp = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  const res = await auth.api.signUpEmail({
    body: { email: `dev${stamp}@example.test`, password: "correct-horse-battery", name: "Dev" },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const json = (await res.json()) as { user?: { id?: string } };
  const userId = json.user?.id;
  if (!cookie || !userId) throw new Error(`sign-up failed (${res.status})`);
  return { cookie, userId, stamp };
}

// Create an org + membership + workspace for a user (so authorizeWorkspace passes).
async function makeWorkspace(userId: string, stamp: string, member = true) {
  const org = await db.organization.create({ data: { id: `org_dev_${stamp}`, name: "Dev Org" } });
  if (member) {
    await db.member.create({
      data: {
        id: `mem_dev_${stamp}`,
        organizationId: org.id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  }
  return db.workspace.create({ data: { organizationId: org.id, name: "Default" } });
}

const startCode = () =>
  fetch(`${BASE}/api/device/code`, { method: "POST" }).then(
    (r) =>
      r.json() as Promise<{ device_code: string; user_code: string; verification_uri: string }>,
  );
const poll = (deviceCode: string) =>
  fetch(`${BASE}/api/device/poll?device_code=${encodeURIComponent(deviceCode)}`);
const approve = (cookie: string, body: object) =>
  fetch(`${BASE}/api/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

describe.skipIf(!serverUp)("device-code onboarding (HTTP)", () => {
  it("code -> approve -> poll delivers a working scoped key exactly once", async () => {
    const { cookie, userId, stamp } = await signUpHttp();
    const ws = await makeWorkspace(userId, stamp);

    const code = await startCode();
    expect(code.device_code).toBeTruthy();
    expect(code.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code.verification_uri).toContain("/link");

    // Before approval: pending.
    const pending = await poll(code.device_code);
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { status: string }).status).toBe("pending");

    // Approve in the browser (cookie session) for the chosen workspace.
    const ok = await approve(cookie, { user_code: code.user_code, workspaceId: ws.id });
    expect(ok.status).toBe(200);

    // Poll delivers the key once.
    const got = await poll(code.device_code);
    expect(got.status).toBe(200);
    const body = (await got.json()) as {
      status: string;
      api_key: string;
      api_key_id?: string;
      workspace_id: string;
    };
    expect(body.status).toBe("approved");
    expect(body.workspace_id).toBe(ws.id);
    expect(body.api_key).toBeTruthy();
    // The poll now also returns the key id — the revocation handle (U4). Existing
    // CLI parsing still works since it's an additive field.
    expect(body.api_key_id).toBeTruthy();

    // The delivered key is scoped + works against that workspace.
    const list = await fetch(`${BASE}/api/workspaces/${ws.id}/list`, {
      headers: { "x-api-key": body.api_key },
    });
    expect(list.status).toBe(200);

    // A second poll cannot re-fetch the key.
    const again = await poll(code.device_code);
    expect(again.status).toBe(410);
  });

  it("rejects approval for a workspace the user is not a member of", async () => {
    const { cookie, stamp } = await signUpHttp();
    // Workspace in an org the signed-up user is NOT a member of.
    const otherWs = await makeWorkspace("someone-else", `${stamp}_other`, false);

    const code = await startCode();
    const res = await approve(cookie, { user_code: code.user_code, workspaceId: otherWs.id });
    expect(res.status).toBe(403);
  });

  it("rejects a non-string user_code/workspaceId with 400, not a 500", async () => {
    const { cookie } = await signUpHttp();
    // Truthy but not a string: the old presence-only check let these through to
    // `.trim()`, turning a malformed request into a server error.
    for (const body of [
      { user_code: 123, workspaceId: "x" },
      { user_code: "ABCD-EFGH", workspaceId: 42 },
      { user_code: true, workspaceId: true },
    ]) {
      const res = await approve(cookie, body);
      expect(res.status).toBe(400);
    }
  });

  it("returns 404 for an unknown device_code", async () => {
    const res = await poll("not-a-real-device-code");
    expect(res.status).toBe(404);
  });

  it("requires a cookie session to approve (rejects no-auth)", async () => {
    const code = await startCode();
    const res = await fetch(`${BASE}/api/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_code: code.user_code, workspaceId: "x" }),
    });
    expect(res.status).toBe(401);
  });
});