import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { HEADER_BYTES } from "../src/blob-crypto";
import {
  type BlobGrant,
  GRANT_EXPIRY_STEP_SECONDS,
  GRANT_TTL_SECONDS,
  GrantTooLargeError,
  grantExpiry,
  grantKeyRing,
  mintGrant,
  openGrant,
  openUsageReport,
  sealUsageReport,
} from "../src/blob-grant";

const entry = (id: string) => `${id}:${randomBytes(32).toString("base64")}`;
const T1 = entry("t1");
const T2 = entry("t2");
const NOW = 1_800_000_000;

function grant(over: Partial<BlobGrant> = {}): BlobGrant {
  return {
    workspaceId: "ws-1",
    contentHash: "a".repeat(64),
    size: 12345,
    header: new Uint8Array(randomBytes(HEADER_BYTES)),
    key: new Uint8Array(randomBytes(32)),
    etag: `"3-${"a".repeat(64)}"`,
    headers: { "content-type": "video/mp4", "cache-control": "private, max-age=0" },
    expiresAt: NOW + 3600,
    meter: false,
    ...over,
  };
}

const ring = (active: string, retired?: string) => grantKeyRing(active, retired)!;

/** Change one character of the sealed body, keeping it valid base64url. */
function tamper(token: string, at = token.length - 5): string {
  const c = token[at] === "A" ? "B" : "A";
  return token.slice(0, at) + c + token.slice(at + 1);
}

describe("blob grants", () => {
  it("round-trips every field", () => {
    const g = grant({ meter: true, etag: null });
    const opened = openGrant(ring(T1), mintGrant(ring(T1), g), NOW);
    expect(opened).toEqual(g);
  });

  it("carries the key id in the clear, and nothing else readable", () => {
    const g = grant({
      headers: { "content-disposition": 'attachment; filename="secret-plan.pdf"' },
    });
    const token = mintGrant(ring(T1), g);
    expect(token.startsWith("t1.")).toBe(true);
    const body = Buffer.from(token.slice(3), "base64url").toString("latin1");
    expect(body).not.toContain("secret-plan");
    expect(body).not.toContain("ws-1");
    expect(token).not.toContain(Buffer.from(g.key).toString("base64url"));
  });

  it("is deterministic: the same grant seals to the same URL, a different one does not", () => {
    const g = grant();
    expect(mintGrant(ring(T1), g)).toBe(mintGrant(ring(T1), { ...g }));
    expect(mintGrant(ring(T1), g)).not.toBe(mintGrant(ring(T1), { ...g, size: g.size + 1 }));
    expect(mintGrant(ring(T1), g)).not.toBe(mintGrant(ring(T2), g));
  });

  it("refuses an expired grant, including at the exact second", () => {
    const token = mintGrant(ring(T1), grant({ expiresAt: NOW }));
    expect(openGrant(ring(T1), token, NOW - 1)).not.toBeNull();
    expect(openGrant(ring(T1), token, NOW)).toBeNull();
    expect(openGrant(ring(T1), token, NOW + 1)).toBeNull();
  });

  it("refuses a tampered grant anywhere in its body", () => {
    const token = mintGrant(ring(T1), grant());
    for (const at of [3, 10, Math.floor(token.length / 2), token.length - 3, token.length - 1]) {
      expect(openGrant(ring(T1), tamper(token, at), NOW)).toBeNull();
    }
    expect(openGrant(ring(T1), token.slice(0, -4), NOW)).toBeNull();
    expect(openGrant(ring(T1), `${token}AAAA`, NOW)).toBeNull();
  });

  it("refuses a grant sealed under a key the ring does not hold", () => {
    const token = mintGrant(ring(T2), grant());
    expect(openGrant(ring(T1), token, NOW)).toBeNull();
    // Same id, different key material: authentication fails rather than parsing.
    const impostor = mintGrant(ring(entry("t1")), grant());
    expect(openGrant(ring(T1), impostor, NOW)).toBeNull();
  });

  it("refuses a grant whose key id was swapped for another the ring holds", () => {
    const token = mintGrant(ring(T1), grant());
    const swapped = `t2${token.slice(2)}`;
    expect(openGrant(ring(T2, T1), swapped, NOW)).toBeNull();
  });

  it("refuses junk without throwing", () => {
    for (const junk of ["", ".", "t1.", "t1", "t1.!!!", "nope.AAAA", "x".repeat(10_000)]) {
      expect(openGrant(ring(T1), junk, NOW)).toBeNull();
    }
  });

  it("rotates: a retired key still opens, a dropped one does not", () => {
    const old = mintGrant(ring(T1), grant());
    const fresh = mintGrant(ring(T2, T1), grant());
    expect(fresh.startsWith("t2.")).toBe(true);
    // The Worker during rotation accepts both.
    expect(openGrant(ring(T2, T1), old, NOW)).not.toBeNull();
    expect(openGrant(ring(T2, T1), fresh, NOW)).not.toBeNull();
    // ... and once the old key is dropped, its grants die with it.
    expect(openGrant(ring(T2), old, NOW)).toBeNull();
  });

  it("only carries the response headers the API's byte routes set", () => {
    for (const name of ["set-cookie", "location", "access-control-allow-origin", "Content-Type"]) {
      expect(() => mintGrant(ring(T1), grant({ headers: { [name]: "x" } }))).toThrow(/header/);
    }
    expect(() =>
      mintGrant(
        ring(T1),
        grant({ headers: { "content-disposition": "inline\r\nset-cookie: a=b" } }),
      ),
    ).toThrow(/line break/);
  });

  it("refuses to mint a grant longer than the Worker accepts, and mints one just under", () => {
    const withName = (n: number) =>
      grant({ headers: { "content-disposition": `attachment; filename="${"a".repeat(n)}"` } });
    expect(() => mintGrant(ring(T1), withName(7000))).toThrow(GrantTooLargeError);
    // Find a name that lands just under the limit; it must open again.
    const fits = (size: number) => {
      try {
        mintGrant(ring(T1), withName(size));
        return true;
      } catch {
        return false;
      }
    };
    let n = 5000;
    while (fits(n + 10)) n += 10;
    const token = mintGrant(ring(T1), withName(n));
    expect(token.length).toBeLessThanOrEqual(8192);
    expect(openGrant(ring(T1), token, NOW)).not.toBeNull();
  });

  it("refuses to mint a grant that could never be served", () => {
    expect(() => mintGrant(ring(T1), grant({ key: new Uint8Array(16) }))).toThrow();
    expect(() => mintGrant(ring(T1), grant({ header: new Uint8Array(10) }))).toThrow();
    expect(() => mintGrant(ring(T1), grant({ size: -1 }))).toThrow();
  });
});

