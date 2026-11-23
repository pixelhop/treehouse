import { describe, expect, it } from "vite-plus/test";
import { slugify } from "../app/utils/slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Acme Inc")).toBe("acme-inc");
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugify("  Hello,  World!!  ")).toBe("hello-world");
  });

  it("trims leading and trailing separators", () => {
    expect(slugify("--Pixelhop--")).toBe("pixelhop");
  });
});