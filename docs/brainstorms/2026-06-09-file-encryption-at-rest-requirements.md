---
date: 2026-06-09
topic: file-encryption-at-rest
---

# File Encryption at Rest (Tier 1, Treehouse-managed key)

## Summary

Encrypt all file bytes stored in the blob store at rest, transparently at the `BlobStore` seam, using a single Treehouse-held master key — so a leaked R2 bucket or backup dump is unreadable on its own, while agents, web preview, dedup, and version history keep working unchanged. The on-disk format is chunked/streaming-ready from day one so it never needs re-encrypting when large-file handling arrives later.

---

## Problem Frame

Treehouse stores every file's bytes in a blob store (R2 in deployed environments, local FS in dev) keyed by content hash, with metadata in Postgres. Today those bytes are written and read in plaintext: anyone who obtains the bucket contents — a leaked R2 credential, a misconfigured-public bucket, a stolen backup or disk image — can read every file in every workspace directly, with no further compromise required.

That is the gap this work closes: the most realistic data-exposure path for a hosted file workspace is the storage layer leaking independently of the application, and right now such a leak hands over cleartext. The cost is a full-fidelity breach of customer file contents from a single misplaced credential or backup.

This is deliberately scoped to the _infrastructure-at-rest_ threat. It does not attempt to protect against an attacker who can execute code in the API process or read its environment, and it does not attempt to hide file contents from Treehouse-the-operator — those are a different (zero-knowledge) product with a different relationship to the agent-native design.

---

## Requirements

**Encryption at the storage boundary**

- R1. All blob bytes are encrypted before they are persisted to the blob store and decrypted after they are fetched, at the `BlobStore` seam (`packages/api/server/utils/storage.ts`), so no calling code (`files.ts`, REST routes, MCP tools, CLI) changes.
- R2. Encryption uses an authenticated cipher (AES-256-GCM) so a tampered or corrupted stored blob fails decryption loudly rather than returning corrupted plaintext.
- R3. The stored object is self-describing: it carries the information needed to decrypt it (format/version marker, key identifier, per-encryption nonce, auth tag) without requiring a schema change to the Treehouse Prisma models.
- R4. The encrypted blob format is chunked/framed (fixed-size chunks, each independently authenticated) so it is compatible with future streaming and HTTP Range reads — even though v1 still buffers whole files in memory. The format must not require re-encryption when streaming is later introduced.

**Key management**

- R5. A single master key is held in Railway secrets (loaded in `useBlobStore()`, the same place R2 credentials are read), not in the bucket or the database.
- R6. Each stored blob records which key encrypted it (a key identifier in the self-describing header), so a second key can later be introduced for new writes while the old key still decrypts existing blobs — without shipping rotation tooling now.

**Content-addressing and compatibility**

- R7. Blob keys remain derived from the **plaintext** content hash (`<workspaceId>/<sha256(plaintext)>`, computed in `files.ts` as today), preserving cross-file dedup and keeping the `ChangeEvent.contentHash` version/restore pointers working with no changes.
- R8. Reads tolerate legacy plaintext blobs: a stored object with no encryption header is treated as pre-encryption plaintext and returned as-is, so existing data keeps working with no flag day.
- R9. New writes always encrypt. A background backfill that re-encrypts legacy plaintext blobs in place may be provided but is not required to ship.

**Behaviour preservation**

- R10. Agents (MCP), the web file browser/preview, REST reads/writes, and CLI two-way sync continue to function exactly as today — encryption is invisible to all of them.

---

## Success Criteria

- An actor holding only the blob store contents (bucket objects + a backup), without the API's environment, cannot read any file's contents.
- A flipped or truncated byte in a stored blob is detected on read (decryption fails) rather than silently returning corrupt data.
- Existing workspaces created before this change continue to read and write with no migration step required.
- A downstream implementer can build this from the doc without having to decide the threat model, the key location, the content-addressing scheme, or the legacy-compatibility behaviour — those are all fixed here.

---

## Scope Boundaries

