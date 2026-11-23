---
title: "Rotating the file-encryption keys (BLOB_KEK and the workspace data keys)"
date: 2026-10-29
category: security
module: storage
problem_type: runbook
component: blob_storage
severity: high
applies_when:
  - "BLOB_KEK may have leaked, or is due for routine rotation"
  - "The database and BLOB_KEK may both have leaked, so stored files must be re-encrypted"
  - "Reading the output of GET /api/internal/keys/status"
tags: [encryption, kek, dek, rotation, r2, runbook]
---

# Rotating the file-encryption keys

## How the keys fit together

Each workspace's files are encrypted with that workspace's **data key** (DEK). Data keys
are stored in the `workspace_key` table, sealed under the **master key** (`BLOB_KEK`),
which exists only in the API's environment. Reading a file needs the database row, the
object in R2, and the master key.

A workspace can hold several data-key **generations**. The highest is the one new writes
use. Every stored object records the generation it was sealed under, and reads use that
generation's key, so a rotation can re-encrypt a workspace while old and new objects both
stay readable.

Both rotations below are configuration changes. The API carries them out itself, on boot
and every ten minutes (`server/plugins/key-maintenance.ts`, `server/utils/key-maintenance.ts`).
Nobody runs anything inside the cluster. Every step is safe to repeat and safe on several
pods at once.

## Which rotation?

- **The master key leaked, or routine rotation:** rotate the KEK. It takes minutes and
  touches no file.
- **The master key AND a copy of the database may both have leaked:** someone could
  already have the data keys, and rotating the KEK does not change them. Rotate the KEK,
  then the data keys. Every object is re-encrypted, and the old data keys are destroyed a
  day later.

Always do staging first.

## Rotating the master key (BLOB_KEK)

This takes two rollouts, because pods restart one at a time. A pod still running with
only the old key cannot open a row that a new pod has already re-sealed. So first every
pod is given the new key without using it, and only then is the new key made active.

1. **Phase 1: distribute the new key.** Generate a key with a new id: if the current one
   is `v1:...`, the new one is `v2:...` (`printf 'v2:%s\n' "$(openssl rand -base64 32)"`).
   Save it in your password manager before anything else: once rows are re-sealed under it, losing it
   loses every file. Put it in `BLOB_KEK_RETIRED`, creating the field in the same section
   as `BLOB_KEK` if it doesn't exist, and leave `BLOB_KEK` as it is. Nothing is re-sealed yet. Every pod restarts and
   can now open rows under either key.
2. **Wait for that rollout to finish.** Every API pod must have restarted. Allow a minute or two
   for the new value to reach them. Check the status endpoint below: `retiredKekIds`
   lists `v2`.
3. **Phase 2: swap them, in a single edit.** Put `v2` in `BLOB_KEK` and `v1` in
   `BLOB_KEK_RETIRED`. During this rollout the old pods still hold `v2`, so they can open
   rows the new pods re-seal. Until an old pod is replaced, though, it can still seal rows
   under `v1`: its maintenance re-seals them back, and it uses `v1` for any brand-new
   workspace's key. The first maintenance run on a new pod starts 10 seconds after boot,
   and its log line reads `[keys] maintenance: rewrapped=N ...`.
4. **Wait for that rollout to finish:** every API pod restarted with `v2` active. Then
   wait for a maintenance run that starts after the last old pod has gone. Runs happen
   every ten minutes, so allow up to ten. Only then check the status endpoint: expect
   `rowsByKekId` to list only `v2`, and `unreadableKeys` to be 0. If either is wrong,
   wait for another run and check again. If it stays wrong, some row is under a key the
   pods don't hold: stop and find out which before removing anything.
5. **Remove `BLOB_KEK_RETIRED`**, which restarts the pods once more. Files keep opening.
6. **Delete the old key everywhere.** Exception: keep it while any database backup you
   might restore still has rows sealed under it. Restoring such a backup needs the old
   key.

## Rotating the data keys (re-encrypting every file)

Do this after the master-key rotation above, so the new data keys are sealed under the
new master key from the start.

