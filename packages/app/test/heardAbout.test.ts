import { describe, expect, it } from "vite-plus/test";
import { HEARD_ABOUT_OPTIONS, heardAboutAnswer } from "../app/utils/heardAbout";

describe("heardAboutAnswer", () => {
  it("leaves the field out when nothing was chosen", () => {
    expect(heardAboutAnswer("", "ignored")).toBeUndefined();
  });

  it("stores an option's key", () => {
    expect(heardAboutAnswer("friend", "ignored")).toBe("friend");
  });

  it("stores the person's own words for somewhere else", () => {
    expect(heardAboutAnswer("other", "  Hacker News ")).toBe("other: Hacker News");
    expect(heardAboutAnswer("other", "   ")).toBe("other");
  });

  it("keeps every option key unique", () => {
    const keys = HEARD_ABOUT_OPTIONS.map((o) => o.value);
    expect(new Set(keys).size).toBe(keys.length);
  });
});