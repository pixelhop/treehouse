// Desktop-app handoff helpers (U5). The invite page and the device-link page both
// need to (a) work out whether *this* visitor can run the macOS desktop app, and
// (b) build the `treehouse://` deep link the shell consumes. Keeping the logic here
// as pure functions lets both pages share one implementation and lets it be unit
// tested without mounting the Vue components.

// ── Platform detection ──────────────────────────────────────────────────────
// Mirrors link.vue's existing UA/arch handling exactly, extracted so the invite
// page reuses it rather than growing a second copy.

export type DetectedOS = "mac" | "windows" | "linux" | "mobile" | "unknown";
export type DetectedArch = "arm64" | "x64" | "unknown";

export interface PlatformInput {
  /** `navigator.userAgentData?.platform ?? navigator.platform` */
  platform?: string | null;
  /** `navigator.userAgent` */
  userAgent?: string | null;
  /** `navigator.maxTouchPoints` — modern iPads report a macOS UA but expose touch. */
  maxTouchPoints?: number;
  /** `navigator.userAgentData?.mobile` */
  uaMobile?: boolean;
}

export function detectOS(input: PlatformInput): DetectedOS {
  const plat = (input.platform ?? "").toLowerCase();
  const ua = (input.userAgent ?? "").toLowerCase();
  // Modern iPads report a macOS UA but expose touch points.
  if (/mac/.test(plat) && (input.maxTouchPoints ?? 0) > 1) return "mobile";
  if (input.uaMobile || /android|iphone|ipad|mobile/.test(ua)) return "mobile";
  if (/mac/.test(plat) || /mac os/.test(ua)) return "mac";
  if (/win/.test(plat) || /windows/.test(ua)) return "windows";
  if (/linux|x11/.test(plat) || /linux/.test(ua)) return "linux";
  return "unknown";
}

/** Classify the high-entropy arch hints Chromium exposes (best-effort). */
export function classifyArch(architecture?: string | null, bitness?: string | null): DetectedArch {
  const a = String(architecture ?? "").toLowerCase();
  if (a.includes("arm")) return "arm64";
  if (a === "x86" && String(bitness) === "64") return "x64";
  return "unknown";
}

// ── Desktop-app support ─────────────────────────────────────────────────────
// v1 ships the macOS Apple-Silicon build only (the bundled SEA daemon is
// darwin-arm64-only). Everyone else gets the web path first-class; Intel Macs are
// told they're unsupported rather than being offered a download that won't run.

export interface DesktopSupport {
  /** Human label for the detected platform. */
  label: string;
  /** Whether the desktop app can be installed here (Mac Apple Silicon only). */
  supported: boolean;
  /** Why it's unsupported (empty when supported). */
  note: string;
}

const WEB_FALLBACK = "You can keep using Treehouse right here in your browser.";

// Folder sync has only been tested on a Mac. The Windows and Linux CLI builds
// exist, but until they have been tested nothing offers them.
export const COMING_SOON_NOTE = `Windows and Linux are coming soon — syncing a folder is Mac-only for now. ${WEB_FALLBACK}`;

export function desktopAppSupport(os: DetectedOS, arch: DetectedArch): DesktopSupport {
  switch (os) {
    case "mac":
      if (arch === "x64") {
        return {
          label: "macOS · Intel",
          supported: false,
          note: `The Treehouse desktop app is Apple-Silicon-only for now. ${WEB_FALLBACK}`,
        };
      }
      // arch === "unknown" reaches here on Safari/Firefox, where the high-entropy
      // UA hints that identify the CPU are Chromium-only. We can't tell an Intel Mac
      // from an Apple Silicon one there, and refusing the download outright would be
      // wrong for the majority — so offer it with a caveat rather than the silent
      // "supported" claim, which sent Intel users to a build that won't launch.
      return {
        label: arch === "arm64" ? "macOS · Apple Silicon" : "macOS",
        supported: true,
        note:
          arch === "unknown"
            ? "If the app doesn't open, your Mac may have an Intel chip — the desktop app is Apple-Silicon-only for now."
            : "",
      };
    case "windows":
      return {
        label: "Windows",
        supported: false,
        note: COMING_SOON_NOTE,
      };
    case "linux":
      return {
        label: "Linux",
        supported: false,
        note: COMING_SOON_NOTE,
      };
    case "mobile":
      return {
        label: "a phone or tablet",
        supported: false,
        note: `The desktop app runs on a Mac — Treehouse syncs a folder on your computer. ${WEB_FALLBACK}`,
      };
    default:
      return {
        label: "your computer",
        supported: false,
        note: `The desktop app is macOS-only for now. ${WEB_FALLBACK}`,
      };
  }
}

