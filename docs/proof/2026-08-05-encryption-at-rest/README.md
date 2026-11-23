# Proof: encryption at rest

Evidence captured against a running stack for
`docs/plans/2026-08-05-001-feat-workspace-file-encryption-plan.md`.

A video would show nothing useful here — nothing moves, and the claim is about
bytes at rest. The convincing artefacts are a hexdump of what actually landed in
the blob store, and the app rendering the same file back.

## Reproducing

```bash
# API with encryption on, filesystem driver, scratch database
BLOB_KEK="v1:$(openssl rand -base64 32)" BLOB_DIR=/tmp/th-e2e-blobs \
  pnpm --filter api dev

BASE=http://localhost:3457 BLOB_DIR=/tmp/th-e2e-blobs \
  node scripts/verify-encryption-e2e.mjs
```

`scripts/seed-encryption-demo.mjs` seeds a workspace with a markdown file and an
image if you want the UI to have something to render.

## Files

| File                               | What it shows                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e-verification.txt`             | Full output of the end-to-end run: a hexdump of the stored object, the round-trip read, the 304 path, legacy-plaintext tolerance, and tamper detection. |
| `app-rendering-encrypted-file.png` | The web app rendering a markdown file and an embedded PNG whose stored bytes are ciphertext.                                                            |

## What the hexdump decodes to

```
54 48 45 00   magic "THE\0"          — the format marker
01            format version 1
00 00 00 01   key generation 1       — which DEK sealed this blob
00 10 00 00   chunk size 0x00100000  — 1 MiB
<32 bytes>    salt                   — HKDF input, fresh per blob
<7 bytes>     nonce prefix           — fresh per blob
<sealed chunks>                      — AES-256-GCM, 16-byte tag each
```

For the 34-byte canary the stored object is 102 bytes: a 52-byte header, 34
bytes of ciphertext, and a 16-byte tag.

## What this does not prove

The bytes are protected; the shape is not. File names, sizes, and content types
stay in cleartext in Postgres because listing and incremental sync need them.
Anyone who can read the API process or its environment can still read plaintext
— that is the threat model, stated in the plan, not an oversight.