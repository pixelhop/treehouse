import { spawn } from "node:child_process";
import { ensureDaemonRunning } from "./commands";
import { isDaemonAlive } from "./daemon";
import { sendIpc } from "./ipc";
import { addLink, appOwnedLinks, setPaused } from "./links-store";
import { saveConfig } from "./write-config";

// Device-code onboarding (the terminal half). Starts a device authorization,
// shows the URL + code (and best-effort opens the browser), polls until the user
// approves in the web app, then writes the workspace-scoped config. The API key
// is never printed or logged.

interface CodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}
interface PollApproved {
  status: "approved";
  api_key: string;
  workspace_id: string;
  api_base?: string;
  /** The minted key's id (added by U4); absent from older servers. */
  api_key_id?: string;
}

export interface LoginOptions {
  apiBase: string;
  root: string;
  force?: boolean;
  /** Best-effort open the browser (default true). */
  open?: boolean;
  /** Start syncing the folder immediately after connecting (default true). */
  start?: boolean;
  /**
   * Workspace to preselect on the approval page. Only a hint: the person still
   * confirms the code and can pick another, and the page ignores an id that
   * isn't one of theirs. Lets an agent that already knows the workspace spare
   * them choosing it again.
   */
  workspaceId?: string;
}

/** The approval link, with the requested workspace preselected when there is one. */
export function approvalUrl(verificationUriComplete: string, workspaceId?: string): string {
  if (!workspaceId) return verificationUriComplete;
  try {
    const url = new URL(verificationUriComplete);
    url.searchParams.set("workspace", workspaceId);
    return url.toString();
  } catch {
    return verificationUriComplete;
  }
}

/**
 * The command that opens `url` in the default browser. Never through a shell:
 * on Windows `start` is a cmd builtin, and cmd reads the `&` in
 * `?code=…&workspace=…` as a command separator — the browser got a truncated
 * link and cmd tried to run `workspace=…`. rundll32's URL handler takes the
 * whole URL as one argument.
 */
export function browserOpener(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  const { cmd, args } = browserOpener(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener (headless Linux, SSH, a container) is reported as an
    // `error` EVENT, not a throw — unhandled, it killed login right after
    // "Waiting for approval…". The printed link is the fallback either way.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Headless / no browser — the printed URL is the fallback.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLogin(opts: LoginOptions): Promise<void> {
  const { apiBase, root } = opts;

  const codeRes = await fetch(`${apiBase}/api/device/code`, { method: "POST" });
  if (!codeRes.ok) throw new Error(`could not start login: ${codeRes.status}`);
  const code = (await codeRes.json()) as CodeResponse;

  const link = approvalUrl(code.verification_uri_complete, opts.workspaceId);
  console.log(`\nTo connect this folder, open:\n  ${link}`);
  console.log(`and confirm the code:  ${code.user_code}\n`);
  if (opts.open !== false) openBrowser(link);
  console.log("Waiting for approval…");

  let intervalMs = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await fetch(
      `${apiBase}/api/device/poll?device_code=${encodeURIComponent(code.device_code)}`,
    );
    if (res.status === 429) {
      intervalMs += 5000; // slow_down — back off
      continue;
    }
    if (res.status === 410) throw new Error("login code expired — run `treehouse login` again");
    if (res.status === 403) throw new Error("login was denied");
    if (res.status === 404) throw new Error("login session not found");
    if (!res.ok) throw new Error(`login failed: ${res.status}`);

    const body = (await res.json()) as { status: string } | PollApproved;
    if (body.status === "pending") continue;
    if (body.status === "approved") {
      const a = body as PollApproved;
      saveConfig(
        root,
        {
          apiBase: a.api_base || apiBase,
          apiKey: a.api_key,
          workspaceId: a.workspace_id,
          // Record the key id so it can later be revoked; the config's key id is
          // also the ownership anchor a link's attribution is matched against.
          keyId: a.api_key_id,
        },
        opts.force,
      );
      // Register the directory so the daemon (treehouse start) supervises it. A
      // CLI-created link is attributed `cli` (never app-owned); recording the key
      // id keeps the schema symmetric with app-created links.
      addLink(root, a.workspace_id, { origin: "cli", keyId: a.api_key_id });
      console.log(`\n✓ Connected to workspace ${a.workspace_id}.`);

      if (opts.start === false) {
        console.log(`  Start syncing when you're ready:  treehouse start`);
        return;
      }

      // Begin syncing right away so it's a one-command experience.
      try {
        const { autostart } = await ensureDaemonRunning();
        console.log(`  Syncing ${root} now — drop a file in and watch it appear in the web app.`);
        if (autostart) console.log(`  It keeps syncing in the background and resumes on login.`);
        console.log(`  Check anytime with:  treehouse status`);
      } catch {
        // Couldn't auto-start (e.g. restricted environment) — fall back to manual.
        console.log(`  Start syncing with:  treehouse start`);
      }
      return;
    }
  }
  throw new Error("login timed out — run `treehouse login` again");
}

