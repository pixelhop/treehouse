import { describe, expect, it, vi } from "vite-plus/test";
import {
  makeReloadCoordinator,
  makeUpdateActivator,
  shouldRegisterServiceWorker,
} from "../app/utils/pwa";

// The gate that keeps the PWA service worker out of the desktop shell. If it
// regressed to true under an Electron UA, the shell would grow a second,
// SW-cached update path and show the previous build on first launch after a
// deploy — silently.

const SHELL =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Electron/33.4.11 TreehouseDesktop/1.0.0 Safari/537.36";
const BARE_ELECTRON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("shouldRegisterServiceWorker", () => {
  it("registers in a normal browser with the API available", () => {
    expect(shouldRegisterServiceWorker(CHROME, true)).toBe(true);
  });

  it("never registers inside the desktop shell (branded UA)", () => {
    expect(shouldRegisterServiceWorker(SHELL, true)).toBe(false);
  });

  it("never registers under a bare Electron UA (pre-branding shells)", () => {
    expect(shouldRegisterServiceWorker(BARE_ELECTRON, true)).toBe(false);
  });

  it("skips browsers without the serviceWorker API", () => {
    expect(shouldRegisterServiceWorker(CHROME, false)).toBe(false);
  });

  it("a missing UA is not the shell — the API decides", () => {
    expect(shouldRegisterServiceWorker(null, true)).toBe(true);
    expect(shouldRegisterServiceWorker(undefined, false)).toBe(false);
  });
});
describe("makeUpdateActivator", () => {
  const RECHECK = 30_000;

  function setup(opts: { dirty?: () => boolean } = {}) {
    vi.useFakeTimers();
    const activated: unknown[] = [];
    const activator = makeUpdateActivator({
      hasUnsavedWork: opts.dirty ?? (() => false),
      requestActivation: (w) => activated.push(w),
      recheckMs: RECHECK,
    });
    return { activator, activated };
  }

  it("activates immediately when nothing is dirty", () => {
    const { activator, activated } = setup();
    const worker = { postMessage: () => {} };
    activator.arm(() => worker);
    expect(activated).toEqual([worker]);
    expect(activator.pending).toBe(false);
    vi.useRealTimers();
  });

  it("defers while dirty, then activates once the edit is saved or discarded", () => {
    let dirty = true;
    const { activator, activated } = setup({ dirty: () => dirty });
    const worker = { postMessage: () => {} };
    activator.arm(() => worker);
    expect(activated).toEqual([]);
    vi.advanceTimersByTime(RECHECK * 3);
    expect(activated).toEqual([]); // still dirty — never reload over the buffer
    dirty = false;
    vi.advanceTimersByTime(RECHECK);
    expect(activated).toEqual([worker]);
    expect(activator.pending).toBe(false);
    vi.useRealTimers();
  });

  it("stands down without activating when the waiting worker disappears", () => {
    let dirty = true;
    const { activator, activated } = setup({ dirty: () => dirty });
    let worker: { postMessage: () => void } | null = { postMessage: () => {} };
    activator.arm(() => worker);
    worker = null; // another tab activated it, or a newer update superseded it
    vi.advanceTimersByTime(RECHECK);
    expect(activator.pending).toBe(false);
    dirty = false;
    vi.advanceTimersByTime(RECHECK * 2);
    expect(activated).toEqual([]); // no ghost activation later
    vi.useRealTimers();
  });

  it("arming again while a deferral is pending does not stack activations", () => {
    let dirty = true;
    const { activator, activated } = setup({ dirty: () => dirty });
    const worker = { postMessage: () => {} };
    activator.arm(() => worker);
    activator.arm(() => worker);
    activator.arm(() => worker);
    dirty = false;
    vi.advanceTimersByTime(RECHECK);
    expect(activated).toEqual([worker]); // exactly one SKIP_WAITING
    vi.useRealTimers();
  });
});
describe("makeReloadCoordinator", () => {
  const RECHECK = 30_000;

  function setup(opts: { hadController: boolean; dirty?: () => boolean }) {
    vi.useFakeTimers();
    let reloads = 0;
    const coordinator = makeReloadCoordinator({
      hadControllerAtStart: opts.hadController,
      hasUnsavedWork: opts.dirty ?? (() => false),
      reload: () => {
        reloads += 1;
      },
      recheckMs: RECHECK,
    });
    return { coordinator, reloads: () => reloads };
  }

  it("does not reload on the first-install clientsClaim, but does on the next takeover", () => {
    const { coordinator, reloads } = setup({ hadController: false });
    coordinator.onControllerChange(); // clientsClaim on a fresh page
    expect(reloads()).toBe(0);
    coordinator.onControllerChange(); // a real update took control
    expect(reloads()).toBe(1);
    vi.useRealTimers();
  });

  it("a sibling tab that never posted SKIP_WAITING still reloads on takeover", () => {
    // Sibling tabs load already-controlled, and only observe controllerchange.
    const { coordinator, reloads } = setup({ hadController: true });
    coordinator.onControllerChange();
    expect(reloads()).toBe(1);
    vi.useRealTimers();
  });

  it("a dirty sibling defers its reload until its own registry is clean", () => {
    let dirty = true;
    const { coordinator, reloads } = setup({ hadController: true, dirty: () => dirty });
    coordinator.onControllerChange();
    vi.advanceTimersByTime(RECHECK * 4);
    expect(reloads()).toBe(0); // never over an unsaved buffer
    dirty = false;
    vi.advanceTimersByTime(RECHECK);
    expect(reloads()).toBe(1);
    vi.useRealTimers();
  });

  it("re-checks dirty state at reload time: typing after activation was requested defers the reload", () => {
    // The async gap: the activator saw a clean tab and posted SKIP_WAITING,
    // the user typed, THEN controllerchange arrived.
    let dirty = false;
    const { coordinator, reloads } = setup({ hadController: true, dirty: () => dirty });
    dirty = true; // keystrokes land between SKIP_WAITING and controllerchange
    coordinator.onControllerChange();
    expect(reloads()).toBe(0);
    dirty = false; // saved or discarded
    vi.advanceTimersByTime(RECHECK);
    expect(reloads()).toBe(1);
    vi.useRealTimers();
  });

  it("reloads exactly once across repeated controller changes", () => {
    const { coordinator, reloads } = setup({ hadController: true });
    coordinator.onControllerChange();
    coordinator.onControllerChange();
    coordinator.onControllerChange();
    expect(reloads()).toBe(1);
    vi.useRealTimers();
  });
});