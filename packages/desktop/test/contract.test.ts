import { describe, expect, it } from "vite-plus/test";
import { buildFolderStepUrl, buildWorkspaceStepUrl, parseWorkspaceSentinel } from "../src/contract";

// The workspace step hands its result back by NAVIGATING, not by calling into the
// shell — that is what lets the workspace window keep running with no preload.
// These tests pin the shape both sides agree on, and the untrusted-input handling
// on the reading side.

const APP = "https://treehouse.pixelhop.io";

describe("buildWorkspaceStepUrl", () => {
  it("targets the workspace step on the app origin in app mode", () => {
    const url = new URL(buildWorkspaceStepUrl(APP));
    expect(url.origin).toBe(APP);
    expect(url.pathname).toBe("/connect/workspace");
    expect(url.searchParams.get("app")).toBe("1");
  });

  it("follows a self-hosted origin rather than the default", () => {
    expect(buildWorkspaceStepUrl("https://selfhost.example.com")).toContain(
      "https://selfhost.example.com/connect/workspace",
    );
  });
});

describe("parseWorkspaceSentinel", () => {
  it("reads the workspace id off a sentinel navigation", () => {
    expect(parseWorkspaceSentinel(`${APP}/connect/chosen?workspace=ws_123`, APP)).toBe("ws_123");
  });

  it("round-trips with the step url's origin", () => {
    const step = new URL(buildWorkspaceStepUrl(APP));
    const sentinel = `${step.origin}/connect/chosen?workspace=ws_abc`;
    expect(parseWorkspaceSentinel(sentinel, APP)).toBe("ws_abc");
  });

  it("ignores ordinary navigation within the app", () => {
    expect(parseWorkspaceSentinel(`${APP}/workspace`, APP)).toBeNull();
    expect(parseWorkspaceSentinel(`${APP}/connect/workspace?app=1`, APP)).toBeNull();
  });

  it("ignores a sentinel path on a DIFFERENT origin", () => {
    // A page may navigate off-origin; that is not a result from our step.
    expect(
      parseWorkspaceSentinel("https://evil.example.com/connect/chosen?workspace=ws_1", APP),
    ).toBeNull();
  });

  it("ignores a sentinel with no workspace id", () => {
    expect(parseWorkspaceSentinel(`${APP}/connect/chosen`, APP)).toBeNull();
    expect(parseWorkspaceSentinel(`${APP}/connect/chosen?workspace=`, APP)).toBeNull();
  });

  it("rejects an oversized id rather than truncating it", () => {
    const huge = "w".repeat(200);
    expect(parseWorkspaceSentinel(`${APP}/connect/chosen?workspace=${huge}`, APP)).toBeNull();
  });

  it("returns null for unparseable input on either side", () => {
    expect(parseWorkspaceSentinel("not-a-url", APP)).toBeNull();
    expect(parseWorkspaceSentinel(`${APP}/connect/chosen?workspace=ws_1`, "not-a-url")).toBeNull();
  });

  it("does not treat a path that merely starts with the sentinel as a match", () => {
    expect(
      parseWorkspaceSentinel(`${APP}/connect/chosen-not-really?workspace=ws_1`, APP),
    ).toBeNull();
  });
});
// ── Already-linked workspaces ───────────────────────────────────────────────
// One workspace gets one folder per machine, so the step has to know what is
// already here. It travels in the FRAGMENT: a fragment never reaches the server,
// so the user's local folder names stay out of access and CDN logs.

describe("buildWorkspaceStepUrl — linked workspaces", () => {
  it("omits the fragment entirely when nothing is linked", () => {
    expect(new URL(buildWorkspaceStepUrl(APP)).hash).toBe("");
  });

  it("carries linked workspaces in the fragment, never the query string", () => {
    const url = new URL(buildWorkspaceStepUrl(APP, [{ workspaceId: "ws_1", folderName: "Acme" }]));
    expect(url.hash).toContain("ws_1");
    expect(url.hash).toContain("Acme");
    // The load-bearing assertion: a fragment is not sent to the server.
    expect(url.search).not.toContain("Acme");
    expect(url.search).not.toContain("ws_1");
  });

  it("escapes ids and folder names containing the separators", () => {
    const url = new URL(
      buildWorkspaceStepUrl(APP, [{ workspaceId: "a:b,c", folderName: "My, Folder: 2" }]),
    );
    // Raw separators would split the payload into bogus entries.
    const payload = url.hash.replace(/^#linked=/, "");
    expect(payload.split(",")).toHaveLength(1);
    // BOTH separators matter. Asserting only on the comma let a raw colon through,
    // which would corrupt the `workspaceId:folderName` boundary rather than the
    // entry boundary — exactly one colon may survive, the one we put there.
    expect(payload.split(":")).toHaveLength(2);
    const [id, name] = payload.split(":");
    expect(decodeURIComponent(id ?? "")).toBe("a:b,c");
    expect(decodeURIComponent(name ?? "")).toBe("My, Folder: 2");
  });

  it("packs several linked workspaces", () => {
    const url = new URL(
      buildWorkspaceStepUrl(APP, [
        { workspaceId: "ws_1", folderName: "Acme" },
        { workspaceId: "ws_2", folderName: "Home" },
      ]),
    );
    expect(url.hash.replace(/^#linked=/, "").split(",")).toHaveLength(2);
  });
});
describe("buildFolderStepUrl", () => {
  it("names the workspace in the query and keeps the folder name in the fragment", () => {
    const url = new URL(
      buildFolderStepUrl(APP, { workspaceId: "ws_1", folderName: "Acme Launch 2", reclaim: false }),
    );
    expect(url.pathname).toBe("/connect/folder");
    expect(url.searchParams.get("app")).toBe("1");
    expect(url.searchParams.get("workspace")).toBe("ws_1");
    // The folder name never reaches the server — fragment only, and encoded the
    // way the page's decodeURIComponent reads it (a space is %20, not "+").
    expect(url.search).not.toContain("Acme");
    expect(url.hash).toBe("#folder=Acme%20Launch%202");
  });

  it("flags a reclaimed folder", () => {
    const url = new URL(
      buildFolderStepUrl(APP, { workspaceId: "ws_1", folderName: "Acme", reclaim: true }),
    );
    expect(url.hash).toBe("#folder=Acme&reclaim=1");
  });
});