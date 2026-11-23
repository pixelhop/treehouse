---
title: "File bytes served from a Cloudflare Worker (the byte Worker)"
date: 2026-10-20
category: developer-experience
module: deployment
problem_type: developer_experience
component: blob_storage
severity: medium
applies_when:
  - "Deploying or configuring packages/blob-worker for staging or production"
  - "Rotating BLOB_WORKER_TOKEN_KEY"
  - "Debugging a 307 from a file, version or share-link GET, or a 403/502 from the blob host"
  - "Changing the headers the API's byte routes send (the Worker must send the same)"
tags:
  - cloudflare-workers
  - r2
  - egress
  - encryption
  - wrangler
---

# The byte Worker

Every byte the API streams leaves Railway as metered egress (about $0.05/GB).
A Cloudflare Worker reading R2 through a binding pays no egress. So the API
keeps every rule (authentication, the private-path gate, versions, share links,
their limits and view counts) and hands the bytes themselves to a Worker:

```
client ──GET──▶ API (authorise, count the view, read 52-byte header, derive per-blob key)
       ◀─307── Location: https://<blob host>/b/<grant>
client ──GET──▶ Worker (open grant, ranged R2 read, decrypt only the covering frames)
       ◀─200/206/304/416── same headers the API would send
Worker ──POST (waitUntil)──▶ API /api/internal/blob-usage   (share links only: bytes sent)
```

Downloads only. Uploads still go through the API; direct-to-R2 uploads are a
separate follow-up.

## What the Worker holds, and what a grant is

