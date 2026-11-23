import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  DeviceGrantExpiredError,
  GrantAbortedError,
  type GrantDeps,
  runDeviceGrant,
  WorkspaceMismatchError,
} from "../src/auth";

function resp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const CODE = {
  device_code: "dev-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://api.example.com/link",
  verification_uri_complete: "https://api.example.com/link?code=ABCD-EFGH",
  expires_in: 600,
  interval: 1,
};

/** A fetch stub that serves the code POST, then a scripted sequence of polls. */
function scriptedFetch(polls: Response[]): { fetch: typeof fetch; approvals: string[] } {
  const approvals: string[] = [];
  let i = 0;
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/device/code") && init?.method === "POST") return resp(200, CODE);
    if (String(url).includes("/api/device/poll")) {
      approvals.push(String(url));
      return polls[i++] ?? resp(200, { status: "pending" });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: f, approvals };
}

const deps = (fetchImpl: typeof fetch): GrantDeps => ({
  fetch: fetchImpl,
  sleep: async () => {},
  now: () => 1_000, // constant clock, well inside the 600s deadline
});

function freshFolder(): string {
  return mkdtempSync(join(tmpdir(), "th-grant-"));
}

describe("runDeviceGrant", () => {
  it("writes the minted key straight into the folder config on approval", async () => {
    const root = freshFolder();
    const { fetch } = scriptedFetch([
      resp(200, { status: "pending" }),
      resp(200, {
        status: "approved",
        api_key: "sk_secret",
        api_key_id: "key_1",
        workspace_id: "ws_1",
        api_base: "https://api.example.com",
      }),
    ]);
    let approvalLoaded = "";
    const out = await runDeviceGrant(
      {
        apiBase: "https://api.example.com",
        folderRoot: root,
        expectWorkspaceId: "ws_1",
        loadApproval: ({ userCode }) => {
          approvalLoaded = userCode;
        },
        revokeKey: async () => {},
      },
      deps(fetch),
    );
    expect(out).toEqual({ keyId: "key_1", workspaceId: "ws_1" });
    expect(approvalLoaded).toBe("ABCD-EFGH");
    const cfg = JSON.parse(readFileSync(join(root, ".treehouse", "config.json"), "utf8"));
    expect(cfg).toMatchObject({
      apiBase: "https://api.example.com",
      apiKey: "sk_secret",
      workspaceId: "ws_1",
      keyId: "key_1",
    });
  });

  it("rejects + revokes a mismatched workspace, writing no config", async () => {
    const root = freshFolder();
    const { fetch } = scriptedFetch([
      resp(200, {
        status: "approved",
        api_key: "sk_secret",
        api_key_id: "key_wrong",
        workspace_id: "ws_OTHER",
      }),
    ]);
    const revoked: string[] = [];
    await expect(
      runDeviceGrant(
        {
          apiBase: "https://api.example.com",
          folderRoot: root,
          expectWorkspaceId: "ws_1",
          loadApproval: () => {},
          revokeKey: async (id) => {
            revoked.push(id);
          },
        },
        deps(fetch),
      ),
    ).rejects.toBeInstanceOf(WorkspaceMismatchError);
    expect(revoked).toEqual(["key_wrong"]);
    // No config was written for the wrong workspace.
    expect(() => readFileSync(join(root, ".treehouse", "config.json"), "utf8")).toThrow();
  });

  it("throws DeviceGrantExpiredError on a 410 poll", async () => {
    const { fetch } = scriptedFetch([resp(410, { error: "expired_token" })]);
    await expect(
      runDeviceGrant(
        {
          apiBase: "https://api.example.com",
          folderRoot: freshFolder(),
          expectWorkspaceId: "ws_1",
          loadApproval: () => {},
          revokeKey: async () => {},
        },
        deps(fetch),
      ),
    ).rejects.toBeInstanceOf(DeviceGrantExpiredError);
  });

  it("backs off on 429 slow_down then completes", async () => {
    const root = freshFolder();
    const { fetch, approvals } = scriptedFetch([
      resp(429, { error: "slow_down" }),
      resp(200, {
        status: "approved",
        api_key: "sk",
        api_key_id: "key_1",
        workspace_id: "ws_1",
      }),
    ]);
    const out = await runDeviceGrant(
      {
        apiBase: "https://api.example.com",
        folderRoot: root,
        expectWorkspaceId: "ws_1",
        loadApproval: () => {},
        revokeKey: async () => {},
      },
      deps(fetch),
    );
    expect(out.workspaceId).toBe("ws_1");
    expect(approvals.length).toBe(2); // one throttled poll, one success
  });

  it("treats a mid-poll fetch rejection as transient and keeps polling to approval", async () => {
    const root = freshFolder();
    // First poll throws (a dropped request), the second succeeds. The whole grant
    // must NOT be torn down by one transient network error.
    let call = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/device/code") && init?.method === "POST")
        return resp(200, CODE);
      call += 1;
      if (call === 1) throw new Error("network reset");
      return resp(200, {
        status: "approved",
        api_key: "sk",
        api_key_id: "k",
        workspace_id: "ws_1",
      });
    }) as unknown as typeof fetch;
    const out = await runDeviceGrant(
      {
        apiBase: "https://api.example.com",
        folderRoot: root,
        expectWorkspaceId: "ws_1",
        loadApproval: () => {},
        revokeKey: async () => {},
      },
      deps(fetchImpl),
    );
    expect(out.workspaceId).toBe("ws_1");
    expect(call).toBe(2); // one dropped poll, one success — not aborted
  });

  it("aborts the poll loop when the signal fires (superseded flow)", async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetch } = scriptedFetch([resp(200, { status: "pending" })]);
    await expect(
      runDeviceGrant(
        {
          apiBase: "https://api.example.com",
          folderRoot: freshFolder(),
          expectWorkspaceId: "ws_1",
          loadApproval: () => {},
          revokeKey: async () => {},
        },
        { ...deps(fetch), signal: ac.signal },
      ),
    ).rejects.toBeInstanceOf(GrantAbortedError);
  });

  it("logs (does not swallow) a failed mismatch-cleanup revoke", async () => {
    const { fetch } = scriptedFetch([
      resp(200, {
        status: "approved",
        api_key: "sk",
        api_key_id: "key_wrong",
        workspace_id: "ws_OTHER",
      }),
    ]);
    const logged: string[] = [];
    await expect(
      runDeviceGrant(
        {
          apiBase: "https://api.example.com",
          folderRoot: freshFolder(),
          expectWorkspaceId: "ws_1",
          loadApproval: () => {},
          revokeKey: async () => {
            throw new Error("revoke 500");
          },
        },
        { ...deps(fetch), onRevokeError: (id) => logged.push(id) },
      ),
    ).rejects.toBeInstanceOf(WorkspaceMismatchError);
    expect(logged).toEqual(["key_wrong"]);
  });

  it("adopts the granted workspace when no expectation is set (create-workspace path)", async () => {
    const root = freshFolder();
    const { fetch } = scriptedFetch([
      resp(200, { status: "approved", api_key: "sk", api_key_id: "k", workspace_id: "ws_new" }),
    ]);
    const out = await runDeviceGrant(
      {
        apiBase: "https://api.example.com",
        folderRoot: root,
        loadApproval: () => {},
        revokeKey: async () => {},
      },
      deps(fetch),
    );
    expect(out.workspaceId).toBe("ws_new");
  });
});