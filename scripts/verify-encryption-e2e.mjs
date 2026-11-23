#!/usr/bin/env node
/**
 * End-to-end verification of encryption at rest against a RUNNING api server.
 *
 * Drives the real HTTP surface exactly as a client would — sign up, create a
 * workspace, mint an agent key, write a file — then reads the object that
 * actually landed in the blob store and proves it is ciphertext, while the API
 * still returns the original bytes.
 *
 * Usage:
 *   BASE=http://localhost:3457 BLOB_DIR=/tmp/th-e2e-blobs node scripts/verify-encryption-e2e.mjs
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3457";
const BLOB_DIR = process.env.BLOB_DIR ?? "/tmp/th-e2e-blobs";
// better-auth rejects credentialed calls without a trusted Origin, so present
// the same one the browser app would.
const ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";

const SECRET = "PLAINTEXT-CANARY-swordfish-hunter2";
const out = [];
function say(line = "") {
  out.push(line);
  console.log(line);
}

function hexdump(bytes, limit = 96) {
  const slice = bytes.subarray(0, limit);
  const lines = [];
  for (let i = 0; i < slice.length; i += 16) {
    const row = slice.subarray(i, i + 16);
    const hex = [...row]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47);
    const ascii = [...row]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (bytes.length > limit) lines.push(`... (${bytes.length} bytes total)`);
  return lines.join("\n");
}

let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  return res;
}

function assert(ok, label) {
  say(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

const stamp = Date.now();

say("Treehouse — encryption at rest, end-to-end verification");
say(`server ${BASE}   blob store ${BLOB_DIR}`);
say();

// --- 1. Real client flow: sign up, workspace, agent key, write a file --------
const signup = await api("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify({
    email: `e2e${stamp}@example.test`,
    password: "correct-horse-battery-staple",
    name: "E2E",
  }),
});
if (!signup.ok) throw new Error(`sign-up failed: ${signup.status} ${await signup.text()}`);

const org = await api("/api/auth/organization/create", {
  method: "POST",
  body: JSON.stringify({ name: `E2E Org ${stamp}`, slug: `e2e-${stamp}` }),
});
if (!org.ok) throw new Error(`org create failed: ${org.status} ${await org.text()}`);

const wsRes = await api("/api/workspaces", {
  method: "POST",
  body: JSON.stringify({ name: "Encryption E2E" }),
});
if (!wsRes.ok) throw new Error(`workspace create failed: ${wsRes.status} ${await wsRes.text()}`);
const ws = await wsRes.json();

const keyRes = await api("/api/keys", {
  method: "POST",
  body: JSON.stringify({ name: "e2e-agent", actorType: "agent", workspaceId: ws.id }),
});
if (!keyRes.ok) throw new Error(`key mint failed: ${keyRes.status} ${await keyRes.text()}`);
const { key } = await keyRes.json();

say(`workspace ${ws.id}`);
say();

const put = await fetch(`${BASE}/api/workspaces/${ws.id}/files/secret.md`, {
  method: "PUT",
  headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
  body: SECRET,
});
if (!put.ok) throw new Error(`PUT failed: ${put.status} ${await put.text()}`);

// --- 2. What actually landed in the blob store -------------------------------
say("1. The object that landed in the blob store");
say();
// Listed in-process rather than shelled out: no quoting concerns, and no
// dependence on which `find` implementation is on PATH.
async function blobsIn(dir) {
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    if (name.endsWith(".ct")) continue;
    const full = join(dir, name);
    const info = await stat(full);
    if (info.isFile()) out.push({ path: full, mtimeMs: info.mtimeMs });
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

const wsDir = join(BLOB_DIR, ws.id);
const firstBlobs = await blobsIn(wsDir);
const found = firstBlobs[0]?.path;
if (!found) throw new Error(`no blob found under ${wsDir}`);
const stored = new Uint8Array(await readFile(found));
say(`   ${found.replace(BLOB_DIR, "$BLOB_DIR")}`);
say();
say(
  hexdump(stored)
    .split("\n")
    .map((l) => `   ${l}`)
    .join("\n"),
);
say();

const asText = Buffer.from(stored).toString("latin1");
assert(!asText.includes(SECRET), "stored bytes do not contain the plaintext");
assert(
  stored[0] === 0x54 && stored[1] === 0x48 && stored[2] === 0x45 && stored[3] === 0x00,
  'stored bytes carry the encryption format marker ("THE\\0")',
);
assert(stored.length > SECRET.length, "stored bytes are framed (header + sealed chunk)");
say();

// --- 3. The API still returns the original bytes -----------------------------
say("2. Reads still round-trip through the API");
say();
const get = await fetch(`${BASE}/api/workspaces/${ws.id}/files/secret.md`, {
  headers: { "x-api-key": key },
});
const body = await get.text();
say(`   GET /files/secret.md -> ${get.status}`);
say(`   body: ${JSON.stringify(body)}`);
assert(get.status === 200, "read returns 200");
assert(body === SECRET, "read returns the exact plaintext that was written");
say();

// --- 4. Conditional request skips the blob entirely --------------------------
say("3. A repeat view answers 304 without touching the blob store");
say();
const etag = get.headers.get("etag");
const cond = await fetch(`${BASE}/api/workspaces/${ws.id}/files/secret.md`, {
  headers: { "x-api-key": key, "if-none-match": etag ?? "" },
});
say(`   ETag: ${etag}   Cache-Control: ${get.headers.get("cache-control")}`);
say(`   GET with If-None-Match -> ${cond.status}`);
assert(cond.status === 304, "matching validator returns 304");
assert(
  (get.headers.get("cache-control") ?? "").includes("private"),
  "cached as private, not public",
);
say();

// --- 5. Legacy plaintext blobs still read ------------------------------------
say("4. A blob written before encryption still reads (no migration needed)");
say();
const legacyText = "# Written before encryption existed\n";
const legacyPut = await fetch(`${BASE}/api/workspaces/${ws.id}/files/legacy.md`, {
  method: "PUT",
  headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
  body: legacyText,
});
if (!legacyPut.ok) throw new Error(`legacy PUT failed: ${legacyPut.status}`);
const legacyBlob = (await blobsIn(wsDir)).map((b) => b.path).find((p) => p !== found);
if (!legacyBlob) throw new Error("could not locate the legacy blob that was just written");
// Overwrite it with raw plaintext, simulating a pre-encryption object.
await writeFile(legacyBlob, legacyText);
const legacyGet = await fetch(`${BASE}/api/workspaces/${ws.id}/files/legacy.md`, {
  headers: { "x-api-key": key },
});
const legacyBody = await legacyGet.text();
say(`   replaced the stored object with raw plaintext, then read it back`);
say(`   GET /files/legacy.md -> ${legacyGet.status}`);
assert(
  legacyGet.status === 200 && legacyBody === legacyText,
  "legacy plaintext blob reads unchanged",
);
say();

// --- 6. A tampered blob fails loudly -----------------------------------------
say("5. A tampered blob fails loudly rather than reading as missing or corrupt");
say();
const damaged = new Uint8Array(stored);
damaged[damaged.length - 1] ^= 0x01;
await writeFile(found, damaged);
const tampered = await fetch(`${BASE}/api/workspaces/${ws.id}/files/secret.md`, {
  headers: { "x-api-key": key },
});
say(`   flipped one bit in the stored object`);
say(`   GET /files/secret.md -> ${tampered.status}`);
assert(tampered.status >= 500, "tampering surfaces as a server error, not 200/404/502-as-missing");
const tamperedBody = await tampered.text();
assert(!tamperedBody.includes(SECRET), "no plaintext leaks in the error response");
say();

// --- 7. A marked blob with a broken header must not leak ciphertext ----------
say("6. A blob carrying the marker but a broken header fails, rather than");
say("   handing the raw ciphertext back as file content");
say();
// Distinct bytes: blobs are content-addressed, so reusing SECRET here would
// dedup onto the object step 5 already damaged.
const MARKED_SECRET = `${SECRET}-marked-header-case`;
const reMark = await fetch(`${BASE}/api/workspaces/${ws.id}/files/marked.md`, {
  method: "PUT",
  headers: { "x-api-key": key, "content-type": "text/markdown", "if-none-match": "*" },
  body: MARKED_SECRET,
});
if (!reMark.ok) throw new Error(`marked PUT failed: ${reMark.status}`);
const markedBlob = (await blobsIn(wsDir))
  .map((b) => b.path)
  .find((p) => p !== found && p !== legacyBlob);
if (!markedBlob) throw new Error("could not locate the blob just written");
const marked = new Uint8Array(await readFile(markedBlob));
marked[4] = 0x02; // format version 1 -> 2, leaving the magic marker intact
await writeFile(markedBlob, marked);
const markedGet = await fetch(`${BASE}/api/workspaces/${ws.id}/files/marked.md`, {
  headers: { "x-api-key": key },
});
const markedBody = await markedGet.text();
say(`   flipped the format-version byte (the magic marker still matches)`);
say(`   GET /files/marked.md -> ${markedGet.status}`);
assert(markedGet.status >= 500, "an unreadable header is an integrity failure, not a 200");
assert(!markedBody.includes(MARKED_SECRET), "no plaintext leaks");
say();

say(process.exitCode ? "RESULT: FAILURES ABOVE" : "RESULT: all checks passed");
await writeFile("/tmp/th-e2e-report.txt", `${out.join("\n")}\n`);