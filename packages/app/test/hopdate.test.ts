import { describe, expect, it } from "vite-plus/test";
import { hopdateTheme, rgbToHex } from "../app/utils/hopdate";

describe("rgbToHex", () => {
  it("pads each channel to two digits", () => {
    expect(rgbToHex([46, 125, 91])).toBe("#2e7d5b");
    expect(rgbToHex([0, 5, 255])).toBe("#0005ff");
  });
});

describe("hopdateTheme", () => {
  it("uses the accent as the widget's primary colour", () => {
    expect(hopdateTheme([46, 125, 91], [255, 255, 255]).primaryColor).toBe("#2e7d5b");
  });

  it("is light on the Treehouse and Solarized Light surfaces", () => {
    expect(hopdateTheme([0, 0, 0], [255, 255, 255]).mode).toBe("light");
    expect(hopdateTheme([0, 0, 0], [0xfb, 0xf6, 0xe9]).mode).toBe("light");
  });

  it("is dark on the Dark, Dracula and Nord surfaces", () => {
    expect(hopdateTheme([0, 0, 0], [0x17, 0x17, 0x17]).mode).toBe("dark");
    expect(hopdateTheme([0, 0, 0], [0x2f, 0x31, 0x40]).mode).toBe("dark");
    expect(hopdateTheme([0, 0, 0], [0x3b, 0x42, 0x52]).mode).toBe("dark");
  });
});