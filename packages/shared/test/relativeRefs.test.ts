import { describe, expect, it } from "vite-plus/test";
import { dirOf, resolveRef } from "../relativeRefs";

describe("dirOf", () => {
  it("returns the containing directory, or empty at the root", () => {
    expect(dirOf("docs/guide/intro.md")).toBe("docs/guide");
    expect(dirOf("readme.md")).toBe("");
  });
});

describe("resolveRef", () => {
  it("resolves ./ and bare relative refs against the base directory", () => {
    expect(resolveRef("docs", "./b.md")).toEqual({
      kind: "workspace",
      path: "docs/b.md",
      fragment: null,
    });
    expect(resolveRef("docs", "b.md")).toEqual({
      kind: "workspace",
      path: "docs/b.md",
      fragment: null,
    });
  });

  it("resolves ../ traversal within the workspace (AE1)", () => {
    expect(resolveRef("docs/guide", "../assets/a.png")).toEqual({
      kind: "workspace",
      path: "docs/assets/a.png",
      fragment: null,
    });
  });

  it("treats traversal past the root as unresolvable, never clamped (AE2)", () => {
    expect(resolveRef("", "../../a.png")).toEqual({ kind: "unresolvable" });
    expect(resolveRef("docs", "../../a.png")).toEqual({ kind: "unresolvable" });
  });

  it("resolves root-absolute refs from the workspace root", () => {
    expect(resolveRef("docs/guide", "/logo.png")).toEqual({
      kind: "workspace",
      path: "logo.png",
      fragment: null,
    });
  });

  it("classifies scheme and protocol-relative refs as external", () => {
    expect(resolveRef("docs", "https://x.com/a.png")).toEqual({ kind: "external" });
    expect(resolveRef("docs", "mailto:a@b.c")).toEqual({ kind: "external" });
    expect(resolveRef("docs", "//evil.com/x.png")).toEqual({ kind: "external" });
  });

  it("classifies fragment-only and empty refs as fragment", () => {
    expect(resolveRef("docs", "#heading")).toEqual({ kind: "fragment" });
    expect(resolveRef("docs", "")).toEqual({ kind: "fragment" });
    expect(resolveRef("docs", "?x=1")).toEqual({ kind: "fragment" });
  });

  it("decodes percent-encoded segments to match stored paths", () => {
    expect(resolveRef("docs", "./my%20file.md")).toEqual({
      kind: "workspace",
      path: "docs/my file.md",
      fragment: null,
    });
    expect(resolveRef("docs", "./my file.md")).toEqual({
      kind: "workspace",
      path: "docs/my file.md",
      fragment: null,
    });
  });

  it("treats malformed percent-encoding and unsafe bytes as unresolvable", () => {
    expect(resolveRef("docs", "./bad%E0%A4%A")).toEqual({ kind: "unresolvable" });
    expect(resolveRef("docs", "a\\b.png")).toEqual({ kind: "unresolvable" });
  });

  it("rejects encoded slashes — %2F cannot smuggle traversal past the segment split", () => {
    expect(resolveRef("docs", "..%2F..%2Fsecret.png")).toEqual({ kind: "unresolvable" });
    expect(resolveRef("docs", "a%2Fb.png")).toEqual({ kind: "unresolvable" });
    expect(resolveRef("", "%2e%2e%2Fsecret.png")).toEqual({ kind: "unresolvable" });
  });

  it("strips query and keeps the fragment separately", () => {
    expect(resolveRef("docs", "./img.png?x=1#frag")).toEqual({
      kind: "workspace",
      path: "docs/img.png",
      fragment: "frag",
    });
    expect(resolveRef("docs", "./doc.md#sec")).toEqual({
      kind: "workspace",
      path: "docs/doc.md",
      fragment: "sec",
    });
  });

  it("handles folder refs, self refs, and redundant segments", () => {
    expect(resolveRef("docs", "./api/")).toEqual({
      kind: "workspace",
      path: "docs/api",
      fragment: null,
    });
    expect(resolveRef("docs", "./")).toEqual({ kind: "workspace", path: "docs", fragment: null });
    expect(resolveRef("", "a//b.png")).toEqual({
      kind: "workspace",
      path: "a/b.png",
      fragment: null,
    });
  });
});