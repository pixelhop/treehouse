import type { TrustedOrigins } from "../origins";
import { DeviceGrantExpiredError, WorkspaceMismatchError } from "../auth";
import type { FolderPlan } from "./folder";

// The onboarding state machine (origin R1–R4; F1/F2; AE1/AE5). Explicit and
// RESUMABLE: a relaunch mid-flow lands on the right screen, never the splash, and
// never past the grant with no key (a keyless link is impossible). The step
// ordering + resume computation + error recovery are the testable core here; the
// driver delegates every side effect (webview, fs, device flow, daemon) to an
// injected `OnboardingEffects` so the logic runs without an Electron runtime.
//
// Order (KTD): trust-on-first-use (non-default origin) → sign-in (webview) →
// WORKSPACE → FOLDER before the grant → device grant (writes the key straight into
// the folder) → start sync. Folder-before-grant means poll-approval writes the key
// into a real folder atomically — no in-memory key custody, and resume needs no key
// persistence.
//
// The workspace step sits BEFORE the folder step so the folder can be named after
// the workspace it actually syncs. Previously the folder was created first, which on
// the create-workspace path (no preselected id) left `workspaceName` undefined and
// named every folder the literal "Workspace" — then "Workspace 2", "Workspace 3" on
// collision. Moving the CHOICE earlier fixes that at the root; the key write stays
// exactly where it was, so the no-in-memory-custody property is untouched.

/**
 * The user dismissed the folder picker. Not a failure: they said "not now", so
 * the flow ends quietly — no "Setup didn't finish" dialog, no Retry — and nothing
 * is created. (Cancel used to fall back to the default folder, which meant the
 * button that looks like "stop" created a folder and started syncing anyway.)
 */
export class FolderPickCancelledError extends Error {
  constructor() {
    super("Folder selection was cancelled.");
    this.name = "FolderPickCancelledError";
  }
}

export type Step =
  | "trust"
  | "signin"
  | "workspace"
  | "folder"
  | "grant"
  | "starting"
  | "syncing"
  | "error";

export interface OnboardingContext {
  /** The app origin (from deep link / paste / default). */
  appOrigin: string;
  /** The API origin resolved from the well-known descriptor (U4). */
  apiOrigin?: string;
  /** Preselected workspace from invite/deep-link context (F1). Absent for the
   * create-workspace path (F2), where the grant defines it. */
  workspaceId?: string;
  /** Display name used for the folder (resolved after sign-in). */
  workspaceName?: string;
  /** Invite token carried by the deep link (informational — accept already
   * happened in the browser). */
  inviteToken?: string;
  /** The created local folder. */
  folderRoot?: string;
  /** A TCC-protected-path warning surfaced by the folder step. */
  folderWarning?: string;
  /** The minted key's id, recorded for link attribution + later revocation. */
  keyId?: string;
  /** Re-auth: force a fresh grant even if the folder already holds a (now
   * revoked) key — used by the menubar's "Re-authenticate" for an auth-lost folder. */
  forceGrant?: boolean;
  /** Human-readable error for the error step. */
  error?: string;
  /** The error step was reached because the user chose to stop (cancelled the
   * folder picker), not because something broke — end without offering Retry. */
  cancelledByUser?: boolean;
  /** Where a retry from the error step resumes. */
  recoverTo?: Step;
}

export interface OnboardingState {
  step: Step;
  ctx: OnboardingContext;
}

/** Observable, on-disk facts used to resume after a relaunch. */
export interface ResumeFacts {
  /** Default origin OR an already-linked server → no TOFU. */
  originTrusted: boolean;
  /** The workspace-window partition already has an authenticated session. */
  signedIn: boolean;
  /** A workspace has been chosen, or was preselected by an invite / deep link.
   * Derived from the persisted context, which already carries `workspaceId` — so
   * resuming mid-workspace-step needs no new persisted field. */
  workspaceChosen: boolean;
  /** The target folder was created. */
  folderExists: boolean;
  /** The folder has .treehouse/config.json with a key (the grant completed). */
  configPresent: boolean;
  /** links.json already registers the folder. */
  linkRegistered: boolean;
}

/**
 * Where a fresh or relaunched flow resumes. Never lands on the splash while work
 * is half-done; never returns a step past the grant unless a key already exists on
 * disk (so no abandonment point leaves an orphaned key, and no link is ever
 * registered without a key).
 */
