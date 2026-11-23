import { existsSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig } from "cli/src/config";
import { type Link, loadLinks } from "cli/src/links-store";
import { dialog, session } from "electron";
import { readFolderConfig } from "../folder-config";
import { DEFAULT_APP_ORIGIN } from "../origins";
import { WORKSPACE_PARTITION } from "../security";
import { loadInWorkspaceWindow } from "../windows";
import { createOnboardingEffects } from "./effects";
import { track } from "../analytics";
import { createJournal, type OnboardingJournal } from "./journal";
import {
  entryStep,
  OnboardingDriver,
  type OnboardingContext,
  type OnboardingState,
  type Step,
} from "./machine";
import {
  clearOnboarding,
  computeFacts,
  contextFrom,
  loadOnboarding,
  type PersistedOnboarding,
  rememberTrustedOrigin,
  saveOnboarding,
  trustedOrigins,
} from "./state";

// Orchestrates the onboarding machine against the real effects and the resume
// persistence. Electron/fs-bound (not unit-tested — the machine, folder, auth, and
// resume logic underneath all are). Exposes the active-flow state so the deep-link
// router (U9) can apply its supersede rule.

/**
 * Diagnostic trail (R12). Everything below CLEARS the resume record on the way out
 * — on completion and on abandonment alike — so without this a failed run left no
 * evidence at all beyond whichever files happened to exist on disk. It hangs off
 * the machine's existing `onTransition` hook, so recording costs no new call sites
 * inside the flow, and it swallows its own errors: a journal that can't be written
 * must never break onboarding.
 */
const fileJournal = createJournal();

/**
 * The journal, plus an analytics event for the same transition.
 *
 * Wrapping here rather than inside `createJournal` keeps the journal a pure,
 * disk-only unit that the tests can exercise without a network client, and
 * gives analytics the same single chokepoint the journal already earned: every
 * start, every step transition and every outcome passes through `record`, so
 * there are no new call sites inside the flow to keep in sync.
 *
 * Only the STEP NAME and the note go out — never the context, which carries the
 * app origin, a workspace id, a key id and an invite token. `journal.record`
 * still gets the full state, because that file stays on the user's own disk.
 */
const journal: OnboardingJournal = {
  record(kind, state, note) {
    fileJournal.record(kind, state, note);
    track("onboarding_step", { kind, step: state.step, note });
  },
};

let activeDriver: OnboardingDriver | null = null;
/** The in-flight run of `activeDriver`, so a supersede can await its settlement. */
let activeRun: Promise<Step> | null = null;

export function isOnboarding(): boolean {
  return activeDriver !== null;
}

/**
 * If the running flow is only FINISHING — the grant is done and it is registering
 * the folder — wait for it and return true. Returns false for a flow that still
 * needs the user (sign-in, a choice, a folder, an approval).
 *
 * The approval page shows success as soon as its own approve call returns, which
 * is a beat before the shell's poll notices and registers the link. The page then
 * offers the account's other workspaces; a click in that beat used to be refused
 * as "a flow is already running", so the first "Sync" press appeared to do nothing.
 */
export async function awaitFinishingFlow(): Promise<boolean> {
  const driver = activeDriver;
  if (!driver) return true;
  if (!["grant", "starting", "syncing"].includes(driver.state.step)) return false;
  await activeRun?.catch(() => {});
  // The grant step can still need the user (approval not yet given) — only treat
  // it as finishing if it actually ended.
  return activeDriver === null;
}

/**
 * Serializes every entry point that installs an `activeDriver`. The supersede rule
 * reads `activeDriver` and reassigns it several awaits later (cancel → await the
 * old run → isSignedIn → loadLinks → assign). A second entry landing inside that
 * window sees `activeDriver === null`, skips the cancel, and installs a rival
 * driver: two live drivers then race the one shared webview and interleave
 * config/link writes — exactly what the supersede rule exists to prevent. Chaining
 * the entry points onto one promise makes check-then-assign atomic between them.
 */
let entryQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = entryQueue.then(task, task);
  // The queue itself must never reject, or every later entry inherits the failure.
  entryQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Abort the in-flight driver and await its settlement before installing another. */
async function cancelActive(): Promise<void> {
  if (!activeDriver) return;
  activeDriver.cancel();
  await activeRun?.catch(() => {}); // let the superseded driver settle
  activeDriver = null;
  activeRun = null;
}

/** Whether the partition already carries a better-auth session for an origin. */
async function isSignedIn(apiOrigin?: string): Promise<boolean> {
  if (!apiOrigin) return false;
  try {
    const cookies = await session
      .fromPartition(WORKSPACE_PARTITION)
      .cookies.get({ url: apiOrigin });
    return cookies.some((c) => c.name.includes("session_token") && c.value.length > 0);
  } catch {
    return false;
  }
}

/** Mirror the machine's live context into the resume record after each step. */
function persistProgress(state: OnboardingState): void {
  const c = state.ctx;
  saveOnboarding({
    appOrigin: c.appOrigin,
    apiOrigin: c.apiOrigin,
    workspaceId: c.workspaceId,
    workspaceName: c.workspaceName,
    inviteToken: c.inviteToken,
    folderRoot: c.folderRoot,
  });
}