// The signed/notarized DMG is published by U11 to the R2 download bucket under a
// `desktop/` prefix that mirrors the CLI's `latest` layout. arm64-only for v1.
export const DESKTOP_DOWNLOAD_URL = "https://dl.trytree.house/desktop/latest/Treehouse-arm64.dmg";

// ── Deep link ───────────────────────────────────────────────────────────────
// Shape consumed by the desktop shell's URL router (U9):
//
//   treehouse://invite?token=<inviteToken>&workspace=<workspaceId>&origin=<appOrigin>
//
//   host `invite`  — selects the onboarding machine's invite entry point (U7/U9).
//   token          — the invite token. An ACCELERATOR only: acceptance already
//                    happened in the browser, so a lost/never-fired deep link costs
//                    nothing — first sign-in resolves membership by account.
//   workspace      — the joined workspace id, so the shell preselects it in the
//                    device grant (link.vue app mode) and focuses the window if the
//                    workspace is already linked.
//   origin         — the app (web) origin the invite was served from, so a
//                    self-hosted shell can discover the matching API origin via the
//                    well-known descriptor (U4/R15) with no user input.
//
// A scheme URL is untrusted input on the shell side: the router validates `origin`
// through the same TOFU + descriptor checks before it loads anything (U9).

export interface InviteDeepLinkParams {
  token: string;
  workspaceId?: string;
  appOrigin?: string;
}

export function buildInviteDeepLink(p: InviteDeepLinkParams): string {
  const q = new URLSearchParams();
  q.set("token", p.token);
  if (p.workspaceId) q.set("workspace", p.workspaceId);
  if (p.appOrigin) q.set("origin", p.appOrigin);
  return `treehouse://invite?${q.toString()}`;
}

// The second deep-link host (U7):
//
//   treehouse://open?workspace=<workspaceId>&origin=<appOrigin>
//
//   host `open`  — an *already installed* app is asked to take this workspace on.
//                  The shell focuses its window when the workspace is already
//                  linked to a folder, and enters onboarding at the folder step
//                  when it isn't (U6) — so this is safe to offer to someone who
//                  has never connected this particular workspace.
//   workspace    — required; without it there is nothing to open.
//   origin       — the web origin the link was served from, so a self-hosted shell
//                  finds the matching API (omitted → the shell's default origin).
//
// Shape mirrored in packages/desktop/src/contract.ts (`parseDeepLink`), which is
// the side that treats it as untrusted input.

export interface OpenDeepLinkParams {
  workspaceId: string;
  appOrigin?: string;
}

export function buildOpenDeepLink(p: OpenDeepLinkParams): string {
  const q = new URLSearchParams();
  q.set("workspace", p.workspaceId);
  if (p.appOrigin) q.set("origin", p.appOrigin);
  return `treehouse://open?${q.toString()}`;
}

// ── The connect hand-off (/connect) ─────────────────────────────────────────
// Creating a workspace on the web leaves the folder-sync half of the product
// invisible. /connect closes that gap, and the one decision it makes is which
// way to send this visitor. There are exactly three, and none of them is a dead
// end:
//
//   "download" — the desktop app runs here (Apple Silicon, or a Mac whose arch we
//                can't read). Offer the DMG, plus a treehouse://open link for
//                someone who already has it.
//   "cli"      — a computer the app won't run on (an Intel Mac), or one we
//                couldn't classify. Offer the CLI instead of a build that won't
//                launch.
//   "web"      — nothing to install here: a phone or tablet has no folder to
//                sync, and Windows and Linux are coming soon (their CLI builds
//                exist but have never been tested, so we don't offer them).
//                Stay in the browser.

export type ConnectOffer = "download" | "cli" | "web";

export function connectOffer(os: DetectedOS, arch: DetectedArch): ConnectOffer {
  if (desktopAppSupport(os, arch).supported) return "download";
  return os === "mac" || os === "unknown" ? "cli" : "web";
}