export function entryStep(facts: ResumeFacts): Step {
  if (!facts.originTrusted) return "trust";
  if (!facts.signedIn) return "signin";
  // Before the folder: a folder can't be named until its workspace is known. An
  // invite/deep-link flow arrives with the workspace preselected, so this clause
  // falls straight through for F1/F3 and only stops the create path (F2).
  //
  // `configPresent` short-circuits it: once the grant has written a key, that
  // config NAMES the workspace, so the choice is settled no matter what the resume
  // record says. Without this, a record written before the workspace step existed
  // resumes backwards — re-asking for a workspace a key was already minted for.
  if (!facts.workspaceChosen && !facts.configPresent) return "workspace";
  if (!facts.folderExists) return "folder";
  if (!facts.configPresent) return "grant";
  if (!facts.linkRegistered) return "starting";
  return "syncing";
}

export type OnboardingEvent =
  | { type: "trustConfirmed" }
  | { type: "trustDeclined" }
  | { type: "signedIn"; apiOrigin: string }
  | { type: "workspaceChosen"; workspaceId: string; workspaceName: string }
  | { type: "folderReady"; plan: FolderPlan }
  | { type: "granted"; keyId?: string; workspaceId: string }
  | { type: "started" }
  | { type: "fail"; message: string; recoverTo: Step; byUser?: boolean }
  | { type: "retry" };

/**
 * Pure transition function. Unknown (step, event) pairs are a no-op so a stray
 * event can never derail the flow.
 */
export function reduce(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  const { step, ctx } = state;

  if (event.type === "fail") {
    return {
      step: "error",
      ctx: {
        ...ctx,
        error: event.message,
        recoverTo: event.recoverTo,
        cancelledByUser: event.byUser === true ? true : undefined,
      },
    };
  }
  if (event.type === "retry") {
    if (step !== "error") return state;
    return {
      step: ctx.recoverTo ?? "trust",
      ctx: { ...ctx, error: undefined, cancelledByUser: undefined },
    };
  }

  switch (step) {
    case "trust":
      if (event.type === "trustConfirmed") return { step: "signin", ctx };
      if (event.type === "trustDeclined") {
        return {
          step: "error",
          ctx: { ...ctx, error: "Connection cancelled.", recoverTo: "trust" },
        };
      }
      return state;
    case "signin":
      if (event.type === "signedIn") {
        return { step: "workspace", ctx: { ...ctx, apiOrigin: event.apiOrigin } };
      }
      return state;
    case "workspace":
      if (event.type === "workspaceChosen") {
        return {
          step: "folder",
          ctx: {
            ...ctx,
            workspaceId: event.workspaceId,
            workspaceName: event.workspaceName,
          },
        };
      }
      return state;
    case "folder":
      if (event.type === "folderReady") {
        return {
          step: "grant",
          ctx: {
            ...ctx,
            folderRoot: event.plan.root,
            workspaceName: event.plan.name,
            folderWarning: event.plan.tccWarning,
          },
        };
      }
      return state;
    case "grant":
      if (event.type === "granted") {
        return {
          step: "starting",
          ctx: { ...ctx, keyId: event.keyId, workspaceId: event.workspaceId },
        };
      }
      return state;
    case "starting":
      if (event.type === "started") return { step: "syncing", ctx };
      return state;
    default:
      return state;
  }
}

/** Side effects the driver delegates to (Electron/fs/device-flow/daemon glue). */
export interface OnboardingEffects {
  /** Present the TOFU confirmation in shell chrome; resolve true to continue. */
  confirmTrust(ctx: OnboardingContext): Promise<boolean>;
  /** Fetch + validate the well-known descriptor → API origin, or null. */
  resolveApiOrigin(ctx: OnboardingContext): Promise<string | null>;
  /** True if the partition already carries an authenticated session (skip sign-in). */
  hasSession(ctx: OnboardingContext): Promise<boolean>;
  /** Drive webview sign-in; resolve once authenticated. `signal` aborts a poll
   * loop when the flow is superseded. */
  signIn(ctx: OnboardingContext, origins: TrustedOrigins, signal?: AbortSignal): Promise<void>;
  /** SETTLE the workspace — the step has two shapes behind one effect:
   *  - `ctx.workspaceId` already set (invite / deep link): resolve its NAME from the
   *    API and return both. No prompt; the workspace was decided elsewhere.
   *  - no workspace yet (create path): let the user pick or create one.
   * Either way the folder step downstream is guaranteed a real name, which is what
   * makes the `"Workspace"` fallback unreachable.
   * `signal` aborts the wait when the flow is superseded. The shell implements the
   * prompting shape by loading a web step and OBSERVING its sentinel navigation — it
   * never exposes an IPC channel to remote content (see security.ts). */
  chooseWorkspace(
    ctx: OnboardingContext,
    origins: TrustedOrigins,
    signal?: AbortSignal,
  ): Promise<{ workspaceId: string; workspaceName: string }>;
  /** Plan + create the local folder (real fs); return the plan. */
  createFolder(ctx: OnboardingContext): Promise<FolderPlan>;
  /** Undo `createFolder` for a run that was superseded before it could use the
   * folder. MUST be a no-op unless the directory is still empty — by the time this
   * runs the user may have chosen an existing folder of their own, and removing
   * that would delete their files. Optional so tests can omit it. */
  discardEmptyFolder?(root: string): Promise<void>;
  /** Run the device grant (writes the key into the folder atomically). `signal`
   * aborts the approval poll when the flow is superseded. */
  runGrant(
    ctx: OnboardingContext,
    origins: TrustedOrigins,
    signal?: AbortSignal,
  ): Promise<{ keyId?: string; workspaceId: string }>;
  /** Register the app-attributed link + ensure the daemon is running + reload. */
  startSync(ctx: OnboardingContext): Promise<void>;
  /** Open the (already-authenticated) workspace window. */
  openWorkspace(ctx: OnboardingContext, origins: TrustedOrigins): void;
  /** Optional transition hook (UI updates / tests). */
  onTransition?(state: OnboardingState): void;
}

