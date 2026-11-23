---
title: One folder, several sync engines — conflicted-copy bursts, and a baseline that lied about what it uploaded
module: packages/cli/src/daemon.ts
date: 2026-08-25
problem_type: bug
component: sync
severity: high
applies_when:
  - "changing when the daemon supervisor registers or stops an engine"
  - "adding an await to engine.start(), or any startup path a reload can interleave with"
  - "touching the push/pull baseline written into .treehouse/index.json"
  - "changing scanOne's mtime+size fast path, or anything that decides local-changed"
  - "changing how the server names or allocates conflicted copies"
  - "investigating byte-identical conflicted copies of one file, stamped ms apart"
  - "investigating 'it says synced but the cloud has an older version'"
related_components:
  - file_service
tags:
  - sync
  - conflicted-copies
  - optimistic-concurrency
  - race-condition
  - index-baseline
  - daemon-supervisor
---

# One folder, several sync engines — conflicted-copy bursts, and a baseline that lied about what it uploaded

## Context

A workspace under a sustained agent edit batch produced bursts of byte-identical
`(conflicted copy — human — <iso>)` files: up to six copies of one path, stamped
milliseconds apart, each holding the state the file had **before** the edit, while
the canonical file held the state after. One machine, one credential, one editor —
nobody else was touching the files.

Two independent bugs, plus one thing that is working as designed.

**Not a cause: the reconcile core.** An instrumented engine driven through a
200-file workspace under a continuous edit batch issued **zero** overlapping PUTs
for any single path. Per-path serialisation via `exclusive()` holds. The bug is
one level up — in how many engines exist.

## Cause 1 — the supervisor could start several engines on one folder

`startDir` registered an engine only after `await engine.start()` resolved, and
`start()` runs a full bootstrap: minutes on a large folder over a flaky link. A
`reload` arriving inside that window — the desktop shell sends one on sign-in, on
folder changes, on "Start sync" — found no engine for the root and started
another. The map keeps the last; every earlier duplicate kept running, unreferenced
and unstoppable, watching the same folder with its own in-memory baseline.

Each duplicate then answers the same filesystem event independently. Copy a note
and rebase its links a moment later and you get, per engine:

```
PUT versions/snap-0/plan.md  create   hash=6fb0c6a6   ← the un-rebased state
PUT versions/snap-0/plan.md  base:1   hash=ec82c649   ← the rebased state
```

One `create` wins. The rest are identical, so the server's content check makes
them idempotent no-ops — **until the origin is slow enough that the rebased write
commits while they are still queued.** Then every queued create is stale, and each
mints its own timestamped copy of the pre-rebase state. That is the burst, exactly
as the production feed recorded it:

```
09:51:41.373  write     v1   hash=3ee08c87   ← the un-rebased state wins the create race
09:51:45.893  write     v2   hash=a06d2a73   ← the rebased state lands
09:51:46.661  conflict                        ← six queued creates, all hash=3ee08c87,
09:51:46.713  conflict                          now stale against v2, each minting
   …                                            its own copy (two shared a millisecond,
09:51:52.027  conflict                          hence the ` (2)` suffix)
```

**Fix.** Claim the root in `engines` _before_ the await, release it on failure, and
stop a half-started engine. `engine.start()` gained a `stopped` flag so a `stop()`
landing mid-bootstrap doesn't go on to bring up a watcher and poll loop afterwards.

Verified end-to-end against the real daemon (`scripts/investigation/reload-race.mts`):
three reloads during a bootstrap gave **3 bootstraps and 3 watchers** on one folder
before the fix, **1 and 1** after.

## Cause 2 — the baseline paired an old hash with a new stat (silent divergence)

Found during the investigation; never reported, and the more dangerous of the two.

A push is `read bytes → network round trip → record baseline`, and the baseline was
built by stat'ing the file _after_ the response landed:

```ts
index[path] = baselineFromDisk(root, path, res.version, sha256(bytes)); // stat NOW
```

If the file was rewritten during the round trip, the entry records the **uploaded**
content's hash next to the **current** file's mtime and size. That pairing is
invisible downstream, because `scanOne`'s fast path treats matching mtime+size as
proof the file is unchanged and reuses the index hash:

```jsonc
// .treehouse/index.json — observed live
{ "version": 1, "hash": "6fb0c6a6…", "mtime": 1787658146399.592, "size": 100 }
// on disk: same mtime, same size, hash ec82c649… — a different file
```

The edit is then never detected, never uploaded, and the folder reports itself
synced while local and cloud disagree indefinitely.

**Fix.** Pair the hash with the stat taken _before_ the bytes were read
(`baselineForPush`). Inconsistency then always errs toward "re-read next scan",
never toward "silently unchanged" — one wasted hash in the worst case instead of a
lost edit. `baselineFromDisk` (pull / conflicted copy, where we wrote the bytes
ourselves) additionally drops its fast-path metadata when the on-disk size
disagrees with what it wrote.

## Hardening — identical losing bytes get one copy, not N

Cause 1 is the reason there were duplicates, but a stale write can reach the server
more than once by other routes too. A conflicted copy that already holds exactly
these bytes has nothing left to preserve, so `makeConflictCopy` now reuses it.

The check must hold a lock. Done outside one it is only advisory: N simultaneous
replays all look before any commits, all find nothing, and all insert — measured at
3 copies unlocked, 2 with an unlocked pre-check, **1** with
`pg_advisory_xact_lock` around the check and the insert. A genuinely different
losing state still gets its own copy.

## Guidance

- **Register before you await.** Any supervisor keyed on "is this already running?"
  must claim the slot before the slow call, not after. Adding an `await` inside a
  start path is the moment to re-check every liveness map that gates it.
- A long-running component whose `start()` can be interrupted needs a `stopped`
  flag its own start path honours. `stop()` returning is not the same as stopped.
- Any index entry must satisfy: `hash`, `mtime` and `size` describe the **same**
  bytes. When you cannot guarantee it, omit `mtime`/`size` — a re-read is cheap, a
  missed edit is not. Never stat a file to baseline it after an `await`.
- Treat an operation that may be delivered more than once as needing a
  content-addressed identity, not a time-addressed one. Timestamped names make
  replays look like distinct events.
- **Read the log from the machine that did the writing.** During this investigation
  the absence of `⚠ conflict — both kept` lines was briefly taken as evidence the
  client never saw a 412 — but that log belonged to a second machine that was only
  pulling. Check `actorKeyId` on the change feed before trusting a local log.

## Reproducing

`scripts/investigation/` holds the harness. `drive.mts <scenario>` provisions a
disposable workspace, runs an instrumented engine (every request traced) through
one scenario, and reports local vs remote content hashes, duplicate conflicted
copies grouped by content, and divergence.

- `s15-duplicate-engines` — the burst: N engines on one root, snapshot-then-rebase.
  With `INV_TWIN_PUT_DELAY_MS` standing in for origin queueing it produces
  byte-identical copies of the pre-rebase state, milliseconds apart.
- `s9-chaos` — cause 2's silent divergence.
- `reload-race.mts` — the real daemon, reloaded during bootstrap; counts engines.
- `flaky-proxy.mts` — drops responses after the origin commits, or models a
  contended origin (`INV_QUEUE_MS`).

Regression tests: `packages/cli/test/engine.test.ts` ("stop() during a slow
start()"), `packages/cli/test/sync-core.test.ts` ("baseline after a push that raced
a local edit"), `packages/api/test/files-service.test.ts` ("replaying identical
losing bytes reuses the conflicted copy").