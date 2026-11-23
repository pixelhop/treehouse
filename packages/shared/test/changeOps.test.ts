import { describe, expect, it } from "vite-plus/test";
import { CHANGE_OPS, COMMENT_OPS, carriesContent, isChangeOp, isCommentOp } from "../changeOps";

describe("change ops", () => {
  it("lists each op once", () => {
    expect(new Set(CHANGE_OPS).size).toBe(CHANGE_OPS.length);
  });

  it("narrows known ops and rejects ones from a newer server", () => {
    expect(isChangeOp("write")).toBe(true);
    expect(isChangeOp("access_granted")).toBe(true);
    expect(isChangeOp("shelved")).toBe(false);
    expect(isChangeOp("")).toBe(false);
  });

  it("classes every comment op as comment traffic by its prefix, future ones too", () => {
    for (const op of COMMENT_OPS) expect(isCommentOp(op), op).toBe(true);
    expect(isCommentOp("comment_pinned")).toBe(true);
    expect(isCommentOp("access_revoked")).toBe(false);
  });

  it("points at content only for write, move and restore", () => {
    expect(CHANGE_OPS.filter(carriesContent)).toEqual(["write", "move", "restore"]);
  });
});