/**
 * Drives the machine from a start state to `syncing`, delegating I/O to effects
 * and mapping their results/errors onto pure transitions. Pauses at `error`
 * (awaiting an external `retry`) and returns; call `run()` again after `retry`.
 */
export class OnboardingDriver {
  state: OnboardingState;
  private readonly fx: OnboardingEffects;
  private readonly ac = new AbortController();

  constructor(start: OnboardingState, effects: OnboardingEffects) {
    this.state = start;
    this.fx = effects;
  }

  /** Signal effects can watch to abort long polls when the flow is superseded. */
  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** True once `cancel()` was called (the flow was superseded/abandoned). */
  get cancelled(): boolean {
    return this.ac.signal.aborted;
  }

  /** Abort this flow: superseding deep links call this (then await `run()`'s
   * settlement) before starting a rival driver, so two drivers never race the one
   * shared webview and never interleave config/link writes. */
  cancel(): void {
    this.ac.abort();
  }

  private origins(): TrustedOrigins {
    return { app: this.state.ctx.appOrigin, api: this.state.ctx.apiOrigin ?? "" };
  }

  /** Apply an event, notify, and return the new step. */
  dispatch(event: OnboardingEvent): Step {
    this.state = reduce(this.state, event);
    this.fx.onTransition?.(this.state);
    return this.state.step;
  }

