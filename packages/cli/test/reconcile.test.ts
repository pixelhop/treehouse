import { describe, expect, it } from "vite-plus/test";
import { type Action, reconcile } from "../src/reconcile";

const L = (hash: string) => ({ hash });
const R = (version: number) => ({ version });
const IDX = (version: number, hash: string) => ({ version, hash });

describe("reconcile", () => {
  it("no baseline: new local -> create, new remote -> pull, both -> create", () => {
    expect(reconcile(L("a"), undefined, undefined)).toEqual<Action>({ type: "create" });
    expect(reconcile(undefined, R(1), undefined)).toEqual<Action>({ type: "pull" });
    expect(reconcile(L("a"), R(1), undefined)).toEqual<Action>({ type: "create", onRemote: true });
  });

  it("unchanged on both sides -> noop", () => {
    expect(reconcile(L("a"), R(1), IDX(1, "a"))).toEqual<Action>({ type: "noop" });
  });

  it("local edited only -> push; remote edited only -> pull", () => {
    expect(reconcile(L("b"), R(1), IDX(1, "a"))).toEqual<Action>({ type: "push", baseVersion: 1 });
    expect(reconcile(L("a"), R(2), IDX(1, "a"))).toEqual<Action>({ type: "pull" });
  });

  it("both edited -> push (server returns 412 -> pull conflicted copy)", () => {
    expect(reconcile(L("b"), R(2), IDX(1, "a"))).toEqual<Action>({ type: "push", baseVersion: 1 });
  });

  it("delete interleavings honor resurrection-over-loss", () => {
    // local deleted, remote untouched -> propagate delete
    expect(reconcile(undefined, R(1), IDX(1, "a"))).toEqual<Action>({
      type: "pushDelete",
      baseVersion: 1,
    });
    // remote deleted, local untouched -> delete local
    expect(reconcile(L("a"), undefined, IDX(1, "a"))).toEqual<Action>({ type: "deleteLocal" });
    // local deleted, remote edited -> remote wins (resurrect locally)
    expect(reconcile(undefined, R(2), IDX(1, "a"))).toEqual<Action>({ type: "pull" });
    // remote deleted, local edited -> local wins (resurrect on server)
    expect(reconcile(L("b"), undefined, IDX(1, "a"))).toEqual<Action>({ type: "create" });
    // both deleted -> converge
    expect(reconcile(undefined, undefined, IDX(1, "a"))).toEqual<Action>({ type: "dropIndex" });
  });
});