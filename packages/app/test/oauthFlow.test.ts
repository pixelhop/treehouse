import { describe, expect, it } from "vite-plus/test";
import { oauthResumeURL } from "../app/utils/oauthFlow";

describe("oauthResumeURL", () => {
  const signed = {
    response_type: "code",
    client_id: "abc",
    redirect_uri: "http://127.0.0.1:53682/callback",
    state: "xyz",
    exp: "1793290000",
    ba_iat: "1793289400000",
    ba_pl: "s1",
    max_age: "0",
    sig: "signature",
  };

  it("sends the client's own parameters back to authorize, without the signature or max_age", () => {
    const url = new URL(oauthResumeURL(signed, "https://api.example.com/"));
    expect(url.origin + url.pathname).toBe("https://api.example.com/api/auth/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "abc",
      redirect_uri: "http://127.0.0.1:53682/callback",
      state: "xyz",
    });
  });

  it("drops login and create from prompt, keeping anything else", () => {
    const url = new URL(oauthResumeURL({ ...signed, prompt: "login consent" }, "https://api.x"));
    expect(url.searchParams.get("prompt")).toBe("consent");
    const bare = new URL(oauthResumeURL({ ...signed, prompt: "create" }, "https://api.x"));
    expect(bare.searchParams.has("prompt")).toBe(false);
  });
});