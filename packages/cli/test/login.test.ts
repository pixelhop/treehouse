import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { addLink, loadLinks } from "../src/links-store";
import { approvalUrl, browserOpener, runLogin, runSignOut } from "../src/login";

const tmp = () => mkdtempSync(join(tmpdir(), "th-login-"));

// Isolate the per-user state dir so runLogin's addLink writes links.json into a
// throwaway home, NOT the real ~/Library registry.
beforeEach(() => {
  process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-login-home-"));
});
afterEach(() => {
  delete process.env.TREEHOUSE_HOME;
});

function stubFetch(handler: (url: string) => Response): () => void {
  const orig = globalThis.fetch;
  const fake: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handler(url));
  };
  globalThis.fetch = fake;
  return () => {
    globalThis.fetch = orig;
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CODE = {
  device_code: "DEV",
  user_code: "ABCD-2345",
  verification_uri: "https://app/link",
  verification_uri_complete: "https://app/link?code=ABCD-2345",
  expires_in: 600,
  interval: 0, // no real wait between polls in tests
};

function captureLog() {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  return { lines, restore: () => (console.log = orig) };
}

const cfgFile = (root: string) => join(root, ".treehouse", "config.json");

describe("runLogin", () => {
  it("writes a 0600 config on approval and never logs the key", async () => {
    const root = tmp();
    let polls = 0;
    const restore = stubFetch((url) => {
      if (url.endsWith("/api/device/code")) return json(CODE);
      if (url.includes("/api/device/poll")) {
        polls += 1;
        return polls === 1
          ? json({ status: "pending" })
          : json({
              status: "approved",
              api_key: "th_secret_KEY",
              workspace_id: "ws_9",
              api_base: "https://api",
            });
      }
      return json({}, 404);
    });
    const log = captureLog();
    try {
      await runLogin({ apiBase: "https://api", root, open: false, start: false });
    } finally {
      log.restore();
      restore();
    }

    const cfg = JSON.parse(readFileSync(cfgFile(root), "utf8"));
    expect(cfg).toEqual({ apiBase: "https://api", apiKey: "th_secret_KEY", workspaceId: "ws_9" });
    expect(statSync(cfgFile(root)).mode & 0o777).toBe(0o600);
    expect(log.lines.join("\n")).not.toContain("th_secret_KEY"); // key never printed
    expect(log.lines.join("\n")).toContain("ws_9"); // workspace surfaced
  });

  it("errors on an expired code", async () => {
    const root = tmp();
    const restore = stubFetch((url) =>
      url.endsWith("/api/device/code") ? json(CODE) : new Response("", { status: 410 }),
    );
    try {
      await expect(runLogin({ apiBase: "x", root, open: false })).rejects.toThrow(/expired/);
    } finally {
      restore();
    }
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const root = tmp();
    mkdirSync(join(root, ".treehouse"), { recursive: true });
    writeFileSync(
      cfgFile(root),
      JSON.stringify({ apiBase: "x", apiKey: "OLD", workspaceId: "ws_old" }),
    );
    const restore = stubFetch((url) =>
      url.endsWith("/api/device/code")
        ? json(CODE)
        : json({ status: "approved", api_key: "NEW", workspace_id: "ws_new" }),
    );
    try {
      await expect(runLogin({ apiBase: "x", root, open: false })).rejects.toThrow(/already exists/);
    } finally {
      restore();
    }
    // The existing config is untouched.
    expect(JSON.parse(readFileSync(cfgFile(root), "utf8")).apiKey).toBe("OLD");
  });

  it("overwrites with force", async () => {
    const root = tmp();
    mkdirSync(join(root, ".treehouse"), { recursive: true });
    writeFileSync(
      cfgFile(root),
      JSON.stringify({ apiBase: "x", apiKey: "OLD", workspaceId: "ws_old" }),
    );
    const restore = stubFetch((url) =>
      url.endsWith("/api/device/code")
        ? json(CODE)
        : json({ status: "approved", api_key: "NEW", workspace_id: "ws_new" }),
    );
    try {
      await runLogin({ apiBase: "x", root, open: false, force: true, start: false });
    } finally {
      restore();
    }
    expect(JSON.parse(readFileSync(cfgFile(root), "utf8")).apiKey).toBe("NEW");
    expect(existsSync(cfgFile(root))).toBe(true);
  });
});

// Create a folder whose config records `keyId`, so its link is genuinely
// app-owned (isAppOwned matches the link's keyId against the config's).
function folderLinkedApp(keyId: string): string {
  const root = mkdtempSync(join(tmpdir(), "th-signout-"));
  mkdirSync(join(root, ".treehouse"), { recursive: true });
  writeFileSync(
    cfgFile(root),
    JSON.stringify({ apiBase: "x", apiKey: "s", workspaceId: "ws", keyId }),
  );
  return root;
}

describe("runSignOut (U3, AE2)", () => {
  it("pauses and revokes only app-owned links; CLI links keep syncing", async () => {
    const appRoot = folderLinkedApp("APPKEY");
    const cliRoot = folderLinkedApp("CLIKEY");
    addLink(appRoot, "ws", { origin: "app", account: "u", keyId: "APPKEY" });
    addLink(cliRoot, "ws-cli", { origin: "cli", keyId: "CLIKEY" });

    const revoked: string[] = [];
    const res = await runSignOut({ revokeKey: (id) => (revoked.push(id), Promise.resolve()) });

    // The app-owned folder is paused and its key revoked BY ID.
    expect(res.pausedRoots).toEqual([appRoot]);
    expect(res.revokedKeyIds).toEqual(["APPKEY"]);
    expect(revoked).toEqual(["APPKEY"]);

    const links = loadLinks();
    expect(links.find((l) => l.root === appRoot)?.paused).toBe(true);
    // The CLI-owned folder is untouched — still syncing, key intact.
    expect(links.find((l) => l.root === cliRoot)?.paused).toBeUndefined();
    expect(revoked).not.toContain("CLIKEY");
    // Local files (the config marker) are left on disk.
    expect(existsSync(cfgFile(appRoot))).toBe(true);
  });

  it("still pauses on a failed revoke, but reports it as FAILED (not revoked)", async () => {
    const appRoot = folderLinkedApp("K1");
    addLink(appRoot, "ws", { origin: "app", account: "u", keyId: "K1" });

    const res = await runSignOut({ revokeKey: () => Promise.reject(new Error("network")) });

    expect(res.pausedRoots).toEqual([appRoot]);
    expect(loadLinks()[0].paused).toBe(true); // paused despite the failed revoke
    // A failed revoke is NOT reported as revoked — it lands in failedKeyIds so
    // the caller can surface the still-live key for retry.
    expect(res.revokedKeyIds).toEqual([]);
    expect(res.failedKeyIds).toEqual(["K1"]);
  });

  it("pauses every owned root before any revocation is issued", async () => {
    const a = folderLinkedApp("KA");
    const b = folderLinkedApp("KB");
    addLink(a, "ws-a", { origin: "app", account: "u", keyId: "KA" });
    addLink(b, "ws-b", { origin: "app", account: "u", keyId: "KB" });

    // Snapshot the persisted pause state at the moment the FIRST revoke is
    // issued. Interleaving pause-then-revoke left every later folder syncing for
    // as long as this call took to settle — indefinitely, if it hung.
    let pausedWhenFirstRevokeStarted: string[] = [];
    let seen = 0;
    const res = await runSignOut({
      revokeKey: (id) => {
        if (seen++ === 0) {
          pausedWhenFirstRevokeStarted = loadLinks()
            .filter((l) => l.paused)
            .map((l) => l.root);
        }
        return id === "KB" ? Promise.reject(new Error("network")) : Promise.resolve();
      },
    });

    const byPath = (x: string, y: string) => x.localeCompare(y);
    expect(pausedWhenFirstRevokeStarted.sort(byPath)).toEqual([a, b].sort(byPath));
    // One failing revoke doesn't stop the others from being attempted.
    expect(res.revokedKeyIds).toEqual(["KA"]);
    expect(res.failedKeyIds).toEqual(["KB"]);
    expect(res.pausedRoots.sort(byPath)).toEqual([a, b].sort(byPath));
  });

  it("a revoke that never settles can't strand the sign-out", async () => {
    const a = folderLinkedApp("KA");
    const b = folderLinkedApp("KB");
    addLink(a, "ws-a", { origin: "app", account: "u", keyId: "KA" });
    addLink(b, "ws-b", { origin: "app", account: "u", keyId: "KB" });

    // `revokeKey` is caller-supplied and carries no deadline; a request that
    // hangs must not leave runSignOut pending (which would also mean the daemon
    // reload never ran, back when it was ordered after the revocations).
    const res = await runSignOut({
      revokeKey: (id) => (id === "KA" ? Promise.resolve() : new Promise<void>(() => {})),
      revokeTimeoutMs: 50,
    });

    expect(res.revokedKeyIds).toEqual(["KA"]);
    // A timed-out revoke reads as "key may still be live" — surfaced for retry,
    // never reported as revoked.
    expect(res.failedKeyIds).toEqual(["KB"]);
    expect(loadLinks().every((l) => l.paused)).toBe(true);
  });

  it("a revoke that throws synchronously doesn't abort the sign-out", async () => {
    const a = folderLinkedApp("KA");
    const b = folderLinkedApp("KB");
    addLink(a, "ws-a", { origin: "app", account: "u", keyId: "KA" });
    addLink(b, "ws-b", { origin: "app", account: "u", keyId: "KB" });

    // A caller-supplied revokeKey is typed as async but nothing stops it from
    // throwing before it returns a promise. Un-converted, that throw escapes the
    // surrounding `.map()` before allSettled runs — rejecting runSignOut, losing
    // the pause results, and skipping every remaining key.
    const res = await runSignOut({
      revokeKey: (id) => {
        if (id === "KA") throw new Error("sync boom");
        return Promise.resolve();
      },
    });

    expect(res.failedKeyIds).toEqual(["KA"]);
    expect(res.revokedKeyIds).toEqual(["KB"]); // the later key was still attempted
    expect(res.pausedRoots).toHaveLength(2);
  });
});
describe("approvalUrl", () => {
  it("preselects the requested workspace", () => {
    expect(approvalUrl("https://app/link?code=ABCD-2345", "ws_9")).toBe(
      "https://app/link?code=ABCD-2345&workspace=ws_9",
    );
  });

  it("leaves the link alone when no workspace was asked for", () => {
    expect(approvalUrl("https://app/link?code=ABCD-2345")).toBe("https://app/link?code=ABCD-2345");
  });
});
describe("browserOpener", () => {
  const url = "https://app/link?code=ABCD-2345&workspace=ws_9";

  // The whole URL must arrive as ONE argument, with no shell in between: cmd
  // treats `&` as a command separator, which dropped the workspace hint on
  // Windows and tried to run `workspace=ws_9` as a command.
  it("hands the whole URL to the opener on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const { args } = browserOpener(platform, url);
      expect(args.at(-1)).toBe(url);
    }
  });

  it("uses the URL handler rather than cmd's start on Windows", () => {
    expect(browserOpener("win32", url).cmd).toBe("rundll32");
  });
});