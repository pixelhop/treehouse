#!/usr/bin/env node
/**
 * Seed a workspace with content for the encryption demo capture, and print the
 * credentials to sign in with. Companion to verify-encryption-e2e.mjs — that
 * one proves the bytes at rest, this one gives the UI something to render.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3457";
const ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3458";

const stamp = Date.now();
const email = `demo${stamp}@example.test`;
const password = "correct-horse-battery-staple";

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
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res;
}

await api("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify({ email, password, name: "Encryption Demo" }),
});
await api("/api/auth/organization/create", {
  method: "POST",
  body: JSON.stringify({ name: `Demo ${stamp}`, slug: `demo-${stamp}` }),
});
const ws = await (
  await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Encrypted Notes", icon: "🔐", color: "green" }),
  })
).json();
const { key } = await (
  await api("/api/keys", {
    method: "POST",
    body: JSON.stringify({ name: "demo-agent", actorType: "agent", workspaceId: ws.id }),
  })
).json();

// A 1x1 lime PNG, so an <img> in the rendered markdown also comes back through
// the decrypting read path rather than only text.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==",
  "base64",
);

async function put(path, body, contentType) {
  const res = await fetch(`${BASE}/api/workspaces/${ws.id}/files/${path}`, {
    method: "PUT",
    headers: { "x-api-key": key, "content-type": contentType, "if-none-match": "*" },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${path} -> ${res.status} ${await res.text()}`);
}

await put("dot.png", PNG, "image/png");
await put(
  "README.md",
  `# Encrypted at rest

Every byte of this file — and the image below — is stored in the blob store as
AES-256-GCM ciphertext under a key belonging to this workspace alone. The page
you are looking at is the decrypted read path.

![a dot](dot.png)

## What is protected

A leaked bucket, a stolen backup, or a misconfigured-public bucket yields
ciphertext only. The workspace's data key lives in the database wrapped under a
master key held in the API's environment, so neither store is useful alone.

## What is not

File **names** and **sizes** stay in cleartext in Postgres, because listing and
incremental sync need them. This protects the bytes, not the shape.
`,
  "text/markdown",
);
await put(
  "notes/todo.md",
  "# Todo\n\n- [x] encrypt the bytes\n- [ ] tell everyone\n",
  "text/markdown",
);

const creds = { base: BASE, email, password, workspaceId: ws.id, apiKey: key };
// A fresh private directory, owner-only, and `wx` so an existing path (or a
// planted symlink) is an error rather than something we write through.
const dir = await mkdtemp(join(tmpdir(), "th-demo-"));
const credsPath = join(dir, "creds.json");
await writeFile(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(creds, null, 2));
console.log(`\ncredentials written to ${credsPath}`);