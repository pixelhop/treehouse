import { describe, expect, it } from "vite-plus/test";
import { formatMoney, perMonth } from "../pricing";

describe("plan price formatting", () => {
  it("drops the cents from a whole price and keeps them otherwise", () => {
    expect(formatMoney(1200, "usd")).toMatch(/12$/);
    expect(formatMoney(1250, "usd")).toMatch(/12\.50$/);
  });

  it("writes a plain dollar sign, never US$", () => {
    expect(formatMoney(1200, "usd")).not.toContain("US");
  });

  it("quotes a yearly price per month so it compares with the monthly one", () => {
    expect(perMonth({ interval: "year", unitAmount: 12_000, currency: "usd" })).toBe(1000);
    expect(perMonth({ interval: "month", unitAmount: 1200, currency: "usd" })).toBe(1200);
  });
});