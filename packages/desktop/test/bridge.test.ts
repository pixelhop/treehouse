import { describe, expect, it } from "vite-plus/test";
import { BRIDGE_CHANNELS, isValidWorkspaceId, mayExposeBridge } from "../src/bridge";

// The bridge is the only privileged surface the remote page can see, so its two
// guards carry real weight: what counts as a workspace id, and which origins get
// the bridge at all.

describe("isValidWorkspaceId", () => {
  it("accepts an opaque server-issued id", () => {
    expect(isValidWorkspaceId("bdc29328-3009-4168-a834-8d7ca8568692")).toBe(true);
    expect(isValidWorkspaceId("ws_1")).toBe(true);
  });

  it("rejects anything with a path separator or a dot", () => {
    // These reach code that looks up folders; an id shaped like a path is not an
    // id, and letting one through is how traversal bugs start.
    expect(isValidWorkspaceId("../etc/passwd")).toBe(false);
    expect(isValidWorkspaceId("a/b")).toBe(false);
    expect(isValidWorkspaceId("a\\b")).toBe(false);
    expect(isValidWorkspaceId("a.b")).toBe(false);
  });

  it("rejects whitespace, control characters and NUL", () => {
    expect(isValidWorkspaceId("has space")).toBe(false);
    expect(isValidWorkspaceId("a\nb")).toBe(false);
    expect(isValidWorkspaceId("a\0b")).toBe(false);
  });

  it("rejects empty and oversized ids", () => {
    expect(isValidWorkspaceId("")).toBe(false);
    expect(isValidWorkspaceId("w".repeat(129))).toBe(false);
    expect(isValidWorkspaceId("w".repeat(128))).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isValidWorkspaceId(null)).toBe(false);
    expect(isValidWorkspaceId(undefined)).toBe(false);
    expect(isValidWorkspaceId(42)).toBe(false);
    expect(isValidWorkspaceId({})).toBe(false);
  });
});

describe("mayExposeBridge", () => {
  const APP = "https://treehouse.pixelhop.io";

  it("exposes the bridge on the app origin", () => {
    expect(mayExposeBridge(APP, APP)).toBe(true);
  });

  it("withholds it from the API origin", () => {
    // A preload attaches to the webContents, so it runs again on every navigation
    // the allow-list permits — including to the API. Only the app renders our UI.
    expect(mayExposeBridge("https://treehouse-api.pixelhop.io", APP)).toBe(false);
  });

  it("withholds it from any other origin", () => {
    expect(mayExposeBridge("https://evil.example.com", APP)).toBe(false);
    expect(mayExposeBridge("http://treehouse.pixelhop.io", APP)).toBe(false);
  });

  it("returns false rather than throwing on unparseable input", () => {
    expect(mayExposeBridge("not-a-url", APP)).toBe(false);
    expect(mayExposeBridge(APP, "not-a-url")).toBe(false);
  });
});

describe("BRIDGE_CHANNELS", () => {
  it("namespaces every channel, so nothing collides with another handler", () => {
    for (const channel of Object.values(BRIDGE_CHANNELS)) {
      expect(channel.startsWith("treehouse:")).toBe(true);
    }
  });
});