#!/usr/bin/env node
/**
 * READ-ONLY pre-flight check before deploying encryption at rest.
 *
 * Every blob written before this feature is plaintext, and the new read path
 * verifies plaintext against the content hash it is keyed by. That check is
 * what stops someone with bucket write access substituting content — but it
 * also means any pre-existing blob whose bytes do NOT hash to its key would
 * stop being readable.
 *
 * In principle none can: `blobKeyFor` has been `<workspaceId>/<sha256(body)>`
 * since the first commit, and both write paths key by the hash of the exact
 * bytes they store. This turns that reasoning into a fact about YOUR data.
 *
 * Writes nothing. Reads every live FileNode's blob and reports.
 *
 * Set `BLOB_KEK` as well to fully authenticate any already-encrypted blobs
 * rather than merely recognising their header. Without it they are counted but
 * reported as unverified, and the result says so.
 *
 * Usage (against production credentials):
 *   cd packages/api
 *   DATABASE_URL=... R2_ENDPOINT=... R2_BUCKET=... \
 *   R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... BLOB_KEK=... \
 *     pnpm exec tsx scripts/preflight-encryption.mts
 *
 * `PREFLIGHT_ACCEPT_MISSING=<n>` acknowledges up to n blobs already absent from
 * the store (pre-existing data loss, unrelated to this change). Without it, any
 * missing blob makes the result inconclusive rather than a pass.
 */
import { createHash } from "node:crypto";
import { usePrismaClient } from "db";
import { classifyBlob } from "blob-io/blob-crypto";
import { resolveBlobStore } from "../server/utils/storage";

const db = usePrismaClient();

const STORAGE = {
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  BLOB_DIR: process.env.BLOB_DIR,
};

// Two views of the same store. The bare driver shows the bytes as they really
// sit at rest; the wrapped one applies exactly the checks the running API will,
// so "this blob is fine" means the app can actually open it.
const rawStore = resolveBlobStore({ ...STORAGE, BLOB_KEK: undefined } as NodeJS.ProcessEnv);
const appStore = process.env.BLOB_KEK
  ? resolveBlobStore({ ...STORAGE, BLOB_KEK: process.env.BLOB_KEK } as NodeJS.ProcessEnv)
  : null;

const acceptMissing = Number(process.env.PREFLIGHT_ACCEPT_MISSING ?? 0);

const nodes = await db.fileNode.findMany({
  select: { workspaceId: true, path: true, blobKey: true },
  orderBy: { createdAt: "asc" },
});

console.log(`Checking ${nodes.length} live file(s)...`);
if (!appStore) {
  console.log("(no BLOB_KEK set — encrypted blobs will be recognised but not authenticated)");
}
console.log();

const problems: { workspaceId: string; path: string; why: string }[] = [];
let plaintextOk = 0;
let encryptedVerified = 0;
let encryptedUnverified = 0;
let missing = 0;

for (const n of nodes) {
  const fail = (why: string) => problems.push({ workspaceId: n.workspaceId, path: n.path, why });

  const raw = await rawStore.get(n.blobKey).catch((e: Error) => ({ error: e }) as const);
  if (raw && "error" in raw) {
    fail(`read failed: ${raw.error.message}`);
    continue;
  }
  if (!raw) {
    // Already broken today — the row points at bytes that are not there.
    missing++;
    continue;
  }

  // Structural classification, not a four-byte marker test: bytes that carry
  // the marker but will not parse are exactly what the app now refuses to
  // serve, so they must not be counted as healthy here either.
  const kind = classifyBlob(raw.body);

  if (kind === "malformed") {
    fail("carries the encryption marker but its header will not parse");
    continue;
  }

  if (kind === "legacy") {
    const actual = createHash("sha256").update(raw.body).digest("hex");
    const keyHash = n.blobKey.split("/")[1];
    if (actual !== keyHash) {
      fail(
        `plaintext blob hashes to ${actual.slice(0, 12)}… but is keyed by ${String(keyHash).slice(0, 12)}…`,
      );
    } else {
      plaintextOk++;
    }
    continue;
  }

  // Encrypted. Recognising the header proves nothing about whether it opens, so
  // put it through the same wrapper the API uses when a key is available.
  if (!appStore) {
    encryptedUnverified++;
    continue;
  }
  const opened = await appStore.get(n.blobKey).catch((e: Error) => ({ error: e }) as const);
  if (opened && "error" in opened) {
    fail(`encrypted blob failed to open: ${opened.error.message}`);
  } else if (!opened) {
    fail("encrypted blob vanished between reads");
  } else {
    encryptedVerified++;
  }
}

console.log(`  ${plaintextOk} plaintext blob(s) verify against their key — these keep working`);
console.log(`  ${encryptedVerified} encrypted blob(s) decrypt successfully`);
if (encryptedUnverified)
  console.log(`  ${encryptedUnverified} encrypted blob(s) NOT verified (no BLOB_KEK)`);
console.log(`  ${missing} missing from the blob store`);
console.log(`  ${problems.length} would STOP being readable after this deploy\n`);

if (problems.length) {
  console.log("Affected files:");
  for (const p of problems.slice(0, 50)) console.log(`  ${p.workspaceId}/${p.path} — ${p.why}`);
  if (problems.length > 50) console.log(`  ... and ${problems.length - 50} more`);
  console.log();
}

// Verdict. Anything short of "every live blob was read and checked" is
// inconclusive rather than a pass — a wrong bucket that happens to share a few
// keys, or a store where most objects are absent, must not read as success.
const reachable = plaintextOk + encryptedVerified + encryptedUnverified;
const unacknowledgedMissing = Math.max(0, missing - acceptMissing);

if (problems.length) {
  console.log("RESULT: do NOT deploy until the files above are understood.");
  process.exitCode = 1;
} else if (nodes.length > 0 && reachable === 0) {
  console.log("RESULT: INCONCLUSIVE — not one blob was readable.");
  console.log("This usually means the storage credentials point somewhere other than");
  console.log("the store these files live in. Check R2_* / BLOB_DIR and re-run.");
  process.exitCode = 2;
} else if (unacknowledgedMissing > 0) {
  console.log(`RESULT: INCONCLUSIVE — ${unacknowledgedMissing} live file(s) have no blob.`);
  console.log("Either the storage config is wrong, or these are pre-existing losses.");
  console.log("Confirm which, then re-run with PREFLIGHT_ACCEPT_MISSING=<count> to");
  console.log("acknowledge them.");
  process.exitCode = 2;
} else if (encryptedUnverified > 0) {
  console.log(`RESULT: PARTIAL — ${encryptedUnverified} encrypted blob(s) were recognised but`);
  console.log("not opened. Re-run with BLOB_KEK set to authenticate them.");
  process.exitCode = 2;
} else {
  console.log("RESULT: safe to deploy — every live blob was read and checked.");
}

await db.$disconnect();