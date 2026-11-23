import { describe, expect, it } from "vite-plus/test";
import { DeviceGrantExpiredError, WorkspaceMismatchError } from "../src/auth";
import type { FolderPlan } from "../src/onboarding/folder";
import {
  entryStep,
  FolderPickCancelledError,
  OnboardingDriver,
  type OnboardingContext,
  type OnboardingEffects,
  type OnboardingState,
  type ResumeFacts,
  reduce,
  type Step,
} from "../src/onboarding/machine";

const facts = (over: Partial<ResumeFacts> = {}): ResumeFacts => ({
  originTrusted: true,
  signedIn: true,
  workspaceChosen: true,
  folderExists: true,
  configPresent: true,
  linkRegistered: true,
  ...over,
});

describe("entryStep (resume)", () => {
  it("prompts for trust when the origin is untrusted", () => {
    expect(entryStep(facts({ originTrusted: false }))).toBe("trust");
  });

  it("enters at sign-in when not signed in", () => {
    expect(entryStep(facts({ signedIn: false }))).toBe("signin");
  });

  it("enters at the workspace step when signed in with no workspace settled", () => {
    expect(
      entryStep(
        facts({
          workspaceChosen: false,
          folderExists: false,
          configPresent: false,
          linkRegistered: false,
        }),
      ),
    ).toBe("workspace");
  });

  it("enters at the folder screen once the workspace is settled", () => {
    // Killed after the workspace step but before folder creation → folder screen.
    expect(
      entryStep(facts({ folderExists: false, configPresent: false, linkRegistered: false })),
    ).toBe("folder");
  });

  it("the workspace step precedes the folder step (a folder is never named blind)", () => {
    // Even with a folder somehow on disk, an unsettled workspace goes back to the
    // workspace step rather than forward — this ordering is what makes the
    // "Workspace"/"Workspace 2" fallback unreachable.
    expect(entryStep(facts({ workspaceChosen: false, configPresent: false }))).toBe("workspace");
  });

  it("a completed grant is never sent back to the workspace step", () => {
    // A resume record written before the workspace step existed carries no
    // workspaceId, but its folder already holds a key — and that key's config
    // names the workspace. Re-asking would mint a second key for a settled flow.
    expect(entryStep(facts({ workspaceChosen: false, linkRegistered: false }))).toBe("starting");
    expect(entryStep(facts({ workspaceChosen: false }))).toBe("syncing");
  });

  it("enters at grant when the folder exists but has no key yet", () => {
    expect(entryStep(facts({ configPresent: false, linkRegistered: false }))).toBe("grant");
  });

  it("never returns a step past grant without a key on disk (keyless link impossible)", () => {
    // configPresent false ⇒ must not be starting/syncing even if a link somehow exists.
    expect(entryStep(facts({ configPresent: false, linkRegistered: true }))).toBe("grant");
  });

  it("enters at starting when the key exists but the link isn't registered", () => {
    expect(entryStep(facts({ linkRegistered: false }))).toBe("starting");
  });

  it("is complete when everything is present", () => {
    expect(entryStep(facts())).toBe("syncing");
  });
});

const ctx = (over: Partial<OnboardingContext> = {}): OnboardingContext => ({
  appOrigin: "https://acme.example.com",
  workspaceId: "ws_1",
  ...over,
});

const state = (step: Step, over: Partial<OnboardingContext> = {}): OnboardingState => ({
  step,
  ctx: ctx(over),
});

