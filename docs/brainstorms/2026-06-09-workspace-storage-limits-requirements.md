---
date: 2026-06-09
topic: workspace-storage-limits
---

# Workspace Storage Limits

## Summary

Introduce a per-workspace storage quota tied to the owning organization's plan
tier. A workspace's usage is the sum of its live file sizes; a write that would
push the workspace over its quota is rejected at the shared file-service write
path, so the limit applies identically to agents (MCP) and humans (REST). Usage
and the limit are queryable so users can see where they stand and when to
upgrade.

## Problem Frame

Storage is currently unbounded. Every live file already records its byte count,
but nothing aggregates or caps it, so a single workspace — an agent in a write
loop, or a team accumulating large files — can grow without limit, turning
storage into an uncapped cost. As storage becomes a paid dimension, the product
needs a quota that gates growth and a usage figure users can act on before they
hit the wall.

## Key Decisions

- **Quota is per workspace, valued from the org plan.** Enforcement is scoped to
  a single workspace, matching how users think about "their workspace." The
  quota _number_ derives from the owning org's plan tier as a flat per-workspace
  allowance — the plan grants the same fixed quota to every workspace in the org
  (e.g. a Pro org grants N GB to each), not a shared pool the org distributes.
  Billing attaches to the org, not the individual workspace.
- **Usage is the logical sum of live file sizes.** Total is computed from the
  byte count stored per live file, not from physical (dedup-aware) blob
  bytes. This is predictable for the user — their files visibly add up to the
  number — and any physical dedup savings accrue to us rather than confusing the
  quota.
- **Hard block, not warn-or-grace.** A write that would exceed the quota is
  rejected outright. Warn-only provides no real protection for a paid tier, and
  grace/overage windows add state and abuse surface without enough benefit.
- **Never-lose-data beats the cap.** Data-preservation writes (conflicted copies
  produced by stale-write handling) are exempt from the block and may push a
  workspace over its quota. The overage is bounded and rare; the workspace is
  then over-quota and blocked from further ordinary writes until it frees space.

## Requirements

### Usage measurement

- R1. The system can compute a workspace's current storage usage as the sum of
  the sizes of its live files.
- R2. Usage reflects only live files; hard-deleted files do not count toward the
  total.

### Quota and enforcement

- R3. Each workspace has a storage quota whose value is determined by the owning
  organization's plan tier.
- R4. An ordinary write (file create or update / upload) that would take the
  workspace's usage above its quota is rejected, and no bytes from the rejected
  write are retained.
- R5. Enforcement happens at the shared file-service write path, so REST and MCP
  writes are gated by the same rule with no per-channel divergence.
- R6. Reads, moves, and deletes are always permitted regardless of quota state,
  so a user over quota can always inspect and recover space.
- R7. Data-preservation writes (conflicted copies from stale-write handling) are
  exempt from the quota block and may exceed the quota.

### Visibility

- R8. A workspace's current usage and its quota are queryable via the API and
  exposed to agents via MCP.
- R9. Users are warned as they approach the quota (before the hard block), so the
  block is not the first signal that they are running out of space.
- R10. When a write is rejected for exceeding quota, the response is a clear,
  machine-readable quota error so an agent can recognize the condition and stop
  rather than retry blindly.

## Acceptance Examples

- AE1. **Covers R4.** A workspace is at 9.8 GB of a 10 GB quota. A 0.5 GB upload
  arrives. The write is rejected; usage stays at 9.8 GB.
- AE2. **Covers R6.** A workspace is over quota. The user deletes a large file.
  The delete succeeds and usage drops below the quota; ordinary writes resume.
- AE3. **Covers R6.** A workspace is over quota. A move (rename) is requested.
  The move succeeds — it does not increase total usage.
- AE4. **Covers R7.** A workspace is exactly at quota. A stale write triggers a
  conflicted copy. The conflicted copy is written (usage now exceeds quota); the
  next ordinary write is blocked until space is freed.
- AE5. **Covers R10.** An agent over quota attempts a write via MCP. It receives
  a quota error identifying the condition, not a generic failure.

## Scope Boundaries

- Physical, dedup-aware accounting against actual R2/blob bytes is out of scope —
  usage is the logical sum of live file sizes.
- Org-pooled quotas (one shared limit across an org's workspaces) are not the
  model; enforcement is per workspace.
- Grace/overage windows and reserve-headroom schemes are rejected in favor of a
  hard block plus the data-safety exemption.

## Outstanding Questions

### Deferred to planning

- Whether current usage is computed on demand (aggregate query per check) or
  maintained as a running counter, and the trade-off between the two under
  write-heavy load.
- Exact warning threshold(s) for R9 and how the warning surfaces in the UI.
- Per-file maximum size as a separate limit from the total quota (not discussed;
  decide if needed during planning).
- Behavior for existing workspaces that are already above a newly-applied quota
  at rollout.

## Sources

- `packages/db/prisma/schema.prisma` — `FileNode.size` (bytes per live file) and
  the `Workspace` → `Organization` relation that anchors plan-tier ownership.
  Hard-delete model (no soft-deleted rows) means the live-file sum is the exact
  current footprint.
- `packages/api/server/utils/files.ts` — the single write path for REST + MCP and
  the home of the stale-write conflicted-copy behavior the R7 exemption protects.