The Worker never holds the KEK or a workspace DEK. For each read the API reads
the blob's 52-byte header (one small ranged GET), derives that blob's key
(HKDF of the DEK, the header's salt, the workspace id and content hash), and
puts it in the grant. A leaked grant opens one blob until it expires.

A grant is `<keyId>.<base64url(nonce ‖ AES-256-GCM ciphertext ‖ tag)>`, sealed
under `BLOB_WORKER_TOKEN_KEY` (shared by the API and the Worker). It is
encrypted, not just signed, because it carries key material in a URL. It binds:
workspace id, content hash (so the R2 key), plaintext size, the 52-byte header,
the per-blob key, the ETag to emit, an allowlisted set of response headers
(content type, disposition, cache control, nosniff/CSP for share links, the
`X-Treehouse-*` version headers), the expiry, and whether to meter bytes.

- **Expiry: 4 hours, rounded up to the next 15 minutes.** Long enough that a
  feature-length video can be paused and seeked: Chrome sends its later range
  requests straight to the redirected URL, so the grant has to outlive the
  playback. The rounding makes grants deterministic (the nonce is an HMAC of the
  payload), so the same file asked for within 15 minutes gets the same URL and
  the browser's cached copy revalidates with a 304 instead of downloading again.
- **Revocation lag.** A grant cannot be recalled. After a member is removed, a
  path is made private, or a share link is revoked, URLs already issued keep
  working until they expire (at most about 4h15m). New requests are refused at
  once, because the 307 is `no-store` and every read goes back through the API.
- **Share-link ceilings.** Views are counted at the API before the redirect.
  Bytes are reported by the Worker after the response (sealed under the same key
  with a separate purpose label, random nonce, refused if more than 10 minutes
  stale). The report route is unauthenticated until the report opens, so it
  reads at most 4 KiB of body and refuses more with 413 while reading, chunked
  bodies included. A paused link stops getting new grants, but a grant already issued can
  keep serving until it expires; its bytes are still counted. A byte counts
  when the runtime takes it from the response stream (the write into the
  `FixedLengthStream` completes), not when it is decrypted, so a frame decrypted
  ahead of a client that then leaves is not charged. As on the API, bytes handed
  to the network but never read by a client that left mid-transfer are charged.
- **Grant length.** The Worker refuses grants over 8192 characters, so the API
  never mints one: a grant that long (in practice only a very long non-ASCII
  file name in a `?download=1` disposition, which carries the name twice) is
  served directly by the API instead of being redirected to a 403.

## Logs must never hold a grant

Every request URL the Worker sees is `/b/<grant>`, a bearer capability for one
blob until it expires. Anything that records request URLs is a store of
replayable grants. So:

- `wrangler.jsonc` turns Workers **invocation logs** off
  (`observability.logs.invocation_logs: false`) and **traces** off
  (`observability.traces.enabled: false`), in both environments; a test reads
  the config through wrangler and fails if either comes back on. Only the
  Worker's own `console` output is kept, and it never includes a grant or a URL
  (a test checks the failure paths).
- `redact_query_string` would not help: the grant is in the path.
- Do not add a **Logpush** job for Workers trace events, or a **tail Worker**,
  that records the request URL. `wrangler tail` shows URLs to whoever runs it;
  that is an account-level permission, and grants seen there still expire.
- Cloudflare's HTTP request logs/analytics for the zone also see the path. If
  those are shipped anywhere (zone Logpush), exclude `ClientRequestPath` /
  `ClientRequestURI` for the blob host.
- **Analytics.** The app's PostHog setup sends every URL through
  `shared/analytics.ts` `redactUrl`: event properties (`$current_url`,
  `$referrer`, …), replayed `src`/`href` attributes, and replay network
  requests. It redacts `/b/<grant>`, and any path segment shaped like a grant
  wherever it appears, so it does not depend on knowing the Worker's host.
  Exceptions carry no grant: nothing in the app fetches a grant URL by script
  (media are loaded by the browser, and a media error reports no URL), and the
  API's own exception capture attaches only its redacted request path.
- **CLI and desktop.** A failed request to a grant URL (or any other origin) is
  rethrown without the URL or the underlying error, and an unusable `Location`
  is never echoed, so their logs cannot hold a grant.
- The Worker sends `Referrer-Policy: no-referrer`, so a page it serves never
  passes its own URL on.

## Who is redirected

Only bytes worth the extra round trip: video and audio of any size, and
anything else from 32 MiB up (`HANDOFF_MIN_BYTES`). Media means what the app
plays, judged as its viewer judges it (`viewerKind`): the file's own stored
type, then its extension when the type alone says nothing. So media synced as
octet-stream counts, and so does an `.m4a` uploaded as `audio/x-m4a`. The
file's own type decides rather than its blob's, which can differ: identical
bytes share one blob, typed by their latest upload. Versions and pinned shares
know only the blob, so its type decides there. Smaller files are served by
the API directly. Measured on staging from London, a small image took about
540 ms through the Worker against about 256 ms from the API: the API spends
nearly as long issuing the redirect as sending a small file, and the Worker's
own first byte comes on top. Video gains because the browser follows the
redirect once and sends every later range request (each seek) straight to the
Worker: seeks went from 557 ms to 304 ms. When the route knows the size and
type, a small non-media file is decided before anything is read from R2.

Then, only clients known to follow the redirect safely:

- browsers loading bytes as an image, video, audio, page or download
  (`Sec-Fetch-Dest` present and not `empty`), and
- API clients that send `x-treehouse-byte-redirect: 1` (the CLI and desktop
  sync do, and follow the 307 by hand without their API key; fetch would
  otherwise forward `x-api-key` to the Worker). The API marks a handoff with
  `X-Treehouse-Byte-Handoff: 1`, and that marker, not the redirect itself, is
  what the CLI follows without credentials. Any other redirect (a proxy
  sending clients to a canonical API URL, with or without the Worker
  configured) is followed with the key only while it stays on the API's own
  origin, never across origins, for up to 20 hops. 404 and 401 are read as the
  API's verdicts only when the final answer came from the API's origin.

The desktop shell is the exception for navigations: its window may only
navigate (and be redirected) to the app and API origins, so a download or a
file opened as a page from inside the shell (Sec-Fetch-Dest `document`,
`iframe`, …, with the shell's user agent) is served by the API. Its images and
video are subresources and still go to the Worker.

Everything else is served by the API as before: the app's `fetch` text reads,
MCP, older CLIs, curl. Only encrypted blobs are handed over; legacy plaintext
and damaged-marker blobs need whole-file hash checks that only the API can do.
A blob whose header implies a different size from its metadata (a legacy
"lookalike") also stays on the API. Conditional requests (`If-None-Match`) are
still answered by the API with a 304 before any redirect.

## Configuration

API (Railway). **`BLOB_WORKER_URL` is the on/off switch**; the key can be set
on its own beforehand and left set afterwards:

| Variable                        | Value                                                                 |
| ------------------------------- | --------------------------------------------------------------------- |
| `BLOB_WORKER_URL`               | `https://treehousefiles.com` (https and R2 storage enforced in prod)  |
| `BLOB_WORKER_TOKEN_KEY`         | `t1:<base64 32 bytes>`, from `printf "t1:$(openssl rand -base64 32)"` |
| `BLOB_WORKER_TOKEN_KEY_RETIRED` | optional, comma-separated, during rotation                            |

Redirects happen only with a URL and a valid key both set. Any other state
serves every byte from the API and never fails a request: key only (the normal
state before turning on and after turning off; usage reports from grants still
in flight keep being counted), URL only, a malformed key, or, in production, an
`http:` URL or non-R2 storage. The last three are logged once as
`[blob-worker] byte Worker is OFF ...`. The settings are only read when a
request would actually be redirected.

Worker (`packages/blob-worker/wrangler.jsonc` plus secrets):

| Setting                         | Where                                                               |
| ------------------------------- | ------------------------------------------------------------------- |
| R2 binding `BLOBS`              | `r2_buckets`: the SAME bucket as that environment's API `R2_BUCKET` |
| `USAGE_REPORT_URL`              | `vars`: `https://<api host>/api/internal/blob-usage`                |
| `BLOB_WORKER_TOKEN_KEY`         | `wrangler secret put`, identical to the API's                       |
| `BLOB_WORKER_TOKEN_KEY_RETIRED` | `wrangler secret put`, optional                                     |

With neither set, nothing changes: self-hosters and local dev serve every byte
from the API.

## Deploy steps

Both Workers are live (staging since 2026-10-27, production since
2026-10-28). CI (`.github/workflows/cloudflare.yml`) builds and dry-runs the
package on every PR, and deploys it on every push to `staging` and `main`, then
checks the host answers a made-up grant with 403 (503 means the key is
missing). Deploys never touch the secret, so steps 1 to 5 are one-time setup
per environment: redo them only for a new environment or to rotate the key.

1. **Add the domain to Cloudflare.** The blob host is `treehousefiles.com`
   (production) and `staging.treehousefiles.com` (staging), already set as
   `custom_domain` routes in `wrangler.jsonc`. The zone must be in the same
   Cloudflare account as the Worker. Set up no email on it. Remove
   `"workers_dev": false` only if you want the `*.workers.dev` URL as well.
2. **Check the buckets match the APIs.** Production reads `treehouse-blobs`
   and staging `treehouse-staging-blobs`, each the `R2_BUCKET` of that
   environment's API. Staging must never point at production's bucket. The
   Worker reads the exact objects the API writes; there is no copy.
3. **Deploy the Worker and give it its key** (staging first). One key per
   environment; staging and production must not share one:
   ```bash
   cd packages/blob-worker
   STAGING_KEY="t1:$(openssl rand -base64 32)"
   PROD_KEY="t1:$(openssl rand -base64 32)"
   pnpm exec wrangler deploy --env staging
   printf %s "$STAGING_KEY" | pnpm exec wrangler secret put BLOB_WORKER_TOKEN_KEY --env staging
   pnpm exec wrangler deploy --env ""
   printf %s "$PROD_KEY" | pnpm exec wrangler secret put BLOB_WORKER_TOKEN_KEY --env ""
   ```
   Check `https://<blob host>/b/x` answers a bare 403.
4. **Set the key on the API**: `BLOB_WORKER_TOKEN_KEY` to the matching value,
   in the API's environment. Nothing changes yet; with no URL every byte is still served by the API.
5. **Turn it on** by setting `BLOB_WORKER_URL` on the API (staging first). Open
   an image and a video in the app and confirm in the network panel: a 307 from
   the API, then 200/206 from the blob host. Open a public share link as a
   video, seek, and confirm the workspace's share-usage bytes go up.
6. **CI deploys it from then on**, with the same `CLOUDFLARE_API_TOKEN` as the
   other Workers. That token covers every zone in the account, so it can attach
   `treehousefiles.com`; see `cloudflare-deploys-via-github-actions.md`.

**To turn it off (rollback), remove `BLOB_WORKER_URL` from the API and nothing
else.** Nothing new is redirected. Grants already issued keep working until
they expire (up to about 4h15m), and the API keeps counting the bytes they
report because it still has the key. Leave the Worker and both keys in place for
at least that long; after that the key can be removed too.

## Rotating the grant key

1. Add the new key to the Worker's `BLOB_WORKER_TOKEN_KEY_RETIRED` (it now
   accepts grants under both).
2. On the API, make the new key `BLOB_WORKER_TOKEN_KEY` and move the old one to
   `BLOB_WORKER_TOKEN_KEY_RETIRED` (it now mints under the new key and accepts
   usage reports under both).
3. On the Worker, make the new key active and the old one retired.
4. After 4h15m, remove the old key from both.

## Local development and testing

- `vp test packages/blob-worker` runs the handler against an in-memory bucket
  and, in `runtime.test.ts`, the real Worker in workerd (via wrangler's test
  harness) over a local R2 bucket seeded with ciphertext sealed by Node.
- To run it by hand: copy `packages/blob-worker/.dev.vars.example` to
  `.dev.vars`, start the API with `BLOB_KEK`, `BLOB_WORKER_URL=http://localhost:8787`
  and the same `BLOB_WORKER_TOKEN_KEY`, upload a file, copy its ciphertext from
  the API's `BLOB_DIR` into the Worker's local bucket with
  `wrangler r2 object put treehouse-blobs/<ws>/<hash> --file <BLOB_DIR>/<ws>/<hash> --local`,
  then `pnpm --filter blob-worker dev`. (The API's local store is the
  filesystem and the Worker's is local R2, so they share bytes only by copying.)

## Uploaded content is inert on the blob host

Every grant, from every workspace, is served from the one Worker origin. Without
a defence, an attacker could upload an HTML page and a script to their own
workspace, send a victim the page's grant URL, and have the page register the
script as a **service worker** scoped to `/b/`. It would then intercept every
later grant URL on that origin, other workspaces' downloads included, and
outlive the grant that installed it. A separate domain does not help here,
because all grants share the one origin. So the Worker:

- refuses any worker-script fetch (`Service-Worker: script`, or a
  `Sec-Fetch-Dest` of `serviceworker`, `sharedworker` or `worker`) with a bare
  403 before the grant is even opened; and
- sends `Content-Security-Policy: sandbox` (no `allow-same-origin`, no
  `allow-scripts`) as a policy of its own on every response, together with
  `X-Content-Type-Options: nosniff`. A document served from a grant gets an
  opaque origin and runs no script, so it can neither register a service worker
  nor touch the origin's storage. Images, video, scripts and stylesheets loaded
  as subresources ignore a response CSP, so the app's `<img>`, `<video>` and
  downloads, and the HTML preview (which reads the page as text into a
  `srcdoc` frame), are unaffected. Share links keep their own stricter policy
  alongside it.

Checked in real Chrome against workerd (`wrangler`'s test harness): before the
fix, the attacker's page registered the script and a different grant URL then
answered "hijacked" from the service worker. After it, the page's origin is
`null`, `navigator.serviceWorker` throws `SecurityError` ("the context is
sandboxed and lacks the 'allow-same-origin' flag"), and the other grant URL gets
the Worker's own answer.

## Known limits and open questions

- **Domain (decided: `treehousefiles.com`).** Production sets `COOKIE_DOMAIN`
  to the shared parent, so a `trytree.house` subdomain would receive session
  cookies on every grant request. With the sandbox above, served pages run no
  script, but a separate registrable domain keeps the blob host out of the
  app's cookie scope entirely. It also keeps the reputation of user-uploaded
  content (a phishing page flagged by a blocklist, say) off `trytree.house` and
  `pixelhop.io`, which is why it is not a subdomain of either.
- **Inline PDFs opened directly** in a tab get the same sandbox policy that
  public share links already send. Not separately checked in a browser here.
- **Re-sealing.** Uploading identical bytes again re-seals the blob with a new
  salt. A grant issued before that fails with 502 (the old key no longer opens
  it); asking the API again gets a fresh grant. A video playing across such a
  re-upload stops.
- **Lookalike check for versions and pinned links.** Without a metadata size,
  the API authenticates the first chunk (up to 1 MiB read from R2, no egress)
  before redirecting. It could be dropped once no legacy plaintext blobs remain.
- **Usage reports are best effort.** A report that fails is logged and lost.