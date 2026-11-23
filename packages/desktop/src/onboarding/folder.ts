import { homedir } from "node:os";
import { basename, join } from "node:path";

// v1 folder policy (KTD): create-new at ~/Treehouse/<workspace-name>/. Never adopt
// an existing non-empty dir (bootstrap pushes everything local — that would upload
// personal files to the team). The default avoids macOS TCC-protected locations;
// a user override into one warns. Collisions get a numeric suffix. These functions
// are pure so the naming/collision/TCC rules are unit-testable.

// TCC-protected top-level dirs under ~ (macOS prompts for access and eviction is
// likely). ~/Treehouse avoids all of them; only an override into one warns.
const TCC_PROTECTED = new Set([
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
]);

export interface FolderPlan {
  /** The final folder name (may carry a collision suffix). */
  name: string;
  /** Absolute path to create. */
  root: string;
  /** Set when the location is a macOS TCC-protected area (override only). */
  tccWarning?: string;
  /** The folder already holds THIS workspace's files from an earlier sync on this
   * Mac (its `.treehouse/config.json` names the workspace, and nothing links it
   * any more). It is picked back up rather than replaced: the caller retires the
   * stale key so the grant mints a fresh one into the same folder. */
  reclaim?: boolean;
}

/** Why a chosen folder can't be used, or null when it's fine. */
export type OverrideRejection = "not-empty" | "not-absolute" | null;

/**
 * Whether a user-chosen folder may be adopted. The bootstrap sync pushes
 * everything local, so adopting a folder that already has files in it would
 * upload the user's unrelated documents to a shared workspace — that is the
 * never-adopt rule, and it is the reason this returns a reason rather than a
 * boolean (the UI has to explain the refusal, not just refuse).
 *
 * An EMPTY existing directory is fine: the picker can only return a directory
 * that exists, so refusing all existing directories would refuse everything.
 */
export function checkOverride(
  path: string,
  probes: { isEmpty: (p: string) => boolean; isReclaimable?: (p: string) => boolean },
): OverrideRejection {
  if (!path.startsWith("/")) return "not-absolute";
  // A folder that already holds this workspace's own files is not "someone's
  // unrelated documents" — the reason the never-adopt rule exists. Refusing it
  // left a user who stopped syncing and came back unable to choose their own
  // folder, so the flow made "<Name> 2" and the real files sat orphaned beside it.
  if (probes.isReclaimable?.(path)) return null;
  return probes.isEmpty(path) ? null : "not-empty";
}

/**
 * Sanitize a workspace name into one safe path segment: strip path separators,
 * control + filesystem-reserved characters, leading dots (hidden / traversal) and
 * trailing dots/spaces; collapse whitespace; cap the length. Falls back to
 * "Workspace" if nothing usable remains.
 */
export function sanitizeFolderName(name: string): string {
  // Drop control characters by codepoint (avoids control chars inside a regex),
  // then strip path separators + filesystem-reserved characters.
  const noControl = Array.from(name.normalize("NFC"))
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)
    .join("");
  const cleaned = noControl
    .replace(/[/\\<>:"|?*]/g, " ")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  // Truncate by CODE POINT, not UTF-16 code unit, so the cut can't split a
  // surrogate pair (an emoji) into a lone half. Re-strip afterwards: the cut can
  // land just after a dot/space that wasn't trailing before, which would other-
  // wise hand back a name ending in "." — exactly what this function promises not to.
  const truncated = Array.from(cleaned)
    .slice(0, 64)
    .join("")
    .replace(/[. ]+$/, "")
    .trim();
  return truncated || "Workspace";
}

/** The path relative to home, or null if it isn't under home. */
function relativeToHome(path: string, home: string): string | null {
  const h = home.endsWith("/") ? home : `${home}/`;
  return path.startsWith(h) ? path.slice(h.length) : null;
}

/**
 * Plan the local folder for a workspace. Default location is
 * ~/Treehouse/<sanitized-name>/, with a numeric suffix appended on collision.
 * `override` picks a custom location (warned if TCC-protected). `exists` supplies
 * collision state without touching disk (the caller passes a real fs check; tests
 * pass a fake).
 */
export function planFolder(
  workspaceName: string,
  opts: {
    home?: string;
    base?: string;
    override?: string;
    exists?: (path: string) => boolean;
    /** Does this existing path hold THIS workspace's files, unlinked? */
    isReclaimable?: (path: string) => boolean;
    /** Is this existing path an empty directory nothing links? */
    isUnusedEmpty?: (path: string) => boolean;
  } = {},
): FolderPlan {
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? (() => false);
  const isReclaimable = opts.isReclaimable ?? (() => false);
  const isUnusedEmpty = opts.isUnusedEmpty ?? (() => false);

  if (opts.override) {
    const rel = relativeToHome(opts.override, home);
    const top = rel?.split("/")[0];
    const tccWarning =
      top && TCC_PROTECTED.has(top)
        ? `“${top}” is a protected macOS folder — the app may be blocked from syncing it until you grant access in System Settings.`
        : undefined;
    const plan: FolderPlan = { name: basename(opts.override), root: opts.override, tccWarning };
    if (exists(opts.override) && isReclaimable(opts.override)) plan.reclaim = true;
    return plan;
  }

  const base = opts.base ?? join(home, "Treehouse");
  const name = sanitizeFolderName(workspaceName);
  let finalName = name;
  let candidate = join(base, finalName);
  let n = 2;
  while (exists(candidate)) {
    // The workspace's own earlier folder is the answer, not a collision to step
    // around — stepping around it is what produced "<Name> 2".
    if (isReclaimable(candidate)) return { name: finalName, root: candidate, reclaim: true };
    // An empty, unlinked directory is not a collision either — typically the one an
    // abandoned setup made. Stepping around it is the other road to "<Name> 2".
    if (isUnusedEmpty(candidate)) return { name: finalName, root: candidate };
    finalName = `${name} ${n}`;
    candidate = join(base, finalName);
    n += 1;
  }
  return { name: finalName, root: candidate };
}
/**
 * The files in a folder being picked back up that were never part of the
 * workspace: present on disk, absent from the sync baseline it kept when syncing
 * stopped.
 *
 * Reclaiming a folder is only safe for the workspace's OWN files. Anything that
 * landed in the folder after syncing stopped — the user's unrelated documents,
 * most dangerously — would otherwise be uploaded to everyone in the workspace by
 * the first reconcile. These are the files the user has to agree to share. With
 * no baseline at all, every file is listed.
 */
export function filesOutsideBaseline(localFiles: string[], baseline: Iterable<string>): string[] {
  const known = new Set(baseline);
  return localFiles.filter((f) => !known.has(f)).sort();
}

/** A short, human list of paths for a dialog: the first few, then "…and N more". */
export function summarizePaths(paths: string[], max = 5): string {
  const shown = paths.slice(0, max).map((p) => `• ${p}`);
  if (paths.length > max) shown.push(`…and ${paths.length - max} more`);
  return shown.join("\n");
}