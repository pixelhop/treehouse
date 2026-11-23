import type { AccessSubject } from "./acl";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createError } from "h3";
import { MAX_RECOVERY_ACTIONS, type RecoveryPreview, recoveryActionKey } from "shared";
import {
  fitToLimits,
  onlyApproved,
  type OperationMeta,
  planPointInTime,
  planTrashRestore,
  planUndo,
  type RecoveryPlan,
} from "./recovery";
import { normalizePath } from "./paths";
import type { RequestPrincipal } from "./workspace";

// The request side of the recovery routes: validate a body, and turn it into a
// plan and the description of the operation it would be. Preview and apply
// share this, so what is previewed is exactly what is applied.

export interface PlannedRequest {
  plan: RecoveryPlan;
  meta: OperationMeta;
}

/** The `paths` of a trash request, validated. */
function trashPaths(body: Record<string, unknown>): string[] {
  const paths = body.paths;
  const valid =
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((p) => typeof p === "string" && p.length > 0);
  if (!valid) {
    throw createError({ statusCode: 400, statusMessage: "paths must be a non-empty string array" });
  }
  if (paths.length > MAX_RECOVERY_ACTIONS) {
    throw createError({
      statusCode: 400,
      statusMessage: `At most ${MAX_RECOVERY_ACTIONS} paths at a time`,
    });
  }
  return paths as string[];
}

/** The previewed changes being confirmed, when applying. */
function approvedOf(body: Record<string, unknown>): Set<string> | undefined {
  const raw = body.approved;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || !raw.every((k) => typeof k === "string")) {
    throw createError({ statusCode: 400, statusMessage: "approved must be a string array" });
  }
  if (raw.length > MAX_RECOVERY_ACTIONS) {
    throw createError({
      statusCode: 400,
      statusMessage: `At most ${MAX_RECOVERY_ACTIONS} changes at a time`,
    });
  }
  return new Set(raw as string[]);
}

/** A required ISO timestamp field. */
function timestamp(body: Record<string, unknown>, field: string): Date {
  const raw = body[field];
  const at = typeof raw === "string" ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw createError({ statusCode: 400, statusMessage: `${field} must be an ISO timestamp` });
  }
  return at;
}

/** An optional folder path; empty or absent means the whole workspace. */
function scopeOf(body: Record<string, unknown>): string | null {
  const raw = body.path;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw createError({ statusCode: 400, statusMessage: "path must be a string" });
  }
  return normalizePath(raw);
}

/** The preview's head, when applying. */
function previewHeadOf(body: Record<string, unknown>): bigint | undefined {
  const raw = body.previewHead;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw createError({ statusCode: 400, statusMessage: "previewHead must be a whole number" });
  }
  return BigInt(raw);
}

type Planner = (
  workspaceId: string,
  ctx: RequestPrincipal,
  access: AccessSubject,
  body: Record<string, unknown>,
) => Promise<PlannedRequest>;

/** One planner per recovery kind. */
const PLANNERS: Record<string, Planner> = {
  async trash(workspaceId, _ctx, access, body) {
    const plan = await planTrashRestore({
      workspaceId,
      subject: access,
      paths: trashPaths(body),
      previewHead: previewHeadOf(body),
    });
    return {
      plan: await fitToLimits(workspaceId, onlyApproved(plan, approvedOf(body))),
      meta: { kind: "trash" },
    };
  },
  async restore(workspaceId, _ctx, access, body) {
    const scope = scopeOf(body);
    const at = timestamp(body, "at");
    const plan = await planPointInTime({
      workspaceId,
      subject: access,
      scope,
      at,
      previewHead: previewHeadOf(body),
    });
    return {
      plan: await fitToLimits(workspaceId, onlyApproved(plan, approvedOf(body))),
      meta: { kind: "restore", scopePath: scope, targetAt: at },
    };
  },
  async undo(workspaceId, ctx, access, body) {
    const keyId = typeof body.keyId === "string" ? body.keyId : "";
    if (!keyId) throw createError({ statusCode: 400, statusMessage: "keyId is required" });
    // A person may undo any key's changes they can see, as they could restore
    // the workspace to a point in time. A key may only undo its own: undoing
    // someone else's work is a person's call, not an agent's.
    if (ctx.keyId && ctx.keyId !== keyId) {
      throw createError({ statusCode: 403, statusMessage: "A key can only undo its own changes" });
    }
    const since = timestamp(body, "since");
    const planned = await planUndo({
      workspaceId,
      subject: access,
      keyId,
      since,
      previewHead: previewHeadOf(body),
    });
    return {
      plan: await fitToLimits(workspaceId, onlyApproved(planned, approvedOf(body))),
      meta: { kind: "undo", targetAt: since, targetKeyId: keyId, targetLabel: planned.label },
    };
  },
};

export async function planFromBody(
  workspaceId: string,
  ctx: RequestPrincipal,
  access: AccessSubject,
  body: unknown,
): Promise<PlannedRequest> {
  const b = (body ?? {}) as Record<string, unknown>;
  const planner =
    typeof b.kind === "string" && Object.hasOwn(PLANNERS, b.kind) ? PLANNERS[b.kind] : undefined;
  if (!planner) throw createError({ statusCode: 400, statusMessage: "Unknown recovery kind" });
  return planner(workspaceId, ctx, access, b);
}

/**
 * A preview as one opaque token for an agent to hand back when applying: the
 * feed head and the changes the preview showed, so applying it is held to
 * exactly those, as the app's `previewHead` and `approved` hold its apply.
 * Compressed, since a restore can list thousands of changes.
 */
export function previewTokenFor(preview: RecoveryPreview): string {
  const keys = preview.actions.map(recoveryActionKey);
  return deflateRawSync(JSON.stringify([preview.previewHead, keys])).toString("base64url");
}

/** The head and approved changes in a preview token, or null if it isn't one. */
export function readPreviewToken(
  token: string,
): { previewHead: bigint; approved: Set<string> } | null {
  try {
    const [head, keys] = JSON.parse(inflateRawSync(Buffer.from(token, "base64url")).toString());
    const valid =
      Number.isSafeInteger(head) &&
      head >= 0 &&
      Array.isArray(keys) &&
      keys.length <= MAX_RECOVERY_ACTIONS &&
      keys.every((k) => typeof k === "string");
    return valid ? { previewHead: BigInt(head), approved: new Set(keys as string[]) } : null;
  } catch {
    return null;
  }
}