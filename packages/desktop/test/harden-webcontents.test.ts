import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TrustedOrigins } from "../src/origins";

// `hardenWebContents` is the Electron wiring for the pure policy in security.ts.
// The policy itself is covered by security.test.ts; what's covered HERE is that
// every navigation channel is actually subscribed — a missing listener is
// invisible to a policy test but leaves a real hole in the remote-content lockdown.

const openExternal = vi.fn();
vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: { openExternal: (...a: unknown[]) => openExternal(...a) },
}));

const { hardenWebContents } = await import("../src/windows");

const origins: TrustedOrigins = {
  app: "https://app.trytree.house",
  api: "https://api.trytree.house",
};

/** A stand-in WebContents that records handlers so we can fire them by name. */
function fakeWebContents() {
  const handlers = new Map<string, (...args: never[]) => void>();
  let windowOpenHandler: ((d: { url: string }) => unknown) | undefined;
  return {
    wc: {
      on(event: string, fn: (...args: never[]) => void) {
        handlers.set(event, fn);
      },
      setWindowOpenHandler(fn: (d: { url: string }) => unknown) {
        windowOpenHandler = fn;
      },
    },
    handlers,
    openWindow: (url: string) => windowOpenHandler?.({ url }),
  };
}

/** Fire a navigation event and report whether it was blocked. */
function navigate(
  handlers: Map<string, (...args: never[]) => void>,
  event: string,
  url: string,
  isMainFrame = true,
): boolean {
  let prevented = false;
  const e = {
    url,
    isMainFrame,
    preventDefault: () => {
      prevented = true;
    },
  };
  const fn = handlers.get(event);
  if (!fn) throw new Error(`no handler registered for "${event}"`);
  // will-navigate/will-redirect take (event, url); will-frame-navigate takes one
  // event object carrying .url. Passing both shapes keeps this agnostic.
  (fn as (a: unknown, b: unknown) => void)(e, url);
  return prevented;
}

describe("hardenWebContents (navigation lockdown wiring)", () => {
  let fake: ReturnType<typeof fakeWebContents>;
  beforeEach(() => {
    fake = fakeWebContents();
    hardenWebContents(fake.wc as never, origins);
  });

  it("subscribes to every navigation channel, subframes included", () => {
    // will-navigate fires for the MAIN frame only. Without will-frame-navigate an
    // iframe can navigate anywhere, inside the authed workspace partition.
    expect([...fake.handlers.keys()].sort()).toEqual([
      "will-frame-navigate",
      "will-navigate",
      "will-redirect",
    ]);
  });

  for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    it(`blocks an untrusted origin on ${event}`, () => {
      expect(navigate(fake.handlers, event, "https://evil.example.com/phish")).toBe(true);
    });

    it(`allows a trusted origin on ${event}`, () => {
      expect(navigate(fake.handlers, event, `${origins.app}/w/abc`)).toBe(false);
      expect(navigate(fake.handlers, event, `${origins.api}/api/device/code`)).toBe(false);
    });
  }

  for (const event of ["will-redirect", "will-frame-navigate"]) {
    it(`lets a subframe load a video player on ${event}, but not the main frame`, () => {
      const player = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
      expect(navigate(fake.handlers, event, player, false)).toBe(false);
      expect(navigate(fake.handlers, event, player, true)).toBe(true);
      expect(navigate(fake.handlers, event, "https://evil.example.com/", false)).toBe(true);
    });
  }

  it("denies window.open and routes only safe https links to the system browser", () => {
    openExternal.mockClear();
    expect(fake.openWindow("https://example.com/docs")).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");

    openExternal.mockClear();
    expect(fake.openWindow("file:///etc/passwd")).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
  });
});