/**
 * Begin (or restart) onboarding for a given entry context. A supersede (a fresh
 * deep link mid-flow) must (a) abort + await the active driver so two drivers never
 * race the one shared webview, and (b) NOT graft the new target onto the old flow's
 * folder/API origin: the router's entry only carries appOrigin/workspaceId/token, so
 * a blind `{...prior, ...entry}` merge keeps the OLD flow's folderRoot/apiOrigin/
 * workspaceName. Merge only when the entry targets the SAME flow; otherwise start
 * from a clean record.
 */
export function startOnboarding(entry: PersistedOnboarding): Promise<Step> {
  // The queue covers only cancel-and-install. The run itself — which can sit on an
  // open sign-in or workspace step for as long as the user likes — is awaited
  // OUTSIDE it; holding the queue for the whole flow meant a superseding link
  // waited behind the very flow it was meant to replace, indefinitely once those
  // steps stopped timing out.
  return serialized(() => startOnboardingInner(entry)).then((r) => r.done);
}

/** An installed flow: the queue releases once this resolves; `done` settles when
 * the flow itself ends. */
interface Installed {
  done: Promise<Step>;
}

async function startOnboardingInner(entry: PersistedOnboarding): Promise<Installed> {
  await cancelActive();
  const prior = loadOnboarding();
  const sameFlow =
    prior != null &&
    prior.appOrigin === entry.appOrigin &&
    (prior.workspaceId ?? "") === (entry.workspaceId ?? "");
  saveOnboarding(sameFlow ? { ...prior, ...entry } : entry);
  // Already inside the queue — call the inner form, or this would await itself.
  return resumeOnboardingInner();
}

/** Resume onboarding from the persisted record, landing on the right step. */
export function resumeOnboarding(): Promise<Step> {
  return serialized(() => resumeOnboardingInner()).then((r) => r.done);
}

async function resumeOnboardingInner(): Promise<Installed> {
  const persisted = loadOnboarding();
  if (!persisted) return { done: Promise.resolve("syncing") }; // nothing to resume

  const facts = computeFacts(persisted, {
    signedIn: await isSignedIn(persisted.apiOrigin),
    trusted: trustedOrigins(),
    folderExists: (r) => existsSync(r),
    folderConfig: readFolderConfig,
    linkRegistered: (r) => loadLinks().some((l) => l.root === r),
  });

  // Hydrate the key id from the folder's config: it is never persisted (config is
  // its only sink), so a resume re-entering past the grant (crash between grant and
  // link registration) would otherwise register an app link WITHOUT a keyId — and
  // sign-out, which keys off the recorded id, would then miss the folder.
  const keyId = persisted.folderRoot ? readFolderConfig(persisted.folderRoot)?.keyId : undefined;

  const start: OnboardingState = { step: entryStep(facts), ctx: contextFrom(persisted, { keyId }) };
  // Record the entry step before anything runs: a flow abandoned by quitting the
  // app never dispatches a transition, and "started at grant, nothing after" is
  // still a far better trail than silence.
  journal.record("start", start);
  const driver = new OnboardingDriver(start, {
    ...createOnboardingEffects(),
    onTransition: (state) => {
      persistProgress(state);
      journal.record("step", state);
    },
  });
  activeDriver = driver;
  const run = driver.run();
  activeRun = run;
  return { done: finishFlow(driver, run, persisted) };
}

/** Everything after the driver's first run settles: retries, outcome, cleanup. */
async function finishFlow(
  driver: OnboardingDriver,
  run: Promise<Step>,
  persisted: PersistedOnboarding,
): Promise<Step> {
  let step = await run;

  // A superseding flow cancelled this driver — it now owns the record; leave quietly.
  if (driver.cancelled) {
    journal.record("outcome", driver.state, "superseded by another flow");
    if (activeDriver === driver) {
      activeDriver = null;
      activeRun = null;
    }
    return step;
  }

  // Error handling: a declined/failed TRUST (recoverTo "trust") is an explicit
  // abandonment — clear the (possibly attacker-supplied) record so it never hijacks
  // the next launch. Any other error offers a native Retry.
  while (step === "error") {
    if (driver.state.ctx.recoverTo === "trust") break; // abandon → cleared below
    if (driver.state.ctx.cancelledByUser) break; // they said "not now" — no Retry nag
    const retry = await promptRetry(driver.state.ctx.error);
    // The Retry dialog can sit open while a deep link supersedes this flow. By
    // the time it closes the resume record belongs to the NEW flow: retrying
    // would persist this flow's context over it, and Cancel would clear it.
    if (driver.cancelled) {
      journal.record("outcome", driver.state, "superseded by another flow");
      if (activeDriver === driver) {
        activeDriver = null;
        activeRun = null;
      }
      return step;
    }
    if (!retry) break;
    driver.dispatch({ type: "retry" });
    // Track the re-run too, so a supersede that arrives during it awaits it.
    const rerun = driver.run();
    if (activeDriver === driver) activeRun = rerun;
    step = await rerun;
    if (driver.cancelled) {
      journal.record("outcome", driver.state, "superseded by another flow");
      if (activeDriver === driver) {
        activeDriver = null;
        activeRun = null;
      }
      return step;
    }
  }

  if (step === "syncing") {
    journal.record("outcome", driver.state, "completed");
    rememberTrustedOrigin(persisted.appOrigin);
    clearOnboarding();
  } else if (step === "error") {
    // Abandoned (declined trust or the user dismissed Retry): don't let the record
    // re-drive onboarding on every launch — clear it so bootstrap falls through.
    // The journal outlives that clear — it is the ONLY thing that does.
    const byUser = driver.state.ctx.cancelledByUser === true;
    journal.record(
      "outcome",
      driver.state,
      byUser
        ? "cancelled by the user — resume record cleared"
        : "abandoned — resume record cleared",
    );
    clearOnboarding();
    // A cancelled folder pick leaves the window on the "where should it live?"
    // step. Take them to the workspace they were setting up — signed in, usable,
    // and one "Sync a folder" click from trying again.
    if (byUser) leaveForWorkspace(driver.state.ctx);
  }
  if (activeDriver === driver) {
    activeDriver = null;
    activeRun = null;
  }
  return step;
}

