import { describe, expect, it } from "vite-plus/test";
import { APP_ORIGIN_ARG } from "../src/bridge";
import type { TrustedOrigins } from "../src/origins";
import {
  isAllowedFrameNavigation,
  isAllowedNavigation,
  isPermissionGranted,
  isSafeExternalUrl,
  WORKSPACE_PARTITION,
  workspaceWindowOptions,
} from "../src/security";

const origins: TrustedOrigins = {
  app: "https://app.trytree.house",
  api: "https://api.trytree.house",
};

describe("navigation allow-list", () => {
  it("accepts a path on the app origin", () => {
    expect(isAllowedNavigation("https://app.trytree.house/w/abc", origins)).toBe(true);
  });

  it("accepts a path on the API origin", () => {
    expect(isAllowedNavigation("https://api.trytree.house/api/device/code", origins)).toBe(true);
  });

  it("rejects an arbitrary third-party origin", () => {
    expect(isAllowedNavigation("https://evil.example.com/phish", origins)).toBe(false);
  });

  it("rejects a downgraded (http) scheme on an allowed host", () => {
    expect(isAllowedNavigation("http://app.trytree.house/", origins)).toBe(false);
  });

  it("rejects a look-alike subdomain", () => {
    expect(isAllowedNavigation("https://app.trytree.house.evil.com/", origins)).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isAllowedNavigation("not a url", origins)).toBe(false);
  });
});

describe("frame navigation allow-list", () => {
  it("allows the app and API origins in any frame", () => {
    expect(isAllowedFrameNavigation("https://app.trytree.house/w/abc", origins, true)).toBe(true);
    expect(isAllowedFrameNavigation("https://api.trytree.house/x", origins, false)).toBe(true);
  });

  it("lets a subframe load the YouTube, Vimeo and Loom players", () => {
    for (const url of [
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://player.vimeo.com/video/76979871",
      "https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184",
    ]) {
      expect(isAllowedFrameNavigation(url, origins, false)).toBe(true);
    }
  });

  it("never lets the main frame navigate to a video player", () => {
    expect(
      isAllowedFrameNavigation("https://www.youtube-nocookie.com/embed/abc", origins, true),
    ).toBe(false);
  });

  it("only allows the player paths, not the rest of the site", () => {
    expect(isAllowedFrameNavigation("https://www.youtube.com/signin", origins, false)).toBe(false);
    expect(isAllowedFrameNavigation("https://vimeo.com/76979871", origins, false)).toBe(false);
    expect(isAllowedFrameNavigation("https://www.loom.com/share/abc", origins, false)).toBe(false);
  });

  it("rejects look-alike hosts and downgraded schemes", () => {
    expect(
      isAllowedFrameNavigation("https://www.youtube.com.evil.com/embed/abc", origins, false),
    ).toBe(false);
    expect(isAllowedFrameNavigation("http://player.vimeo.com/video/1", origins, false)).toBe(false);
  });

  it("still blocks arbitrary third-party frames", () => {
    expect(isAllowedFrameNavigation("https://evil.example.com/embed/x", origins, false)).toBe(
      false,
    );
  });
});

describe("permission policy", () => {
  it("grants clipboard write to the app origin, so copy buttons work", () => {
    expect(
      isPermissionGranted("clipboard-sanitized-write", "https://app.trytree.house/w/abc", origins),
    ).toBe(true);
  });

  it("never grants clipboard read", () => {
    expect(isPermissionGranted("clipboard-read", "https://app.trytree.house/", origins)).toBe(
      false,
    );
  });

  it("denies every other permission, even to the app origin", () => {
    for (const permission of ["media", "geolocation", "notifications", "openExternal"]) {
      expect(isPermissionGranted(permission, "https://app.trytree.house/", origins)).toBe(false);
    }
  });

  it("denies clipboard write to any origin but the app's", () => {
    for (const url of [
      "https://api.trytree.house/",
      "https://evil.example.com/",
      "http://app.trytree.house/",
      "https://app.trytree.house.evil.com/",
      "",
    ]) {
      expect(isPermissionGranted("clipboard-sanitized-write", url, origins)).toBe(false);
    }
  });
});

describe("openExternal validator", () => {
  it("accepts an https URL", () => {
    expect(isSafeExternalUrl("https://example.com/docs")).toBe(true);
  });

  it("rejects http", () => {
    expect(isSafeExternalUrl("http://example.com")).toBe(false);
  });

  it("rejects custom / dangerous schemes", () => {
    expect(isSafeExternalUrl("treehouse://invite?token=x")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<script>1</script>")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isSafeExternalUrl("nope")).toBe(false);
  });
});

describe("workspace window options", () => {
  const opts = workspaceWindowOptions();

  it("sandboxes and isolates the renderer", () => {
    expect(opts.webPreferences?.sandbox).toBe(true);
    expect(opts.webPreferences?.contextIsolation).toBe(true);
    expect(opts.webPreferences?.nodeIntegration).toBe(false);
    expect(opts.webPreferences?.webviewTag).toBe(false);
  });

  it("ships no preload unless one is supplied", () => {
    // The default stays bare, so any window created without explicitly asking for
    // the bridge gets none.
    expect(opts.webPreferences && "preload" in opts.webPreferences).toBe(false);
  });

  it("attaches the preload only when a path is given", () => {
    const withBridge = workspaceWindowOptions(WORKSPACE_PARTITION, "/x/preload.cjs");
    expect(withBridge.webPreferences?.preload).toBe("/x/preload.cjs");
    // The bridge does not buy the page anything else: the hardening that makes it
    // affordable has to survive alongside it.
    expect(withBridge.webPreferences?.sandbox).toBe(true);
    expect(withBridge.webPreferences?.contextIsolation).toBe(true);
    expect(withBridge.webPreferences?.nodeIntegration).toBe(false);
  });

  it("passes the app origin to the preload, and only alongside one", () => {
    // The bridge's entire access control is this argument: preload.ts exposes
    // `window.treehouse` only when `appOriginFromArgv` matches the page's own
    // origin. If the argument stopped being passed the bridge would silently never
    // appear; if it were passed to a window with no preload it would be a stray
    // origin on a renderer that has no use for it. Both are worth a test, because
    // neither fails loudly.
    const wired = workspaceWindowOptions(WORKSPACE_PARTITION, "/x/preload.cjs", "https://app.test");
    expect(wired.webPreferences?.additionalArguments).toContain(
      `${APP_ORIGIN_ARG}https://app.test`,
    );

    // No preload → no bridge → nothing to configure.
    const bare = workspaceWindowOptions(WORKSPACE_PARTITION);
    expect(bare.webPreferences?.additionalArguments ?? []).toEqual([]);
  });

  it("pins a persistent named partition", () => {
    expect(opts.webPreferences?.partition).toBe(WORKSPACE_PARTITION);
    expect(WORKSPACE_PARTITION.startsWith("persist:")).toBe(true);
  });

  it("starts hidden (shown on ready-to-show)", () => {
    expect(opts.show).toBe(false);
  });

  it("honours a custom partition name", () => {
    expect(workspaceWindowOptions("persist:other").webPreferences?.partition).toBe("persist:other");
  });
});