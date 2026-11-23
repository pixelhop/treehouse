import { describe, expect, it } from "vite-plus/test";
import { buildDescriptor, isHttpUrl, parseDescriptor } from "../server/utils/descriptor";

// The well-known API-origin descriptor (U4/R15). The route serves buildDescriptor
// over the runtime apiUrl; the shell validates with parseDescriptor before trust.
describe("buildDescriptor", () => {
  it("reports the runtime API origin for a deployed and a localhost dev origin", () => {
    expect(buildDescriptor("https://api.trytree.house")).toEqual({
      product: "treehouse",
      version: 1,
      apiUrl: "https://api.trytree.house",
    });
    expect(buildDescriptor("http://localhost:3010").apiUrl).toBe("http://localhost:3010");
  });

  it("strips a trailing slash so the origin is canonical", () => {
    expect(buildDescriptor("https://api.example.com/").apiUrl).toBe("https://api.example.com");
  });
});

// The route gate: a misconfigured apiUrl must 500 rather than be served as a
// successful descriptor the shell will silently reject as "not a Treehouse
// server". Kept deliberately narrow — see the path case below.
describe("isHttpUrl (route-side apiUrl configuration gate)", () => {
  it("rejects unset, empty, unparseable, and non-http(s) values", () => {
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("   ")).toBe(false);
    expect(isHttpUrl("api.example.com")).toBe(false); // no scheme
    expect(isHttpUrl("ftp://api.example.com")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
  });

  it("accepts https, localhost http, and a subpath-mounted API", () => {
    expect(isHttpUrl("https://api.trytree.house")).toBe(true);
    expect(isHttpUrl("http://localhost:3010")).toBe(true);
    // Deliberately allowed: the app builds `${apiUrl}/api/...`, so an API behind
    // a reverse proxy on a subpath is a supported self-hosted layout. Forcing a
    // bare origin here would report the wrong base to every such deployment.
    expect(isHttpUrl("https://example.com/treehouse")).toBe(true);
    expect(buildDescriptor("https://example.com/treehouse").apiUrl).toBe(
      "https://example.com/treehouse",
    );
  });
});

describe("parseDescriptor (shell-side validation)", () => {
  it("accepts a well-formed https descriptor", () => {
    const d = parseDescriptor({
      product: "treehouse",
      version: 1,
      apiUrl: "https://api.example.com",
    });
    expect(d?.apiUrl).toBe("https://api.example.com");
  });

  it("treats missing and malformed/non-https descriptors identically (null)", () => {
    // Missing / not an object.
    expect(parseDescriptor(undefined)).toBeNull();
    expect(parseDescriptor(null)).toBeNull();
    expect(parseDescriptor("not json")).toBeNull();
    // Wrong product, or no apiUrl.
    expect(parseDescriptor({ product: "other", apiUrl: "https://x" })).toBeNull();
    expect(parseDescriptor({ product: "treehouse" })).toBeNull();
    // Non-https origin (a plausible-but-untrusted descriptor).
    expect(parseDescriptor({ product: "treehouse", apiUrl: "http://evil.example.com" })).toBeNull();
    expect(parseDescriptor({ product: "treehouse", apiUrl: "ftp://x" })).toBeNull();
  });

  it("permits http://localhost only when insecure origins are allowed (dev)", () => {
    const raw = { product: "treehouse", apiUrl: "http://localhost:3010" };
    expect(parseDescriptor(raw)).toBeNull();
    expect(parseDescriptor(raw, { allowInsecure: true })?.apiUrl).toBe("http://localhost:3010");
  });
});