import { describe, expect, it } from "vite-plus/test";
import { isDesktopShellUserAgent } from "shared";

// This is what stops the app offering "Download the Mac app" to someone who is
// already inside the Mac app. `?app=1` cannot do it: that marker sits on one URL
// the shell loads for one step and is gone as soon as the user navigates, so the
// workspace UI — and anything it navigates to — carries no marker at all.

const ELECTRON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

describe("isDesktopShellUserAgent", () => {
  it("recognises the real Electron UA the shell reports", () => {
    // Captured from the running shell, not invented.
    expect(isDesktopShellUserAgent(ELECTRON)).toBe(true);
  });

  it("does not fire for ordinary browsers", () => {
    expect(isDesktopShellUserAgent(CHROME)).toBe(false);
    expect(isDesktopShellUserAgent(SAFARI)).toBe(false);
  });

  it("requires a version, so the bare word in a URL or comment can't trigger it", () => {
    expect(isDesktopShellUserAgent("Mozilla/5.0 (compatible; Electron)")).toBe(false);
    expect(isDesktopShellUserAgent("Chrome/130 ElectronBot/2")).toBe(false);
  });

  it("handles absent or empty input rather than throwing", () => {
    expect(isDesktopShellUserAgent(null)).toBe(false);
    expect(isDesktopShellUserAgent(undefined)).toBe(false);
    expect(isDesktopShellUserAgent("")).toBe(false);
  });
});
describe("isDesktopShellUserAgent — the shell's own token", () => {
  const OURS = `${CHROME} TreehouseDesktop/0.1.0`;

  it("recognises the token the shell appends", () => {
    expect(isDesktopShellUserAgent(OURS)).toBe(true);
  });

  it("prefers our token over the runtime one — it identifies the product", () => {
    // A UA with our token but no Electron token still counts (e.g. if Electron
    // ever drops its own, which is precisely why we stopped relying on it).
    expect(isDesktopShellUserAgent(`${CHROME} TreehouseDesktop/1.2.3`)).toBe(true);
  });

  it("still accepts the Electron fallback, so an older shell keeps working", () => {
    expect(isDesktopShellUserAgent(ELECTRON)).toBe(true);
  });

  it("requires a version on our token too", () => {
    expect(isDesktopShellUserAgent(`${CHROME} TreehouseDesktop`)).toBe(false);
  });
});