import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { app, type BrowserWindow, dialog, session } from "electron";
import { runDeviceGrant } from "../auth";
import {
  buildApprovalUrl,
  buildFolderStepUrl,
  buildWorkspaceStepUrl,
  parseWorkspaceSentinel,
} from "../contract";
import { loadLinks, WorkspaceAlreadyLinkedError } from "cli/src/links-store";
import { stableDaemonPath } from "cli/src/paths";
import { startSyncFolder } from "../daemon";
import { fetchDescriptor } from "../descriptor";
import { readFolderConfig } from "../folder-config";
import type { TrustedOrigins } from "../origins";
import { WORKSPACE_PARTITION } from "../security";
import { revokeFolderKey } from "../signout";
import {
  awaitNavigationSignal,
  getWorkspaceWindow,
  loadInWorkspaceWindow,
  openWorkspaceWindow,
} from "../windows";
import {
  checkOverride,
  filesOutsideBaseline,
  type FolderPlan,
  planFolder,
  summarizePaths,
} from "./folder";
import { loadIndex } from "cli/src/index-store";
import { ignored } from "cli/src/sync-core";
import {
  FolderPickCancelledError,
  type OnboardingContext,
  type OnboardingEffects,
} from "./machine";
import { rememberTrustedOrigin } from "./state";

// The REAL Electron/fs/HTTP wiring behind the onboarding machine's effects. Kept
// out of the machine so the state logic stays unit-testable; this glue is covered
// by the U12 packaged-app checklist. Nothing here is imported by tests.

// Insecure transport (http app origins / http://localhost descriptors) is a DEV
// affordance only. Gate it on `!app.isPackaged` — a packaged build does not set
// NODE_ENV=production, so keying off NODE_ENV would silently relax the https-only
// posture in the shipped app.
const allowInsecure = !app.isPackaged;
const KEY_LABEL = "Treehouse Desktop";

/** The workspace-window partition's cookie jar / credentialed fetch. */
function partitionSession() {
  return session.fromPartition(WORKSPACE_PARTITION);
}

/** True once the better-auth session cookie is present in the partition. */
async function isSignedIn(apiOrigin: string): Promise<boolean> {
  try {
    const cookies = await partitionSession().cookies.get({ url: apiOrigin });
    return cookies.some((c) => c.name.includes("session_token") && c.value.length > 0);
  } catch {
    return false;
  }
}

/** Wait for sign-in to complete in the webview. Aborts early when the onboarding
 * flow is superseded, and fails when the window it is waiting on is closed.
 *
 * Deliberately NO deadline. It used to give up after five minutes with "sign-in
 * timed out" — but a first-run user is exactly the person who wanders off to find
 * a password, reset it, or check an email, and coming back to a "Setup didn't
 * finish" dialog for having been slow is the opposite of a smooth first run. The
 * window being closed is the real "I've stopped" signal; while it is open, waiting
 * is correct. */
async function waitForSession(
  apiOrigin: string,
  win: BrowserWindow,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) return;
    if (await isSignedIn(apiOrigin)) return;
    if (win.isDestroyed()) throw new Error("The sign-in window was closed.");
    await new Promise((r) => setTimeout(r, 750));
  }
}

/** Bring the workspace window forward — the step it is showing needs an answer.
 * A deep link or a menubar click often arrives while another app is in front;
 * a sheet on a window behind the browser reads as "nothing happened". */
function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

/** How long a workspace-name lookup may take before the step gives up. Generous —
 * it is one small request, and the cost of being wrong is a step that appears to
 * hang. */
const WORKSPACE_LOOKUP_MS = 15_000;

/** Resolve a workspace's display name via the authed partition session — a
 * membership-checked lookup by id, so it also serves as the authorisation check on
 * an id that arrived from untrusted input (a deep link or a sentinel navigation).
 * Returns undefined on any failure; callers treat that as "no access", NOT as a
 * cue to invent a name. */
