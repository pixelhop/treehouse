import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLOADED_ICON_PREFIX, uploadedIconHash } from "shared";
import { describe, expect, it } from "vite-plus/test";

// Filesystem blob driver, so importing the module graph never reaches for R2.
process.env.BLOB_DIR = mkdtempSync(join(tmpdir(), "treehouse-icons-"));
delete process.env.R2_ENDPOINT;

const { sniffImageType, assertSettableIcon, iconBlobKey } =
  await import("../server/utils/workspaceIcon");
const { splitBlobKey } = await import("../server/utils/storage");

const png = (extra: number[] = []) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);
const HASH = "a".repeat(64);

describe("uploaded icon values", () => {
  it("parses an upload: value into its hash", () => {
    expect(uploadedIconHash(`${UPLOADED_ICON_PREFIX}${HASH}`)).toBe(HASH);
  });

  it("treats emoji, Iconify names and empty values as non-uploads", () => {
    expect(uploadedIconHash("🌳")).toBeNull();
    expect(uploadedIconHash("solar:folder-bold-duotone")).toBeNull();
    expect(uploadedIconHash(null)).toBeNull();
  });

  // The hash is spliced into a blob key and a URL path, so a value that isn't a
  // plain sha256 must not be accepted as one.
  it("rejects a malformed hash rather than passing it through", () => {
    expect(uploadedIconHash(`${UPLOADED_ICON_PREFIX}../../etc/passwd`)).toBeNull();
    expect(uploadedIconHash(`${UPLOADED_ICON_PREFIX}${"A".repeat(64)}`)).toBeNull();
    expect(uploadedIconHash(UPLOADED_ICON_PREFIX)).toBeNull();
  });

  it("keys blobs per workspace", () => {
    expect(iconBlobKey("ws1", HASH)).toBe(`ws1/icon-${HASH}`);
  });

  // Icon bytes go through the same blob store as file bytes, which binds every
  // object to the workspace it belongs to by splitting `<workspaceId>/<hash>`
  // out of the key — and refuses to guess at a nested one. A key that does not
  // split is not a tidiness problem: encryption is off until a KEK is set, so
  // it would pass every local run and throw on the first upload in production.
  it("produces a key the encrypting store can bind to a workspace", () => {
    expect(splitBlobKey(iconBlobKey("ws1", HASH))).toEqual({
      workspaceId: "ws1",
      contentHash: `icon-${HASH}`,
    });
  });

  // Sharing the file namespace would mean a logo also stored as a file in the
  // workspace hashes to the same key, and swapping the icon deletes the file.
  it("does not collide with the key a file of the same bytes would use", () => {
    expect(iconBlobKey("ws1", HASH)).not.toBe(`ws1/${HASH}`);
  });
});

describe("image sniffing", () => {
  it("identifies the formats we store", () => {
    expect(sniffImageType(png())).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a...."))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF????WEBPVP8 "))).toBe("image/webp");
  });

  it("rejects anything else, including SVG and HTML dressed as an image", () => {
    expect(
      sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("assertSettableIcon", () => {
  it("allows emoji and Iconify names", () => {
    expect(() => assertSettableIcon("🌳", null)).not.toThrow();
    expect(() => assertSettableIcon("solar:folder-bold-duotone", null)).not.toThrow();
    expect(() => assertSettableIcon(null, `${UPLOADED_ICON_PREFIX}${HASH}`)).not.toThrow();
  });

  it("allows echoing back the icon the workspace already wears", () => {
    const current = `${UPLOADED_ICON_PREFIX}${HASH}`;
    expect(() => assertSettableIcon(current, current)).not.toThrow();
  });

  // Otherwise a PATCH could point a workspace at another workspace's blob.
  it("refuses an invented upload: pointer", () => {
    expect(() => assertSettableIcon(`${UPLOADED_ICON_PREFIX}${"b".repeat(64)}`, null)).toThrow();
    expect(() =>
      assertSettableIcon(
        `${UPLOADED_ICON_PREFIX}${"b".repeat(64)}`,
        `${UPLOADED_ICON_PREFIX}${HASH}`,
      ),
    ).toThrow();
  });
});