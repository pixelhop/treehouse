---
title: "feat: Sync product — real-time engine, device-code onboarding, binary daemon"
type: feat
status: active
date: 2026-06-07
deepened: 2026-06-07
---

# feat: Sync product — real-time engine, device-code onboarding, binary daemon

## Summary

Turn the Treehouse sync CLI from a manually-configured 5-second full-scan poller into a product: link a directory to a workspace via a browser device-code flow, have it auto-populate from the cloud, and have anything dropped in appear in the cloud near-instantly — shipped as a signed single-file binary running as a background daemon with per-OS autostart. The pure, unit-tested `reconcile` core stays untouched; the work changes only _how_ sync state is gathered (event-driven, incremental) and adds onboarding + packaging + daemon layers around it.

---

## Problem Frame

The sync CLI works and its data-safety core is solid, but it is not a product:

- **Onboarding is fully manual.** Users hand-edit `.treehouse/config.json` with `apiBase`/`apiKey`/`workspaceId`. `POST /api/keys` doesn't even accept a `workspaceId`, so CLI keys are effectively unscoped. There is no login flow.
- **It's a brute-force poller.** `--watch` re-walks the whole tree and re-`list()`s the entire remote every 5s. No filesystem watching, no incremental cloud→local, no server push.
- **It's unbundled live TypeScript via `tsx`.** Not distributable to non-developers.

This directly serves the STRATEGY.md **Sync & substrate** track ("the magic shared folder … and the eventual desktop sync app") and the co-equal human promise that Treehouse "is just a synced folder."

---

## Requirements

- R1. Link a directory to a workspace via a browser device-code flow that mints a **workspace-scoped** API key with zero manual config copying.
- R2. On first link, auto-populate the directory from the workspace's cloud files, and safely merge when the directory already contains files.
- R3. Local file changes (create/modify/delete/move) propagate to the cloud near-instantly (sub-second to low-seconds) without full-tree rescans.
- R4. Cloud changes (from agents or other devices) appear locally within a short interval via **incremental** change-feed pulls (deltas only, not full listings).
- R5. Sync stays correct under conflicts, delete-vs-edit races, crashes, and watcher failures — preserving every existing data-safety invariant, with the periodic full reconcile guaranteeing eventual convergence.
- R6. The change feed exposes a monotonic `seq` cursor so the incremental path is at-most-once-per-seq (never delivers a `seq` twice) and a client can positively confirm catch-up against `head`. Eventual completeness under concurrent writers is guaranteed by the periodic full reconcile, not by the incremental path alone (see Risks — BIGSERIAL commit ordering).
- R7. Ship a single-file binary for macOS (arm64), Windows (x64), and Linux (x64+arm64). **Node SEA does not support macOS x64** — Intel Macs run the arm64 binary under Rosetta 2, or a Bun-compiled `darwin-x64` artifact if native Intel is required (decide at U14).
- R8. Run as a background daemon supervising N linked directories, with per-OS autostart and `start`/`stop`/`status`/`logs` control.
- R9. The Linux inotify watch limit (`ENOSPC`) degrades gracefully to polling without breaking correctness or crashing the daemon.
- R10. Workspace-scoped keys are scoped correctly (fixing the current unscoped-key gap) and onboarding binds each key to the authenticated user.

---

## Scope Boundaries

- **No GUI menubar/tray app** — out of scope now; the daemon + socket protocol are designed so a GUI can wrap them later (CLI-binary-first, per locked decision).
- **No server push (SSE/WebSocket)** — cloud→local is change-feed polling only (locked decision).
- **No delta/chunked file transfer** — whole-file transfer is retained; a one-byte edit re-uploads the file.
- **No per-workspace DB sharding / SQLite backend** — explicitly out of scope (consistent with STRATEGY.md "Not working on" and the prior architecture decision to stay on Postgres).
- **No Watchman backend** — too heavy an external dependency for a consumer tool.
- **No `@parcel/watcher` in the shipped binary now** — kept as a swappable future backend behind the watcher abstraction.

### Deferred to Follow-Up Work

- GUI desktop app wrapping the daemon (future phase; design the socket protocol cleanly now).
- macOS Developer ID signing/notarization + Homebrew cask are sequenced _after_ the unsigned curl-installer first cut (U17 gates U18).
- winget / Scoop / `.dmg` / `.msi` packaging (after signing lands).
- **Active self-update** (download + verify GPG-signed `SHA256SUMS` + atomic-swap-on-restart, Windows running-exe handling) — v1 ships passive awareness only (U19).
- **Native `darwin-x64` binary via Bun `--compile`** — only if Rosetta 2 on the arm64 build proves insufficient for Intel-Mac users.
- Redis-backed at-rest storage of the pending device key (AEAD-in-Postgres is the v1 baseline per U8; Redis-TTL is the later alternative).

