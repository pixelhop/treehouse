import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, ensureAppDir } from "cli/src/paths";
import { needsTrustPrompt } from "../origins";
import type { OnboardingContext, ResumeFacts } from "./machine";

// Resume persistence for the onboarding machine. A relaunch mid-flow must land on
// the right screen, so the IN-PROGRESS context (which origin/workspace/folder) is
// persisted — but NEVER the key (the key lives only in the folder's config, per
// the no-in-memory-custody rule). Also records which app origins are trusted, so a
// return visit to an already-linked server skips the TOFU prompt.

export interface PersistedOnboarding {
  appOrigin: string;
  apiOrigin?: string;
  workspaceId?: string;
  workspaceName?: string;
  inviteToken?: string;
  folderRoot?: string;
}

const onboardingPath = (): string => join(appDir(), "onboarding.json");
const trustedPath = (): string => join(appDir(), "trusted-origins.json");

function atomicWrite(path: string, data: string): void {
  ensureAppDir();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Persist (or update) the in-progress onboarding context — key excluded. */
export function saveOnboarding(state: PersistedOnboarding): void {
  atomicWrite(onboardingPath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function loadOnboarding(): PersistedOnboarding | null {
  try {
    return JSON.parse(readFileSync(onboardingPath(), "utf8")) as PersistedOnboarding;
  } catch {
    return null;
  }
}

/** Clear the in-progress onboarding record (call on completion / abandonment). */
export function clearOnboarding(): void {
  rmSync(onboardingPath(), { force: true });
}

/** App origins the user has previously connected — trusted without a TOFU prompt. */
export function trustedOrigins(): string[] {
  try {
    const list = JSON.parse(readFileSync(trustedPath(), "utf8")) as unknown;
    return Array.isArray(list) ? (list.filter((s) => typeof s === "string") as string[]) : [];
  } catch {
    return [];
  }
}

/** Remember an app origin as trusted (after a successful connect). */
export function rememberTrustedOrigin(origin: string): void {
  const set = new Set(trustedOrigins());
  set.add(origin);
  atomicWrite(trustedPath(), `${JSON.stringify([...set], null, 2)}\n`);
}

/** The observable disk/session inputs the resume computation reads. Injected so
 * the fact computation stays pure and unit-testable. */
export interface FactInputs {
  /** The partition already carries an authenticated session. */
  signedIn: boolean;
  /** App origins trusted without TOFU (default origin is always trusted). */
  trusted: string[];
  /** Does the folder exist on disk? */
  folderExists: (root: string) => boolean;
  /** The folder's config (key id + workspace id), or null if the grant hasn't
   * completed. The workspace id is checked against the flow's target so a config
   * left by a DIFFERENT workspace's flow doesn't masquerade as this one's. */
  folderConfig: (root: string) => { keyId?: string; workspaceId?: string } | null;
  /** Is the folder already registered in links.json? */
  linkRegistered: (root: string) => boolean;
}

/**
 * Pure resume computation: turn a persisted context + observable inputs into the
 * facts `entryStep` consumes. Steps whose folder isn't known yet report false
 * (so the flow never claims a folder/key exists before one does — a keyless link
 * is impossible). When the flow has a target workspace, a config that doesn't NAME
 * that workspace counts as NOT present, so neither a superseded/stale folder nor a
 * partially-written config short-circuits the grant for a different workspace.
 */
export function computeFacts(persisted: PersistedOnboarding, inputs: FactInputs): ResumeFacts {
  const root = persisted.folderRoot;
  const cfg = root ? inputs.folderConfig(root) : null;
  // When the flow HAS a target workspace, the config must name it. Treating a
  // config with a keyId but no workspaceId as a match (folder-config.ts is
  // partial-tolerant, so that shape is reachable) would skip the grant and
  // register a link around a key whose workspace was never verified.
  const workspaceMatches =
    persisted.workspaceId === undefined || cfg?.workspaceId === persisted.workspaceId;
  return {
    originTrusted: !needsTrustPrompt(persisted.appOrigin, inputs.trusted),
    signedIn: inputs.signedIn,
    // The workspace step is settled once the context names a workspace — whether
    // the user picked one, created one, or an invite/deep link preselected it. The
    // NAME matters as much as the id: the folder step is named from it, and
    // resuming with an id but no name would reintroduce the "Workspace" fallback
    // this step exists to eliminate.
    workspaceChosen: !!persisted.workspaceId && !!persisted.workspaceName,
    folderExists: root ? inputs.folderExists(root) : false,
    configPresent: !!cfg?.keyId && workspaceMatches,
    linkRegistered: root ? inputs.linkRegistered(root) : false,
  };
}

/** Build the machine's starting context from a persisted record. The key id is
 * NEVER persisted (it lives only in the folder's config) — so a resume that
 * re-enters past the grant must hydrate it from disk (`keyId`), or a crash between
 * the grant and link registration would strip it and sign-out could miss the folder. */
export function contextFrom(
  persisted: PersistedOnboarding,
  extra: { keyId?: string } = {},
): OnboardingContext {
  return {
    appOrigin: persisted.appOrigin,
    apiOrigin: persisted.apiOrigin,
    workspaceId: persisted.workspaceId,
    workspaceName: persisted.workspaceName,
    inviteToken: persisted.inviteToken,
    folderRoot: persisted.folderRoot,
    keyId: extra.keyId,
  };
}