/** Where the CLI install scripts live (same host as the desktop DMG). */
export const CLI_DOWNLOAD_BASE = "https://dl.trytree.house";

const POSIX_INSTALL = `curl -fsSL ${CLI_DOWNLOAD_BASE}/install.sh | sh`;

/** One labelled install one-liner. */
export interface InstallOption {
  label: string;
  command: string;
}

/**
 * The install one-liner(s) for this platform.
 *
 * Windows and Linux get none: they are coming soon, and `connectOffer` keeps
 * them on the web path. Everything else gets the installer, labelled so a
 * machine we could not classify can tell the line is for a Mac.
 */
export function cliInstallOptions(os: DetectedOS): InstallOption[] {
  if (os === "windows" || os === "linux") return [];
  return [{ label: "macOS", command: POSIX_INSTALL }];
}

// ── Invite page view state ──────────────────────────────────────────────────
// The invite page's success state offers the app instead of auto-redirecting.
// `inviteView` is the single branch decision the template renders from.

export type InviteView = "loading" | "offer" | "invalid" | "invite";

export function inviteView(s: {
  loading: boolean;
  /** Accepted just now, or the viewer is already a member (idempotent accept). */
  accepted: boolean;
  error: boolean;
  previewValid: boolean;
}): InviteView {
  if (s.loading) return "loading";
  // Accepted (or already-a-member) wins over an "unavailable" preview: a returning
  // member of a spent single-use invite still gets the app offer, not a dead end.
  if (s.accepted) return "offer";
  if (s.error || !s.previewValid) return "invalid";
  return "invite";
}

// ── link.vue app mode ───────────────────────────────────────────────────────
// When the desktop shell drives the device-code grant, it loads the approval page
// in its authed webview with `?app=1&workspace=<id>&code=<devcode>`. App mode
// preselects the workspace (so the grant is one click and can't approve the wrong
// one) and swaps the terminal-flavored copy. WITHOUT `app`, link.vue is unchanged.

export function isLinkAppMode(query: Record<string, unknown>): boolean {
  const v = query.app;
  return v === "1" || v === "true" || v === true;
}

/** The preselected workspace id from the query, but only if it's one the user has. */
export function preselectedWorkspaceId(
  query: Record<string, unknown>,
  workspaceIds: string[],
): string {
  // Vue router query values are string | null | (string | null)[].
  const raw = query.workspace;
  let id = "";
  if (typeof raw === "string") id = raw;
  else if (Array.isArray(raw) && typeof raw[0] === "string") id = raw[0];
  return id && workspaceIds.includes(id) ? id : "";
}

/** The raw requested workspace id from the query (unvalidated — the app-mode page
 * resolves it authoritatively by id via a membership-checked lookup, since the
 * invited workspace may live in an org that isn't the webview session's active one). */
export function requestedWorkspaceId(query: Record<string, unknown>): string {
  const raw = query.workspace;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return "";
}

/** The honest key label carried in the app-mode approval URL (`?name=`). Trimmed
 * and length-capped — it is untrusted display input forwarded to the approve call. */
export function linkKeyName(query: Record<string, unknown>): string | undefined {
  const raw = query.name;
  const s =
    typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "";
  const trimmed = s.trim().slice(0, 64);
  return trimmed || undefined;
}

export interface LinkCopy {
  approveTitle: string;
  approveSubtitle: string;
  successTitle: string;
  successBody: string;
}

export const LINK_CLI_COPY: LinkCopy = {
  approveTitle: "Approve this device",
  approveSubtitle: "Check this matches the code in your terminal, then choose where to sync.",
  successTitle: "You're connected 🌳",
  successBody:
    "Head back to your terminal — your folder is syncing now. Drop a file in and it shows up here; change it here and it lands on your machine.",
};

export const LINK_APP_COPY: LinkCopy = {
  approveTitle: "Approve this workspace",
  approveSubtitle: "Confirm the workspace you're syncing into.",
  successTitle: "You're all set 🌳",
  successBody:
    "Your folder is syncing now. Drop a file in and it shows up here; change it here and it lands on your Mac.",
};

export function linkCopy(appMode: boolean): LinkCopy {
  return appMode ? LINK_APP_COPY : LINK_CLI_COPY;
}