---

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/reconcile.ts` — the pure, unit-tested three-state reconcile core. **Do not modify.** All other engine work changes only how `(local, remote, index)` states are gathered.
- `packages/cli/src/sync.ts` — `runSync` (full pass), `scanLocal`, `applyAction`, `adoptWinner`, `writeAtomic`, the `IGNORE` list. Logic to extract into a per-path primitive.
- `packages/cli/src/index-store.ts` — `.treehouse/index.json` baseline + atomic temp+rename save (mirror this for the cursor store).
- `packages/cli/src/api-client.ts` — ETag→version parsing (strips weak `W/`), `If-Match`/`If-None-Match`, the 412 `{ current_version, conflict_copy_path }` shape.
- `packages/cli/src/config.ts` — current per-dir config; env overrides.
- `packages/api/server/routes/api/workspaces/[workspaceId]/changes.get.ts` — feed to extend with `seq`/`head`.
- `packages/api/server/utils/workspace.ts` — `authenticate`, `authorizeWorkspace`, `requireCookieUser`, `webHeaders` (use `getRequestHeaders`, never `toWebRequest`).
- `packages/api/server/routes/api/keys/index.post.ts` — cookie-only key minting (gap: doesn't set `workspaceId`).
- `packages/api/server/utils/auth.ts` — better-auth `apiKey({ enableMetadata, enableSessionForAPIKeys })`; metadata round-trips `{ workspaceId, actorType }`.
- `packages/app/app/composables/useTreehouseApi.ts`, `app/composables/useAuthClient.ts`, `app/pages/dashboard.vue` — app-side patterns for the `/link` page + workspace picker (`GET /api/workspaces` already returns `{id,name,icon,color}`).
- `packages/shared/index.ts` — pure, zero-dep helpers (`encodePath`, `contentTypeFor`, `conflictedCopyName`, `isConflictedCopy`), bundled into the binary.
- Repo tooling: pnpm 9, Vite+ (`vp`) for check/test/lint, vitest via `vite-plus/test`, Node pinned 22.21.1, esbuild already an approved build dep, `.github/workflows/` empty, `scripts/bump-release-version.ts` for tagging.

### Institutional Learnings

- **Hand-maintained Prisma schema:** the Treehouse models live below the auth section of `packages/db/prisma/schema.prisma`. **Never run `auth:generate`** (it regenerates the whole file and deletes them). Hand-edit, then `prisma:migrate` + `prisma:generate`.
- **Reading request headers:** build `Headers` via `getRequestHeaders(event)` (`webHeaders`), not `toWebRequest(event)` — the latter locks the body stream and hangs PUT/POST.
- Change-feed attribution is by credential `actorType`, not by route.

### External References

- RFC 8628 (OAuth 2.0 Device Authorization Grant) — adapted: approval mints a better-auth API key instead of an OAuth token.
- Node SEA (Single Executable Applications) docs (Node 22 LTS, stable) + `postject`.
- chokidar v4 (pure-JS; `usePolling`, `ignored`, `awaitWriteFinish`, `atomic`; `graceful-fs` for `ENOSPC`/`EMFILE`). Verified current via Context7 (`/paulmillr/chokidar`).

---

## Key Technical Decisions

- **Monotonic `seq` cursor (BIGSERIAL) over ISO `createdAt`:** the current `createdAt > since` filter can miss/duplicate same-timestamp events (e.g. `move`'s two rows) and offers no "caught-up" signal. A DB-assigned sequence is distinct per row even within a transaction. Keep `createdAt` + its index for the time-based activity panel.
- **chokidar v4 behind a `Watcher` abstraction, with auto `ENOSPC`→polling fallback:** pure-JS so it bundles into the single-file binary; recursive on mac/Windows (FSEvents/RDCW, no per-dir handles). The Linux inotify limit is a kernel constraint no JS watcher escapes, so the watcher is treated as a latency optimization (the poller + periodic reconcile are the correctness mechanisms) and degrades to polling on `ENOSPC`. `@parcel/watcher` kept swappable for later.
- **Node SEA over Bun for packaging:** runtime fidelity — we pin Node 22.21.1 and the sync engine is correctness-sensitive on `fs`/`crypto`/`fetch`. Bun documented as the escape hatch if the 5-runner cross-compile matrix becomes painful.
- **Device-code onboarding mints keys via the cookie-authed approval endpoint:** better-auth `createApiKey` derives the owner (`referenceId`) from the session, so minting inside the logged-in `approve` call binds the key to the right user without a session-less trusted-mint path.
- **Custom device-flow over better-auth's built-in `device-authorization` plugin:** the installed better-auth (1.6.x) ships a `device-authorization` plugin, but it issues OAuth access/refresh tokens, not the workspace-scoped **api-key** plugin credential the CLI/MCP stack authenticates with. We build the RFC 8628-shaped flow on a hand-maintained table so approval mints an `apiKey` carrying `{ workspaceId, actorType }` metadata. (Re-evaluate if better-auth later lets the device plugin mint api-keys.)
- **`?sinceSeq` is a distinct query param, not a type-sniffed `?since`:** `Number.parseInt("2026-06-07T…")` returns `2026`, so overloading one `since` param would misroute ISO dates into seq mode. Keep `?since=<ISO>` for the legacy/descending activity-panel path and add a separate `?sinceSeq=<int>` for the cursor — explicit contract, no ambiguity (the CLI method is already named `changes(sinceSeq)`).
- **One daemon per user supervising N linked dirs** (not one process per dir): shared HTTP pool, one autostart entry, one `status`, with per-dir failure isolation.
- **`reconcile.ts` is frozen:** the refactor changes state-gathering only; every data-safety invariant lives below it and is preserved.

---

## Open Questions

### Resolved During Planning

- Onboarding mechanism → device-code browser flow (locked with user).
- Cloud→local mechanism → short-interval change-feed polling (locked).
- Distribution form factor → CLI binary now, GUI later (locked).
- Scope → full, including the background daemon (locked).
- Default watcher → chokidar v4 behind an abstraction with polling fallback (locked).
- `seq` JSON serialization → emit as `Number` (safe under 2^53; document the ceiling).
- Cursor param → a **separate `?sinceSeq=<int>`** param (not a type-sniffed `?since`); `?since=<ISO>` stays for the activity panel. Avoids `parseInt("2026-…")===2026` misrouting.
- Pre-existing unscoped keys (U9/U10) → `authorizeWorkspace` becomes **fail-closed**: a key whose metadata lacks `workspaceId` is rejected once scoped minting is the only path (rather than silently reaching every org workspace). Decided during review; see U9.

### Deferred to Implementation

- Exact poll interval / `awaitWriteFinish` thresholds / worker-pool concurrency — tune against real behavior.
- Whether `api.stat(path)` is a new HEAD route or a reuse of GET — decide when wiring U3.
- Exact `user_code` alphabet/length and rate-limit thresholds — finalize at U10.
- Per-OS socket vs named-pipe specifics and `state.json` shape — finalize at U16.
- Whether the periodic full-reconcile interval is fixed or adaptive — decide during U7.

---

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```
LOCAL DISK ──chokidar event──▶ ┐
                                ├─▶ per-path queue ──▶ reconcilePath(p):
CLOUD ──/changes?sinceSeq=N─────┘                        local = stat+hash(p)
        (poll ~2s, deltas only)                          remote = api.stat(p)  [event.version = fast-path noop hint only]
                                                         index  = index[p]
                                                         applyAction( reconcile(local, remote, index) )  ◀── FROZEN CORE
        ▲                                                   │
        └──── ChangeEvent.seq (BIGSERIAL) ◀── recordChange ─┘ (push/pull/delete/move)

