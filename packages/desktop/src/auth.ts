// The cli is consumed as a raw-TS library via its declared `./src/*` export map
// (packages/cli/package.json) — the shell bundles it rather than shelling out to
// the binary, so that subpath is an intentional public surface, not workspace luck.
import type { Config } from "cli/src/config";
import { saveConfig } from "cli/src/write-config";

// The device-flow driver, app side. It runs the existing device-code grant against
// the API, then writes the minted key STRAIGHT into the target folder's
// .treehouse/config.json — there is no in-memory key-custody window and resume
// needs no separate key persistence (the config file is the only sink). The
// approval page is loaded in the already-authed webview (workspace preselected via
// U5's /link app mode), so it is one click for the invited teammate.
//
// Pure/fetch-based and fully injectable (fetch/sleep/now) so the poll loop,
// workspace-mismatch guard, and expiry handling are unit-testable without Electron.

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
  /** The minted key's id (U4); absent from older servers. */
  api_key_id?: string;
}

/** The polled workspace didn't match the onboarding context — key rejected. */
export class WorkspaceMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly got: string,
  ) {
    super(`approved workspace ${got} does not match onboarding workspace ${expected}`);
    this.name = "WorkspaceMismatchError";
  }
}

/** The device code expired / was denied / vanished — the user must re-approve. */
export class DeviceGrantExpiredError extends Error {
  constructor(message = "device code expired") {
    super(message);
    this.name = "DeviceGrantExpiredError";
  }
}

export interface GrantDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Aborts the poll loop when the onboarding flow is superseded/abandoned. */
  signal?: AbortSignal;
  /** Reports a non-fatal cleanup-revoke failure (default: console.error). */
  onRevokeError?: (keyId: string, err: unknown) => void;
}

/** The onboarding flow was superseded/abandoned mid-grant. */
export class GrantAbortedError extends Error {
  constructor() {
    super("device grant aborted");
    this.name = "GrantAbortedError";
  }
}

export interface GrantOptions {
  /** API origin (from the descriptor). */
  apiBase: string;
  /** The folder whose config the minted key is written into, atomically. */
  folderRoot: string;
  /** The onboarding workspace the poll's workspace_id MUST match (invite/deep-link
   * context). Omit for the create-workspace path where the grant defines it. */
  expectWorkspaceId?: string;
  /** Honest label for the minted key in the key-management UI (U4). */
  keyName?: string;
  /** Load the app-mode approval page in the authed webview (workspace preselected). */
  loadApproval: (approval: { url: string; userCode: string }) => void | Promise<void>;
  /** Revoke a minted key by id — a cookie-authenticated call the shell owns.
   * Used to clean up a mismatched grant so no orphaned key lingers. */
  revokeKey: (keyId: string) => Promise<void>;
}

/**
 * Run the device-code grant. On approval: verify the workspace matches the context
 * (mismatch → revoke the just-minted key + throw `WorkspaceMismatchError`, no
 * config written), otherwise write the config atomically and return the key id for
 * link attribution. Throws `DeviceGrantExpiredError` on expiry/denial.
 */
export async function runDeviceGrant(
  opts: GrantOptions,
  deps: GrantDeps = {},
): Promise<{ keyId?: string; workspaceId: string }> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const onRevokeError =
    deps.onRevokeError ??
    ((keyId: string, err: unknown) =>
      console.error(`[onboarding] failed to revoke mismatched key ${keyId}:`, err));
  const aborted = () => deps.signal?.aborted === true;

  // Check the signal BEFORE the first network call and again before the webview
  // load. `aborted()` was only consulted inside the poll loop (i.e. after the first
  // sleep), so an already-superseded flow still burned a device-code round-trip and
  // briefly threw the approval page up over the flow that replaced it.
  if (aborted()) throw new GrantAbortedError();
  const codeRes = await doFetch(`${opts.apiBase}/api/device/code`, { method: "POST" });
  // Worded for the person reading the "Setup didn't finish" dialog — the raw
  // "could not start device grant: 429" told them nothing about what to do.
  if (!codeRes.ok) {
    throw new Error(
      codeRes.status === 429
        ? "Treehouse has had a lot of setup requests from this network. Wait a few minutes, then press Retry."
        : `Treehouse couldn't start connecting this folder (HTTP ${codeRes.status}). Check your connection, then press Retry.`,
    );
  }
  const code = (await codeRes.json()) as CodeResponse;

  if (aborted()) throw new GrantAbortedError();
  await opts.loadApproval({ url: code.verification_uri_complete, userCode: code.user_code });

  let intervalMs = (code.interval ?? 5) * 1000;
  const deadline = now() + (code.expires_in ?? 600) * 1000;

  while (now() < deadline) {
    await sleep(intervalMs);
    if (aborted()) throw new GrantAbortedError();
    // A dropped poll request (Wi-Fi blip, DNS hiccup, connection reset — common
    // over a multi-minute wait for the user to approve) is transient: keep polling
    // until the deadline rather than tearing down a grant the user may have already
    // approved and forcing a fresh device-code exchange.
    let res: Response;
    try {
      res = await doFetch(
        `${opts.apiBase}/api/device/poll?device_code=${encodeURIComponent(code.device_code)}`,
      );
    } catch {
      if (aborted()) throw new GrantAbortedError();
      continue;
    }
    if (res.status === 429) {
      intervalMs += 5000; // slow_down — back off
      continue;
    }
    if (res.status === 410) throw new DeviceGrantExpiredError("login code expired");
    if (res.status === 403) throw new DeviceGrantExpiredError("approval was denied");
    if (res.status === 404) throw new DeviceGrantExpiredError("login session not found");
    if (!res.ok) throw new Error(`device grant failed: ${res.status}`);

    const body = (await res.json()) as { status: string } | PollApproved;
    if (body.status === "pending") continue;
    if (body.status === "approved") {
      const a = body as PollApproved;
      // Guard the workspace BEFORE the key touches disk. A mismatched approval
      // (user picked the wrong workspace) is rejected and the key revoked, so no
      // orphaned key survives and no config is written for the wrong workspace.
      if (opts.expectWorkspaceId && a.workspace_id !== opts.expectWorkspaceId) {
        if (a.api_key_id) {
          await opts.revokeKey(a.api_key_id).catch((err: unknown) => {
            // Non-fatal, but log it — a swallowed failure here silently breaks the
            // "no orphaned key lingers" guarantee this branch exists to uphold.
            onRevokeError(a.api_key_id as string, err);
          });
        }
        throw new WorkspaceMismatchError(opts.expectWorkspaceId, a.workspace_id);
      }
      const cfg: Config = {
        apiBase: a.api_base || opts.apiBase,
        apiKey: a.api_key,
        workspaceId: a.workspace_id,
        keyId: a.api_key_id,
      };
      // force: the folder was just created (no prior config), but a resumed grant
      // may overwrite a stale partial — the fresh key is authoritative.
      saveConfig(opts.folderRoot, cfg, true);
      return { keyId: a.api_key_id, workspaceId: a.workspace_id };
    }
  }
  throw new DeviceGrantExpiredError("login timed out");
}