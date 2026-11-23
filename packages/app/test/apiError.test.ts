import { describe, expect, it } from "vite-plus/test";
import { apiErrorMessage } from "../app/utils/apiError";

describe("apiErrorMessage", () => {
  it("uses the API's own message", () => {
    const error = { data: { statusMessage: "Name must be at most 80 characters" } };
    expect(apiErrorMessage(error, "fallback")).toBe("Name must be at most 80 characters");
  });

  it("falls back when there is no usable message", () => {
    expect(apiErrorMessage(new TypeError("Failed to fetch"), "fallback")).toBe("fallback");
    expect(apiErrorMessage({ data: { statusMessage: "" } }, "fallback")).toBe("fallback");
    expect(apiErrorMessage(null, "fallback")).toBe("fallback");
  });
});