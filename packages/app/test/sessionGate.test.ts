import { describe, expect, it } from "vite-plus/test";
import { SESSION_RECHECK_MS, sessionGate, storeHasUser } from "../app/utils/sessionGate";

describe("sessionGate", () => {
  it("waits for the API when nobody is known to be signed in", () => {
    expect(sessionGate({ signedIn: false, lastChecked: 1000, now: 1000 })).toBe("verify");
  });

  it("lets a recently confirmed session straight through", () => {
    expect(sessionGate({ signedIn: true, lastChecked: 1000, now: 1000 + SESSION_RECHECK_MS })).toBe(
      "pass",
    );
  });

  it("re-checks in the background once the session is a while old", () => {
    expect(sessionGate({ signedIn: true, lastChecked: 1000, now: 1001 + SESSION_RECHECK_MS })).toBe(
      "recheck",
    );
    // Never checked yet (a session restored from the store on load).
    expect(sessionGate({ signedIn: true, lastChecked: 0, now: Date.now() })).toBe("recheck");
  });
});

describe("storeHasUser", () => {
  it("reads a signed-in user out of the session atom", () => {
    expect(storeHasUser({ get: () => ({ data: { user: { id: "u1" } } }) })).toBe(true);
  });

  it("is false with no atom, no data, or no user", () => {
    expect(storeHasUser(undefined)).toBe(false);
    expect(storeHasUser({ get: () => ({ data: null }) })).toBe(false);
    expect(storeHasUser({ get: () => ({}) })).toBe(false);
  });
});