describe("reduce (transitions)", () => {
  it("trust → signin on confirmation", () => {
    expect(reduce(state("trust"), { type: "trustConfirmed" }).step).toBe("signin");
  });

  it("trust → error on decline, recoverable to trust", () => {
    const s = reduce(state("trust"), { type: "trustDeclined" });
    expect(s.step).toBe("error");
    expect(s.ctx.recoverTo).toBe("trust");
  });

  it("signin → workspace records the resolved API origin", () => {
    const s = reduce(state("signin"), { type: "signedIn", apiOrigin: "https://api.example.com" });
    expect(s.step).toBe("workspace");
    expect(s.ctx.apiOrigin).toBe("https://api.example.com");
  });

  it("workspace → folder records the chosen workspace id + name", () => {
    const s = reduce(state("workspace"), {
      type: "workspaceChosen",
      workspaceId: "ws_new",
      workspaceName: "Acme",
    });
    expect(s.step).toBe("folder");
    expect(s.ctx.workspaceId).toBe("ws_new");
    expect(s.ctx.workspaceName).toBe("Acme");
  });

  it("ignores an unrelated event at the workspace step", () => {
    expect(reduce(state("workspace"), { type: "started" }).step).toBe("workspace");
  });

  it("a failure at the workspace step is recoverable to the workspace step", () => {
    const s = reduce(state("workspace"), {
      type: "fail",
      message: "no workspaces",
      recoverTo: "workspace",
    });
    expect(s.step).toBe("error");
    expect(reduce(s, { type: "retry" }).step).toBe("workspace");
  });

  it("folder → grant records the folder root + name + warning", () => {
    const plan: FolderPlan = { name: "Acme 2", root: "/h/Treehouse/Acme 2", tccWarning: "w" };
    const s = reduce(state("folder"), { type: "folderReady", plan });
    expect(s.step).toBe("grant");
    expect(s.ctx.folderRoot).toBe("/h/Treehouse/Acme 2");
    expect(s.ctx.workspaceName).toBe("Acme 2");
    expect(s.ctx.folderWarning).toBe("w");
  });

  it("grant → starting records the key id + workspace", () => {
    const s = reduce(state("grant"), { type: "granted", keyId: "k1", workspaceId: "ws_1" });
    expect(s.step).toBe("starting");
    expect(s.ctx.keyId).toBe("k1");
  });

  it("starting → syncing", () => {
    expect(reduce(state("starting"), { type: "started" }).step).toBe("syncing");
  });

  it("a failure moves to error carrying the recovery target", () => {
    const s = reduce(state("grant"), { type: "fail", message: "boom", recoverTo: "grant" });
    expect(s.step).toBe("error");
    expect(s.ctx.error).toBe("boom");
    expect(s.ctx.recoverTo).toBe("grant");
  });

  it("retry from error resumes at the recovery target", () => {
    const errored = reduce(state("grant"), { type: "fail", message: "x", recoverTo: "signin" });
    const s = reduce(errored, { type: "retry" });
    expect(s.step).toBe("signin");
    expect(s.ctx.error).toBeUndefined();
  });

  it("ignores an out-of-order event", () => {
    expect(reduce(state("folder"), { type: "granted", workspaceId: "ws_1" }).step).toBe("folder");
  });
});

// ─────────────────────────── driver walk-throughs ───────────────────────────

interface Calls {
  steps: Step[];
  signIn: number;
  chooseWorkspace: number;
  grant: number;
  startSync: number;
  openWorkspace: number;
}

function fakeEffects(over: Partial<OnboardingEffects> = {}): {
  fx: OnboardingEffects;
  calls: Calls;
} {
  const calls: Calls = {
    steps: [],
    signIn: 0,
    chooseWorkspace: 0,
    grant: 0,
    startSync: 0,
    openWorkspace: 0,
  };
  const fx: OnboardingEffects = {
    confirmTrust: async () => true,
    resolveApiOrigin: async () => "https://api.example.com",
    hasSession: async () => false,
    signIn: async () => {
      calls.signIn += 1;
    },
    chooseWorkspace: async () => {
      calls.chooseWorkspace += 1;
      return { workspaceId: "ws_1", workspaceName: "Acme" };
    },
    createFolder: async () => ({ name: "Acme", root: "/h/Treehouse/Acme" }),
    runGrant: async () => {
      calls.grant += 1;
      return { keyId: "k1", workspaceId: "ws_1" };
    },
    startSync: async () => {
      calls.startSync += 1;
    },
    openWorkspace: () => {
      calls.openWorkspace += 1;
    },
    onTransition: (s) => calls.steps.push(s.step),
    ...over,
  };
  return { fx, calls };
}