async function fetchWorkspaceName(
  apiOrigin: string,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  try {
    // Bounded, and cancellable by the supersede signal. Unbounded, an unreachable
    // server left the workspace step hanging with no step visible and no way out
    // but quitting — and a superseded flow kept its request alive behind the one
    // that replaced it. Any failure (timeout, abort, refusal) lands in the same
    // `undefined`, which callers already treat as "no access" rather than a cue to
    // invent a name.
    const res = await partitionSession().fetch(
      `${apiOrigin}/api/workspaces/${encodeURIComponent(workspaceId)}`,
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(WORKSPACE_LOOKUP_MS)])
          : AbortSignal.timeout(WORKSPACE_LOOKUP_MS),
      },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { name?: unknown };
    return typeof body.name === "string" && body.name.trim() ? body.name : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort current account id (link attribution). */
async function fetchAccountId(apiOrigin: string): Promise<string | undefined> {
  try {
    const res = await partitionSession().fetch(`${apiOrigin}/api/auth/get-session`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { user?: { id?: string } };
    return body.user?.id;
  } catch {
    return undefined;
  }
}

/** Revoke a minted key by id using the partition's cookie session. Throws on a real
 * failure (so the caller's cleanup path logs it); a 404 means already-gone → success. */
async function revokeKey(apiOrigin: string, keyId: string): Promise<void> {
  const res = await partitionSession().fetch(`${apiOrigin}/api/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`revoke failed for ${keyId}: HTTP ${res.status}`);
  }
}

/**
 * Native folder picker, defaulted to the suggested path. Returns the chosen path,
 * or null when the user keeps the default (cancel) — cancelling the picker must
 * fall back to the sensible default, never wedge or abandon onboarding.
 *
 * A chosen folder that already holds files is refused and re-asked: bootstrap sync
 * pushes everything local, so adopting a populated folder would upload unrelated
 * personal documents into a shared workspace.
 */
async function pickFolder(
  suggested: string,
  opts: {
    workspaceName: string;
    parent: BrowserWindow | null;
    isReclaimable: (p: string) => boolean;
  },
): Promise<string | null> {
  for (;;) {
    const options: Electron.OpenDialogOptions = {
      title: `Choose where “${opts.workspaceName}” lives`,
      // macOS shows `message` at the top of the panel — the one place that can
      // say WHICH workspace this is for. The title alone is invisible on a sheet.
      message: `Choose where “${opts.workspaceName}” syncs on this Mac. Treehouse suggests the folder that's selected.`,
      defaultPath: suggested,
      buttonLabel: "Sync here",
      properties: ["openDirectory", "createDirectory"],
    };
    // Attached to the workspace window as a sheet, so it opens in front of it and
    // reads as belonging to the step on screen rather than floating free.
    const { canceled, filePaths } = opts.parent
      ? await dialog.showOpenDialog(opts.parent, options)
      : await dialog.showOpenDialog(options);
    const chosen = filePaths[0];
    // Cancel means cancel. It used to mean "use the default" — so the one button
    // that looks like "not now" created a folder and started syncing anyway.
    if (canceled || !chosen) throw new FolderPickCancelledError();
    if (chosen === suggested) return null;

    const rejection = checkOverride(chosen, {
      isReclaimable: opts.isReclaimable,
      isEmpty: (p) => {
        try {
          return readdirSync(p).filter((e) => e !== ".DS_Store").length === 0;
        } catch {
          // Unreadable (or gone) — treat as unusable rather than empty, so we
          // don't hand the daemon a root it can't scan.
          return false;
        }
      },
    });
    if (rejection === null) return chosen;

    const refusal: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Choose another", "Use the suggested folder"],
      defaultId: 0,
      cancelId: 0,
      title: "That folder isn't empty",
      message: "Pick an empty folder",
      detail:
        `Treehouse uploads everything in the folder you choose, so it has to start empty — otherwise your existing files would be shared with everyone in “${opts.workspaceName}”.\n\n` +
        `The suggested folder is ${basename(suggested)}.`,
    };
    const { response } = opts.parent
      ? await dialog.showMessageBox(opts.parent, refusal)
      : await dialog.showMessageBox(refusal);
    if (response === 1) return null;
  }
}

