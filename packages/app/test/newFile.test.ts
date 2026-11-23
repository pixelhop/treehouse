import { describe, expect, it } from "vite-plus/test";
import { withDefaultExtension } from "../app/utils/newFile";

describe("withDefaultExtension", () => {
  it("defaults an extension-less name to markdown", () => {
    expect(withDefaultExtension("notes")).toBe("notes.md");
    expect(withDefaultExtension("  meeting notes  ")).toBe("meeting notes.md");
  });

  it("keeps an explicit extension", () => {
    expect(withDefaultExtension("notes.md")).toBe("notes.md");
    expect(withDefaultExtension("rows.csv")).toBe("rows.csv");
    expect(withDefaultExtension("page.HTML")).toBe("page.HTML");
  });

  it("treats a dotfile as already extended", () => {
    expect(withDefaultExtension(".env")).toBe(".env");
  });

  it("drops trailing dots rather than doubling them", () => {
    expect(withDefaultExtension("notes.")).toBe("notes.md");
    expect(withDefaultExtension("notes...")).toBe("notes.md");
  });

  it("returns empty for a name that trims to nothing", () => {
    expect(withDefaultExtension("   ")).toBe("");
    expect(withDefaultExtension("..")).toBe("");
  });

  it("honours a non-markdown default", () => {
    expect(withDefaultExtension("rows", "csv")).toBe("rows.csv");
  });
});