1. **Set `BLOB_DEK_ROTATE_BEFORE`** in the API's environment to the current UTC time, for
   example `2026-10-30T09:00:00Z`. It must have a time zone and must not be more than ten
   minutes in the future. A future cutoff would re-issue every key on every run, so it is
   refused: it is logged as `Data-key rotation is NOT running` and reported as
   `rotateBeforeError`.
2. **After the restart, the first run:**
   - issues a new generation for every workspace (`issued=N`);
   - re-encrypts every object in each workspace's bucket prefix (`resealed=N`). That
     includes objects no file points at any more, and plaintext written before encryption
     existed.

   Expect `errors=0`. An object that fails is retried on every run.
   `malformed=N` counts objects that carry the encryption marker but whose header won't
   parse. They are left untouched and need a human.

   `orphanedPrefixes=N` counts bucket prefixes whose workspace has been deleted. Their
   bytes can't be re-encrypted, because the key went with the workspace, so they are
   **deleted** on the first run after the cutoff plus 24 hours. Check that number before
   then. To keep them, remove `BLOB_DEK_ROTATE_BEFORE` before the day is up.
   A malformed object in a workspace also keeps that workspace's old keys: none is
   destroyed until the object has been repaired or deleted.

3. **Check the status endpoint:**
   - `workspacesAwaitingNewKey` is 0;
   - `currentGenerations` shows the new generation;
   - `retiredPendingDestroy` counts the old generations waiting out their grace period.
4. **Wait 24 hours.** The first run after `oldestRetiredAt` + 24h sweeps each workspace
   once more. That catches any straggler a pod wrote under the old key in the minute
   before it saw the new one. It then scans again and destroys each old generation that
   no object names. The same run deletes the bytes of deleted workspaces (`purged=N`).
   Expect `retiredPendingDestroy: 0`. That is the moment the old data
   keys stop existing.
   With filesystem storage, also wait for `recentLeftovers: 0` in `lastRun.summary`.
   Leftovers of interrupted writes are removed once they are an hour old, and only while
   a rotation is in progress.
5. **Remove `BLOB_DEK_ROTATE_BEFORE`.** Leaving it set is harmless, because every key is
   now newer than it.
6. **Take a fresh database backup.** Backups from before the rotation hold only the old
   data keys, which no longer open anything in the bucket.

## The status endpoint

`GET /api/internal/keys/status` returns counts and key ids, never key material. It needs
the `x-internal-job-secret` header set to `INTERNAL_JOB_SECRET`.

    {
      "encrypted": true, "pod": "api-…",
      "activeKekId": "v2", "retiredKekIds": ["v1"],
      "rowsByKekId": { "v2": 12 },
      "workspacesWithKeys": 12, "currentGenerations": { "2": 12 },
      "rotateBefore": "2026-10-30T09:00:00.000Z", "rotateBeforeError": null,
      "workspacesAwaitingNewKey": 0,
      "retiredPendingDestroy": 12, "oldestRetiredAt": "2026-10-30T09:01:10.000Z",
      "lastRun": { "at": "…", "summary": { "rewrapped": 0, "issued": 0, "resealed": 0, … } }
    }

`lastRun` comes from whichever pod answered. The other fields come from the database.

## What can go wrong

- **A pod starts with the new `BLOB_KEK` but without the old key in `BLOB_KEK_RETIRED`.**
  Workspaces under the old key fail to open with "sealed under unknown key". Nothing is
  lost: put the old key back in `BLOB_KEK_RETIRED`.
- **A re-encryption fails part way.** R2 replaces an object only once the new copy is
  whole, so the old object stays readable. The next run retries.
- **A file read races its own re-encryption.** A ranged read takes its header and its
  bytes in two requests. It retries once if the object was replaced in between.
  The byte Worker can't retry: its grant carries the old header and key. So a video or
  download that is mid-transfer while its object is re-encrypted fails once. Reloading
  fetches a fresh grant. Do the data-key rotation at a quiet time.
- **Destroying a generation that is still needed.** Several checks guard against it:
  - the 24-hour grace period;
  - a final sweep, which must finish without errors;
  - a fresh census taken immediately before deletion.

  The census opens the first chunk of every object. A workspace's old keys are destroyed
  only if every object proves it opens under the current one. Legacy bytes, a damaged
  header, or an object under any other generation keeps them all, because repairing such
  an object later might need one of them.