import { createHash, randomBytes } from "node:crypto";
import { UPLOADED_ICON_PREFIX } from "shared";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useTempBlobDir } from "./blob-env";

useTempBlobDir("treehouse-icon-cleanup-");

/**
 * Icon writes span two stores — the pointer in Postgres, the bytes in the blob
 * store — so cleaning up a replaced icon is a compare-and-delete across both.
 * These tests stand in a fake for each store and drive the interleavings by
 * hand, including the one that defeated two earlier lock-free attempts.
 *
 * The fake `$transaction` is a real per-key mutex, because that is the property
 * `pg_advisory_xact_lock` buys and the property under test. It also ASSERTS the
 * lock is actually taken, so removing the lock fails the suite rather than
 * quietly reducing it to testing nothing.
 */

/** Serializes on the advisory-lock key, like Postgres does. */
const held = new Map<string, Promise<unknown>>();

/** Runs once the upload's bytes exist but before it publishes its pointer. */
let afterBytesLand: (() => void | Promise<void>) | null = null;

let lockTaken = 0;

/**
 * Committed state. Transactions read through their own staged writes and only
 * fold them in here on commit, so a rollback can be modelled honestly — the
 * previous version of this fake always committed, which is precisely why it
 * could not see a blob deleted by a transaction that then failed.
 */
const committed: { icon: string | null } = { icon: null };

/** Set by a test to make the NEXT transaction fail after its callback returns. */
let failNextCommit = false;

function makeDelegate(staged: { icon?: string | null }) {
  return {
    findUnique: async () => ({ icon: "icon" in staged ? staged.icon! : committed.icon }),
    update: async ({ data }: { data: { icon?: string | null } }) => {
      if (data.icon !== undefined) staged.icon = data.icon;
      const icon = "icon" in staged ? staged.icon! : committed.icon;
      return { id: "ws", name: "ws", icon, color: null, theme: null, themeCss: null };
    },
  };
}

vi.mock("db", () => ({
  usePrismaClient: () => ({
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      let release = () => {};
      const staged: { icon?: string | null } = {};
      const tx = {
        workspace: makeDelegate(staged),
        // The lock is ACQUIRED here, not before `fn` runs — the key is only
        // known from the query itself, which is exactly how the real
        // pg_advisory_xact_lock behaves. Getting this wrong made an earlier
        // version of this fake serialize everything on one key, which passed
        // whether or not the code under test took a lock at all.
        $executeRaw: async (strings: TemplateStringsArray, ...vals: unknown[]) => {
          expect(strings.join("?")).toContain("pg_advisory_xact_lock");
          const key = String(vals[0]);
          lockTaken += 1;
          const previous = held.get(key) ?? Promise.resolve();
          let mineDone!: () => void;
          const mine = new Promise<void>((r) => (mineDone = r));
          held.set(key, mine); // queue behind whoever holds it, FIFO
          release = mineDone;
          await previous.catch(() => {});
          return 1;
        },
      };
      try {
        const out = await fn(tx);
        if (failNextCommit) {
          // Staged writes are discarded, exactly as a rollback discards them.
          throw new Error("transaction failed to commit");
        }
        if ("icon" in staged) committed.icon = staged.icon!;
        return out;
      } finally {
        release(); // transaction-scoped: released on commit or rollback
      }
    },
  }),
}));

const blobs = new Map<string, Uint8Array>();
const { setStorageForTesting } = await import("../server/utils/storage");
setStorageForTesting({
  put: async (key, body) => {
    blobs.set(key, body);
    // Fires with the bytes written but the pointer not yet published — the gap
    // the reviewer's interleaving exploits.
    if (afterBytesLand) {
      const hook = afterBytesLand;
      afterBytesLand = null;
      await hook();
    }
  },
  get: async (key) => {
    const body = blobs.get(key);
    return body ? { body, contentType: "image/png" } : null;
  },
  delete: async (key) => void blobs.delete(key),
  // Icons are small and never streamed.
  putSource: () => Promise.reject(new Error("not used by icons")),
  open: () => Promise.reject(new Error("not used by icons")),
  stat: () => Promise.reject(new Error("not used by icons")),
});

const { deleteReplacedIcon, iconBlobKey, setUploadedWorkspaceIcon, withWorkspaceIconLock } =
  await import("../server/utils/workspaceIcon");

const WS = "ws_race";
const A = "a".repeat(64);
const B = "b".repeat(64);
const upload = (hash: string) => `${UPLOADED_ICON_PREFIX}${hash}`;
const keyA = iconBlobKey(WS, A);

const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A real PNG signature, so sniffing accepts it. */
const png = (tag: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag]);

beforeEach(() => {
  blobs.clear();
  blobs.set(keyA, randomBytes(8));
  held.clear();
  afterBytesLand = null;
  lockTaken = 0;
  failNextCommit = false;
  committed.icon = upload(B);
});

