import { describe, expect, it } from "vite-plus/test";
import {
  buildSetupLinks,
  buildSetupPrompt,
  needsSetup,
  SETUP_DOCS_URL,
} from "../app/utils/setupPrompt";

const base = {
  workspaceName: "Acme",
  workspaceId: "ws_123",
  appOrigin: "https://app.trytree.house",
  apiBase: "https://api.trytree.house",
};

describe("setup prompt", () => {
  it("hands over the workspace's facts and the way to get connected", () => {
    const prompt = buildSetupPrompt(base);
    expect(prompt).toContain('"Acme"');
    expect(prompt).toContain("ws_123");
    expect(prompt).toContain("https://api.trytree.house");
    expect(prompt).toContain(
      "treehouse://open?workspace=ws_123&origin=https%3A%2F%2Fapp.trytree.house",
    );
    // The procedure for getting connected lives in the docs; the seeded guide
    // takes over after. Lose either reference and the prompt is a vague wish.
    expect(prompt).toContain(SETUP_DOCS_URL);
    expect(prompt).toContain("AGENTS.md");
    // Only the Mac desktop app is offered inline: the Windows and Linux CLI builds
    // are untested, so the prompt hands out no CLI installer.
    expect(prompt).not.toMatch(/install\.(sh|ps1)/);
  });

  it("names the synced folder when the desktop shell knows it", () => {
    expect(buildSetupPrompt({ ...base, folderName: "Acme Docs" })).toContain('"Acme Docs"');
  });

  // A new web signup has no desktop app and no folder: the agent must not
  // assume the files are reachable.
  it("asks the agent to get the workspace syncing when no folder is known", () => {
    const prompt = buildSetupPrompt({ ...base, folderName: null });
    expect(prompt).toMatch(/may not be on this computer yet/i);
  });

  it("only mentions self-hosting on a server that isn't trytree.house", () => {
    expect(buildSetupPrompt(base)).not.toContain("--api-base");
    const prompt = buildSetupPrompt({
      ...base,
      appOrigin: "https://tree.example.com/",
      apiBase: "https://tree-api.example.com/",
    });
    expect(prompt).toContain("--api-base https://tree-api.example.com");
    expect(prompt).toContain("Web app: https://tree.example.com\n");
  });

  // The card builds this during render, so throwing here would take down the
  // whole hand-off — Copy prompt included, which is the route meant to survive
  // everything else failing. Over-length degrades, it does not explode.
  it("still builds a prompt too long for a deep link", () => {
    const prompt = buildSetupPrompt({ ...base, workspaceName: "x".repeat(6000) });
    expect(prompt.length).toBeGreaterThan(5000);
    expect(prompt).toContain("AGENTS.md");
  });
});

describe("setup links", () => {
  it("encodes the prompt into each target's deep link", () => {
    const prompt = buildSetupPrompt(base);
    const links = buildSetupLinks(prompt);
    const encoded = encodeURIComponent(prompt);

    expect(links.claudeCode).toBe(`claude-cli://open?q=${encoded}`);
    expect(links.cowork).toBe(`claude://cowork/new?q=${encoded}`);
    expect(links.codex).toBe(`codex://new?prompt=${encoded}`);
  });

  it("escapes characters that would otherwise break out of the query string", () => {
    const links = buildSetupLinks("a & b?c=d #e");
    expect(links.codex).toBe("codex://new?prompt=a%20%26%20b%3Fc%3Dd%20%23e");
  });

  // A truncated prompt reads exactly like a whole one, so the agent would set
  // off confidently having been told only part of the job. Drop the links that
  // cannot carry it; Copy prompt is unaffected.
  it("drops the links when the prompt exceeds the limit", () => {
    expect(buildSetupLinks("x".repeat(5001))).toEqual({
      claudeCode: null,
      cowork: null,
      codex: null,
    });
  });

  it("keeps the links at exactly the limit", () => {
    expect(buildSetupLinks("x".repeat(5000)).claudeCode).toContain("claude-cli://open?q=");
  });

  it("keeps a realistic prompt well inside the limit", () => {
    const prompt = buildSetupPrompt({
      ...base,
      workspaceName: "Acme Marketing Team",
      folderName: "Acme Marketing Team",
    });
    expect(prompt.length).toBeLessThan(3000);
  });
});

describe("needsSetup", () => {
  const file = { isDir: false };
  const dir = { isDir: true };

  it("offers the hand-off on an empty workspace (seeding disabled)", () => {
    expect(needsSetup([])).toBe(true);
  });

  it("offers it on a freshly seeded workspace (README + AGENTS)", () => {
    expect(needsSetup([file, file])).toBe(true);
  });

  it("withdraws it as soon as the workspace has folders", () => {
    expect(needsSetup([dir])).toBe(false);
    expect(needsSetup([file, dir])).toBe(false);
  });

  it("withdraws it once there are more files than the seed leaves behind", () => {
    expect(needsSetup([file, file, file])).toBe(false);
  });

  // The bootstrap's last step REWRITES AGENTS.md rather than deleting it, so
  // keying off that file would keep the card forever on a finished workspace.
  it("does not key off AGENTS.md still existing", () => {
    expect(needsSetup([dir, dir, file])).toBe(false);
  });
});