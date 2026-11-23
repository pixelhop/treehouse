import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_APP_ORIGIN, needsTrustPrompt } from "../src/origins";
import {
  clearOnboarding,
  computeFacts,
  contextFrom,
  type FactInputs,
  loadOnboarding,
  type PersistedOnboarding,
  rememberTrustedOrigin,
  saveOnboarding,
  trustedOrigins,
} from "../src/onboarding/state";

const freshHome = () => {
  process.env.TREEHOUSE_HOME = mkdtempSync(join(tmpdir(), "th-onb-"));
};

afterEach(() => {
  delete process.env.TREEHOUSE_HOME;
});

describe("needsTrustPrompt (TOFU)", () => {
  it("never prompts for the default hosted origin", () => {
    expect(needsTrustPrompt(DEFAULT_APP_ORIGIN)).toBe(false);
  });

  it("prompts for an unknown origin", () => {
    expect(needsTrustPrompt("https://selfhost.example.com")).toBe(true);
  });

  it("does not prompt for an already-linked origin", () => {
    expect(needsTrustPrompt("https://selfhost.example.com", ["https://selfhost.example.com"])).toBe(
      false,
    );
  });

  it("prompts for unparseable input", () => {
    expect(needsTrustPrompt("not a url")).toBe(true);
  });
});

const inputs = (over: Partial<FactInputs> = {}): FactInputs => ({
  signedIn: true,
  trusted: [],
  folderExists: () => true,
  folderConfig: () => ({ keyId: "k", workspaceId: "ws_1" }),
  linkRegistered: () => true,
  ...over,
});

describe("computeFacts", () => {
  it("marks the default origin trusted", () => {
    const p: PersistedOnboarding = { appOrigin: DEFAULT_APP_ORIGIN };
    expect(computeFacts(p, inputs()).originTrusted).toBe(true);
  });

  it("marks an unknown origin untrusted until it's in the trusted list", () => {
    const p: PersistedOnboarding = { appOrigin: "https://selfhost.example.com" };
    expect(computeFacts(p, inputs()).originTrusted).toBe(false);
    expect(
      computeFacts(p, inputs({ trusted: ["https://selfhost.example.com"] })).originTrusted,
    ).toBe(true);
  });

  it("reports the workspace unsettled when the context names neither id nor name", () => {
    const p = { appOrigin: DEFAULT_APP_ORIGIN };
    expect(computeFacts(p, inputs()).workspaceChosen).toBe(false);
  });

  it("reports the workspace unsettled when an invite gave an id but no name", () => {
    // The invite path carries a workspace id only. The step still has to run to
    // resolve the NAME — otherwise the folder falls back to "Workspace".
    const p = { appOrigin: DEFAULT_APP_ORIGIN, workspaceId: "ws_1" };
    expect(computeFacts(p, inputs()).workspaceChosen).toBe(false);
  });

  it("reports the workspace settled once both id and name are known", () => {
    const p = { appOrigin: DEFAULT_APP_ORIGIN, workspaceId: "ws_1", workspaceName: "Acme" };
    expect(computeFacts(p, inputs()).workspaceChosen).toBe(true);
  });

  it("reports no folder/config/link until a folder root is known", () => {
    const p: PersistedOnboarding = { appOrigin: DEFAULT_APP_ORIGIN }; // pre-folder step
    const f = computeFacts(p, inputs());
    expect(f.folderExists).toBe(false);
    expect(f.configPresent).toBe(false);
    expect(f.linkRegistered).toBe(false);
  });

  it("reads folder facts once a root is known", () => {
    const p: PersistedOnboarding = { appOrigin: DEFAULT_APP_ORIGIN, folderRoot: "/h/Treehouse/A" };
    const f = computeFacts(p, inputs({ folderConfig: () => null }));
    expect(f.folderExists).toBe(true);
    expect(f.configPresent).toBe(false); // no key yet ⇒ resume at grant, never past it
  });

  it("treats a config for a DIFFERENT workspace as not present (supersede safety)", () => {
    // A stale folder holds workspace A's key, but this flow targets workspace B →
    // the grant must run for B; the A-config must not short-circuit it.
    const p: PersistedOnboarding = {
      appOrigin: DEFAULT_APP_ORIGIN,
      workspaceId: "ws_B",
      folderRoot: "/h/Treehouse/A",
    };
    const f = computeFacts(
      p,
      inputs({ folderConfig: () => ({ keyId: "kA", workspaceId: "ws_A" }) }),
    );
    expect(f.configPresent).toBe(false);
  });

  it("counts the config present when its workspace matches the flow target", () => {
    const p: PersistedOnboarding = {
      appOrigin: DEFAULT_APP_ORIGIN,
      workspaceId: "ws_A",
      folderRoot: "/h/Treehouse/A",
    };
    const f = computeFacts(
      p,
      inputs({ folderConfig: () => ({ keyId: "kA", workspaceId: "ws_A" }) }),
    );
    expect(f.configPresent).toBe(true);
  });

  it("rejects a config that has a key but names NO workspace, when the flow targets one", () => {
    // folder-config.ts is partial-tolerant, so { keyId } with no workspaceId is a
    // reachable shape. Counting it as a match skipped the grant and registered a
    // link around a key whose workspace was never verified.
    const p: PersistedOnboarding = {
      appOrigin: DEFAULT_APP_ORIGIN,
      workspaceId: "ws_A",
      folderRoot: "/h/Treehouse/A",
    };
    const f = computeFacts(p, inputs({ folderConfig: () => ({ keyId: "kA" }) }));
    expect(f.configPresent).toBe(false);
  });

  it("still accepts a workspace-less config when the flow has no target either", () => {
    // No target to contradict ⇒ the key alone is enough to resume past the grant.
    const p: PersistedOnboarding = { appOrigin: DEFAULT_APP_ORIGIN, folderRoot: "/h/Treehouse/A" };
    const f = computeFacts(p, inputs({ folderConfig: () => ({ keyId: "kA" }) }));
    expect(f.configPresent).toBe(true);
  });
});

describe("contextFrom", () => {
  it("hydrates the key id from disk (never persisted) for a resume past the grant", () => {
    const p: PersistedOnboarding = {
      appOrigin: DEFAULT_APP_ORIGIN,
      workspaceId: "ws_1",
      folderRoot: "/h/Treehouse/A",
    };
    expect(contextFrom(p, { keyId: "key_9" }).keyId).toBe("key_9");
    expect(contextFrom(p).keyId).toBeUndefined();
  });
});

describe("resume persistence", () => {
  it("round-trips and clears the in-progress context", () => {
    freshHome();
    const p: PersistedOnboarding = {
      appOrigin: "https://acme.example.com",
      workspaceId: "ws_1",
      folderRoot: "/h/Treehouse/Acme",
    };
    saveOnboarding(p);
    expect(loadOnboarding()).toMatchObject(p);
    clearOnboarding();
    expect(loadOnboarding()).toBeNull();
  });

  it("never persists a key (only resume context)", () => {
    freshHome();
    saveOnboarding({ appOrigin: "https://acme.example.com", folderRoot: "/x" });
    const raw = JSON.stringify(loadOnboarding());
    expect(raw).not.toMatch(/apiKey|api_key|"key"/);
  });

  it("remembers trusted origins across a connect", () => {
    freshHome();
    expect(trustedOrigins()).toEqual([]);
    rememberTrustedOrigin("https://acme.example.com");
    rememberTrustedOrigin("https://acme.example.com"); // idempotent
    expect(trustedOrigins()).toEqual(["https://acme.example.com"]);
  });
});