safety nets:  periodic full runSync  +  cursor.json (resume)  +  ENOSPC→polling
onboarding:   treehouse login → /api/device/code → browser /link (pick workspace) → /api/device/approve (mint scoped key) → /api/device/poll (deliver once) → .treehouse config
packaging:    esbuild bundle → Node SEA per-arch → daemon (N dirs) → launchd/systemd/schtasks autostart
```

---

## Implementation Units

### Phase A — Reliable change cursor (server)

- U1. **Add monotonic `seq` to the change feed**

**Goal:** Give `ChangeEvent` a gap-tolerant, per-row monotonic cursor.

**Requirements:** R6

**Dependencies:** None

**Files:**

- Modify: `packages/db/prisma/schema.prisma` (`model ChangeEvent`)
- Create: `packages/db/prisma/migrations/<ts>_change_event_seq/migration.sql`

**Approach:**

- Add `seq BigInt @default(autoincrement())` (→ Postgres `BIGSERIAL`) and `@@index([workspaceId, seq])`. Keep `createdAt` + its index.
- Generate SQL with `--create-only`, review (`ADD COLUMN seq BIGSERIAL NOT NULL` backfills existing rows in insertion order — no data loss), apply, then `prisma:generate` (**never** `auth:generate`).
- `recordChange` in `packages/api/server/utils/files.ts` is unchanged — `seq` is DB-assigned.

**Patterns to follow:** Existing hand-maintained-model migration flow used for the Workspace `icon`/`color` columns.

**Test scenarios:**

- Integration: a `move` produces two `ChangeEvent` rows with **distinct, consecutive** `seq` (the same-timestamp bug class).
- Edge case: existing rows receive ascending `seq` after migration.
- Test expectation: covered by the U2 endpoint tests (no standalone schema test).

**Verification:** Migration applies cleanly; `seq` is present, unique, ascending; client regenerates without touching auth models.

---

- U2. **Rewrite `/changes` for seq cursor + head**

**Goal:** Serve reliable incremental deltas and a catch-up signal.

**Requirements:** R4, R6

**Dependencies:** U1

**Files:**

- Modify: `packages/api/server/routes/api/workspaces/[workspaceId]/changes.get.ts`
- Test: `packages/api/test/files-routes.test.ts` (extend)

**Approach:**

- New `?sinceSeq=<int>` → events `seq > sinceSeq`, `orderBy seq asc`, `take limit`. (Distinct param, not type-sniffed — see Key Technical Decisions.)
- `?since=<ISO>` and `?order=desc` unchanged (createdAt-keyed) for the activity panel.
- **Compute the page and `head` in a single snapshot** (one transaction / one `findMany` + a `max(seq)` consistent read) so `head` is never less than a returned event's `seq`.
- Response adds per-event `seq` and a top-level `head` (max seq for the workspace, `0` if none). **Map `seq`/`head` via `Number(...)`** — BigInt isn't JSON-serializable; document the 2^53 ceiling.
- **Cursor invariant (documented for U7):** clients advance their cursor only to the max `seq` among _returned events_, never to `head`; `head` is only a "more pages exist / caught-up" comparison.

**Patterns to follow:** Existing `changes.get.ts` query + auth via `requireWorkspaceFromRoute`.

**Test scenarios:**

- Happy path: `?sinceSeq=N` returns only `seq > N`, ordered ascending.
- Edge case: same-timestamp events both returned with distinct seq (regression for U1's fix).
- Happy path: `head` equals the workspace's max seq; empty workspace → `head: 0`.
- Edge case: an event committing between the page read and the `head` read does not produce `head < max(returned seq)` (single-snapshot guarantee).
- Back-compat: ISO `?since=` still filters by `createdAt`; `?order=desc` unchanged.
- Edge case: `seq` serializes as a JSON number, not a string/throw.

**Verification:** A client polling `?sinceSeq` and advancing to the max returned `seq` observes every event at most once with no boundary misses; existing consumers unaffected.

---

### Phase B — Incremental real-time engine (CLI)

- U3. **api-client: incremental fetch + per-path stat**

**Goal:** Client methods for delta pulls and targeted reconciles.

**Requirements:** R3, R4

**Dependencies:** U2

**Files:**

- Modify: `packages/cli/src/api-client.ts`
- Test: `packages/cli/test/api-client.test.ts` (new)

**Approach:** Add `changes(sinceSeq) → { changes, head }` (wire param `?sinceSeq=<int>`) and `stat(path) → { version } | null` (HEAD route or GET reuse — decide here). Keep ETag→version parsing.

**Test scenarios:**

- Happy path: `changes(seq)` returns parsed `{ changes, head }`.
- Edge case: `stat` of a missing path → `null` (404); present → `{ version }`.
- Error path: non-OK status throws with a clear message.

**Verification:** Methods round-trip against the U2 endpoint shape.

---

- U4. **Cursor store**

**Goal:** Persist the sync cursor across runs/crashes.

**Requirements:** R4, R5

**Dependencies:** None

**Files:**

- Create: `packages/cli/src/cursor-store.ts`
- Test: `packages/cli/test/cursor-store.test.ts`

**Approach:** `.treehouse/cursor.json` = `{ seq }`, atomic temp+rename (mirror `index-store.ts`). Missing/corrupt → signal bootstrap.

**Test scenarios:**

- Happy path: save→load round-trip.
- Edge case: missing file → bootstrap signal; corrupt JSON → bootstrap signal (no throw).
- Edge case: atomic write leaves no partial file on simulated mid-write.

**Verification:** Cursor survives restart; corruption degrades to a full bootstrap, never a crash.

---

- U5. **Extract a per-path reconcile primitive (`sync-core.ts`)**

**Goal:** Reconcile a single path on demand, reusing existing IO logic verbatim.

**Requirements:** R3, R4, R5

**Dependencies:** U3

**Files:**

- Create: `packages/cli/src/sync-core.ts`
- Modify: `packages/cli/src/sync.ts` (delegate `runSync` to the extracted `sync-core.ts` functions)
- Test: `packages/cli/test/sync-core.test.ts` (new)

**Approach:** Extract `applyAction`/`adoptWinner`/`writeAtomic`/`bytesFor` as **module-level functions** in `sync-core.ts` (don't wrap in a `SyncContext` class for only two call sites — introduce a stateful object only if U7 actually needs one). Add `reconcilePath(path, remoteHint?)`: gather local stat+hash, remote (use a change-event `version` only as a fast-path hint; re-`stat` for pull/ambiguous decisions per U7), `index[path]`, then `applyAction(reconcile(...))`. `reconcile.ts` is **not** touched.

**Execution note:** Pure refactor — keep `reconcile.test.ts` green and verify a full `runSync` still converges before layering U6/U7.

**Patterns to follow:** The exact conflict/resurrection/atomic-write handling already in `sync.ts`.

**Test scenarios:**

- Happy path: `reconcilePath` on a locally-edited file → push; on a remote-only path → pull.
- Edge case: delete hint (remote absent) on an untouched local → deleteLocal; on a locally-edited file → resurrection (create).
- Integration: a push conflict (412) writes the conflicted copy and adopts the winner (no data loss), identical to current behavior.

**Verification:** `runSync` behavior is unchanged; single-path reconcile produces the same action `reconcile` dictates.

---

- U6. **Watcher abstraction (chokidar v4 + polling fallback)**

**Goal:** A swappable filesystem event source that survives watch-limit failures.

**Requirements:** R3, R9

**Dependencies:** None

**Files:**

- Create: `packages/cli/src/watcher.ts`
- Modify: `packages/cli/package.json` (add `chokidar` v4)
- Test: `packages/cli/test/watcher.test.ts` (new)

**Approach:** A `Watcher` interface (emits add/change/unlink for one root). Default backend: chokidar v4 with `ignoreInitial: true`, `awaitWriteFinish`, `atomic: true`, the existing `IGNORE` as `ignored`. Catch `ENOSPC`/`EMFILE` → switch that root to `usePolling` (+ `graceful-fs`) and expose a `degraded` flag. Mode is per-directory.

**Patterns to follow:** The `IGNORE` regex list in `sync.ts`; the `useBlobStore`/driver-seam style for a swappable backend.

**Test scenarios:**

- Happy path: file create/modify/delete emit normalized events (mock or temp-dir).
- Edge case: ignored paths (`.treehouse/`, editor temp files) emit nothing.
- Error path: simulated `ENOSPC` flips the root to polling mode and sets `degraded`, without throwing.

**Verification:** Events drive reconciles in native mode; under forced `ENOSPC` the watcher keeps emitting via polling.

---

- U7. **Incremental engine + `--watch` wiring**

**Goal:** The long-running loop: bootstrap, poller, watcher, queue, periodic safety reconcile.

**Requirements:** R2, R3, R4, R5

**Dependencies:** U4, U5, U6

**Files:**

- Create: `packages/cli/src/engine.ts`
- Modify: `packages/cli/src/index.ts` (`--watch` → engine)
- Test: `packages/cli/test/engine.test.ts` (new)

**Approach:**

- **Bootstrap** (no cursor): **read `head` FIRST**, then run full `runSync` (auto-populates empty dir, merges non-empty safely via `reconcile`), then persist `cursor = head-read-before-the-list`. Reading `head` after the list would drop any write that lands between `runSync`'s `api.list()` snapshot and the `head` read (neither applied nor later polled). The pre-list `head` guarantees such a write has `seq > cursor` and is replayed by the poller.
- **Poller** (~2s): `changes(cursor)` → coalesce to last-event-per-path → skip self-echoes → `reconcilePath`. Use `event.version` only as a **fast-path noop hint** (self-echo / unchanged check); for any pull/ambiguous decision, **re-`stat` the remote** rather than trusting a possibly-stale hint (a concurrent writer may have advanced the version since the event). Advance+persist cursor to **the max `seq` among returned events** (never to `head`) → drain on full page.
- **Watcher** (U6): events → enqueue `reconcilePath`; on `ENOSPC` record degraded mode.
- **Self-echo guard:** (1) primary/correctness — post-push `index[path]={version,hash}` makes the echo `reconcile` a `noop`. (2) efficiency — a **one-shot skip-set keyed on `(path, version)`**, consumed when the matching event `seq` is observed, with a TTL/eviction. Define the re-edit case explicitly: if the user edits again after the push but before the echo, the second edit's own push supersedes and the stale prior-version echo must still resolve to `noop` via the index hash compare (guard 1), never re-pull.
- **Queue:** per-path coalescing + single-flight + bounded concurrency (4–8 workers) replacing the sequential loop. **Durability ordering:** flush the atomic `saveIndex` for an applied batch **before** persisting the advanced `cursor.json`, so a `kill -9` can never strand an advanced cursor against a stale index (which would skip re-delivery of those events). Persist index+cursor together, or index-then-cursor — never cursor-then-index.
- **Crash recovery + safety net:** resume from `cursor.json`; periodic full `runSync` every ~5–10 min (and once post-bootstrap), then resync cursor to `head`. This periodic reconcile is **load-bearing for correctness** (it is the only guarantee that closes the BIGSERIAL commit-ordering gap under concurrent writers — see Risks), not merely a nicety.
- **Move atomicity:** a server `move` emits `delete@from` + `move@to` as one commit with adjacent `seq`. Apply both rows in the **same batch** (don't split a same-commit pair across poll pages — drain to the same seq watermark) so a cloud rename never leaves the file transiently absent locally.

**Patterns to follow:** Existing `runSync` summary line (`↓ ↑ ✗ ⚠`); atomic save in `index-store.ts`.

**Test scenarios:**

- Happy path: bootstrap into an empty dir pulls all remote files; cursor set to the pre-list head.
- Edge case: a remote write landing during bootstrap (after the list snapshot) is still applied by the poller (head-read-first invariant).
- Happy path (Covers R2): bootstrap into a non-empty dir merges (local-only → create, both-new → conflicted copy) without loss.
- Edge case: batch coalescing keeps only the last event per path; cursor advances to max returned seq; full page triggers immediate drain.
- Integration (self-echo): a local push's own change event does **not** re-pull (no spurious `↓`).
- Edge case (self-echo re-edit): edit → push → edit again before the echo arrives → second edit pushed, stale echo resolves to `noop` (no lost second edit, no re-pull).
- Edge case: `move` (delete@from + move@to) applied in one batch → local delete-old + create-new with no transient-absence window; idempotent on replay.
- Error path: `kill -9` after cursor would advance but before index flush → restart re-applies the batch (index-before-cursor ordering); converges with no skipped events.
- Error path: periodic reconcile repairs a deliberately-dropped watcher event and a concurrently-committed lower-seq event.

**Verification:** With `--watch`, local edits reach the cloud within `awaitWriteFinish` and cloud edits arrive within the poll interval, with no full-tree rescans in steady state and guaranteed convergence after the periodic reconcile.

---

### Phase C — Device-code onboarding

- U8. **`DeviceAuthorization` schema**

**Goal:** Persist pending device authorizations.

**Requirements:** R1, R10

**Dependencies:** None

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<ts>_device_authorization/migration.sql`

