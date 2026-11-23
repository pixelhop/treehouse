import { describe, expect, it } from "vite-plus/test";
import { asMember } from "./access";
import { useTempBlobDir } from "./blob-env";
import "./env";

useTempBlobDir("treehouse-recovery-request-");

const { planFromBody } = await import("../server/utils/recovery-request");
const { limitBlocking } = await import("../server/utils/recovery");

const ctx = { userId: "u1", principal: "human" as const };
const access = asMember("u1");
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { statusCode?: number }) => e.statusCode,
  );

describe("recovery request bodies", () => {
  it("rejects an unknown or missing kind, including inherited property names", async () => {
    expect(await status(planFromBody("ws", ctx, access, {}))).toBe(400);
    expect(await status(planFromBody("ws", ctx, access, { kind: "nope" }))).toBe(400);
    expect(await status(planFromBody("ws", ctx, access, { kind: "constructor" }))).toBe(400);
    expect(await status(planFromBody("ws", ctx, access, null))).toBe(400);
  });

  it("requires a non-empty list of path strings for the trash", async () => {
    for (const paths of [undefined, [], [""], [1], "a.md"]) {
      expect(await status(planFromBody("ws", ctx, access, { kind: "trash", paths }))).toBe(400);
    }
    expect(
      await status(
        planFromBody("ws", ctx, access, { kind: "trash", paths: Array(5001).fill("a.md") }),
      ),
    ).toBe(400);
  });
});

describe("undo requests", () => {
  const since = "2026-10-29T10:00:00Z";
  it("needs a key and a valid moment", async () => {
    expect(await status(planFromBody("ws", ctx, access, { kind: "undo", since }))).toBe(400);
    expect(
      await status(planFromBody("ws", ctx, access, { kind: "undo", keyId: "k1", since: "soon" })),
    ).toBe(400);
  });

  it("lets an API key undo only its own changes", async () => {
    const asKey = { ...ctx, keyId: "k1" };
    expect(
      await status(planFromBody("ws", asKey, access, { kind: "undo", keyId: "k2", since })),
    ).toBe(403);
  });
});

describe("limitBlocking", () => {
  const limits = {
    storageBytes: 100,
    files: 2,
    maxFileBytes: 50,
    readOnly: false,
  } as Parameters<typeof limitBlocking>[2];
  const recreate = (size: number) =>
    ({
      kind: "recreate",
      path: "a",
      contentHash: "h",
      size,
      deletedAt: 1n,
      keepPrivateTo: null,
    }) as const;

  it("lets deletes and plain moves through, whatever the limits", () => {
    const used = { bytes: 1000, files: 1000 };
    const ro = { ...limits, readOnly: true };
    expect(
      limitBlocking({ kind: "delete", path: "a", baseVersion: 1, size: 9 }, used, ro),
    ).toBeNull();
    expect(
      limitBlocking(
        {
          kind: "move",
          from: "b",
          path: "a",
          baseVersion: 1,
          size: 9,
          currentSize: 9,
          contentHash: null,
          keepPrivateTo: null,
        },
        used,
        ro,
      ),
    ).toBeNull();
  });

  it("names the limit content going back would break", () => {
    expect(limitBlocking(recreate(10), { bytes: 0, files: 0 }, { ...limits, readOnly: true })).toBe(
      "read_only",
    );
    expect(limitBlocking(recreate(60), { bytes: 0, files: 0 }, limits)).toBe("too_large");
    expect(limitBlocking(recreate(10), { bytes: 0, files: 2 }, limits)).toBe("file_limit");
    expect(limitBlocking(recreate(10), { bytes: 95, files: 0 }, limits)).toBe("storage_limit");
    expect(limitBlocking(recreate(10), { bytes: 0, files: 0 }, limits)).toBeNull();
  });

  it("only counts a restore's growth against storage", () => {
    const restore = {
      kind: "restore",
      path: "a",
      contentHash: "h",
      size: 40,
      baseVersion: 1,
      currentSize: 30,
      keepPrivateTo: null,
    } as const;
    expect(limitBlocking(restore, { bytes: 90, files: 2 }, limits)).toBeNull();
    expect(limitBlocking(restore, { bytes: 91, files: 2 }, limits)).toBe("storage_limit");
  });
});