describe("deleteReplacedIcon", () => {
  it("drops the bytes of an icon the workspace has moved off", async () => {
    await withWorkspaceIconLock(WS, (tx) => deleteReplacedIcon(tx, WS, upload(A), upload(B)));
    expect(blobs.has(keyA)).toBe(false);
    expect(committed.icon).toBe(upload(B));
  });

  it("keeps the bytes when the workspace still wears that icon", async () => {
    committed.icon = upload(A);
    await withWorkspaceIconLock(WS, (tx) => deleteReplacedIcon(tx, WS, upload(A), null));
    expect(blobs.has(keyA)).toBe(true);
    expect(committed.icon).toBe(upload(A));
  });

  it("does nothing when the icon did not change", async () => {
    await withWorkspaceIconLock(WS, (tx) => deleteReplacedIcon(tx, WS, upload(A), upload(A)));
    expect(blobs.has(keyA)).toBe(true);
  });

  it("takes the advisory lock", async () => {
    await withWorkspaceIconLock(WS, (tx) => deleteReplacedIcon(tx, WS, upload(A), upload(B)));
    expect(lockTaken).toBe(1);
  });
});

describe("concurrent icon writes", () => {
  // The interleaving that defeated the post-delete reconciliation: the upload
  // has written its bytes but has NOT yet committed its pointer when cleanup
  // runs. Every unlocked recheck reads the old pointer, deletes the bytes and
  // sees nothing to repair — and then the upload publishes a pointer to bytes
  // that are gone. Serializing the whole write is what closes it.
  it("never publishes a pointer to bytes a concurrent cleanup deleted", async () => {
    const bytesA = png(1);
    blobs.clear();
    committed.icon = upload(B);
    blobs.set(iconBlobKey(WS, B), randomBytes(8));

    // With the upload's bytes written but its pointer not yet committed, start
    // the cleanup that would take those bytes and give it room to finish.
    // Unsynchronised it runs straight through: it reads the OLD pointer, sees
    // nothing referencing the new hash, and deletes it. Under the lock it
    // blocks here and only runs after the upload commits, by which point the
    // pointer names the hash and it correctly leaves the bytes alone.
    let cleanup: Promise<unknown> = Promise.resolve();
    afterBytesLand = async () => {
      cleanup = withWorkspaceIconLock(WS, (tx) =>
        deleteReplacedIcon(tx, WS, upload(hashOf(bytesA)), committed.icon),
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 5));
    };

    const updated = await setUploadedWorkspaceIcon(WS, bytesA);
    await cleanup;

    // Whatever the workspace ended up wearing, its bytes must exist.
    expect(updated.icon).toBe(upload(hashOf(bytesA)));
    expect(committed.icon).toBe(updated.icon);
    expect(blobs.has(iconBlobKey(WS, hashOf(bytesA)))).toBe(true);
  });

  // A blob delete cannot be rolled back, so it must not run inside the
  // transaction that publishes the pointer. If it does, a commit that fails
  // afterwards restores the OLD icon in Postgres while its bytes are already
  // gone — no concurrency required, just one writer and one failed commit.
  it("keeps the old icon's bytes when the replacement fails to commit", async () => {
    blobs.clear();
    committed.icon = upload(A);
    blobs.set(keyA, randomBytes(8));

    failNextCommit = true;
    await expect(setUploadedWorkspaceIcon(WS, png(9))).rejects.toThrow();

    // The workspace still wears A, so A's bytes have to still be there.
    expect(committed.icon).toBe(upload(A));
    expect(blobs.has(keyA)).toBe(true);
  });

  it("does not clean up at all when the publishing transaction fails", async () => {
    blobs.clear();
    committed.icon = upload(A);
    blobs.set(keyA, randomBytes(8));
    failNextCommit = true;
    await expect(setUploadedWorkspaceIcon(WS, png(9))).rejects.toThrow();
    // One transaction attempted, not two: cleanup is only reached after a
    // successful publish.
    expect(lockTaken).toBe(1);
  });

  it("serializes two uploads so the survivor's bytes are present", async () => {
    blobs.clear();
    committed.icon = null;
    const [one, two] = await Promise.all([
      setUploadedWorkspaceIcon(WS, png(1)),
      setUploadedWorkspaceIcon(WS, png(2)),
    ]);
    // Last writer wins the pointer, and the pointer is never a lie.
    expect([one.icon, two.icon]).toContain(committed.icon);
    const hash = committed.icon!.slice(UPLOADED_ICON_PREFIX.length);
    expect(blobs.has(iconBlobKey(WS, hash))).toBe(true);
    // Two uploads, each taking the lock twice: publish, then clean up.
    expect(lockTaken).toBe(4);
  });
});