/** Move the window off an abandoned onboarding step onto the workspace itself. */
function leaveForWorkspace(ctx: OnboardingContext): void {
  if (!ctx.apiOrigin) return;
  const path = ctx.workspaceId ? `/w/${encodeURIComponent(ctx.workspaceId)}` : "/";
  loadInWorkspaceWindow(new URL(path, ctx.appOrigin).toString(), {
    app: ctx.appOrigin,
    api: ctx.apiOrigin,
  });
}

/** Native Retry/Cancel dialog for a failed onboarding step. Returns true on Retry. */
async function promptRetry(message?: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "error",
    buttons: ["Cancel", "Retry"],
    defaultId: 1,
    cancelId: 0,
    title: "Treehouse setup",
    message: "Setup didn't finish",
    detail: message ?? "Something went wrong during setup.",
  });
  return response === 1;
}

/**
 * Re-run just the device grant for an auth-lost folder (menubar "Re-authenticate").
 * The folder + link already exist; only the key was revoked, so this starts at the
 * grant step with `forceGrant` (bypassing the config-present short-circuit), mints
 * a fresh key into the folder, and re-registers it. The approval page handles
 * web sign-in in the webview if the session also lapsed.
 */
export function reauthenticate(link: Pick<Link, "root" | "workspaceId">): Promise<Step> {
  return serialized(() => reauthenticateInner(link)).then((r) => r.done);
}

async function reauthenticateInner(link: Pick<Link, "root" | "workspaceId">): Promise<Installed> {
  // Fail fast on an unreadable config. Swallowing the error left apiOrigin
  // undefined, so `origins()` yielded `api: ""` and the device grant ran against
  // an empty base — a confusing fetch failure several steps later instead of a
  // clear message here.
  let apiOrigin: string;
  try {
    apiOrigin = loadConfig(link.root).apiBase;
  } catch {
    throw new Error(
      `Can't re-authenticate ${basename(link.root)}: its .treehouse/config.json is missing or unreadable.`,
    );
  }
  // Use the origin this folder was actually connected through (recorded on the
  // link at registration). Falling back to `trustedOrigins()[0]` is arbitrary —
  // for a user with more than one connected server it loads the approval page on
  // the wrong instance. Links created before `appOrigin` existed have none, so the
  // old behaviour stays as the last resort.
  const recorded = loadLinks().find((l) => l.root === link.root)?.appOrigin;
  const appOrigin = recorded ?? trustedOrigins()[0] ?? DEFAULT_APP_ORIGIN;
  const ctx: OnboardingContext = {
    appOrigin,
    apiOrigin,
    workspaceId: link.workspaceId,
    workspaceName: basename(link.root),
    folderRoot: link.root,
    forceGrant: true,
  };
  // Same supersede rule as startOnboarding: a menubar re-auth fired during an
  // onboarding flow must retire that driver, not run a second one beside it.
  await cancelActive();
  const start: OnboardingState = { step: "grant", ctx };
  journal.record("start", start, "re-authenticate");
  const driver = new OnboardingDriver(start, {
    ...createOnboardingEffects(),
    onTransition: (state) => journal.record("step", state),
  });
  activeDriver = driver;
  const run = driver.run();
  activeRun = run;
  return { done: finishReauth(driver, run) };
}

async function finishReauth(driver: OnboardingDriver, run: Promise<Step>): Promise<Step> {
  const step = await run;
  // Close the record, the same way `resumeOnboardingInner` does. Without this a
  // re-auth showed a "start" entry and its transitions but never how it ended, so
  // reading the journal you could not tell a successful re-grant from one the user
  // abandoned or one a later flow superseded — which is precisely the question the
  // journal exists to answer.
  journal.record(
    "outcome",
    driver.state,
    driver.cancelled
      ? "superseded by another flow"
      : step === "syncing"
        ? "re-authenticated"
        : `ended at ${step}`,
  );
  if (activeDriver === driver) {
    activeDriver = null;
    activeRun = null;
  }
  return step;
}