import { describe, expect, it } from "vite-plus/test";
import { resolveEditorSrc, unresolveEditorSrc } from "../app/utils/editorImage";

const ctx = {
  docDir: "docs",
  fileUrl: (p: string) =>
    `https://api.test/api/workspaces/ws1/files/${p.split("/").map(encodeURIComponent).join("/")}`,
  filesUrlPrefix: "https://api.test/api/workspaces/ws1/files/",
};

describe("resolveEditorSrc", () => {
  it("resolves relative srcs to the API file URL for display (AE6)", () => {
    expect(resolveEditorSrc("./shot.png", ctx)).toBe(
      "https://api.test/api/workspaces/ws1/files/docs/shot.png",
    );
    expect(resolveEditorSrc("/logo.png", ctx)).toBe(
      "https://api.test/api/workspaces/ws1/files/logo.png",
    );
  });

  it("encodes spaces in the display URL", () => {
    expect(resolveEditorSrc("./my file.png", ctx)).toBe(
      "https://api.test/api/workspaces/ws1/files/docs/my%20file.png",
    );
  });

  it("passes external and unresolvable srcs through unchanged", () => {
    expect(resolveEditorSrc("https://x.com/a.png", ctx)).toBe("https://x.com/a.png");
    expect(resolveEditorSrc("../../a.png", ctx)).toBe("../../a.png");
  });
});

describe("unresolveEditorSrc", () => {
  it("reverse-maps API file URLs to the root-absolute form", () => {
    expect(unresolveEditorSrc("https://api.test/api/workspaces/ws1/files/docs/shot.png", ctx)).toBe(
      "/docs/shot.png",
    );
  });

  it("decodes encoded segments and drops query strings", () => {
    expect(
      unresolveEditorSrc("https://api.test/api/workspaces/ws1/files/docs/my%20file.png?x=1", ctx),
    ).toBe("/docs/my file.png");
  });

  it("leaves non-workspace URLs unchanged", () => {
    expect(unresolveEditorSrc("https://x.com/a.png", ctx)).toBe("https://x.com/a.png");
    expect(unresolveEditorSrc("./shot.png", ctx)).toBe("./shot.png");
  });

  it("round-trips: unresolve(resolve(x)) re-resolves to the same display URL", () => {
    const display = resolveEditorSrc("./shot.png", ctx);
    const stored = unresolveEditorSrc(display, ctx);
    expect(stored).toBe("/docs/shot.png");
    expect(resolveEditorSrc(stored, ctx)).toBe(display);
  });

  it("keeps #, ? and % encoded in the stored form so re-resolution targets the same file", () => {
    expect(
      unresolveEditorSrc("https://api.test/api/workspaces/ws1/files/docs/a%23b.png", ctx),
    ).toBe("/docs/a%23b.png");
    expect(resolveEditorSrc("/docs/a%23b.png", ctx)).toBe(
      "https://api.test/api/workspaces/ws1/files/docs/a%23b.png",
    );
    expect(unresolveEditorSrc("https://api.test/api/workspaces/ws1/files/100%25.png", ctx)).toBe(
      "/100%25.png",
    );
    expect(resolveEditorSrc("/100%25.png", ctx)).toBe(
      "https://api.test/api/workspaces/ws1/files/100%25.png",
    );
  });
});