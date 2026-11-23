import { describe, expect, it } from "vite-plus/test";
import {
  HTML_REFERRER_POLICY,
  HTML_SANDBOX,
  HTML_SCRIPTS_SANDBOX,
  isSafeSandbox,
} from "../app/utils/htmlSandbox";

describe("HTML sandbox security contract", () => {
  it("keeps the document inert: no scripts, no forms, no modals", () => {
    // THE invariant. Same-origin is only dangerous once the document can execute,
    // so this assertion is what makes `allow-same-origin` below safe to grant.
    expect(HTML_SANDBOX).not.toContain("allow-scripts");
    expect(HTML_SANDBOX).not.toContain("allow-forms");
    expect(HTML_SANDBOX).not.toContain("allow-modals");
    expect(HTML_REFERRER_POLICY).toBe("no-referrer");
  });

  it("grants same-origin so the parent can intercept link clicks", () => {
    // Grants the document nothing (it cannot script); it lets OUR code attach a
    // click handler, turning an internal link into an SPA nav instead of a reload.
    expect(HTML_SANDBOX).toContain("allow-same-origin");
  });

  it("allows only user-activated top navigation, so links can leave the frame", () => {
    // Plain `allow-top-navigation` would let the document redirect the tab with
    // no user gesture; links must stay click-driven.
    expect(HTML_SANDBOX).toContain("allow-top-navigation-by-user-activation");
    expect(HTML_SANDBOX).not.toMatch(/(^|\s)allow-top-navigation(\s|$)/);
  });

  it("lets external links open in a real, un-sandboxed tab", () => {
    // Without the escape token the popup inherits this sandbox and renders blank.
    expect(HTML_SANDBOX).toContain("allow-popups");
    expect(HTML_SANDBOX).toContain("allow-popups-to-escape-sandbox");
  });

  it("treats the viewer's sandbox as safe", () => {
    expect(isSafeSandbox(HTML_SANDBOX)).toBe(true);
  });

  it("rejects the script-escape combination", () => {
    expect(isSafeSandbox("allow-scripts allow-same-origin")).toBe(false);
    expect(isSafeSandbox("allow-same-origin allow-scripts allow-forms")).toBe(false);
  });

  it("allows script OR same-origin alone (no escape)", () => {
    expect(isSafeSandbox("allow-scripts")).toBe(true);
    expect(isSafeSandbox("allow-same-origin")).toBe(true);
  });
});

describe("opt-in scripts sandbox", () => {
  it("never pairs scripting with our origin", () => {
    // THE invariant, and the entire basis for letting untrusted HTML execute:
    // the document runs in an opaque origin, so it can reach no cookie, no
    // storage and no DOM of ours. Adding same-origin here would let it strip
    // its own sandbox.
    expect(HTML_SCRIPTS_SANDBOX).toContain("allow-scripts");
    expect(HTML_SCRIPTS_SANDBOX).not.toContain("allow-same-origin");
    expect(isSafeSandbox(HTML_SCRIPTS_SANDBOX)).toBe(true);
  });

  it("cannot navigate the tab it runs in", () => {
    // The inert sandbox can afford top navigation because nothing in it runs.
    // An executing page could turn any stray click into a redirect, so links
    // leave through allow-popups instead.
    expect(HTML_SCRIPTS_SANDBOX).not.toContain("allow-top-navigation");
    expect(HTML_SCRIPTS_SANDBOX).toContain("allow-popups");
    expect(HTML_SCRIPTS_SANDBOX).toContain("allow-popups-to-escape-sandbox");
  });

  it("grants nothing beyond scripting and popups", () => {
    expect(HTML_SCRIPTS_SANDBOX).not.toContain("allow-forms");
    expect(HTML_SCRIPTS_SANDBOX).not.toContain("allow-modals");
    expect(HTML_SCRIPTS_SANDBOX).not.toContain("allow-pointer-lock");
    expect(HTML_SCRIPTS_SANDBOX).not.toContain("allow-downloads");
  });
});