- **Metadata stays cleartext.** Paths, file sizes, content-types, and the entire change feed remain unencrypted in Postgres because they power list / search / incremental sync. File names and sizes leak; this is accepted for the infrastructure-at-rest threat model.
- **No protection against process/env access.** Anyone who can read the API process memory or its environment can still read plaintext. That is zero-knowledge / client-held-key territory (a different product that conflicts with server-side agents) and is explicitly out of scope.
- **No advanced key management in v1.** Per-workspace keys, external KMS, per-blob DEK envelopes, and automated key-rotation tooling are excluded. The key-id header (R6) leaves the door open; the machinery is later work.
- **Plaintext-hash confirmation oracle not closed.** Because blob keys are the plaintext hash (R7), a bucket attacker who can _guess_ a file's exact bytes can confirm its presence. HMAC-keyed addressing would close this but costs cross-workspace dedup; skipped as irrelevant to the stolen-bucket threat.
- **Large-file / video capability is a separate future service.** Big media (anticipated workload, e.g. video) is not handled by this work. Cloudflare Stream is the likely answer for video; a staged-ingest pipeline (below) is the likely answer for large generic files. The leading design is recorded in Key Decisions so this work is built compatibly, but it is not in this doc.

---

## Key Decisions

- **Tier 1 (infrastructure-at-rest), not zero-knowledge.** Chosen because Treehouse is agent-native and agents execute server-side; encrypting against the server itself would either exclude agents or require handing agents the key (defeating the encryption for exactly the workspaces that use agents). Tier 1 delivers the realistic-leak protection without touching the agent model.
- **In-process wrapper, not a staged-ingest pipeline, for encryption.** A holding-bucket → async-encrypt pipeline was considered and is the right shape for _large-file ingestion_, but for the encryption goal alone it is over-engineering: it breaks the synchronous content-addressed CAS write model in `files.ts` (introducing pending/processing file state, async finalize, and orphan cleanup that ripples into the UI, MCP, and change feed). The in-process `BlobStore` wrapper meets the threat model with no changes to that model.
- **Single env-held master key, with a key-id header.** Simplest responsible option; matches how R2 credentials are already handled. The per-blob key-id stamp makes future rotation possible without re-encrypting existing data, so we get the upgrade path without the upfront machinery.
- **Chunked/framed format from day one.** Even though v1 buffers whole files, choosing a streaming-ready format now means the future large-file path (streaming reads, HTTP Range for video seeking) is an upgrade rather than a full re-encryption migration.
- **Content-addressing stays on plaintext hash.** Keeps dedup and the version/restore pointer model intact. Since a Tier 1 server sees plaintext anyway, hashing plaintext leaks nothing new to the server (the only residual is the bucket-side confirmation oracle noted in Scope Boundaries).

---

## Dependencies / Assumptions

- The deployed blob store is R2 via the S3 API; the local FS driver is dev/test only. Both go through the same `BlobStore` interface, so the wrapper covers both.
- Provider-managed server-side encryption (R2/Cloudflare default) is assumed to already be in effect as a baseline; this work adds the Treehouse-held-key layer on top so a leaked bucket is useless without the app's key. (Verify the R2 SSE baseline is on — unverified at brainstorm time.)
- Whole-file buffering remains the v1 behaviour; encryption adds a transient second buffer (~2× peak memory per in-flight file). Instance sizing and any concurrency caps are an operational concern for large files, not a design change here.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3, R4][Technical] Exact self-describing header layout and chunk size (e.g. 1 MiB chunks; STREAM-style nonce derivation: base nonce + chunk counter + final-chunk flag).
- [Affects R5][Technical] Master-key representation and loading (raw 32-byte key vs. base64 in a single secret; env var name; validation/startup failure behaviour when absent).
- [Affects R9][Technical] Whether to ship the legacy-plaintext backfill in v1 or defer it; if shipped, where it runs (one-off script vs. the `packages/workers` BullMQ worker).
- [Affects R10][Needs research] Confirm large uploads to the API are not subject to a Cloudflare Worker request-size/memory cap in the deployed topology, and that Nitro/Railway request body-size and timeout limits accommodate the intended file sizes. (Path constraint surfaced during brainstorm; relevant once large files are exercised, independent of encryption correctness.)

### Recorded for the deferred large-file service (not this doc)

- Leading design for large generic files: presigned direct-to-R2 upload into a holding bucket, then an async worker (the `packages/workers` Railway BullMQ worker is the natural home) hashes, encrypts with the same chunked format, moves to the canonical bucket, and finalizes the `FileNode`. Requires a new "processing" file state and orphan cleanup (R2 lifecycle TTL on the holding bucket).
- Open product decision for that service: encrypted large media cannot be served via presigned-direct-from-R2 (the client lacks the key), so the choice is a decrypting streaming proxy (held-key guarantee, compute scales with bandwidth) vs. provider-managed encryption for media (e.g. Cloudflare Stream; weaker guarantee, scales effortlessly).