describe("grant expiry", () => {
  it("is at least the TTL away and lands on a step, so repeat reads share a URL", () => {
    for (const now of [NOW, NOW + 1, NOW + 899, NOW + 900, NOW + 12345]) {
      const at = grantExpiry(now);
      expect(at - now).toBeGreaterThanOrEqual(GRANT_TTL_SECONDS);
      expect(at - now).toBeLessThan(GRANT_TTL_SECONDS + GRANT_EXPIRY_STEP_SECONDS);
      expect(at % GRANT_EXPIRY_STEP_SECONDS).toBe(0);
    }
    const step = Math.ceil(NOW / GRANT_EXPIRY_STEP_SECONDS) * GRANT_EXPIRY_STEP_SECONDS;
    expect(grantExpiry(step + 1)).toBe(grantExpiry(step + 600));
  });
});

describe("grant key ring", () => {
  it("is off when unset and loud when malformed", () => {
    expect(grantKeyRing(undefined, undefined)).toBeNull();
    expect(grantKeyRing("  ", undefined)).toBeNull();
    expect(() => grantKeyRing("t1:short", undefined)).toThrow(/BLOB_WORKER_TOKEN_KEY is/);
    expect(() => grantKeyRing(T1, "bad")).toThrow(/BLOB_WORKER_TOKEN_KEY_RETIRED/);
  });

  it("refuses key ids that cannot travel in a URL", () => {
    expect(() => grantKeyRing(`a.b:${randomBytes(32).toString("base64")}`, undefined)).toThrow(
      /key id/,
    );
    expect(() => grantKeyRing(T1, `a/b:${randomBytes(32).toString("base64")}`)).toThrow(/key id/);
  });
});

describe("usage reports", () => {
  const report = { workspaceId: "ws-1", bytes: 4096, at: NOW };

  it("round-trips, and two equal reports seal differently", () => {
    const a = sealUsageReport(ring(T1), report);
    expect(openUsageReport(ring(T1), a, NOW)).toEqual(report);
    expect(sealUsageReport(ring(T1), report)).not.toBe(a);
  });

  it("refuses a stale, forged or wrong-key report", () => {
    const sealed = sealUsageReport(ring(T1), report);
    expect(openUsageReport(ring(T1), sealed, NOW + 11 * 60)).toBeNull();
    expect(openUsageReport(ring(T1), sealed, NOW - 11 * 60)).toBeNull();
    expect(openUsageReport(ring(T1), tamper(sealed), NOW)).toBeNull();
    expect(openUsageReport(ring(T2), sealed, NOW)).toBeNull();
  });

  it("never accepts a grant as a report, or a report as a grant", () => {
    const token = mintGrant(ring(T1), grant());
    expect(openUsageReport(ring(T1), token, NOW)).toBeNull();
    expect(openGrant(ring(T1), sealUsageReport(ring(T1), report), NOW)).toBeNull();
  });
});