import { describe, expect, it } from "vite-plus/test";
import { hasUnsavedWork, registerUnsavedWork } from "../app/utils/unsavedWork";

// The service-worker updater reloads the page to activate a new build; this
// registry is the only thing standing between that reload and an unsaved edit.

describe("unsavedWork registry", () => {
  it("is clean with no registered probes", () => {
    expect(hasUnsavedWork()).toBe(false);
  });

  it("reports dirty while any probe is dirty, clean when all are clean", () => {
    let dirty = false;
    const off = registerUnsavedWork(() => dirty);
    expect(hasUnsavedWork()).toBe(false);
    dirty = true;
    expect(hasUnsavedWork()).toBe(true);
    dirty = false;
    expect(hasUnsavedWork()).toBe(false);
    off();
  });

  it("deregistration removes the probe, so a closed editor cannot block updates", () => {
    const off = registerUnsavedWork(() => true);
    expect(hasUnsavedWork()).toBe(true);
    off();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("treats a throwing probe as dirty — never read a broken probe as permission to reload", () => {
    const off = registerUnsavedWork(() => {
      throw new Error("probe broke");
    });
    expect(hasUnsavedWork()).toBe(true);
    off();
  });

  it("tracks multiple surfaces independently", () => {
    let a = false;
    let b = true;
    const offA = registerUnsavedWork(() => a);
    const offB = registerUnsavedWork(() => b);
    expect(hasUnsavedWork()).toBe(true);
    b = false;
    expect(hasUnsavedWork()).toBe(false);
    a = true;
    expect(hasUnsavedWork()).toBe(true);
    offA();
    expect(hasUnsavedWork()).toBe(false);
    offB();
  });
});