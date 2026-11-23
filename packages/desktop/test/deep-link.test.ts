import { describe, expect, it } from "vite-plus/test";
import { parseDeepLink } from "../src/contract";
import { type RouteContext, routeDeepLink } from "../src/deep-link";
import { DEFAULT_APP_ORIGIN } from "../src/origins";

const ORIGIN = "https://acme.example.com";

describe("parseDeepLink", () => {
  it("parses an invite link with token + workspace + origin", () => {
    const link = parseDeepLink(
      `treehouse://invite?token=inv_1&workspace=ws_1&origin=${encodeURIComponent(ORIGIN)}`,
    );
    expect(link).toEqual({
      kind: "invite",
      appOrigin: ORIGIN,
      workspaceId: "ws_1",
      inviteToken: "inv_1",
    });
  });

  it("parses an open link", () => {
    const link = parseDeepLink(
      `treehouse://open?workspace=ws_2&origin=${encodeURIComponent(ORIGIN)}`,
    );
    expect(link).toEqual({ kind: "open", appOrigin: ORIGIN, workspaceId: "ws_2" });
  });

  it("defaults a missing origin to the hosted app", () => {
    const link = parseDeepLink("treehouse://invite?workspace=ws_1");
    expect(link?.appOrigin).toBe(DEFAULT_APP_ORIGIN);
  });

  it("rejects a hostile / non-https origin", () => {
    expect(parseDeepLink("treehouse://invite?origin=http%3A%2F%2Fevil.example.com")).toBeNull();
    expect(parseDeepLink("treehouse://invite?origin=javascript%3Aalert(1)")).toBeNull();
  });

  it("rejects the wrong scheme", () => {
    expect(parseDeepLink("https://acme.example.com/invite")).toBeNull();
    expect(parseDeepLink("evil://invite?workspace=ws_1")).toBeNull();
  });

  it("rejects an unknown host", () => {
    expect(parseDeepLink("treehouse://steal?workspace=ws_1")).toBeNull();
  });

  it("rejects an open link with no workspace", () => {
    expect(parseDeepLink("treehouse://open")).toBeNull();
  });

  it("rejects oversized and garbage input", () => {
    expect(parseDeepLink(`treehouse://invite?token=${"x".repeat(4000)}`)).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
    expect(parseDeepLink("")).toBeNull();
  });
});

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  linkedWorkspaceIds: [],
  onboarding: false,
  ...over,
});