**Approach:** Hand-add `model DeviceAuthorization` below the Treehouse models: `deviceCodeHash @unique` (sha256), `userCode @unique`, `status` (pending|approved|consumed|denied|expired), `userId?`, `workspaceId?`, `actorType @default("human")`, `apiKeyId?`, `apiKeyCiphertext?`, `lastPolledAt?`, `expiresAt`, `createdAt`, `updatedAt`; index `status`, `expiresAt`. Migrate; never `auth:generate`.

**Key-at-rest decision (review):** **Do not** store the minted key plaintext. Store `apiKeyCiphertext` — an AEAD-encrypted blob (key derived from a new server secret, e.g. `DEVICE_KEY_ENC_KEY` in `.env`/`.env.example`), decrypted on the fly by the winning poll then nulled. A DB leak/backup/slow-query-log then never exposes a usable workspace credential. (Redis-TTL storage remains a future alternative; AEAD is the v1 baseline — promoted out of "deferred".)

**Test scenarios:** Test expectation: none — schema only; encrypt/decrypt round-trip and the never-plaintext invariant are covered by U10 endpoint tests.

**Verification:** Migration applies; unique constraints on `deviceCodeHash`/`userCode` enforced; no plaintext key column exists.

---

- U9. **Workspace-scoped key minting helper + fix `POST /api/keys`**

