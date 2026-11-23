// ---------------------------------------------------------------------------
// Recovery wire types: the trash, point-in-time restore and undo all preview
// and apply through one engine (packages/api/server/utils/recovery.ts), and the
// web app renders its answers. The shapes live here so the two can't drift.
// ---------------------------------------------------------------------------

/** What a recovery operation was. Stored on RecoveryOperation.kind. */
export const RECOVERY_KINDS = ["trash", "restore", "undo"] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

/**
 * One change a recovery will make (or made). Every one goes through the file
 * service as an ordinary write, delete or move, so it is versioned, attributed
 * and synced like any other change, and can itself be undone.
 */
export type RecoveryAction =
  /** Bring back a path that doesn't exist now. */
  | { kind: "recreate"; path: string; size: number }
  /** Put earlier content back at a path that exists now. */
  | { kind: "restore"; path: string; size: number; version: number }
  /** Remove a path that didn't exist at the target. It goes to the trash. */
  | { kind: "delete"; path: string; size: number; version: number }
  /**
   * Move a file back to where it was (undoing a rename), so its comments and
   * history follow it. `restoresContent` when its content changed as well.
   */
  | { kind: "move"; from: string; path: string; size: number; restoresContent: boolean };

/**
 * Why a path a recovery would have touched was left alone. None of these fail
 * the operation; each is reported so the person running it knows what to check.
 */
export const RECOVERY_SKIP_REASONS = [
  /** The earlier content was never recorded, or its bytes can't be read. */
  "unavailable",
  /** The file was private to someone else at that point. */
  "private_then",
  /** Someone else changed the file afterwards; undoing would discard their work. */
  "edited_later",
  /** It was renamed together with a file that's being left alone, so it is too. */
  "linked",
  /** The path is no longer in the trash: it was brought back or recreated. */
  "not_in_trash",
  /** The file changed after the preview was taken. */
  "changed",
  /**
   * It was renamed since and another file has its old name now, so putting it
   * back would leave comments and history on the wrong files.
   */
  "name_taken",
  /** Applying would have changed it, but the preview being confirmed didn't show that. */
  "not_previewed",
  /** It would take the workspace over its storage limit. */
  "storage_limit",
  /** It would take the workspace over its file limit. */
  "file_limit",
  /** It is larger than the plan's largest file. */
  "too_large",
  /** The workspace is read-only (its subscription lapsed). */
  "read_only",
  /** Who can reach it changed since then. A restore doesn't change that. */
  "access_changed",
  /** An unexpected error. The rest of the operation carried on. */
  "failed",
] as const;
export type RecoverySkipReason = (typeof RECOVERY_SKIP_REASONS)[number];

export interface RecoverySkip {
  path: string;
  reason: RecoverySkipReason;
  /** Extra context, such as who edited the file later. Never private details. */
  detail?: string;
}

/** What a recovery would do, before anything is changed. */
export interface RecoveryPreview {
  actions: RecoveryAction[];
  skipped: RecoverySkip[];
  /**
   * The workspace's change-feed head when the preview was taken. Pass it back
   * to apply: anything that changes after it is skipped as `changed` rather than
   * acted on unseen.
   */
  previewHead: number;
  /** More changes than one operation may make; narrow it to a folder. */
  tooLarge: boolean;
}

/** What a recovery did. */
export interface RecoveryOutcome {
  /** Groups the operation's events in the feed. Null when nothing changed. */
  operationId: string | null;
  applied: RecoveryAction[];
  skipped: RecoverySkip[];
}

/**
 * Identifies one previewed change, so apply can be held to exactly the changes
 * a person confirmed: anything else it would now do is left alone.
 */
export function recoveryActionKey(a: RecoveryAction): string {
  return JSON.stringify([a.kind, a.kind === "move" ? a.from : null, a.path]);
}

/** Most changes one recovery operation will make. */
export const MAX_RECOVERY_ACTIONS = 5000;

/** One deleted file in the trash. */
export interface TrashItem {
  path: string;
  /** When it was deleted (ISO). */
  deletedAt: string;
  /** Change-feed position of the deletion. */
  seq: number;
  principal: string;
  actorId: string | null;
  actorKeyId: string | null;
  actorLabel: string | null;
  /** False when the content from before the deletion was never recorded. */
  restorable: boolean;
}

/** Plain-language reason for each skip, for agents and the web app alike. */
export const RECOVERY_SKIP_TEXT: Record<RecoverySkipReason, string> = {
  unavailable: "its earlier content wasn't recorded or can't be read",
  private_then: "it was private to someone else at that point",
  edited_later: "someone else changed it afterwards",
  linked: "it was renamed together with a file that's being left alone",
  not_in_trash: "it isn't in the trash",
  changed: "it changed after the preview",
  not_previewed: "it wasn't in the preview you confirmed",
  name_taken: "it was renamed, and another file has its old name now",
  storage_limit: "it would go over the workspace's storage limit",
  file_limit: "it would go over the workspace's file limit",
  too_large: "it's larger than the plan's largest file",
  read_only: "the workspace is read-only",
  access_changed: "who can reach it has changed since then",
  failed: "something went wrong; try again",
};

/** The body of POST /recovery/preview and /recovery/apply. */
export type RecoveryRequest = (
  | {
      /** Bring these deleted files back from the trash. */
      kind: "trash";
      paths: string[];
    }
  | {
      /** Put a folder, or the whole workspace, back the way it was at `at`. */
      kind: "restore";
      /** The folder. Omit (or null) for the whole workspace. */
      path?: string | null;
      /** ISO timestamp. */
      at: string;
    }
  | {
      /** Undo everything one API key changed since `since`. */
      kind: "undo";
      keyId: string;
      /** ISO timestamp. */
      since: string;
    }
) & {
  /** From the preview, on apply: anything changed after it is left alone. */
  previewHead?: number;
  /**
   * On apply, the `recoveryActionKey` of each change the preview showed. Only
   * those are made; anything else is left alone as `not_previewed`.
   */
  approved?: string[];
};