import { describe, expect, it } from "vite-plus/test";
import {
  buildInviteDeepLink,
  buildOpenDeepLink,
  classifyArch,
  cliInstallOptions,
  connectOffer,
  DESKTOP_DOWNLOAD_URL,
  desktopAppSupport,
  detectOS,
  inviteView,
  isLinkAppMode,
  LINK_APP_COPY,
  LINK_CLI_COPY,
  linkCopy,
  linkKeyName,
  preselectedWorkspaceId,
  requestedWorkspaceId,
} from "../app/utils/desktopApp";

// U5 — the invite page's desktop-app handoff and link.vue's app mode. The pages
// render straight off these pure helpers, so the plan's U5 scenarios are exercised
// here rather than by mounting the Vue components.

describe("detectOS", () => {
  it("classifies the major platforms from UA hints", () => {
    expect(detectOS({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" })).toBe("mac");
    expect(detectOS({ platform: "Win32", userAgent: "Windows NT 10.0" })).toBe("windows");
    expect(detectOS({ platform: "Linux x86_64", userAgent: "X11; Linux" })).toBe("linux");
  });

  it("treats touch-capable 'macOS' (iPadOS) and mobile UAs as mobile", () => {
    expect(detectOS({ platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 5 })).toBe(
      "mobile",
    );
    expect(detectOS({ platform: "", userAgent: "iPhone", uaMobile: true })).toBe("mobile");
    expect(detectOS({ platform: "Linux armv8l", userAgent: "Android" })).toBe("mobile");
  });

  it("falls back to unknown with no usable hints", () => {
    expect(detectOS({})).toBe("unknown");
  });
});

describe("classifyArch", () => {
  it("maps high-entropy hints to arm64 / x64 / unknown", () => {
    expect(classifyArch("arm", "64")).toBe("arm64");
    expect(classifyArch("x86", "64")).toBe("x64");
    expect(classifyArch("x86", "32")).toBe("unknown");
    expect(classifyArch(undefined, undefined)).toBe("unknown");
  });
});

describe("desktopAppSupport", () => {
  it("supports only Apple-Silicon (and arch-unknown) Macs", () => {
    expect(desktopAppSupport("mac", "arm64").supported).toBe(true);
    expect(desktopAppSupport("mac", "unknown").supported).toBe(true);
  });

  it("marks Intel Macs unsupported rather than dead-ending them (Apple-Silicon-only)", () => {
    const intel = desktopAppSupport("mac", "x64");
    expect(intel.supported).toBe(false);
    expect(intel.label).toMatch(/intel/i);
    expect(intel.note).toMatch(/apple.silicon/i);
    // Web path stays first-class.
    expect(intel.note).toMatch(/browser/i);
  });

  it("keeps Windows / Linux / mobile / unknown on the web path, never offering a download", () => {
    for (const os of ["windows", "linux", "mobile", "unknown"] as const) {
      const s = desktopAppSupport(os, "unknown");
      expect(s.supported).toBe(false);
      expect(s.note).toMatch(/browser/i);
    }
  });

  it("exposes an arm64 DMG download URL under the desktop/ channel", () => {
    expect(DESKTOP_DOWNLOAD_URL).toMatch(/^https:\/\//);
    expect(DESKTOP_DOWNLOAD_URL).toContain("/desktop/");
    expect(DESKTOP_DOWNLOAD_URL).toMatch(/arm64/);
    // Pin the host: the assertions above still pass against the retired
    // dl.treehouse.pixelhop.io, so without this a revert would go unnoticed.
    expect(new URL(DESKTOP_DOWNLOAD_URL).host).toBe("dl.trytree.house");
  });
});

describe("buildInviteDeepLink", () => {
  it("carries token, workspace, and app origin in a treehouse://invite URL", () => {
    const url = buildInviteDeepLink({
      token: "tok_abc",
      workspaceId: "ws_123",
      appOrigin: "https://app.trytree.house",
    });
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("treehouse:");
    expect(parsed.host).toBe("invite");
    expect(parsed.searchParams.get("token")).toBe("tok_abc");
    expect(parsed.searchParams.get("workspace")).toBe("ws_123");
    expect(parsed.searchParams.get("origin")).toBe("https://app.trytree.house");
  });

  it("omits optional params when absent and encodes the origin", () => {
    expect(buildInviteDeepLink({ token: "t" })).toBe("treehouse://invite?token=t");
    const url = buildInviteDeepLink({
      token: "t",
      appOrigin: "https://self-hosted.example.com:8443",
    });
    expect(new URL(url).searchParams.get("origin")).toBe("https://self-hosted.example.com:8443");
  });
});

// U7 — the /connect hand-off. Creating a workspace on the web used to say nothing
// about the folder-sync half of the product; these are the branches that page
// renders from, so nobody reaches a dead end and nobody is handed a build that
// won't run.

describe("buildOpenDeepLink", () => {
  it("round-trips the workspace id and app origin in a treehouse://open URL", () => {
    const url = buildOpenDeepLink({
      workspaceId: "ws_123",
      appOrigin: "https://treehouse.pixelhop.io",
    });
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("treehouse:");
    expect(parsed.host).toBe("open");
    expect(parsed.searchParams.get("workspace")).toBe("ws_123");
    expect(parsed.searchParams.get("origin")).toBe("https://treehouse.pixelhop.io");
  });

  it("omits the origin when absent (the shell falls back to its default)", () => {
    expect(buildOpenDeepLink({ workspaceId: "ws_1" })).toBe("treehouse://open?workspace=ws_1");
  });

  it("escapes URL-significant characters rather than smuggling extra params", () => {
    const url = buildOpenDeepLink({
      workspaceId: "ws&origin=https://evil.example#x",
      appOrigin: "https://self-hosted.example.com:8443",
    });
    const parsed = new URL(url);
    // The whole hostile string stays one param value…
    expect(parsed.searchParams.get("workspace")).toBe("ws&origin=https://evil.example#x");
    // …and the real origin is the one that survives.
    expect(parsed.searchParams.get("origin")).toBe("https://self-hosted.example.com:8443");
    expect(url).not.toContain("evil.example#");
  });
});

describe("connectOffer", () => {
  it("offers the download on an Apple-Silicon Mac (and where arch is unreadable)", () => {
    expect(connectOffer("mac", "arm64")).toBe("download");
    expect(connectOffer("mac", "unknown")).toBe("download");
  });

  it("sends an Intel Mac down the CLI path, never a download it can't run", () => {
    expect(connectOffer("mac", "x64")).toBe("cli");
    expect(desktopAppSupport("mac", "x64").supported).toBe(false);
  });

  it("gives a computer we couldn't classify the CLI — never a dead end", () => {
    expect(connectOffer("unknown", "unknown")).toBe("cli");
  });

  it("keeps Windows and Linux on the web path and says they are coming soon", () => {
    // Their CLI builds have never been tested, so nothing offers them yet.
    for (const os of ["windows", "linux"] as const) {
      expect(connectOffer(os, "unknown")).toBe("web");
      expect(connectOffer(os, "arm64")).toBe("web");
      expect(desktopAppSupport(os, "unknown").note).toMatch(/coming soon/i);
      expect(cliInstallOptions(os)).toEqual([]);
    }
  });

  it("keeps phones and tablets on the web path (no folder to sync)", () => {
    expect(connectOffer("mobile", "unknown")).toBe("web");
    expect(desktopAppSupport("mobile", "unknown").note).toMatch(/browser/i);
  });
});

describe("cliInstallOptions", () => {
  it("gives macOS and unknown computers the one install command, labelled", () => {
    for (const os of ["mac", "unknown"] as const) {
      const opts = cliInstallOptions(os);
      expect(opts).toHaveLength(1);
      expect(opts[0]?.command).toMatch(
        /^curl -fsSL https:\/\/dl\.trytree\.house\/install\.sh \| sh$/,
      );
      // Labelled, so a machine we could not classify can tell who the line is for.
      expect(opts[0]?.label).toMatch(/macOS/);
    }
  });

  it("never shows the PowerShell installer", () => {
    for (const os of ["mac", "windows", "linux", "mobile", "unknown"] as const) {
      expect(cliInstallOptions(os).some((o) => /install\.ps1/.test(o.command))).toBe(false);
    }
  });
});

describe("inviteView", () => {
  it("shows the offer once accepted — no auto-redirect branch (fresh accept)", () => {
    expect(inviteView({ loading: false, accepted: true, error: false, previewValid: true })).toBe(
      "offer",
    );
  });

  it("shows the offer for a returning member even when the preview is now invalid (spent invite)", () => {
    // The mount probe flips `accepted` true for an already-a-member; the offer wins
    // over the "unavailable" branch.
    expect(inviteView({ loading: false, accepted: true, error: false, previewValid: false })).toBe(
      "offer",
    );
  });

  it("shows the invalid branch (no offer) for an expired/revoked invite to a non-member", () => {
    expect(inviteView({ loading: false, accepted: false, error: false, previewValid: false })).toBe(
      "invalid",
    );
    expect(inviteView({ loading: false, accepted: false, error: true, previewValid: true })).toBe(
      "invalid",
    );
  });

  it("shows the invite card for a valid, not-yet-accepted invite; loading takes priority", () => {
    expect(inviteView({ loading: false, accepted: false, error: false, previewValid: true })).toBe(
      "invite",
    );
    expect(inviteView({ loading: true, accepted: false, error: false, previewValid: true })).toBe(
      "loading",
    );
  });
});

describe("link.vue app mode", () => {
  it("detects app mode only from an explicit app flag", () => {
    expect(isLinkAppMode({ app: "1" })).toBe(true);
    expect(isLinkAppMode({ app: "true" })).toBe(true);
    expect(isLinkAppMode({ app: true })).toBe(true);
    // No flag → CLI behavior, unchanged.
    expect(isLinkAppMode({})).toBe(false);
    expect(isLinkAppMode({ code: "ABCD" })).toBe(false);
    expect(isLinkAppMode({ app: "0" })).toBe(false);
  });

  it("preselects the invite's workspace only when the user is a member of it", () => {
    const ids = ["ws_1", "ws_2"];
    expect(preselectedWorkspaceId({ workspace: "ws_2" }, ids)).toBe("ws_2");
    // Not one of the user's workspaces → no preselection (never approve the wrong one).
    expect(preselectedWorkspaceId({ workspace: "ws_other" }, ids)).toBe("");
    expect(preselectedWorkspaceId({}, ids)).toBe("");
  });

  it("returns the raw requested workspace id for authoritative (cross-org) resolution", () => {
    // The invited workspace can live in an org that isn't the webview's active one,
    // so app mode resolves this id by a membership-checked lookup — NOT by trusting
    // the active-org-scoped list (which is why preselectedWorkspaceId can't be used).
    expect(requestedWorkspaceId({ workspace: "ws_invited" })).toBe("ws_invited");
    expect(requestedWorkspaceId({ workspace: ["ws_a", "ws_b"] })).toBe("ws_a");
    expect(requestedWorkspaceId({})).toBe("");
  });

  it("extracts and sanitizes the app-mode key label from ?name", () => {
    expect(linkKeyName({ name: "Treehouse Desktop" })).toBe("Treehouse Desktop");
    expect(linkKeyName({ name: "  spaced  " })).toBe("spaced");
    expect(linkKeyName({})).toBeUndefined();
    expect(linkKeyName({ name: "" })).toBeUndefined();
    expect(linkKeyName({ name: "x".repeat(200) })?.length).toBe(64);
  });

  it("swaps terminal-flavored copy for app copy without terminal references", () => {
    // CLI copy is terminal-flavored…
    expect(LINK_CLI_COPY.approveSubtitle).toMatch(/terminal/i);
    expect(LINK_CLI_COPY.successBody).toMatch(/terminal/i);
    // …app copy has none.
    for (const s of Object.values(LINK_APP_COPY)) {
      expect(s).not.toMatch(/terminal/i);
    }
    expect(linkCopy(true)).toBe(LINK_APP_COPY);
    expect(linkCopy(false)).toBe(LINK_CLI_COPY);
  });
});