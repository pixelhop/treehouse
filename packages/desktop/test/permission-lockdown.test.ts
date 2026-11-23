import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TrustedOrigins } from "../src/origins";

// `applyPermissionLockdown` is the Electron wiring for `isPermissionGranted`. The
// policy itself is covered by security.test.ts; what's covered HERE is that both
// session handlers judge the frame that ASKED, not the window it sits in. A
// wiring that read `webContents.getURL()` would still pass every policy test while
// handing the clipboard to any subframe of an app page.

type RequestHandler = (
  wc: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { requestingUrl: string; isMainFrame: boolean },
) => void;
type CheckHandler = (wc: unknown, permission: string, requestingOrigin: string) => boolean;

let requestHandler: RequestHandler | undefined;
let checkHandler: CheckHandler | undefined;

vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: {},
  session: {
    fromPartition: () => ({
      getUserAgent: () => "Mozilla/5.0",
      setUserAgent: () => {},
      setPermissionRequestHandler: (fn: RequestHandler) => {
        requestHandler = fn;
      },
      setPermissionCheckHandler: (fn: CheckHandler) => {
        checkHandler = fn;
      },
    }),
  },
}));

const { applyPermissionLockdown } = await import("../src/windows");

const origins: TrustedOrigins = {
  app: "https://app.trytree.house",
  api: "https://api.trytree.house",
};

/** A window whose top-level page is on the app origin, whichever frame asks. */
const appWindow = { getURL: () => "https://app.trytree.house/w/abc" };

/** Fire the request handler and report what it granted. */
function request(permission: string, requestingUrl: string, isMainFrame = true): boolean {
  if (!requestHandler) throw new Error("no permission request handler registered");
  let granted: boolean | undefined;
  requestHandler(appWindow, permission, (g) => (granted = g), { requestingUrl, isMainFrame });
  if (granted === undefined) throw new Error("request handler never called back");
  return granted;
}

/** Fire the check handler. Electron may pass a null webContents here. */
function check(permission: string, requestingOrigin: string): boolean {
  if (!checkHandler) throw new Error("no permission check handler registered");
  return checkHandler(null, permission, requestingOrigin);
}

describe("applyPermissionLockdown (permission wiring)", () => {
  beforeEach(() => {
    requestHandler = undefined;
    checkHandler = undefined;
    applyPermissionLockdown("persist:test", origins);
  });

  describe("request handler", () => {
    it("grants clipboard write to the app page", () => {
      expect(request("clipboard-sanitized-write", "https://app.trytree.house/w/abc")).toBe(true);
    });

    it("judges the requesting frame, not the app page around it", () => {
      for (const url of ["https://api.trytree.house/", "https://evil.example.com/"]) {
        expect(request("clipboard-sanitized-write", url, false)).toBe(false);
      }
    });

    // An about:blank or srcdoc frame inherits the app origin, but its committed
    // URL is opaque, so the request is denied. Nothing in the app copies from one.
    it("denies an inherited-origin frame", () => {
      for (const url of ["about:blank", "about:srcdoc"]) {
        expect(request("clipboard-sanitized-write", url, false)).toBe(false);
      }
    });

    it("denies everything else, even to the app page", () => {
      expect(request("clipboard-read", "https://app.trytree.house/")).toBe(false);
      expect(request("media", "https://app.trytree.house/")).toBe(false);
    });
  });

  describe("check handler", () => {
    // Electron passes the frame's EFFECTIVE origin here, so an inherited-origin
    // frame of an app page reports as the app and passes.
    it("grants clipboard write to the app origin, with no webContents", () => {
      expect(check("clipboard-sanitized-write", "https://app.trytree.house")).toBe(true);
    });

    it("denies clipboard write to any other origin", () => {
      for (const origin of ["https://api.trytree.house", "https://evil.example.com", "null", ""]) {
        expect(check("clipboard-sanitized-write", origin)).toBe(false);
      }
    });

    it("denies everything else, even to the app origin", () => {
      expect(check("clipboard-read", "https://app.trytree.house")).toBe(false);
      expect(check("media", "https://app.trytree.house")).toBe(false);
    });
  });
});