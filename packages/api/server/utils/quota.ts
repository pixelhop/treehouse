import { FILE_SIZE_CEILING, entitlementsForWorkspace } from "./plans";

// Per-workspace limit resolution. This is the single seam where a workspace's
// effective limits are decided, and the only place that merges the two sources
// they come from:
//
//   - the owning org's plan tier (see plans.ts), which is the product limit;
//   - `DEFAULT_WORKSPACE_QUOTA_BYTES` / `MAX_FILE_BYTES`, which are the operator
//     overrides a self-host uses to bound its own disk.
//
// A plan value always wins where it is set. The env values apply when the plan
// is unlimited, so an unbilled deployment still has whatever ceiling its
// operator configured — and `MAX_FILE_BYTES` additionally caps every tier,
// because it exists to stop a single upload OOMing the instance rather than to
// price anything.

// Warning fires when usage reaches this fraction of the limit.
const WARN_RATIO = 0.9;

// Upload size ceiling. A single large write can OOM a small instance (the write
// path buffers the whole body), so a write above this is rejected with 413. The
// default (100 MB) sits well below the `FileNode.size` Int ceiling (~2.1 GB).
// `MAX_FILE_BYTES` overrides it; a non-numeric or non-positive value falls back
// to the default (fail safe, not open).
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * The instance-wide upload ceiling, independent of any plan. `FileNode.size` is
 * a Postgres Int, so an override past `FILE_SIZE_CEILING` is clamped rather than
 * honoured: the write is then refused with a 413 naming the real limit, instead
 * of buffering gigabytes and dying on an out-of-range error at the metadata
 * write.
 */
export function maxFileBytes(): number {
  const raw = process.env.MAX_FILE_BYTES;
  if (!raw) return DEFAULT_MAX_FILE_BYTES;
  // Strict digits only: `parseInt("100MB")` is 100, which would silently cap
  // uploads at 100 bytes. A value with any non-digit falls back to the default.
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_MAX_FILE_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_FILE_BYTES;
  return Math.min(n, FILE_SIZE_CEILING);
}

/**
 * The operator's storage override (bytes), or `null` for no override.
 *
 * This is the pre-billing behaviour, kept as the self-host escape hatch: an
 * unset value means "no limit from the environment", which is why a deployment
 * that never configures billing stays unlimited.
 */
export function quotaForWorkspace(_workspaceId: string): number | null {
  const raw = process.env.DEFAULT_WORKSPACE_QUOTA_BYTES;
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  // A non-numeric or non-positive override is treated as "no limit" rather than
  // a 0-byte cap that would block every write — fail open for a dormant feature.
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The operator's live-file-count override, or `null` for no override.
 *
 * The counterpart to `DEFAULT_WORKSPACE_QUOTA_BYTES`: file count is the limit
 * that actually bounds Postgres row growth (and stops a dependency folder being
 * synced), so a self-host wanting to cap a workspace needs it as much as bytes.
 * Same fail-open handling — a junk value means no limit, never a zero cap.
 */
export function fileLimitForWorkspace(_workspaceId: string): number | null {
  const raw = process.env.DEFAULT_WORKSPACE_FILE_LIMIT;
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** Every limit that gates a single workspace write. `null` means unlimited. */
export interface WorkspaceLimits {
  storageBytes: number | null;
  files: number | null;
  /** Always a number: the instance ceiling applies even when no plan does. */
  maxFileBytes: number;
  /**
   * The org's grace window has expired, so ordinary writes stop.
   *
   * Reads, moves and deletes continue — a lapsed subscription makes a workspace
   * read-only, it never makes it inaccessible and never deletes anything.
   */
  readOnly: boolean;
}

/**
 * Resolve a workspace's effective limits from its org's plan, merged with the
 * operator overrides.
 *
 * Called inline from `write()`, so plan resolution is cached upstream in
 * plans.ts — this adds no query when the workspace is unlimited.
 */
export async function limitsForWorkspace(workspaceId: string): Promise<WorkspaceLimits> {
  const plan = await entitlementsForWorkspace(workspaceId);
  const instanceMax = maxFileBytes();
  return {
    storageBytes: plan.storageBytesPerWorkspace ?? quotaForWorkspace(workspaceId),
    files: plan.filesPerWorkspace ?? fileLimitForWorkspace(workspaceId),
    // The instance ceiling caps every tier: it is OOM protection, not pricing.
    maxFileBytes: Math.min(plan.maxFileBytes ?? Number.POSITIVE_INFINITY, instanceMax),
    readOnly: plan.grace === "expired" || plan.grace === "awaiting_payment",
  };
}

export interface QuotaStatus {
  usedBytes: number;
  /** null = unlimited */
  limitBytes: number | null;
  /** null = unlimited */
  remainingBytes: number | null;
  /** true only when a limit is set and usage has reached the warn ratio */
  warning: boolean;
}

/** Derive the user-facing quota status from a usage figure and effective limit. */
export function quotaStatus(args: { usedBytes: number; limitBytes: number | null }): QuotaStatus {
  const { usedBytes, limitBytes } = args;
  if (limitBytes == null) {
    return { usedBytes, limitBytes: null, remainingBytes: null, warning: false };
  }
  const remainingBytes = Math.max(0, limitBytes - usedBytes);
  const warning = limitBytes > 0 && usedBytes / limitBytes >= WARN_RATIO;
  return { usedBytes, limitBytes, remainingBytes, warning };
}

export interface FileCountStatus {
  usedFiles: number;
  /** null = unlimited */
  limitFiles: number | null;
  /** null = unlimited */
  remainingFiles: number | null;
  warning: boolean;
}

/** The file-count equivalent of `quotaStatus`. */
export function fileCountStatus(args: {
  usedFiles: number;
  limitFiles: number | null;
}): FileCountStatus {
  const { usedFiles, limitFiles } = args;
  if (limitFiles == null) {
    return { usedFiles, limitFiles: null, remainingFiles: null, warning: false };
  }
  const remainingFiles = Math.max(0, limitFiles - usedFiles);
  const warning = limitFiles > 0 && usedFiles / limitFiles >= WARN_RATIO;
  return { usedFiles, limitFiles, remainingFiles, warning };
}

/** Human-readable one-line summary of a quota status (shared by the MCP tools). */
export function usageSummaryText(status: QuotaStatus, files?: FileCountStatus): string {
  const storage =
    status.limitBytes == null
      ? `Using ${status.usedBytes} bytes (no limit set).`
      : `Using ${status.usedBytes} of ${status.limitBytes} bytes${
          status.warning ? " — near the limit" : ""
        }.`;
  if (!files) return storage;
  const count =
    files.limitFiles == null
      ? ` ${files.usedFiles} files (no limit set).`
      : ` ${files.usedFiles} of ${files.limitFiles} files${files.warning ? " — near the limit" : ""}.`;
  return storage + count;
}