import { describe, expect, it } from "vite-plus/test";
import { withInferredApplicationType } from "../server/utils/oauth-registration";

// MCP clients register without `application_type`; RFC 7591's "web" default
// would reject their loopback callbacks. See oauth-registration.ts.
describe("withInferredApplicationType", () => {
  it("treats loopback http callbacks as a native app", () => {
    for (const uri of [
      "http://127.0.0.1:53682/callback",
      "http://localhost:6274/oauth/callback",
      "http://[::1]:8080/cb",
    ]) {
      expect(withInferredApplicationType({ redirect_uris: [uri] }).application_type).toBe("native");
    }
  });

  it("treats a private-use scheme as a native app", () => {
    const body = withInferredApplicationType({ redirect_uris: ["cursor://anysphere/oauth"] });
    expect(body.application_type).toBe("native");
  });

  it("leaves https callbacks to the web-client rules", () => {
    const body = { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
    expect(withInferredApplicationType(body)).toBe(body);
  });

  it("leaves a mix of native and web callbacks to the web-client rules", () => {
    const body = { redirect_uris: ["http://127.0.0.1:1/cb", "https://example.com/cb"] };
    expect(withInferredApplicationType(body).application_type).toBeUndefined();
  });

  it("never overrides a type the client chose", () => {
    const body = { application_type: "web", redirect_uris: ["http://127.0.0.1:1/cb"] };
    expect(withInferredApplicationType(body)).toBe(body);
  });

  it("does not treat plain http on a public host as native", () => {
    const body = { redirect_uris: ["http://example.com/cb"] };
    expect(withInferredApplicationType(body).application_type).toBeUndefined();
  });
});