  /** Run until `syncing`, `error`, a declined trust, or cancellation. Safe to call
   * again after dispatching `retry`. */
  async run(): Promise<Step> {
    // A relaunch may re-enter at a later step, but the descriptor still needs
    // resolving before any step that talks to the API.
    for (;;) {
      // Bail out cleanly the moment the flow is superseded — never advance a
      // cancelled driver into another config/link write.
      if (this.cancelled) return this.state.step;
      // `grant` and `starting` map their own failures onto the error step; the
      // trust/signin/folder effects were left unguarded, and they throw for real:
      // waitForSession rejects with "sign-in timed out" after 5 minutes,
      // fetchDescriptor rejects on network failure, and createFolder's mkdirSync
      // throws on EACCES/EPERM. An escaping rejection propagates out of run() into
      // resumeOnboarding's `await run`, so the user gets no error UI and no retry
      // while activeDriver/activeRun are never cleared — isOnboarding() would stay
      // true for the rest of the session. Map any unexpected throw onto the
      // recoverable error step, offering a retry of whichever step raised it.
      const stepAtEntry = this.state.step;
      try {
        switch (this.state.step) {
          case "trust": {
            const ok = await this.fx.confirmTrust(this.state.ctx);
            this.dispatch(ok ? { type: "trustConfirmed" } : { type: "trustDeclined" });
            if (!ok) return this.state.step;
            break;
          }
          case "signin": {
            // Resolve the API origin (validated descriptor) before any API/webview
            // work. TOFU has already gated this for non-default origins.
            const api =
              this.state.ctx.apiOrigin ?? (await this.fx.resolveApiOrigin(this.state.ctx));
            if (!api) {
              this.dispatch({
                type: "fail",
                message: "That doesn't look like a Treehouse server.",
                recoverTo: "trust",
              });
              return this.state.step;
            }
            this.state.ctx.apiOrigin = api;
            // Skip sign-in when a session already exists (AE5 / second workspace);
            // the grant, however, always runs.
            if (!(await this.fx.hasSession(this.state.ctx))) {
              await this.fx.signIn(this.state.ctx, this.origins(), this.signal);
            }
            if (this.cancelled) return this.state.step;
            this.dispatch({ type: "signedIn", apiOrigin: api });
            break;
          }
          case "workspace": {
            // An invite/deep-link flow already knows its workspace; the step is
            // skipped by entryStep, but guard here too so a direct dispatch into
            // `workspace` with a preselected id can't strand the flow waiting on a
            // choice that was already made.
            if (this.state.ctx.workspaceId && this.state.ctx.workspaceName) {
              this.dispatch({
                type: "workspaceChosen",
                workspaceId: this.state.ctx.workspaceId,
                workspaceName: this.state.ctx.workspaceName,
              });
              break;
            }
            const chosen = await this.fx.chooseWorkspace(
              this.state.ctx,
              this.origins(),
              this.signal,
            );
            if (this.cancelled) return this.state.step;
            this.dispatch({
              type: "workspaceChosen",
              workspaceId: chosen.workspaceId,
              workspaceName: chosen.workspaceName,
            });
            break;
          }
          case "folder": {
            let plan: FolderPlan;
            try {
              plan = await this.fx.createFolder(this.state.ctx);
            } catch (e) {
              if (this.cancelled) return this.state.step;
              if (e instanceof FolderPickCancelledError) {
                this.dispatch({
                  type: "fail",
                  message: e.message,
                  recoverTo: "folder",
                  byUser: true,
                });
                return this.state.step;
              }
              throw e;
            }
            // Every other awaiting case re-checks after its await; this one didn't.
            // Without it a superseded flow still dispatches `folderReady`, which
            // persists a folderRoot for an abandoned run.
            if (this.cancelled) {
              // …and the guard alone is NOT enough. `createFolder` has already run
              // `mkdirSync`, so returning here leaves the directory on disk with
              // nothing pointing at it. The next attempt sees the name taken and
              // plans "<Name> 2" — the suffixed-folder defect this whole flow was
              // written to remove, reintroduced through the supersede path.
              // Only ever discards a directory THIS run just created, and only while
              // it is still empty, so a folder the user already put files in (or
              // pointed us at) is never touched.
              await this.fx.discardEmptyFolder?.(plan.root);
              return this.state.step;
            }
            this.dispatch({ type: "folderReady", plan });
            break;
          }
          case "grant": {
            try {
              const g = await this.fx.runGrant(this.state.ctx, this.origins(), this.signal);
              if (this.cancelled) return this.state.step;
              this.dispatch({ type: "granted", keyId: g.keyId, workspaceId: g.workspaceId });
            } catch (e) {
              if (this.cancelled) return this.state.step;
              if (e instanceof WorkspaceMismatchError) {
                // Re-prompt the grant: the folder + session stand; only the approval
                // was wrong. The mismatched key was already revoked in runDeviceGrant.
                this.dispatch({
                  type: "fail",
                  message: "That approval was for a different workspace. Please try again.",
                  recoverTo: "grant",
                });
              } else if (e instanceof DeviceGrantExpiredError) {
                // The approval expired; return to sign-in with a clear message (the
                // session usually persists, so it falls straight back to the grant).
                this.dispatch({
                  type: "fail",
                  message: "The approval expired. Please sign in and approve again.",
                  recoverTo: "signin",
                });
              } else {
                this.dispatch({
                  type: "fail",
                  message: e instanceof Error ? e.message : "Connecting failed.",
                  recoverTo: "grant",
                });
              }
              return this.state.step;
            }
            break;
          }
          case "starting": {
            // Mirror the "grant" step's error handling: registering the link + nudging
            // the launchd daemon does network + fs + launchctl work and can throw. An
            // uncaught throw here would escape run() and wedge the flow with no error UI
            // and no retry path, so map failures onto the recoverable error step.
            try {
              await this.fx.startSync(this.state.ctx);
            } catch (e) {
              if (this.cancelled) return this.state.step;
              this.dispatch({
                type: "fail",
                message: e instanceof Error ? e.message : "Couldn't start syncing.",
                recoverTo: "starting",
              });
              return this.state.step;
            }
            if (this.cancelled) return this.state.step;
            this.dispatch({ type: "started" });
            break;
          }
          case "syncing": {
            this.fx.openWorkspace(this.state.ctx, this.origins());
            return this.state.step;
          }
          default:
            return this.state.step; // error — awaits external retry
        }
      } catch (e) {
        // A cancelled driver stays silent: the supersede path owns the UI now.
        if (this.cancelled) return this.state.step;
        this.dispatch({
          type: "fail",
          message: e instanceof Error ? e.message : "Setup failed.",
          recoverTo: stepAtEntry,
        });
        return this.state.step;
      }
    }
  }
}