describe("OnboardingDriver", () => {
  it("AE1: an untrusted invite instance walks every state to syncing", async () => {
    const { fx, calls } = fakeEffects();
    const driver = new OnboardingDriver(state("trust", { apiOrigin: undefined }), fx);
    const final = await driver.run();
    expect(final).toBe("syncing");
    expect(calls.steps).toEqual(["signin", "workspace", "folder", "grant", "starting", "syncing"]);
    // Server = the invite's instance, resolved via the descriptor.
    expect(driver.state.ctx.apiOrigin).toBe("https://api.example.com");
    expect(calls.signIn).toBe(1);
    // The invite knows its workspace id but not its NAME, so the step still runs —
    // resolving the name is what keeps the folder from being called "Workspace".
    expect(calls.chooseWorkspace).toBe(1);
    expect(driver.state.ctx.workspaceName).toBe("Acme");
  });

  it("skips the workspace step when both id and name are already known", async () => {
    const { fx, calls } = fakeEffects();
    const driver = new OnboardingDriver(
      state("workspace", { apiOrigin: "https://api.example.com", workspaceName: "Acme" }),
      fx,
    );
    expect(await driver.run()).toBe("syncing");
    expect(calls.chooseWorkspace).toBe(0); // nothing left to settle
  });

  it("AE1: the folder step always receives a real workspace name", async () => {
    // The create path starts with no workspace at all. The folder effect must never
    // see an undefined name — that was the "Workspace"/"Workspace 2" defect.
    let nameAtFolder: string | undefined = "unset";
    const { fx } = fakeEffects({
      chooseWorkspace: async () => ({ workspaceId: "ws_new", workspaceName: "Acme" }),
      createFolder: async (c) => {
        nameAtFolder = c.workspaceName;
        return { name: "Acme", root: "/h/Treehouse/Acme" };
      },
    });
    const driver = new OnboardingDriver(
      { step: "signin", ctx: { appOrigin: "https://acme.example.com" } },
      fx,
    );
    expect(await driver.run()).toBe("syncing");
    expect(nameAtFolder).toBe("Acme");
  });

  it("a failing workspace step lands on error, recoverable to the workspace step", async () => {
    const { fx } = fakeEffects({
      chooseWorkspace: async () => {
        throw new Error("couldn't load your workspaces");
      },
    });
    const driver = new OnboardingDriver(
      state("workspace", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    expect(await driver.run()).toBe("error");
    expect(driver.state.ctx.recoverTo).toBe("workspace");
  });

  it("a superseded flow stops at the workspace step without advancing", async () => {
    const { fx, calls } = fakeEffects({
      chooseWorkspace: async () => {
        throw new Error("should not be reached after cancel");
      },
    });
    const driver = new OnboardingDriver(
      state("workspace", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    driver.cancel();
    expect(await driver.run()).toBe("workspace");
    expect(calls.grant).toBe(0);
  });

  it("AE5 / second workspace: an existing session skips sign-in but still grants", async () => {
    const { fx, calls } = fakeEffects({ hasSession: async () => true });
    const driver = new OnboardingDriver(state("folder"), fx);
    const final = await driver.run();
    expect(final).toBe("syncing");
    expect(calls.signIn).toBe(0); // no second login
    expect(calls.grant).toBe(1); // every workspace still gets its own grant
  });

  it("a workspace mismatch stops at error, recoverable to the grant", async () => {
    const { fx } = fakeEffects({
      runGrant: async () => {
        throw new WorkspaceMismatchError("ws_1", "ws_other");
      },
    });
    const driver = new OnboardingDriver(
      state("grant", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    expect(await driver.run()).toBe("error");
    expect(driver.state.ctx.recoverTo).toBe("grant");
  });

  it("an expired approval returns to sign-in with a message", async () => {
    const { fx } = fakeEffects({
      runGrant: async () => {
        throw new DeviceGrantExpiredError();
      },
    });
    const driver = new OnboardingDriver(
      state("grant", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    expect(await driver.run()).toBe("error");
    expect(driver.state.ctx.recoverTo).toBe("signin");
    expect(driver.state.ctx.error).toMatch(/expired/i);
  });

  it("a declined trust stops without loading anything", async () => {
    const { fx, calls } = fakeEffects({ confirmTrust: async () => false });
    const driver = new OnboardingDriver(state("trust", { apiOrigin: undefined }), fx);
    expect(await driver.run()).toBe("error");
    expect(calls.signIn).toBe(0);
    expect(calls.grant).toBe(0);
  });

  it("a startSync failure lands on error, recoverable to starting (not an uncaught throw)", async () => {
    const { fx } = fakeEffects({
      startSync: async () => {
        throw new Error("daemon spawn failed");
      },
    });
    const driver = new OnboardingDriver(
      state("starting", { apiOrigin: "https://api.example.com", folderRoot: "/h/A", keyId: "k1" }),
      fx,
    );
    expect(await driver.run()).toBe("error");
    expect(driver.state.ctx.recoverTo).toBe("starting");
    expect(driver.state.ctx.error).toMatch(/daemon spawn failed/);
  });

  it("supersede: a cancelled driver stops advancing and never registers the link", async () => {
    // The grant resolves only after cancel() has fired — the driver must not then
    // dispatch `granted`/`starting` and register a link for the abandoned flow.
    let releaseGrant: () => void = () => {};
    const grantGate = new Promise<void>((r) => {
      releaseGrant = r;
    });
    const { fx, calls } = fakeEffects({
      runGrant: async () => {
        await grantGate;
        return { keyId: "k1", workspaceId: "ws_1" };
      },
    });
    const driver = new OnboardingDriver(
      state("grant", { apiOrigin: "https://api.example.com", folderRoot: "/h/A" }),
      fx,
    );
    const run = driver.run();
    driver.cancel();
    releaseGrant();
    const final = await run;
    expect(driver.cancelled).toBe(true);
    expect(final).not.toBe("syncing");
    expect(calls.startSync).toBe(0); // never started sync for the abandoned flow
  });

  // An effect that throws must never escape run(). If it does, the rejection
  // propagates into resumeOnboarding's `await run`: no error UI, no retry, and
  // activeDriver/activeRun are never cleared, so isOnboarding() stays true for the
  // rest of the session. Each of these is a real throw path, not a hypothetical.
  const throwers: Array<{ name: string; step: Step; over: Partial<OnboardingEffects> }> = [
    {
      name: "confirmTrust",
      step: "trust",
      over: {
        confirmTrust: async () => {
          throw new Error("dialog failed");
        },
      },
    },
    {
      name: "resolveApiOrigin (network)",
      step: "signin",
      over: {
        resolveApiOrigin: async () => {
          throw new Error("ENOTFOUND");
        },
      },
    },
    {
      name: "signIn (sign-in timed out)",
      step: "signin",
      over: {
        signIn: async () => {
          throw new Error("sign-in timed out");
        },
      },
    },
    {
      name: "createFolder (EACCES)",
      step: "folder",
      over: {
        createFolder: async () => {
          throw new Error("EACCES: permission denied");
        },
      },
    },
  ];

  for (const t of throwers) {
    it(`maps a throw from ${t.name} onto the recoverable error step`, async () => {
      const { fx } = fakeEffects(t.over);
      const driver = new OnboardingDriver(state(t.step, { apiOrigin: undefined }), fx);
      const final = await driver.run(); // must resolve, not reject
      expect(final).toBe("error");
      expect(driver.state.ctx.recoverTo).toBe(t.step);
      expect(driver.state.ctx.error).toBeTruthy();
    });
  }

  it("a cancelled folder pick stops the flow as the user's choice, not a failure", async () => {
    // Cancel used to fall back to the default folder, so "not now" still created a
    // folder and started syncing. It now ends the flow, flagged so the runner ends
    // quietly instead of offering Retry.
    const { fx, calls } = fakeEffects({
      createFolder: async () => {
        throw new FolderPickCancelledError();
      },
    });
    const driver = new OnboardingDriver(
      state("folder", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    expect(await driver.run()).toBe("error");
    expect(driver.state.ctx.cancelledByUser).toBe(true);
    expect(calls.grant).toBe(0); // no key minted
    expect(calls.startSync).toBe(0); // nothing synced
  });

  it("a real folder failure is NOT marked as the user's choice", async () => {
    const { fx } = fakeEffects({
      createFolder: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const driver = new OnboardingDriver(
      state("folder", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    expect(await driver.run()).toBe("error");
    expect(driver.state.ctx.cancelledByUser).toBeUndefined();
    // …and a retry clears the flag along with the error.
    driver.dispatch({ type: "retry" });
    expect(driver.state.ctx.cancelledByUser).toBeUndefined();
  });

  it("a retry after an effect throw re-runs the failed step and can then succeed", async () => {
    let attempts = 0;
    const { fx, calls } = fakeEffects({
      createFolder: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("EACCES: permission denied");
        return { name: "Acme", root: "/h/Treehouse/Acme" };
      },
    });
    const driver = new OnboardingDriver(
      state("folder", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    expect(await driver.run()).toBe("error");
    driver.dispatch({ type: "retry" });
    expect(await driver.run()).toBe("syncing");
    expect(attempts).toBe(2);
    expect(calls.startSync).toBe(1);
  });

  it("stays silent when a cancelled driver's in-flight effect throws", async () => {
    // The supersede path owns the UI once it has cancelled; a late rejection from
    // the retired driver must not raise an error dialog over the new flow.
    let releaseSignIn: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseSignIn = r;
    });
    // run() awaits hasSession() before it ever calls signIn(), so cancelling in the
    // same turn as run() would retire the driver BEFORE the effect starts — testing
    // the wrong path. Wait until signIn is genuinely in flight first.
    let enteredSignIn: () => void = () => {};
    const signInStarted = new Promise<void>((r) => {
      enteredSignIn = r;
    });
    const { fx } = fakeEffects({
      signIn: async () => {
        enteredSignIn();
        await gate;
        throw new Error("sign-in timed out");
      },
    });
    const driver = new OnboardingDriver(
      state("signin", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    const run = driver.run();
    await signInStarted;
    driver.cancel();
    releaseSignIn();
    const final = await run;
    expect(driver.cancelled).toBe(true);
    expect(final).not.toBe("error"); // no error UI for a superseded flow
    expect(driver.state.ctx.error).toBeUndefined();
  });
});
describe("OnboardingDriver — supersede at every awaiting step", () => {
  // Each awaiting case must re-check `cancelled` after its await. A miss is silent:
  // the superseded flow keeps dispatching and persists state for a run the user
  // already abandoned. The folder case was missing this guard.
  it("a folder created after cancel is not dispatched or persisted", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fx, calls } = fakeEffects({
      createFolder: async () => {
        await gate;
        return { name: "Acme", root: "/h/Treehouse/Acme" };
      },
    });
    const driver = new OnboardingDriver(
      state("folder", { apiOrigin: "https://api.example.com", workspaceName: "Acme" }),
      fx,
    );
    const run = driver.run();
    driver.cancel();
    release();
    expect(await run).toBe("folder");
    expect(driver.state.ctx.folderRoot).toBeUndefined();
    expect(calls.grant).toBe(0);
  });

  it("a folder created after cancel is also REMOVED, not just left undispatched", async () => {
    // Regression (PR #46 review). Not dispatching `folderReady` keeps the abandoned
    // run out of persisted state, but `createFolder` has already run `mkdirSync` —
    // so the directory survived with nothing pointing at it, and the next attempt
    // saw the name taken and planned "Acme 2". That suffixed-folder defect is the
    // thing this whole flow was written to remove; supersede quietly reintroduced it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const discarded: string[] = [];
    const { fx } = fakeEffects({
      createFolder: async () => {
        await gate;
        return { name: "Acme", root: "/h/Treehouse/Acme" };
      },
      discardEmptyFolder: async (root: string) => {
        discarded.push(root);
      },
    });
    const driver = new OnboardingDriver(
      state("folder", { apiOrigin: "https://api.example.com", workspaceName: "Acme" }),
      fx,
    );
    const run = driver.run();
    driver.cancel();
    release();
    await run;
    expect(discarded).toEqual(["/h/Treehouse/Acme"]);
  });

  it("does not discard the folder when the flow was NOT cancelled", async () => {
    const discarded: string[] = [];
    const { fx } = fakeEffects({
      createFolder: async () => ({ name: "Acme", root: "/h/Treehouse/Acme" }),
      discardEmptyFolder: async (root: string) => {
        discarded.push(root);
      },
    });
    const driver = new OnboardingDriver(
      state("folder", { apiOrigin: "https://api.example.com", workspaceName: "Acme" }),
      fx,
    );
    await driver.run();
    expect(discarded).toEqual([]);
  });

  it("a workspace resolved after cancel does not advance the flow", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fx, calls } = fakeEffects({
      chooseWorkspace: async () => {
        await gate;
        return { workspaceId: "ws_late", workspaceName: "Late" };
      },
    });
    const driver = new OnboardingDriver(
      state("workspace", { apiOrigin: "https://api.example.com" }),
      fx,
    );
    const run = driver.run();
    driver.cancel();
    release();
    expect(await run).toBe("workspace");
    expect(calls.grant).toBe(0);
  });
});