**Goal:** One validated path to mint `{ workspaceId, actorType }` keys; close the unscoped-key gap.

**Requirements:** R1, R10

**Dependencies:** None

**Files:**

- Modify: `packages/api/server/utils/workspace.ts` (add `mintWorkspaceKey`)
- Modify: `packages/api/server/routes/api/keys/index.post.ts` (accept + scope `workspaceId`)
- Modify: `packages/app/app/composables/useTreehouseApi.ts` (optional `workspaceId` on `createKey`)
- Test: `packages/api/test/keys-routes.test.ts` (extend or new)

**Approach:** `mintWorkspaceKey(event, { name, actorType, workspaceId })` runs `authorizeWorkspace` (membership check) then `auth.api.createApiKey({ headers, body:{ metadata } })`. Reuse in `POST /api/keys` and U10's approve. **Fail-closed for legacy keys:** today `authorizeWorkspace` only enforces scoping `if (ctx.keyWorkspaceId)`, so pre-existing keys minted without a `workspaceId` (the current state — all CLI keys are unscoped) bypass the check and reach **every** workspace in the user's org. Once scoped minting is the only path, change `authorizeWorkspace` to **reject an api-key credential whose metadata lacks `workspaceId`** (cookie sessions are unaffected). Surface this as a breaking change in the migration notes so any field-issued unscoped key is re-minted via the device flow.

**Test scenarios:**

- Happy path: minting with a valid workspace produces a key whose metadata carries `{ workspaceId, actorType }`; `authenticate()` resolves `keyWorkspaceId`.
- Error path: minting for a workspace the user isn't a member of → 403.
- Integration: a scoped key is rejected by `authorizeWorkspace` for a _different_ workspace.
- Security (fail-closed): an api-key credential with no `workspaceId` in metadata is rejected by `authorizeWorkspace` (not silently granted org-wide access); a cookie session with no key still passes.

**Verification:** Keys are correctly scoped end-to-end; unscoped api-key credentials are denied rather than over-privileged.

---

- U10. **Device endpoints (`code` / `poll` / `approve`)**

**Goal:** The RFC 8628-style grant.

**Requirements:** R1, R10

**Dependencies:** U8, U9

**Files:**

- Create: `packages/api/server/routes/api/device/code.post.ts`, `poll.get.ts`, `approve.post.ts` (optional `deny.post.ts`)
- Test: `packages/api/test/device-flow.test.ts` (new)

**Approach (concrete security parameters — set at plan level, not deferred):**

