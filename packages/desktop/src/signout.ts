import { loadConfig } from "cli/src/config";
import { appOwnedLinks } from "cli/src/links-store";
import { runSignOut } from "cli/src/login";
import { session } from "electron";
import { WORKSPACE_PARTITION } from "./security";
import { clearWorkspaceSession } from "./windows";

/** Every revoke is bounded. Without this a single unreachable server hangs the
 * whole action — "Sign Out" and "Stop Syncing" are both fired from the menubar,
 * where there is no window to show a spinner and no way to cancel. 10s is long
 * enough for a slow link and short enough that the menu doesn't feel dead. */
const REVOKE_TIMEOUT_MS = 10_000;

// Sign-out closes BOTH boundaries (U3 + KTD): the daemon side (pause + revoke the
// app-owned links' keys, leaving CLI-owned links and all local files untouched)
// AND the web side (wipe the workspace window's persistent partition) — otherwise
// a "signed out" shared Mac would still open an authenticated workspace UI. The cli
// owns WHICH links to touch (runSignOut); the shell owns HOW revocation
// authenticates (the partition's cookie session) and the partition wipe.

/** Revoke each app-owned key against the API origin recorded in its folder config. */
function revokeKeyFactory(): (keyId: string) => Promise<void> {
  const apiByKey = new Map<string, string>();
  for (const link of appOwnedLinks()) {
    if (!link.keyId) continue;
    try {
      apiByKey.set(link.keyId, loadConfig(link.root).apiBase);
    } catch {
      // A folder whose config is unreadable can't be revoked by us; pause still stops it.
    }
  }
  return async (keyId: string) => {
    const apiBase = apiByKey.get(keyId);
    // No recorded API base (unreadable config) → we genuinely can't revoke it; treat
    // as a failure so sign-out reports it rather than silently claiming success.
    if (!apiBase) throw new Error(`no API base recorded for key ${keyId}`);
    const res = await session
      .fromPartition(WORKSPACE_PARTITION)
      .fetch(`${apiBase}/api/keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
    // 404 = already gone (revoked/expired) → success. Any other non-2xx (401 from a
    // lapsed cookie session, 5xx) is a real failure: the key may still be LIVE, so
    // it must NOT be counted as revoked. A timeout throws out of `fetch` and lands
    // in the caller's failed-key tally for the same reason.
    if (!res.ok && res.status !== 404) {
      throw new Error(`revoke failed for ${keyId}: HTTP ${res.status}`);
    }
  };
}

export async function signOut(): Promise<{
  pausedRoots: string[];
  revokedKeyIds: string[];
  failedKeyIds: string[];
}> {
  const result = await runSignOut({ revokeKey: revokeKeyFactory() });
  // Wipe cookies/storage so the workspace window prompts for sign-in again.
  await clearWorkspaceSession();
  if (result.failedKeyIds.length > 0) {
    // The folders are paused (sync stopped), but a live key remains on the server —
    // surface it so the user knows to retry rather than assuming a clean sign-out.
    console.error(
      `[signout] ${result.failedKeyIds.length} key(s) could not be revoked; ` +
        "folders are paused but sign in and try again to fully revoke.",
    );
  }
  return result;
}
/**
 * Revoke the key belonging to ONE folder, using that folder's own recorded API
 * origin and the partition's cookie session — the same authentication path
 * sign-out uses.
 *
 * Exported for the tray's unlink action, which must revoke while the link still
 * exists: `revokeKeyFactory` above resolves keys by walking links.json, so a key
 * whose link has already been removed can never be revoked from the app again.
 *
 * The revocation handle is looked for in TWO places, links.json first and then the
 * folder's own config. `Link.keyId` is documented as "Absent on legacy links", and
 * for those the key id lives only in `<root>/.treehouse/config.json` — so keying
 * solely off the link made `revokeFolderKey` a silent no-op for exactly those
 * folders. `unlinkFolder` then proceeded to `cmdUnlink`, leaving a LIVE key on the
 * server with its plaintext copy still on disk and no in-app path left to revoke
 * it: the precise outcome the fail-closed ordering there exists to prevent.
 *
 * A folder with no recorded key in either place (a CLI-owned link, or one whose
 * config is unreadable) is still a no-op rather than an error — there is genuinely
 * nothing to revoke, and refusing to unlink would strand the folder.
 */
export async function revokeFolderKey(root: string): Promise<void> {
  const link = appOwnedLinks().find((l) => l.root === root);
  let cfg: { apiBase: string; keyId?: string } | null = null;
  try {
    cfg = loadConfig(root);
  } catch {
    cfg = null; // handled below, once we know whether there is anything to revoke
  }

  const keyId = link?.keyId ?? cfg?.keyId;
  // Nothing recorded in either place → genuinely nothing to revoke. Returning here
  // (rather than throwing) is what keeps a CLI-owned folder unlinkable.
  if (!keyId) return;

  // A key we know about, but no readable config to tell us WHICH server issued it.
  // Fail closed: the caller keeps the link rather than dropping a live key.
  if (!cfg) {
    throw new Error("this folder's settings are unreadable, so its key can't be revoked");
  }
  const apiBase = cfg.apiBase;
  // Bounded. An unreachable or hanging server would otherwise leave "Stop Syncing"
  // waiting forever before `cmdUnlink` ever runs, with no dialog and no way out —
  // a timeout has to fail the same way a refusal does, so the caller keeps the link
  // rather than dropping a key it could not revoke.
  let res: Response;
  try {
    res = await session
      .fromPartition(WORKSPACE_PARTITION)
      .fetch(`${apiBase}/api/keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new Error(
      timedOut
        ? "the server didn't respond in time"
        : `the server couldn't be reached (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`the server refused the request (HTTP ${res.status})`);
  }
}