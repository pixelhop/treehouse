import { describe, expect, it } from "vite-plus/test";
import { cacheStep, sessionIdentity } from "../app/utils/queryCacheOwner";

const session = (userId: string | null, over = {}) => ({
  pending: false,
  failed: false,
  userId,
  ...over,
});

describe("sessionIdentity", () => {
  it("reads who is signed in, and whether the answer can be trusted", () => {
    expect(sessionIdentity({ isPending: false, data: { user: { id: "a" } } })).toEqual({
      pending: false,
      failed: false,
      userId: "a",
    });
    expect(sessionIdentity({ isPending: false, error: new Error("offline") })).toMatchObject({
      failed: true,
      userId: null,
    });
  });
});

describe("cacheStep", () => {
  it("waits until the session is known", () => {
    expect(cacheStep(session(null, { pending: true }), "alice")).toBe("wait");
  });

  it("doesn't take a failed session request for signing out", () => {
    expect(cacheStep(session(null, { failed: true }), "alice")).toBe("wait");
  });

  it("keeps the cache for the person it belongs to", () => {
    expect(cacheStep(session("alice"), "alice")).toBe("keep");
  });

  it("switches for anyone else, and for no one", () => {
    expect(cacheStep(session("bob"), "alice")).toBe("switch");
    expect(cacheStep(session(null), "alice")).toBe("switch");
    expect(cacheStep(session("alice"), null)).toBe("switch");
  });
});