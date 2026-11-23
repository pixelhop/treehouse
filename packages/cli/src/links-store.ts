import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAppDir, linksPath } from "./paths";

// The registry of directories the daemon supervises. Persisted at
// <appDir>/links.json. Each entry's workspace-scoped key + sync state live under
// that directory's own .treehouse/; this file is just the supervise-list.
//
// links.json is a CROSS-VERSION contract with independently-updated CLI/app
// installs. The attribution fields below are additive and optional: an absent
// field reads as a legacy CLI link. Old readers ignore the extra keys; old
// *writers* are the real hazard — a shipped `addLink(root, workspaceId)` rewrites
// a re-linked entry bare, stripping attribution — so ownership is never trusted
// from the `origin` flag alone (see `isAppOwned`).

export interface Link {
  /** Absolute path to the linked directory. */
  root: string;
  workspaceId: string;
  /** When true the daemon leaves it idle (no watch/poll). */
  paused?: boolean;
  /** Who created this link. Absent = legacy/CLI (never treated as app-owned). */
  origin?: "app" | "cli";
  /** Account (user id) that minted the key — attribution, absent on legacy links. */
  account?: string;
  /** The minted key's id: the revocation handle (the key secret alone can't be
   * revoked). Absent on legacy links. */
  keyId?: string;
  /** The WEB APP origin this folder was connected through (the API origin lives in
   * the folder's own config). Recorded so a later re-authentication loads the
   * approval page on the SAME instance — a user with more than one connected
   * server has no other way to tell which one a folder belongs to. Absent on
   * legacy links and on CLI-created ones. */
  appOrigin?: string;
}

/** Optional attribution recorded when the app (or a newer CLI) creates a link. */
export interface LinkAttribution {
  origin?: "app" | "cli";
  account?: string;
  keyId?: string;
  appOrigin?: string;
}

export function loadLinks(): Link[] {
  try {
    const data = JSON.parse(readFileSync(linksPath(), "utf8")) as { links?: unknown };
    return Array.isArray(data.links) ? (data.links as Link[]) : [];
  } catch {
    return [];
  }
}

export function saveLinks(links: Link[]): void {
  ensureAppDir();
  const path = linksPath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ links }, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Register (or update) a linked directory. Idempotent on `root`. Attribution is
 * recorded when provided (the app passes `{ origin: "app", account, keyId }`);
 * called WITHOUT attribution it rewrites the entry bare — the deliberate,
 * shipped behavior that transfers ownership away from the app on a plain re-link.
 */
export function addLink(root: string, workspaceId: string, attribution?: LinkAttribution): void {
  const links = loadLinks().filter((l) => l.root !== root);
  // ONE folder per workspace per machine. Two local roots for the same workspace
  // means two engines syncing one remote tree against each other — every edit
  // races, and the second folder is the `Acme 2` the naming work exists to
  // prevent. Re-linking the SAME root is still fine (that is a re-key, filtered
  // above); only a second, different root is refused.
  const elsewhere = links.find((l) => l.workspaceId === workspaceId);
  if (elsewhere) {
    throw new WorkspaceAlreadyLinkedError(workspaceId, elsewhere.root);
  }
  links.push({ root, workspaceId, ...attribution });
  saveLinks(links);
}

/** A workspace already has a local folder on this machine (see `addLink`). The
 * existing root is carried so callers can name it rather than just refusing. */
export class WorkspaceAlreadyLinkedError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly existingRoot: string,
  ) {
    super(`that workspace already syncs to ${existingRoot} on this Mac`);
    this.name = "WorkspaceAlreadyLinkedError";
  }
}

/** Read the key id recorded in a folder's `.treehouse/config.json`, if any. */
function configKeyId(root: string): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(root, ".treehouse", "config.json"), "utf8")) as {
      keyId?: unknown;
    };
    return typeof cfg.keyId === "string" ? cfg.keyId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a link is currently owned by the app (so sign-out may pause + revoke
 * it). Requires an `app` origin AND a recorded key id, AND that the folder's
 * config still points at that key: if the config was re-keyed away (a CLI
 * re-link mints a fresh key), ownership has transferred and the app must leave it
 * alone. A legacy CLI writer that stripped the attribution also fails the first
 * check — either way an app sign-out never touches a folder it no longer owns.
 */
export function isAppOwned(link: Link): boolean {
  if (link.origin !== "app" || !link.keyId) return false;
  const cfgKeyId = configKeyId(link.root);
  return cfgKeyId === undefined || cfgKeyId === link.keyId;
}

/** The links the app currently owns (see `isAppOwned`). */
export function appOwnedLinks(): Link[] {
  return loadLinks().filter(isAppOwned);
}

/** Returns true if a link was removed. */
export function removeLink(root: string): boolean {
  const links = loadLinks();
  const next = links.filter((l) => l.root !== root);
  if (next.length === links.length) return false;
  saveLinks(next);
  return true;
}

/**
 * Point exactly ONE entry at a new directory, keyed on its old root. This is the
 * commit point of a relocation (see `relocate.ts`): everything else about the
 * link — workspace, pause flag, and the whole attribution block — is carried
 * across untouched, so a moved folder is still the same link, still app-owned,
 * and still revocable by the key id it was minted with.
 *
 * Returns false, changing nothing, when the old root isn't registered or when
 * `newRoot` is ALREADY registered: merging two entries (or inventing one) would
 * leave two supervised links disagreeing about one directory, and the caller has
 * a half-moved tree to tell the user about instead.
 */
export function relocateLink(oldRoot: string, newRoot: string): boolean {
  const links = loadLinks();
  const i = links.findIndex((l) => l.root === oldRoot);
  if (i === -1) return false;
  if (links.some((l, j) => j !== i && l.root === newRoot)) return false;
  saveLinks(links.map((l, j) => (j === i ? { ...l, root: newRoot } : l)));
  return true;
}

export function setPaused(root: string, paused: boolean): void {
  saveLinks(loadLinks().map((l) => (l.root === root ? { ...l, paused } : l)));
}