/** A message box attached to the window as a sheet when there is one. */
function showMessage(
  parent: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

/** Every syncable file under `root`, as the engine would see it (relative POSIX
 * paths, the engine's own ignore rules, `.treehouse/` excluded). */
function localFiles(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = relative(root, join(e.parentPath, e.name)).split(sep).join("/");
    if (!ignored(rel)) out.push(rel);
  }
  return out;
}

/**
 * Retire the stale key in a folder being picked back up, so the grant mints a fresh
 * one into it. The folder keeps its files, its sync index and its cursor — which is
 * the point: the engine resumes from where it stopped instead of re-uploading.
 *
 * Revocation is best-effort. The menubar's Stop Syncing already revoked it (a 404
 * here is success); `treehouse unlink` did not, and a key left live with nothing
 * pointing at it is the one kind no in-app path can clean up later. The key is
 * then removed from the config, which is what makes resume see "grant not done"
 * rather than adopting a dead key.
 */
async function reclaimFolder(root: string, apiOrigin: string | undefined): Promise<void> {
  const path = join(root, ".treehouse", "config.json");
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return; // nothing to retire
  }
  if (apiOrigin && typeof cfg.keyId === "string") {
    await revokeKey(apiOrigin, cfg.keyId).catch((err: unknown) => {
      console.error("[onboarding] couldn't revoke a reclaimed folder's old key:", err);
    });
  }
  delete cfg.apiKey;
  delete cfg.keyId;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function createOnboardingEffects(): OnboardingEffects {
  return {
    async confirmTrust(ctx: OnboardingContext): Promise<boolean> {
      // TOFU in shell chrome: show the FULL origin and require an explicit continue
      // BEFORE any webview load / allow-list mutation / descriptor trust.
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", "Continue"],
        defaultId: 1,
        cancelId: 0,
        title: "Connect to a Treehouse server",
        message: "Connect to this server?",
        detail: `You're about to sign in to:\n\n${ctx.appOrigin}\n\nOnly continue if you trust this address.`,
      });
      const confirmed = response === 1;
      // Remember the origin as trusted at CONFIRMATION time (not only on completion)
      // so a mid-flow relaunch of a self-hosted onboarding doesn't re-prompt — and a
      // DECLINE never persists trust for an attacker-supplied origin.
      if (confirmed) rememberTrustedOrigin(ctx.appOrigin);
      return confirmed;
    },

    async resolveApiOrigin(ctx: OnboardingContext): Promise<string | null> {
      const descriptor = await fetchDescriptor(ctx.appOrigin, { allowInsecure });
      return descriptor?.apiUrl ?? null;
    },

    hasSession(ctx: OnboardingContext): Promise<boolean> {
      return isSignedIn(ctx.apiOrigin ?? ctx.appOrigin);
    },

    async signIn(
      ctx: OnboardingContext,
      origins: TrustedOrigins,
      signal?: AbortSignal,
    ): Promise<void> {
      const win = loadInWorkspaceWindow(new URL("/sign-in", ctx.appOrigin).toString(), origins);
      bringForward(win);
      await waitForSession(origins.api, win, signal);
    },

    async chooseWorkspace(
      ctx: OnboardingContext,
      origins: TrustedOrigins,
      signal?: AbortSignal,
    ): Promise<{ workspaceId: string; workspaceName: string }> {
      // Already decided elsewhere (invite / deep link): only the NAME is missing.
      // Resolve it rather than asking the user to re-pick what they already picked.
      if (ctx.workspaceId) {
        const known = await fetchWorkspaceName(origins.api, ctx.workspaceId, signal);
        if (known) return { workspaceId: ctx.workspaceId, workspaceName: known };
        // The id came from an invite or a deep link — untrusted, and possibly for a
        // workspace this account can't see. Fail rather than inventing a name and
        // creating a folder for a workspace the grant will then reject.
        throw new Error("You don't have access to that workspace yet.");
      }

      // Create path: run the web step and watch for its sentinel navigation. Tell
      // it which workspaces already have a folder here so it can mark those rows
      // rather than letting the user pick one and hit a refusal afterwards.
      const linked = loadLinks().map((l) => ({
        workspaceId: l.workspaceId,
        folderName: basename(l.root),
      }));
      const win = loadInWorkspaceWindow(buildWorkspaceStepUrl(ctx.appOrigin, linked), origins);
      bringForward(win);
      // No deadline, for the same reason as sign-in: an open window waiting on a
      // choice is a user thinking, not a hung step. Closing it is the way out.
      const chosen = await awaitNavigationSignal(
        win,
        (url) => parseWorkspaceSentinel(url, ctx.appOrigin),
        { signal, timeoutMs: Number.POSITIVE_INFINITY },
      );
      if (chosen === null) throw new Error("Workspace selection was cancelled.");

      // The sentinel id is a HINT from a web page, not proof of membership. Resolve
      // it authoritatively — the same membership-checked lookup link.vue app mode
      // does — so a navigation naming someone else's workspace fails here rather
      // than creating a folder the grant would refuse.
      const name = await fetchWorkspaceName(origins.api, chosen, signal);
      if (!name) throw new Error("We couldn't open that workspace.");
      return { workspaceId: chosen, workspaceName: name };
    },

    async createFolder(ctx: OnboardingContext): Promise<FolderPlan> {
      // Resume/retry: reuse the folder already created for THIS flow rather than
      // re-planning (which would collide and mint "<Name> 2", stranding the first).
      if (ctx.folderRoot) {
        mkdirSync(ctx.folderRoot, { recursive: true });
        return { name: basename(ctx.folderRoot), root: ctx.folderRoot };
      }
      // The workspace step guarantees a real name by the time we get here, so there
      // is no "Workspace" fallback any more — that fallback WAS the naming defect.
      // An absent name now means the machine reached this step out of order, which
      // is a bug worth surfacing rather than papering over with a generic folder.
      const name = ctx.workspaceName;
      if (!name) throw new Error("folder step reached before the workspace was settled");

      // Offer the default, then let the user put it somewhere else. `planFolder`
      // has always accepted an override; until now nothing ever passed one.
      // A folder is "reclaimable" when it already holds THIS workspace's files from
      // an earlier sync here and nothing links it now — Stop Syncing leaves the
      // files on disk by design, so coming back must find them, not step around
      // them to "<Name> 2" and leave the folder the user knows about dead.
      //
      // Every probe re-reads the registry and the disk when it is called. The
      // picker can sit open for minutes, so a decision taken before it opened is
      // re-taken after it closes (see `stillSafe` below).
      const isLinked = (p: string): boolean => loadLinks().some((l) => l.root === p);
      const isReclaimable = (p: string): boolean => {
        if (isLinked(p)) return false;
        const cfg = readFolderConfig(p);
        // Exact workspace AND server. A config with no apiBase can't prove which
        // server issued the id, so it doesn't qualify.
        return (
          !!cfg?.workspaceId &&
          cfg.workspaceId === ctx.workspaceId &&
          !!cfg.apiBase &&
          cfg.apiBase === ctx.apiOrigin
        );
      };
      const exists = (p: string): boolean => existsSync(p);
      const isUnusedEmpty = (p: string): boolean => {
        if (isLinked(p)) return false;
        try {
          return readdirSync(p).filter((e) => e !== ".DS_Store").length === 0;
        } catch {
          return false; // a file, or unreadable — a real collision
        }
      };
      /** Is the folder we're about to use still what we judged it to be? */
      const stillSafe = (plan: FolderPlan): boolean => {
        if (!existsSync(plan.root)) return true; // created fresh below
        return plan.reclaim ? isReclaimable(plan.root) : isUnusedEmpty(plan.root);
      };

      for (;;) {
        const suggested = planFolder(name, { exists, isReclaimable, isUnusedEmpty });

        // Put the question on screen behind the picker: on a deep link the window
        // was still showing another workspace, so "choose a folder" arrived under
        // the wrong name.
        let parent: BrowserWindow | null = getWorkspaceWindow();
        if (ctx.workspaceId && ctx.apiOrigin) {
          parent = loadInWorkspaceWindow(
            buildFolderStepUrl(ctx.appOrigin, {
              workspaceId: ctx.workspaceId,
              folderName: suggested.name,
              reclaim: suggested.reclaim,
            }),
            { app: ctx.appOrigin, api: ctx.apiOrigin },
          );
        }
        if (parent) bringForward(parent);

        const override = await pickFolder(suggested.root, {
          workspaceName: name,
          parent,
          isReclaimable,
        });
        const plan = override ? planFolder(name, { override, exists, isReclaimable }) : suggested;

        // Re-check AFTER the dialog. The suggestion was judged empty (or ours)
        // when the picker opened; anything could have been written into it since,
        // and accepting the suggestion would otherwise upload it unexamined.
        if (!stillSafe(plan)) {
          await showMessage(parent, {
            type: "warning",
            buttons: ["Choose Again"],
            title: "That folder changed",
            message: `“${basename(plan.root)}” changed while you were choosing`,
            detail:
              "Files were added to it, or it's now used by something else, so it isn't safe to sync any more. Pick a folder again.",
          });
          continue;
        }

        if (plan.reclaim) {
          // Only the workspace's own files are safe to pick back up. Anything the
          // sync baseline doesn't know was added after syncing stopped, and the
          // first reconcile would upload it to everyone in the workspace.
          const baseline = Object.keys(loadIndex(plan.root, ctx.workspaceId));
          const unknownNow = (): string[] => filesOutsideBaseline(localFiles(plan.root), baseline);
          let approved = new Set<string>();
          let declined = false;
          // Loop until what the user approved is exactly what's there: the consent
          // dialog is itself a window in which more files can arrive, and those
          // were never shown to them.
          for (;;) {
            const unknown = unknownNow();
            if (unknown.every((f) => approved.has(f))) break;
            const { response } = await showMessage(parent, {
              type: "warning",
              buttons: ["Choose Another Folder", "Upload and Sync"],
              defaultId: 0,
              cancelId: 0,
              title: "Upload new files?",
              message: `${unknown.length === 1 ? "1 file" : `${unknown.length} files`} in “${basename(plan.root)}” ${unknown.length === 1 ? "isn't" : "aren't"} part of ${name} yet`,
              detail:
                `${unknown.length === 1 ? "It was" : "They were"} added after this folder stopped syncing. Syncing it again uploads ${unknown.length === 1 ? "it" : "them"} and shares ${unknown.length === 1 ? "it" : "them"} with everyone in ${name}:\n\n` +
                summarizePaths(unknown),
            });
            if (response !== 1) {
              declined = true;
              break;
            }
            approved = new Set(unknown);
            // The folder's identity can change while the dialog is up, too.
            if (!stillSafe(plan)) break;
          }
          if (declined) continue;
          if (!stillSafe(plan)) {
            await showMessage(parent, {
              type: "warning",
              buttons: ["Choose Again"],
              title: "That folder changed",
              message: `“${basename(plan.root)}” changed while you were choosing`,
              detail:
                "It's now used by something else, so it isn't safe to sync. Pick a folder again.",
            });
            continue;
          }
          await reclaimFolder(plan.root, ctx.apiOrigin);
        }
        mkdirSync(plan.root, { recursive: true });
        // Surface the TCC-protected-path warning before the grant (getting-started
        // promises a warning on protected locations).
        if (plan.tccWarning) {
          await showMessage(parent, {
            type: "warning",
            buttons: ["OK"],
            title: "Protected folder",
            message: "This folder is in a protected location",
            detail: plan.tccWarning,
          });
        }
        return plan;
      }
    },

    async discardEmptyFolder(root: string): Promise<void> {
      // Undo for a superseded run. `rmdirSync` WITHOUT `recursive` is the safety
      // property, not an oversight: it refuses on a non-empty directory, so the
      // only thing this can ever remove is a directory we just made and never
      // wrote to. If the user picked an existing folder of their own, or anything
      // landed in it meanwhile, this throws ENOTEMPTY and we leave it alone.
      // Failure is never worth surfacing — the flow that owned this run is already
      // gone, and a stray empty directory is a cosmetic problem, not a broken one.
      try {
        rmdirSync(root);
      } catch {
        // non-empty, already gone, or not ours to remove — all fine.
      }
    },

    async runGrant(ctx: OnboardingContext, origins: TrustedOrigins, signal?: AbortSignal) {
      if (!ctx.folderRoot) throw new Error("folder not created before grant");
      // Idempotent resume safety net: if the folder already holds a valid config
      // (a prior grant completed before the crash), adopt it instead of minting a
      // second key. Belt-and-braces with entryStep's `configPresent` fact. Re-auth
      // (forceGrant) deliberately bypasses this — the on-disk key is revoked.
      if (!ctx.forceGrant) {
        const existing = readFolderConfig(ctx.folderRoot);
        if (existing?.keyId && existing.workspaceId) {
          return { keyId: existing.keyId, workspaceId: existing.workspaceId };
        }
      }
      return runDeviceGrant(
        {
          apiBase: origins.api,
          folderRoot: ctx.folderRoot,
          expectWorkspaceId: ctx.workspaceId,
          keyName: KEY_LABEL,
          loadApproval: ({ url: _url, userCode }) => {
            // Load the app-mode approval page in the authed webview (workspace
            // preselected). We drive our own URL rather than the server's
            // verification_uri so the workspace is preselected, copy is app-flavored,
            // and the minted key is labelled honestly (KEY_LABEL) in key management.
            loadInWorkspaceWindow(
              buildApprovalUrl(ctx.appOrigin, {
                code: userCode,
                workspaceId: ctx.workspaceId,
                keyName: KEY_LABEL,
                // The folder is settled by now, so the page can confirm the real
                // thing instead of re-asking which workspace.
                folderName: ctx.folderRoot ? basename(ctx.folderRoot) : undefined,
              }),
              origins,
            );
          },
          revokeKey: (keyId) => revokeKey(origins.api, keyId),
        },
        { signal },
      );
    },

    async startSync(ctx: OnboardingContext): Promise<void> {
      if (!ctx.folderRoot || !ctx.workspaceId) throw new Error("incomplete grant context");
      // In a packaged app, NEVER install/start the launchd service while the stable
      // daemon binary is missing: cli's daemonInvocation() would fall back to
      // process.execPath — the Electron GUI — and bake that into the plist. Surface a
      // real (retryable) error instead; the ownership monitor installs the daemon.
      if (app.isPackaged && !existsSync(stableDaemonPath())) {
        throw new Error(
          "Treehouse's sync engine isn't installed yet. Please reopen the app and try again.",
        );
      }
      const account = await fetchAccountId(ctx.apiOrigin ?? ctx.appOrigin);
      try {
        await startSyncFolder({
          root: ctx.folderRoot,
          workspaceId: ctx.workspaceId,
          keyId: ctx.keyId,
          account,
          appOrigin: ctx.appOrigin,
        });
      } catch (e) {
        // `addLink` refuses a SECOND root for a workspace — but by this point the
        // grant has already minted a key and written it into the folder's config.
        // Rethrowing plainly left that key live on the server with no links.json
        // record, which is the one state no in-app path can revoke from (sign-out
        // and unlink both find keys by walking links.json). Same failure mode as an
        // unrevoked legacy link, reached from the other end.
        //
        // Revocation is best-effort and must not mask the real error: if it fails
        // too, the original refusal is still the thing the user needs to read.
        if (e instanceof WorkspaceAlreadyLinkedError) {
          await revokeFolderKey(ctx.folderRoot).catch((revokeErr: unknown) => {
            console.error("[onboarding] couldn't revoke the stranded key:", revokeErr);
          });
          throw new Error(
            `That workspace already syncs to ${e.existingRoot} on this Mac. ` +
              "A workspace can only have one folder here — move that folder instead, " +
              "or stop syncing it first.",
          );
        }
        throw e;
      }
    },

    openWorkspace(ctx: OnboardingContext, origins: TrustedOrigins): void {
      openWorkspaceWindow(ctx.appOrigin, origins);
    },
  };
}