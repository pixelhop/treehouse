import { describe, expect, it } from "vite-plus/test";
import { redactApiPath } from "../server/utils/analytics";

// This API embeds user-authored file paths in its own route shapes, so any
// exception report that carries a raw request path carries file names with it.
// The failure is silent — the error still reports, it just reports too much —
// which is why these tests lean on the leaky direction.
describe("redactApiPath", () => {
  it("strips the file path from file routes", () => {
    expect(redactApiPath("/api/workspaces/ws_1/files/Finances/2026 Tax Return.md")).toBe(
      "/api/workspaces/ws_1/files/<redacted>",
    );
  });

  it("strips paths from list and search routes", () => {
    expect(redactApiPath("/api/workspaces/ws_1/list/Private/Notes")).toBe(
      "/api/workspaces/ws_1/list/<redacted>",
    );
    expect(redactApiPath("/api/workspaces/ws_1/search/secret")).toBe(
      "/api/workspaces/ws_1/search/<redacted>",
    );
  });

  it("keeps the bare route when there is no path after it", () => {
    expect(redactApiPath("/api/workspaces/ws_1/files")).toBe("/api/workspaces/ws_1/files");
    expect(redactApiPath("/api/workspaces/ws_1/list")).toBe("/api/workspaces/ws_1/list");
  });

  it("strips share and invite tokens, which are bearer credentials", () => {
    // Anyone holding one of these can read the shared content, so a token in an
    // error report is a leak even though the report is private.
    expect(redactApiPath("/api/share/tok_abc/file")).toBe("/api/share/<redacted>");
    expect(redactApiPath("/api/invites/tok_abc/accept")).toBe("/api/invites/<redacted>");
  });

  it("leaves routes that carry no user data intact", () => {
    for (const path of [
      "/api/health",
      "/api/keys",
      "/api/workspaces",
      "/api/workspaces/ws_1",
      "/api/workspaces/ws_1/changes",
      "/api/mcp",
    ]) {
      expect(redactApiPath(path)).toBe(path);
    }
  });

  it("does not throw on unusual input", () => {
    expect(() => redactApiPath("")).not.toThrow();
    expect(() => redactApiPath("///")).not.toThrow();
  });
});