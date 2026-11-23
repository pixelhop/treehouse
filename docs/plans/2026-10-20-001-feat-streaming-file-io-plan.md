---
date: 2026-10-20
topic: streaming-file-io
requirements: docs/brainstorms/2026-06-09-file-encryption-at-rest-requirements.md
status: complete
---

# Streaming file I/O — Plan

File bytes currently pass through the API whole. `readBodyCapped` collects the
request into one `Buffer`, `encryptBlob` builds a second full-size ciphertext
buffer, and R2 receives one `PutObject`. Reads fetch the whole object and decrypt
it into a third buffer before the first byte goes out. That is fine at the free
plan's 25 MB, but paid plans allow ~2 GB files, so a handful of concurrent large
uploads can exhaust the memory of the one API process every workspace shares.
There is also no range support, which video seeking needs.

The on-disk format was built for this (independently authenticated 1 MiB chunks,
see `blob-crypto.ts`), so this is a change to how the server processes bytes, not
a re-encryption of stored data. Old blobs stay readable unchanged.

## The constraint that shapes the write path

Each blob's key is derived from the **plaintext SHA-256** (`deriveKey(dek, salt,
workspaceId, contentHash)`), and the storage key is `<workspaceId>/<sha256>`.
Encryption cannot start until the whole body has been hashed. So writes are two
passes:

1. **Spool:** read the request body into memory up to 4 MiB, overflowing to a
   temp file beyond that, hashing and counting as it arrives and enforcing the
   plan's size cap mid-stream (as `readBodyCapped` does today).
2. **Seal:** stream the spooled bytes through chunked encryption into storage
   as one streamed `PutObject` with a declared length. R2 accepts up to ~5 GiB
   that way, above every plan's file limit, so multipart's part bookkeeping
   waits for direct-to-R2 uploads. The hash is recomputed on the way and
   confirmed before the final chunk is sealed, so a body that changed never
   completes an upload.

Memory per upload becomes about one 1 MiB chunk plus stream buffers, whatever
the file size. Changing the format so the key doesn't depend on the hash was
considered and rejected: the hash binding is what makes a blob non-portable
within a workspace, and keeping it means no format version bump.

## Reads

`BlobStore.open(key, range?)` returns a plaintext view: total size, content type,
the satisfied range, and a lazily decrypting body.

- Encrypted blobs map a plaintext byte range onto the chunk frames that cover it
  and fetch only those frames (plus the 52-byte header) with ranged GETs. Each
  chunk is authenticated before any of its bytes are yielded, so a file up to
  1 MiB is fully verified before the response headers go out.
- Legacy plaintext and malformed-marker blobs keep today's buffered read, because
  their only authenticator is the whole-file hash. They predate encryption.
- A chunk that fails authentication mid-stream aborts the response. Today that
  error happens before any bytes are sent; for large files it now happens part
  way through, which the client sees as a truncated download.

The file GET, share file GET and version GET routes stream and answer `Range`
(single range; `416` when unsatisfiable; `If-Range` against the ETag; multiple
ranges fall back to a full `200`). Text consumers (MCP reads, comments, read
state) keep the buffered `read()` — they need the whole string anyway.

## Restore

`restore` currently reads a whole old version into memory and re-puts it to the
key it was read from. Content addressing means the blob already exists, so it
only needs the size and content type. It stops buffering and stops re-putting.

## Seam for moving bytes to a Worker later

`FileService.open()` keeps authorization (path gate, version, content hash)
separate from `BlobStore.open()` (bytes). A later Cloudflare Worker byte path
slots in as "API authorizes and signs, Worker opens and decrypts" without
touching the service's rules. Nothing Worker-specific is built now.

## Build order

1. **Crypto streaming** (`blob-crypto.ts`): `encryptChunks` (async iterable in,
   sealed frames out, final flag from the declared size) and `decryptFrames`
   for a chunk index range. Tests: byte-identical round trips with the existing
   `encryptBlob`/`decryptBlob` in both directions, every range boundary
   (first/last chunk, exact chunk multiples, empty file), and tampering, reorder
   and truncation still failing.
2. **Store** (`storage.ts`): `BlobSource`, `putSource`, `open` and `stat` on the
   R2 and FS drivers and the encrypting wrapper. R2 streams one PUT, aborting the
   request if the body fails; FS writes to a temp file and renames.
3. **File service** (`files.ts`): `write` accepts `Uint8Array | BlobSource`;
   `open()` for byte-serving routes; restore without buffering.
4. **Routes:** spool in the PUT route; streaming plus `Range` in the three GET
   routes.
5. **Verification:** the full API suite plus the server-backed route suites with
   encryption on; a memory comparison against `main` (a 1 GiB upload and
   download); the R2 driver against a real S3-compatible server (SeaweedFS in
   Docker; the MinIO image is no longer pullable anonymously); and in the
   browser, an image, a markdown doc, a large download and a share link.

## Outcome

- **Memory, 1 GiB round trip through the API (dev server, RSS growth):** `main`
  rose ~1.5 GB on upload and ~2.9 GB on download; this branch rose ~12 MB on
  upload and not at all on download.
- **Found by the real-server test:** the AWS SDK ignores errors from a streamed
  body, so a failed upload hung and leaked an unhandled stream error. The R2
  driver now watches the body and aborts the request.

## Not in this PR

- **CLI and desktop streaming** (push from a file stream, pull to disk). That is
  client memory, not a shared outage, so it follows separately.
- **Video and audio viewers.** They consume the range support built here.
- **Direct-to-R2 uploads and the Worker byte path** (option B).