export interface SignOutOptions {
  /**
   * Revoke a minted key by its id. Supplied by the caller (the desktop shell,
   * which holds the cookie session the key-management route requires) — the CLI
   * substrate owns which links to touch, not how the HTTP revocation authenticates.
   */
  revokeKey: (keyId: string) => Promise<void>;
  /** Nudge a running daemon to drop the now-paused folders (default true). */
  reload?: boolean;
  /** Per-key revocation deadline (default 10s). See `runSignOut`. */
  revokeTimeoutMs?: number;
}

const REVOKE_TIMEOUT_MS = 10_000;

/**
 * Run `run()` and reject after `ms` if it hasn't settled. Takes a thunk rather
 * than a promise so that BOTH failure modes of a caller-supplied `revokeKey`
 * land as a rejection here: one that never settles (no deadline of its own would
 * keep `runSignOut` pending forever) and one that throws synchronously — which,
 * invoked eagerly in the caller's `.map()`, would escape before `allSettled`
 * ever saw it and skip every remaining key. Calling it inside the executor is
 * what converts that throw; the catch is only there to disarm the timer, which
 * would otherwise hold the event loop open for the rest of the deadline.
 */
function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`revocation timed out after ${ms}ms`)), ms);
    const clear = () => clearTimeout(timer);
    try {
      run().then(resolve, reject).finally(clear);
    } catch (e) {
      clear();
      reject(e);
    }
  });
}

/**
 * Sign-out semantics for app-owned links (R14; origin R7/R8): pause each
 * app-owned folder and revoke its key BY ID — never the CLI's own links, and
 * never a folder whose ownership has transferred (see `isAppOwned`). Pausing is
 * applied even if a revoke fails (best-effort) so a signed-out folder always
 * stops syncing; local files are left untouched. Returns what was affected.
 *
 * Order matters, because none of the revocation work is what actually stops a
 * folder syncing. links.json is advisory until the daemon re-reads it, so the
 * sequence is: persist EVERY pause, then reload the daemon (which tears the
 * engines down), and only then revoke the keys. `revokeKey` is caller-supplied
 * network work with no deadline of its own — doing it earlier meant a slow or
 * hung request kept signed-out folders syncing for as long as it took to settle.
 * Revocations then run together rather than in series, each under its own
 * timeout, so one dead request can neither strand the others nor leave
 * `runSignOut` pending forever.
 */
export async function runSignOut(
  opts: SignOutOptions,
): Promise<{ pausedRoots: string[]; revokedKeyIds: string[]; failedKeyIds: string[] }> {
  const owned = appOwnedLinks();
  const pausedRoots: string[] = [];
  const revokedKeyIds: string[] = [];
  const failedKeyIds: string[] = [];
  for (const link of owned) {
    setPaused(link.root, true); // stops sync regardless of the revoke outcome
    pausedRoots.push(link.root);
  }

  // Drop the paused engines BEFORE revoking — this, not the pause write, is what
  // stops the folders syncing. sendIpc is bounded by its own timeout, so
  // awaiting it here can't stall the revocations below.
  if (opts.reload !== false && isDaemonAlive()) await sendIpc({ cmd: "reload" });

  const timeoutMs = opts.revokeTimeoutMs ?? REVOKE_TIMEOUT_MS;
  const keyIds = owned.map((l) => l.keyId).filter((id): id is string => Boolean(id));
  const outcomes = await Promise.allSettled(
    keyIds.map((id) => withTimeout(() => opts.revokeKey(id), timeoutMs)),
  );
  outcomes.forEach((o, i) => {
    // The folder stays paused, but a failed revoke leaves a live key — the
    // caller surfaces it so the user can retry (a live key on a shared Mac is a
    // real gap, not "success"). Only successes go in revokedKeyIds; a timeout
    // counts as failure, since "unknown" has to read as "still live".
    if (o.status === "fulfilled") revokedKeyIds.push(keyIds[i]);
    else failedKeyIds.push(keyIds[i]);
  });
  return { pausedRoots, revokedKeyIds, failedKeyIds };
}