- `POST /code` (no auth): mint 32-byte (`crypto.randomBytes`, base64url) `device_code`; mint `user_code` = 8 chars from a 20-symbol unambiguous alphabet (no `0/O/1/I`) ≈ 42 bits, retry on unique collision (cap retries → 503); 10-min expiry; return codes + `verification_uri(_complete)` (`${APP_URL}/link`) + `expires_in`/`interval` (5s). **Rate-limit:** ≤5 starts per IP per 10 min + a global ceiling on pending rows/min.
- `GET /poll?device_code` (no cookie): sha256 lookup; enforce expiry; **slow-down** — reject if `now − lastPolledAt < interval` (429), always update `lastPolledAt`, hard-cap total polls before forced-expire. On `approved` do an **atomic** `updateMany(approved→consumed, apiKeyCiphertext:null)`; only the winning update **decrypts the ciphertext** and returns `{ api_key, workspace_id, api_base }` (exactly-once); later polls → `already_consumed`. Use a constant 404 shape for unknown codes (don't confirm existence).
- `POST /approve` (cookie only): `requireCookieUser` (binds to user) → **per-user rate-limit (≤10 approve attempts / 15 min, anti-enumeration)** → lookup by `user_code` → `authorizeWorkspace` → `mintWorkspaceKey` → store `apiKeyCiphertext` + fields, status `approved`; return `{ ok }` (never the key to the browser).
- **Cleanup:** a periodic sweep (or migration-time job) deletes expired/consumed rows so the table doesn't grow unbounded (indexes on `status`/`expiresAt` support it).

**Patterns to follow:** Nitro file-based routing; `webHeaders`/`requireCookieUser`; existing `cors.ts` — confirm it restricts `approve` to the exact app origin (not wildcard) and that `/code`/`/poll` responses aren't cross-origin-readable.

**Test scenarios:**

- Happy path: code → approve → poll returns the scoped key exactly once (decrypted from ciphertext).
- Edge case: second poll after consume → `already_consumed`; poll before approve → pending.
- Error path: expired code rejected on poll and approve; poll faster than `interval` → 429 slow-down.
- Security: approve for a non-member workspace → 403; key never returned to the browser; unknown `device_code` → constant 404.
- Security: `>10` approve attempts in 15 min by one user → rate-limited (enumeration defense).
- Integration: the minted key's owner equals the approving session user; no plaintext key is ever persisted.

**Verification:** A full device handshake yields a working workspace-scoped key delivered once; abuse paths (replay, expiry, slow-down, non-member, enumeration) are rejected; the DB never holds a plaintext key.

---

- U11. **App `/link` verification page**

**Goal:** Browser approval UI with a workspace picker.

**Requirements:** R1

**Dependencies:** U10

**Files:**

- Create: `packages/app/app/pages/link.vue`
- Modify: `packages/app/app/composables/useTreehouseApi.ts` (`approveDevice`), `app/pages/dashboard.vue` (entry link)
- Test: covered by manual E2E (component test optional)

**Approach:** Route `/link`, `middleware:"auth"` (logged-out users sign in and return). Read `?code=`, confirm `user_code`, pick workspace via `listWorkspaces()` (`GET /api/workspaces`), default actorType `human`, call `POST /api/device/approve`. Success copy: "Return to your terminal."

**Patterns to follow:** Existing pages using `useTreehouseApi`/auth middleware; the workspace list shape `{id,name,icon,color}`.

**Test scenarios:**

- Happy path: visiting `/link?code=…` prefills the code, lists workspaces, approves successfully.
- Error path: invalid/expired code surfaces an error; non-member workspace shows 403.
- Edge case: logged-out visit redirects to sign-in then returns to `/link`.

**Verification:** A non-technical user can approve and pick a workspace entirely in the browser.

---

- U12. **CLI `login` / `link` commands**

**Goal:** Terminal side of onboarding; write config automatically.

**Requirements:** R1

**Dependencies:** U10

**Files:**

- Create: `packages/cli/src/login.ts`, `packages/cli/src/write-config.ts`
- Modify: `packages/cli/src/index.ts` (command router: `login`, `link [dir]`)
- Test: `packages/cli/test/login.test.ts` (new; mock fetch)

**Approach:** `POST /code`, print URL + code, best-effort open browser via `node:child_process` (`open`/`start`/`xdg-open`, never fail), poll until approved (handle slow_down/expired), then `saveConfig` (`0600`, refuse overwrite without `--force`). **Never log the key.** Built-in default `apiBase` (or `--api-base`).

**Test scenarios:**

- Happy path: poll loop receives approval and writes a `0600` config with `{ apiBase, apiKey, workspaceId }`.
- Edge case: `slow_down` increases interval; `expired` exits non-zero with a clear message.
- Security: the API key is never written to stdout/logs.
- Edge case: existing config without `--force` aborts with the current workspace shown.

**Verification:** `treehouse login ./dir` → browser → terminal connects → `treehouse sync ./dir` works with the scoped key.

---

### Phase D — Binary packaging + background daemon

- U13. **esbuild bundle → Node SEA binary**

**Goal:** Single-file binaries from the TS source.

**Requirements:** R7

**Dependencies:** U7 (engine present), U12 (commands present)

**Files:**

- Create: `packages/cli/scripts/build.mjs`, `packages/cli/scripts/make-sea.mjs`, `packages/cli/sea-config.json`
- Modify: `packages/cli/package.json` (`build`/`package` scripts; keep `tsx` for `start`)

**Approach:** esbuild `src/index.ts` → `dist/treehouse.cjs` (`bundle`, `platform:node`, `target:node22`, `format:cjs`), inlining `shared` + `chokidar`; embed version via `define`. SEA per Node docs: build blob → copy `node` → **mac/Linux: `codesign --remove-signature` before injection** → `postject` inject (use the documented segment name **`NODE_JS`**, not `NODE_SEA`; with the matching sentinel fuse) → **mac: ad-hoc re-sign `codesign --sign - <bin>` after injection** (an arm64 binary with a broken/absent signature will not launch at all — this is separate from quarantine-stripping and from Developer ID signing in U18). Windows: set icon/version via `rcedit`.

**Test scenarios:** Integration: the built SEA runs `treehouse sync` with parity to `tsx start` on the host OS (i.e. the blob is actually found — wrong segment name would silently boot a bare Node CLI). Smoke-tested in CI (U14), not unit-tested.

**Verification:** A host-OS binary runs all commands identically to the dev path, and an arm64 mac binary launches (ad-hoc signed) without a dyld/codesign kill.

---

- U14. **Release CI (5-runner matrix) + install scripts**

**Goal:** Cross-platform artifacts + a curl install path.

**Requirements:** R7

**Dependencies:** U13

**Files:**

- Create: `.github/workflows/release-cli.yml`, `scripts/install.sh`, `scripts/install.ps1`

**Approach:** Tag-triggered (hang off `scripts/bump-release-version.ts`): bundle once → matrix package (**macos-14 arm64**, windows x64, ubuntu x64, ubuntu-24.04 arm64; SEA can't cross-compile and **has no macOS x64 target** — Intel runs the arm64 build under Rosetta 2, or add a Bun-`--compile` `darwin-x64` leg if native Intel is required) → publish binaries + a **GPG-signed `SHA256SUMS`** + `latest.json`, all from the immutable tagged GitHub Release (HTTPS). `install.sh`/`install.ps1` detect OS/arch, download from the **pinned release URL (not a mutable `latest` redirect)**, verify against `SHA256SUMS`, strip macOS quarantine. Offer a two-step "download then inspect then run" variant alongside the `curl | sh` one-liner; recommend Homebrew (U18) as the trust-anchored path once signing lands.

**Test scenarios:** Test expectation: none (CI/release config) — validated by a dry-run release producing the verifiable artifacts (arm64 mac + win + 2× linux) with a signed `SHA256SUMS`.

**Verification:** `curl … | sh` installs a working binary on a clean Apple-Silicon mac / Linux; Intel mac works via Rosetta; Windows via `install.ps1`; tampered downloads fail the checksum.

---

- U15. **Per-user global config/state layout**

**Goal:** Move credentials out of synced folders; give the daemon a registry to supervise.

**Requirements:** R8

**Dependencies:** U12

**Files:**

- Modify: `packages/cli/src/config.ts` (OS-path resolver; split global vs per-dir)
- Create: `packages/cli/src/paths.ts`, `packages/cli/src/links-store.ts`
- Test: `packages/cli/test/paths.test.ts`, `packages/cli/test/links-store.test.ts`

**Approach:** Per-OS app dir (macOS `~/Library/Application Support/Treehouse` + `~/Library/Logs/...`; Linux `$XDG_CONFIG_HOME`/`$XDG_STATE_HOME`; Windows `%APPDATA%`/`%LOCALAPPDATA%\Logs`), **created mode `0700`**. `credentials.json` (`0600`, atomic temp+rename, **verify perms on read** and refuse/repair if looser), `links.json` (`[{root, workspaceId, paused}]`), `daemon.pid/.sock/.log`. Per-dir `.treehouse/` keeps `index.json`/`cursor.json`/`state.json`. Env vars still override (CI). `login`/`link` write here.

**Backward-compat (review):** existing users have credentials in per-dir `.treehouse/config.json`. The loader must try the new global `credentials.json` first, then **fall back to the legacy per-dir `config.json` with a deprecation warning**, and `login`/`link` on an already-configured dir migrates the credential into the global store. No silent break for existing `treehouse sync ./dir` setups or CI env-var configs.

**Test scenarios:**

- Happy path: path resolver returns correct dirs per platform (mock `process.platform`/env).
- Edge case: missing global dir is created `0700`; `credentials.json` written `0600`; a pre-existing looser-perm credentials file is flagged/repaired on read.
- Happy path: links add/remove/list round-trips atomically.
- Edge case (back-compat): a legacy `.treehouse/config.json` is still loaded (with a deprecation warning) and migrated on next `login`.

**Verification:** Credentials live once per user with `0600`/`0700` perms; the daemon enumerates linked dirs from `links.json`; existing per-dir configs keep working through the transition.

---

- U16. **CLI command router + daemon supervisor + IPC**

**Goal:** The long-lived multi-dir daemon and its control commands.

**Requirements:** R8, R9

**Dependencies:** U7, U15

**Files:**

- Modify: `packages/cli/src/index.ts` (router: `daemon`, `start`, `stop`, `restart`, `status`, `logs`, `unlink`)
- Create: `packages/cli/src/daemon.ts`, `packages/cli/src/ipc.ts`
- Test: `packages/cli/test/daemon.test.ts`, `packages/cli/test/ipc.test.ts`

**Approach:** `daemon` runs one engine (U7) per linked dir, isolated by try/catch + backoff, writing per-dir `state.json`. Unix socket (named pipe on Windows) for `status`/`logs`/`stop`; disk fallback when down. **Socket trust boundary:** create the Unix socket mode `0600` in the `0700` per-user state dir; on Windows, ACL the named pipe to the current user's SID only — otherwise any same-host process could `stop` the daemon (DoS) or read `logs` (path/metadata disclosure). Single-instance pid guard; graceful SIGTERM (drain in-flight, flush, exit 0). `status` renders a per-dir table incl. degraded-watcher mode.

**Test scenarios:**

- Happy path: daemon supervises two linked dirs; `status` over IPC reports per-dir state.
- Error path: one dir throwing is isolated (logged to its `state.json`) without crashing the daemon.
- Edge case: second `daemon` start refused by the pid guard; SIGTERM drains and exits 0.
- Integration (R9): a dir in degraded (polling) mode is reported as such in `status`.

**Verification:** `treehouse start` runs a background process syncing all linked dirs; `status`/`logs`/`stop` work; failures isolate per-dir.

---

- U17. **OS service install + autostart**

**Goal:** Survive logout/reboot and start on login.

**Requirements:** R8

**Dependencies:** U16

**Files:**

- Create: `packages/cli/src/service/launchd.ts`, `service/systemd.ts`, `service/windows.ts`
- Modify: `packages/cli/src/index.ts` (`start`/`stop` install/uninstall the service)
- Test: `packages/cli/test/service.test.ts` (template generation)

**Approach:** `start` writes + loads the per-OS unit: macOS launchd LaunchAgent (`RunAtLoad`, `KeepAlive{Crashed:true}`, `ThrottleInterval`); Linux systemd `--user` (`Restart=on-failure`; offer `loginctl enable-linger`; XDG-autostart fallback where systemd `--user` absent); Windows Task Scheduler logon task (`schtasks /SC ONLOGON`). `stop --uninstall` removes them.

**Test scenarios:**

- Happy path: each generator emits a valid unit pointing at `treehouse daemon` with the right log paths (assert on rendered template strings).
- Edge case: systemd-absent path falls back to XDG autostart.
- Edge case: uninstall removes the unit cleanly.

**Verification:** On each OS the daemon autostarts at login and restarts on crash.

---

- U18. **Trust + Homebrew (gated on signing)**

**Goal:** Pass Gatekeeper/SmartScreen and offer a package-manager install.

**Requirements:** R7

**Dependencies:** U14, U17

**Files:**

- Modify: `.github/workflows/release-cli.yml` (sign/notarize steps)
- Create: Homebrew tap formula/cask (separate `homebrew-treehouse` repo)

**Approach:** macOS Developer ID sign + `notarytool` + staple; Windows Authenticode. Then a Homebrew cask pointing at signed release assets. **Sequenced after** the unsigned curl-installer first cut.

**Test scenarios:** Test expectation: none (release/signing config) — validated by a notarized artifact installing without a Gatekeeper prompt.

**Verification:** A downloaded mac binary runs without quarantine warnings; `brew install` works.

---

- U19. **Update awareness (passive) — full self-update deferred**

**Goal:** Keep field binaries current without standing up a heavy, OS-divergent self-updater in v1.

**Requirements:** R7

**Dependencies:** U14, U16

**Scope (review):** No requirement mandates self-update, the curl/Homebrew paths already deliver updates (re-run the installer / `brew upgrade`), and atomic-swap is broken on Windows (can't overwrite a running exe). **v1 ships passive awareness only**; the active downloading self-updater is moved to Deferred to Follow-Up Work.

**Files:**

- Modify: `packages/cli/src/daemon.ts` (passive check), `packages/cli/src/index.ts` (`update --check`)
- Create: `packages/cli/src/update.ts` (check-only in v1)
- Test: `packages/cli/test/update.test.ts`

**Approach:** Daemon checks `latest.json` (pinned HTTPS GitHub Release) on start + daily, compares to the build-embedded version, surfaces "update available — run your installer / `brew upgrade`" in `status`/logs. `treehouse update --check` prints current vs latest. **No binary download/swap in v1.** When the active updater is later built, it must verify the **GPG-signed `SHA256SUMS`** (not just a hash from a possibly-spoofed `latest.json`), special-case Homebrew-managed installs, and handle Windows' running-exe constraint.

**Test scenarios:**

- Happy path: a newer `latest.json` version is detected and surfaced in `status`/`--check`.
- Edge case: a Homebrew-managed install reports "managed by brew" instead of suggesting a raw download.
- Edge case: an unreachable/invalid `latest.json` fails closed (no crash, no false "up to date").

**Verification:** Outdated binaries are flagged accurately; v1 performs no self-download (no atomic-swap risk surface).

---

## System-Wide Impact

- **Interaction graph:** `recordChange` now also feeds the seq cursor; the new device endpoints sit beside `keys`/`workspaces`; the daemon drives N engines, each driving the frozen `reconcile`.
- **Error propagation:** per-dir engine failures isolate to that dir's `state.json`; watcher `ENOSPC` degrades to polling; device-flow errors map to clear HTTP statuses (410/429/403).
- **State lifecycle risks:** cursor must never advance past applied events (at-least-once + idempotent replay); pending device key is single-use and nulled on consume; atomic writes for config/index/cursor/links.
- **API surface parity:** the workspace-scoped-key fix (U9) also benefits the existing manual key UI; MCP keys already carry `actorType` and are unaffected.
- **Integration coverage:** self-echo suppression, move decomposition, crash-resume, and bootstrap-merge are the cross-layer behaviors unit tests alone won't fully prove — covered by the U7 E2E checklist.
- **Unchanged invariants:** `reconcile.ts`, the file-service write path (`packages/api/server/utils/files.ts`), blob storage, and the MCP server are not modified; the `/changes` change is additive and back-compatible.

---

## Risks & Dependencies

| Risk                                                                                                                                                                                                                        | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BIGSERIAL seq assigned at INSERT, not commit — under concurrent writers (multiple devices + agents, per R4) a txn can commit a lower seq after a higher one was already served, so an incremental poll permanently skips it | The incremental path is **at-most-once-per-seq, not guaranteed-complete** (R6 reworded accordingly); the **periodic full reconcile is load-bearing**, not a nicety — it is the convergence guarantee. Future hardening if writer concurrency grows: a small visibility lag (serve only `seq ≤ head − margin`, or gate on `txid_snapshot` xmin). The earlier "single-writer/workspace" justification is dropped — it contradicts R4. |
| Linux inotify watch-limit (`ENOSPC`) on large trees                                                                                                                                                                         | Watcher abstraction auto-degrades to polling (U6); ignore rules; periodic reconcile guarantees correctness; document the `sysctl` bump.                                                                                                                                                                                                                                                                                             |
| SEA can't cross-compile                                                                                                                                                                                                     | 5-runner CI matrix (U14); Bun `--compile` documented as the escape hatch.                                                                                                                                                                                                                                                                                                                                                           |
| macOS notarization / Windows SmartScreen                                                                                                                                                                                    | Ship unsigned curl-installer first (U14), gate Homebrew/GUI behind signing (U18).                                                                                                                                                                                                                                                                                                                                                   |
| Pending device API key exposed via DB leak/backup/slow-query-log                                                                                                                                                            | **AEAD-encrypt the key at rest** (`apiKeyCiphertext`, server-secret key) — no plaintext column (U8/U10); plus single-use + short expiry + atomic consume. Redis-TTL is a later alternative.                                                                                                                                                                                                                                         |
| Legacy unscoped api-keys reach every org workspace after scoped minting lands                                                                                                                                               | `authorizeWorkspace` becomes **fail-closed** for api-key credentials lacking `workspaceId` (U9); breaking change noted in migration docs — re-mint via the device flow.                                                                                                                                                                                                                                                             |
| Unauthenticated `/code` abuse (table growth, `user_code` exhaustion) and `/poll`/`/approve` brute-force                                                                                                                     | Concrete rate-limits + slow-down + ~42-bit `user_code` + per-user approve cap + expired-row cleanup sweep (U10).                                                                                                                                                                                                                                                                                                                    |
| Crash strands an advanced cursor against a stale index (skips events)                                                                                                                                                       | Durability ordering — flush index **before** persisting the cursor (U7); idempotent replay on resume.                                                                                                                                                                                                                                                                                                                               |
| Accidentally running `auth:generate` wipes hand-maintained models                                                                                                                                                           | Documented in CLAUDE.md/learnings; U1/U8 use `--create-only` migrations only.                                                                                                                                                                                                                                                                                                                                                       |
| `reconcile.ts` regressions during extraction (U5)                                                                                                                                                                           | Frozen core + `reconcile.test.ts` as the regression guard; U5 is a pure refactor verified before U6/U7.                                                                                                                                                                                                                                                                                                                             |

---

## Documentation / Operational Notes

- Add CLI usage docs for `login`/`link`/`start`/`stop`/`status`/`logs`/`update` and the install one-liners.
- Document the Linux `sysctl fs.inotify.max_user_watches` recommendation and the degraded-polling indicator in `status`.
- Note the per-OS config/log locations for support.

---

## Phased Delivery

### Phase A — Server cursor (U1–U2)

Independent; unblocks Phase B. Ship + verify in isolation.

### Phase B — Engine (U3–U7)

The core value: incremental + real-time + auto-populate. Usable behind the existing `tsx` run before packaging.

### Phase C — Onboarding (U8–U12)

Device-code flow, scoped-key fix, `/link` page, CLI `login`/`link`.

### Value-validation gate (after Phase C, before Phase D)

Phases A–C deliver the core value (incremental real-time sync + frictionless onboarding) **runnable via the existing `tsx`/curl path**, with no daemon. Ship that to real beachhead users (teams already running agents — comfortable with a terminal) and confirm the signal that justifies Phase D: workspaces actively syncing with **agent write activity** (STRATEGY.md's leading metric) and basic sync retention. **Phase D's heavier, permanent-maintenance investment (daemon, per-OS autostart, signing/notarization, update infra) is gated on that signal** — 7 of 19 units are packaging/lifecycle, not sync value, and they sit on the parity axis while the differentiating web/share layer is still stubbed. Treat U13–U14 (a plain binary) as cheap and shippable early if useful, but commit U16–U19 only after the gate.

### Phase D — Binary + daemon (U13–U19)

Build/SEA → release (unsigned) → global state → daemon+commands → service/autostart → signing+Homebrew → passive update awareness. GUI is a later phase wrapping the daemon.

Only A→B is a hard ordering; C is independent of B; D depends on B+C being present **and on clearing the value gate above**. Recommend a PR per unit (or per small cluster), and per-phase for Phase D.

---

## Sources & References

- Internal design doc (pre-conversion): `~/.claude/plans/async-sprouting-eich.md` (this session)
- Strategy: `STRATEGY.md` — Sync & substrate track ("the eventual desktop sync app")
- Related plans: `docs/plans/2026-06-07-003-feat-multiple-workspaces-plan.md`, `docs/plans/2026-06-06-001-feat-treehouse-mvp-plan.md`
- chokidar v4 docs via Context7 `/paulmillr/chokidar`; RFC 8628; Node SEA docs