describe("routeDeepLink", () => {
  it("routes an invite for a new workspace to onboarding with parsed context", () => {
    const action = routeDeepLink(
      `treehouse://invite?token=inv_1&workspace=ws_new&origin=${encodeURIComponent(ORIGIN)}`,
      ctx(),
    );
    expect(action).toEqual({
      type: "onboard",
      entry: { appOrigin: ORIGIN, workspaceId: "ws_new", inviteToken: "inv_1" },
      supersede: false,
    });
  });

  it("focuses the window for an already-linked workspace", () => {
    const action = routeDeepLink(
      `treehouse://open?workspace=ws_1&origin=${encodeURIComponent(ORIGIN)}`,
      ctx({ linkedWorkspaceIds: ["ws_1"] }),
    );
    expect(action).toEqual({ type: "focus-workspace", appOrigin: ORIGIN, workspaceId: "ws_1" });
  });

  it("onboards an unlinked workspace even from an open link (second-workspace)", () => {
    const action = routeDeepLink(
      `treehouse://open?workspace=ws_2&origin=${encodeURIComponent(ORIGIN)}`,
      ctx({ linkedWorkspaceIds: ["ws_1"] }),
    );
    expect(action.type).toBe("onboard");
  });

  // R7: the browser's "open in Treehouse" button routinely names a workspace with no
  // folder here yet. Focusing a window would show the user nothing, so the link has
  // to start the spine — carrying the id, so the workspace step resolves its name
  // instead of asking the user to re-pick what they just picked on the web.
  it("onboards an open link for a workspace that was never linked here, carrying the id", () => {
    const action = routeDeepLink(
      `treehouse://open?workspace=ws_web&origin=${encodeURIComponent(ORIGIN)}`,
      ctx(),
    );
    expect(action).toEqual({
      type: "onboard",
      entry: { appOrigin: ORIGIN, workspaceId: "ws_web", inviteToken: undefined },
      supersede: false,
    });
  });

  it("still routes an open link from an unknown origin to onboarding (TOFU downstream)", () => {
    const action = routeDeepLink(
      "treehouse://open?workspace=ws_web&origin=https%3A%2F%2Fselfhost.example.com",
      ctx(),
    );
    expect(action).toMatchObject({ type: "onboard" });
    if (action.type === "onboard") {
      expect(action.entry.appOrigin).toBe("https://selfhost.example.com");
      expect(action.entry.workspaceId).toBe("ws_web");
    }
  });

  it("ignores an open link whose workspace id is missing or unusable", () => {
    const origin = `origin=${encodeURIComponent(ORIGIN)}`;
    // Nothing to open and nothing to onboard — an open link IS its workspace id.
    expect(routeDeepLink(`treehouse://open?${origin}`, ctx())).toEqual({ type: "ignore" });
    expect(routeDeepLink(`treehouse://open?workspace=&${origin}`, ctx())).toEqual({
      type: "ignore",
    });
    // Unbounded / smuggled values never reach the flow's persisted context.
    expect(routeDeepLink(`treehouse://open?workspace=${"w".repeat(200)}&${origin}`, ctx())).toEqual(
      { type: "ignore" },
    );
    expect(routeDeepLink(`treehouse://open?workspace=ws_1%0Aevil&${origin}`, ctx())).toEqual({
      type: "ignore",
    });
    expect(routeDeepLink(`treehouse://open?workspace=ws%201&${origin}`, ctx())).toEqual({
      type: "ignore",
    });
  });

  it("keeps an invite valid but DROPS an unusable workspace id", () => {
    // The open-link counterpart above ignores the whole link, because an open link
    // IS its id. An invite carries a token and stays valid without one — but the id
    // still lands in persisted onboarding state and from there in an API path, so
    // "only a preselection hint" is not a reason to skip validating it.
    const origin = `origin=${encodeURIComponent(ORIGIN)}`;
    for (const bad of [`${"w".repeat(200)}`, "ws_1%0Aevil", "ws%201"]) {
      const action = routeDeepLink(
        `treehouse://invite?token=inv_1&workspace=${bad}&${origin}`,
        ctx(),
      );
      expect(action.type).toBe("onboard");
      if (action.type !== "onboard") throw new Error("unreachable");
      // The invite survives; the unusable hint does not.
      expect(action.entry.inviteToken).toBe("inv_1");
      expect(action.entry.workspaceId).toBeUndefined();
    }
    // A usable id is still carried.
    const ok = routeDeepLink(`treehouse://invite?token=inv_1&workspace=ws_ok&${origin}`, ctx());
    if (ok.type !== "onboard") throw new Error("expected onboard");
    expect(ok.entry.workspaceId).toBe("ws_ok");
  });

  it("supersedes an in-progress onboarding from an open link too (same rule as invite)", () => {
    const action = routeDeepLink(
      `treehouse://open?workspace=ws_web&origin=${encodeURIComponent(ORIGIN)}`,
      ctx({ onboarding: true }),
    );
    expect(action).toMatchObject({ type: "onboard", supersede: true });
  });

  it("focuses, not supersedes, when an open link names a linked workspace mid-onboarding", () => {
    const action = routeDeepLink(
      `treehouse://open?workspace=ws_1&origin=${encodeURIComponent(ORIGIN)}`,
      ctx({ linkedWorkspaceIds: ["ws_1"], onboarding: true }),
    );
    expect(action).toEqual({ type: "focus-workspace", appOrigin: ORIGIN, workspaceId: "ws_1" });
  });

  it("still routes an unknown origin to onboarding (TOFU handled downstream)", () => {
    const action = routeDeepLink(
      "treehouse://invite?workspace=ws_new&origin=https%3A%2F%2Fselfhost.example.com",
      ctx(),
    );
    expect(action).toMatchObject({ type: "onboard" });
    if (action.type === "onboard") {
      expect(action.entry.appOrigin).toBe("https://selfhost.example.com");
    }
  });

  it("supersedes an in-progress onboarding (documented mid-flow rule)", () => {
    const action = routeDeepLink(
      `treehouse://invite?workspace=ws_new&origin=${encodeURIComponent(ORIGIN)}`,
      ctx({ onboarding: true }),
    );
    expect(action).toMatchObject({ type: "onboard", supersede: true });
  });

  it("ignores garbage / wrong-scheme / oversized input without throwing", () => {
    expect(routeDeepLink("not a url", ctx())).toEqual({ type: "ignore" });
    expect(routeDeepLink("https://evil.example.com/", ctx())).toEqual({ type: "ignore" });
    expect(routeDeepLink(`treehouse://open?x=${"y".repeat(4000)}`, ctx())).toEqual({
      type: "ignore",
    });
  });
});