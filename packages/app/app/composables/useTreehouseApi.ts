// Credentialed client for the Treehouse API (cookie session). Mirrors
// useAuthClient's cross-origin setup: the API is a different origin, so every
// call sends credentials. No Prisma/server deps — Worker-safe.
import {
  encodePath,
  KEEP_FILE,
  type RecoveryOutcome,
  type RecoveryPreview,
  type RecoveryRequest,
  type TrashItem,
  uploadedIconHash,
} from "shared";
import type { ChangeEvent, FeedEvent, RecoveryOperationInfo } from "~/utils/activity";
import {
  type DeleteResult,
  parseDeleteResponse,
  parseWriteResponse,
  writeHeaders,
  type WriteResult,
} from "~/utils/fileWrites";

// A change-feed event including the monotonic `seq` cursor (the reliable
// incremental path). Canonical shape is FeedEvent in utils/activity; aliased
// here for the existing callers that import it from this module.
export type ChangeFeedEvent = FeedEvent;

// New files can't be truly 0 bytes: the PUT route rejects an empty body (a
// truncated upload must not commit a 0-byte file). Seed new files / `.keep`
// placeholders with a single newline.
const NEW_FILE_SEED = "\n";

export interface WorkspaceInfo {
  id: string;
  name: string;
  // Emoji or Iconify name; palette token. Absent on the legacy /api/workspace.
  icon?: string | null;
  color?: string | null;
  // Default theme: preset id or "custom" (themeCss holds the --th-* overrides).
  theme?: string | null;
  themeCss?: string | null;
  /** The caller's own access here. Absent from the workspace list and older APIs. */
  access?: {
    role: string;
    canWrite: boolean;
    key?: { access: "read" | "write"; folder: string | null } | null;
  };
}
export interface FileModifier {
  principal: string; // agent | human
  actorId: string | null;
  actorLabel: string | null;
}
export interface FileEntry {
  path: string;
  version: number;
  size: number;
  contentType: string;
  // From `/list?details=1` (the workspace listing). Absent on a share's listing.
  createdAt?: string;
  updatedAt?: string;
  /** Who made the latest content change; null when the feed has no record. */
  modifiedBy?: FileModifier | null;
  /** Changed recently by someone else (or an agent) and not yet opened by you. */
  unseen?: boolean;
}
/** Notes that link to a file, as the signed-in member sees them. */
export interface FileLinks {
  path: string;
  backlinks: string[];
  /** The file's own tags (front matter, then inline), as written. */
  tags: string[];
  /** False while older notes are still being indexed: the list may grow. */
  complete: boolean;
}
export interface WorkspaceTags {
  /** Sorted by name; `paths` are the readable notes carrying the tag itself. */
  tags: { tag: string; paths: string[] }[];
  /** False while older notes are still being indexed. */
  complete: boolean;
}
/** What a move with `updateLinks` did to the notes linking to the file. */
export interface MoveLinks {
  updated: string[];
  failed: string[];
}
export interface WorkspaceUsage {
  usedBytes: number;
  // null = unlimited (no limit configured)
  limitBytes: number | null;
  remainingBytes: number | null;
  warning: boolean;
  // Live file count against the plan's file limit — the primary workspace
  // limit, since gigabytes barely constrain a folder of documents.
  usedFiles: number;
  limitFiles: number | null;
  remainingFiles: number | null;
  maxFileBytes: number;
  // Public share traffic this month against the published view limit.
  shareViews: number;
  shareViewLimit: number | null;
  shareViewsRemaining: number | null;
  shareWarning: boolean;
  sharesPaused: boolean;
  billing: WorkspaceBilling;
}

/** One purchasable price, per seat, in minor units (cents). */
export interface PlanPrice {
  interval: "month" | "year";
  unitAmount: number;
  currency: string;
}

/** The limits a tier is sold on. `null` means unlimited. */
export interface PlanHighlights {
  filesPerWorkspace: number | null;
  storageBytesPerWorkspace: number | null;
  maxFileBytes: number | null;
  membersPerOrg: number | null;
  shareViewsPerMonth: number | null;
  historyDays: number | null;
  workspacesPerUser: number | null;
}

/** A tier a user can choose, with prices read live from Stripe. */
export interface PlanOffer {
  slug: "seedling" | "grove" | "forest";
  label: string;
  paid: boolean;
  monthly: PlanPrice | null;
  annual: PlanPrice | null;
  highlights: PlanHighlights;
}

/** The workspace's plan, as the server reports it. Never derived client-side. */
export interface WorkspaceBilling {
  plan: "seedling" | "grove" | "forest" | "legacy" | "unlimited";
  planLabel: string;
  paid: boolean;
  status: string | null;
  // `awaiting_payment` = created as a paid workspace whose checkout was never
  // finished. Read-only until the subscription starts. See GraceState in the
  // API's plans.ts, which this mirrors.
  grace: "none" | "grace" | "expired" | "awaiting_payment";
  readOnly: boolean;
  seats: number | null;
  /**
   * People in the workspace — what a checkout will bill for, as opposed to
   * `seats`, which is what Stripe is charging for today.
   */
  members: number;
  /** How often it bills, so seat cost can be quoted in the right units. */
  interval: "month" | "year" | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canManageBilling: boolean;
  hasBillingAccount: boolean;
}
export interface WorkspaceMember {
  id: string; // the user id (matches a change event's actorId)
  name: string;
  image: string | null;
  // "owner" | "admin" | "member" — owners and admins can remove people.
  role: string;
}
export interface ShareView {
  id: string;
  path: string;
  kind: "file" | "folder";
  access: "member" | "public";
  token: string | null;
  hasPassword: boolean;
  pinnedVersion: number | null;
  pinnedContentHash: string | null;
  /** Whether a shared HTML page may run its own scripts for visitors. */
  allowScripts: boolean;
  createdAt: string;
  /** Deduplicated views — one per visitor per day, bots and unfurlers excluded. */
  viewCount: number;
  lastViewedAt: string | null;
}
export interface CreateShareBody {
  path: string;
  kind: "file" | "folder";
  access: "member" | "public";
  password?: string;
  pinnedVersion?: number;
  pinnedContentHash?: string;
  allowScripts?: boolean;
}
// --- Comments (mirrors the server's CommentThreadView; text-first by design:
// the payload carries quote/context/currentText and never numeric offsets) ---
export interface CommentAttribution {
  principal: string; // "human" | "agent"
  actorId: string | null;
  actorKeyId: string | null;
  actorLabel: string | null;
}
export interface CommentEntryView {
  id: string;
  body: string;
  author: CommentAttribution;
  createdAt: string;
}
export interface CommentThreadView {
  id: string;
  path: string;
  status: "open" | "resolved";
  resolvedAt: string | null;
  resolvedAtVersion: number | null;
  resolvedBy: CommentAttribution | null;
  anchorKind: "range" | "point";
  quote: string;
  contextBefore: string;
  contextAfter: string;
  pinnedVersion: number;
  anchorStatus: "anchored" | "ambiguous" | "outdated";
  /** The matching text in the CURRENT version; null unless anchored. */
  currentText: string | null;
  createdBy: CommentAttribution;
  createdAt: string;
  updatedAt: string;
  entries: CommentEntryView[];
  entryCount: number;
  hasMoreEntries: boolean;
}
// A page of threads. Both lists in it are capped, so both say how to get the
// rest: `nextOffset` (null on the last page) walks the threads, and each
// thread's `entryCount`/`hasMoreEntries` walk its replies via `entriesOffset`.
export interface CommentPage {
  threads: CommentThreadView[];
  total: number;
  nextOffset: number | null;
}
/** Replies pulled per "show more" — the server's own default entries page. */
export const COMMENT_ENTRY_PAGE = 20;
export interface CreateCommentBody {
  path: string;
  body: string;
  kind: "range" | "point";
  quote?: string;
  contextBefore?: string;
  contextAfter?: string;
  occurrence?: number;
  /** The version the quote was read from — the server anchors there first. */
  baseVersion?: number;
}
// A create either lands or comes back with a reason. The server never guesses a
// position, so "couldn't anchor" is a normal outcome the caller shows the user
// while keeping their drafted text.
export type CreateCommentResult =
  | { status: "created"; thread: CommentThreadView }
  | { status: "ambiguous"; occurrences: number }
  | { status: "not_found_text" }
  | { status: "conflict"; baseVersion: number; currentVersion: number; reason: string }
  | { status: "error"; error: string };

// A thread's pinned bytes. "gone" is terminal (content-addressed — the version
// will never come back under that hash) and never falls back to current bytes.
export type PinnedContentResult =
  | { status: "ok"; text: string; pinnedVersion: number | null }
  | { status: "gone" }
  | { status: "error"; message: string };

// --- Per-file read state (the return recap + the track-changes base) ---------
export interface FileRecap {
  /** Content-changing events (write/restore/move) since the last visit. */
  versions: number;
  newThreads: number;
  replies: number;
  resolved: number;
  reopened: number;
  /** Threads that anchored in the last-seen bytes and no longer do. */
  newlyOutdated: number;
  actors: { principal: string; actorId: string | null; actorLabel: string | null }[];
  since: string | null;
}
export interface FileReadStateView {
  path: string;
  /** No stored row — seed silently, show no recap. */
  firstVisit: boolean;
  /** The stored hash isn't in this path's current incarnation: degrade to first visit. */
  staleBase: boolean;
  /** The bytes changed since the last visit (hashes, never version numbers). */
  changed: boolean;
  lastSeenVersion: number | null;
  currentVersion: number | null;
  /** The last-seen bytes, when they're still retrievable and worth diffing. */
  base: { version: number; text: string } | null;
  recap: FileRecap | null;
}

/** A restriction the caller can see, with who's on it and how far the caller reaches. */
export interface NodeRestriction {
  path: string;
  kind: string;
  level: "none" | "read" | "write";
  grants: { subject: string; userId: string | null; level: string }[];
}

export interface ApiKeyInfo {
  id: string;
  name: string | null;
  start: string | null;
  metadata?: {
    workspaceId?: string;
    actorType?: string;
    scope?: { access: "read" | "write"; folder: string | null };
  } | null;
  createdAt: string;
}

/** An agent connected over OAuth (one client's consent), from /api/mcp-connections. */
export interface McpConnectionInfo {
  id: string;
  /** The user's name for it, else the name the client registered with. */
  name: string;
  clientName: string | null;
  clientIcon: string | null;
  connectedAt: string;
}

/** What the OAuth consent page shows about the app asking to connect. */
export interface OAuthConsentInfo {
  client: { name: string | null; icon: string | null; uri: string | null };
  /** The name given last time this app was connected, if it was. */
  name: string | null;
}

// Shared conditional-PUT path for write/create/upload. Uses $fetch.raw +
// ignoreResponseError so the expected 412 (stale write) returns a typed conflict
// result instead of throwing; other non-2xx responses still throw.
function filePut(
  base: string,
  credentials: "include",
  workspaceId: string,
  path: string,
  body: string | Uint8Array,
  headerOpts: { path: string; create?: boolean; baseVersion?: number; contentType?: string },
): Promise<WriteResult> {
  return $fetch
    .raw(`${base}/api/workspaces/${workspaceId}/files/${encodePath(path)}`, {
      method: "PUT",
      credentials,
      headers: writeHeaders(headerOpts),
      body,
      ignoreResponseError: true,
    })
    .then((res) => parseWriteResponse(res.status, res._data as never));
}

export function useTreehouseApi() {
  const {
    public: { apiUrl },
  } = useRuntimeConfig();
  const base = apiUrl as string;
  const credentials = "include" as const;

  // Product events are captured HERE rather than in the components that trigger
  // them, for the same reason the masking classes sit at chokepoints: there are
  // several callers for most of these (a workspace can be created from the
  // switcher, the connect flow, or onboarding) and instrumenting the call sites
  // means missing the one added next month.
  //
  // NOTHING derived from a file name, folder name, share token or search query
  // goes into these properties — see useAnalytics() for the rule.
  const analytics = useAnalytics();

  /** Capture `event` once `promise` resolves, and never turn an analytics
   * problem into a user-visible one: a rejected call still rejects for the
   * caller, it just goes uncounted. */
  function tracked<T>(
    promise: Promise<T>,
    event: string,
    props: (result: T) => Record<string, unknown> = () => ({}),
  ): Promise<T> {
    return promise.then((result) => {
      analytics.capture(event, props(result));
      return result;
    });
  }

  return {
    getWorkspace: () => $fetch<WorkspaceInfo>(`${base}/api/workspace`, { credentials }),

    listWorkspaces: () =>
      $fetch<{ workspaces: WorkspaceInfo[] }>(`${base}/api/workspaces`, { credentials }),

    getWorkspaceById: (workspaceId: string) =>
      $fetch<WorkspaceInfo>(`${base}/api/workspaces/${workspaceId}`, { credentials }),

    getUsage: (workspaceId: string) =>
      $fetch<WorkspaceUsage>(`${base}/api/workspaces/${workspaceId}/usage`, { credentials }),

    // Start a Stripe checkout for this workspace's plan. Returns the URL to
    // send the browser to; the org id never reaches the client, because
    // organizations are invisible machinery.
    // Public pricing, read from Stripe by the API. Never hardcode an amount in
    // the app: checkout charges what Stripe says, so a number written down here
    // would eventually advertise one price and bill another.
    plans: () =>
      $fetch<{ available: boolean; plans: PlanOffer[] }>(`${base}/api/plans`, { credentials }),

    startCheckout: (workspaceId: string, plan: "grove" | "forest", annual = false) =>
      $fetch<{ url: string }>(`${base}/api/workspaces/${workspaceId}/billing/checkout`, {
        method: "POST",
        credentials,
        body: { plan, annual },
      }),

    // Open Stripe's billing portal (change card, invoices, cancel).
    openBillingPortal: (workspaceId: string) =>
      $fetch<{ url: string }>(`${base}/api/workspaces/${workspaceId}/billing/portal`, {
        method: "POST",
        credentials,
      }),

    // `plan` does not grant anything: it says the caller intends to buy this
    // workspace, which exempts it from the free-workspace allowance and creates
    // it awaiting payment. The caller must then send them to checkout for it.
    createWorkspace: (input: {
      name: string;
      icon?: string | null;
      color?: string | null;
      plan?: "grove" | "forest";
    }) =>
      tracked(
        $fetch<WorkspaceInfo>(`${base}/api/workspaces`, {
          method: "POST",
          credentials,
          body: input,
        }),
        "workspace_created",
        // The workspace NAME is user-authored, so only whether they bothered to
        // personalise the icon and colour is reported.
        () => ({ customIcon: input.icon != null, customColor: input.color != null }),
      ),

    updateWorkspace: (
      workspaceId: string,
      patch: {
        name?: string;
        icon?: string | null;
        color?: string | null;
        theme?: string | null;
        themeCss?: string | null;
      },
    ) =>
      $fetch<WorkspaceInfo>(`${base}/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        credentials,
        body: patch,
      }),

    // Upload a logo/image as the workspace icon (raw bytes, like a file write).
    // The server stores the bytes and points `icon` at them.
    uploadWorkspaceIcon: (workspaceId: string, image: Blob) =>
      $fetch<WorkspaceInfo>(`${base}/api/workspaces/${workspaceId}/icon`, {
        method: "POST",
        credentials,
        body: image,
        headers: { "content-type": image.type || "application/octet-stream" },
      }),

    // Bytes URL for an uploaded icon (`icon` = "upload:<sha256>"); null for
    // emoji/Iconify icons. Content-addressed, so it is safe to cache forever.
    workspaceIconUrl: (workspaceId: string, icon: string | null | undefined) =>
      uploadedIconHash(icon)
        ? `${base}/api/workspaces/${workspaceId}/icon/${uploadedIconHash(icon)}`
        : null,

    // Iterate the reserved pagination cursor until it is null (always null for
    // now — one page). Aggregating entries here means callers keep working
    // unchanged once the server paginates for real. icons/orders/privatePaths are
    // workspace-global (identical on every page), so the last page's win.
    list: async (workspaceId: string, prefix = "") => {
      type ListPage = {
        entries: FileEntry[];
        icons: Record<string, string>;
        orders: Record<string, number>;
        // The caller's own private node paths (files and folders) — drives the lock.
        privatePaths: string[];
        restrictions?: NodeRestriction[];
        nextCursor: string | null;
      };
      const entries: FileEntry[] = [];
      const meta = {
        icons: {} as Record<string, string>,
        orders: {} as Record<string, number>,
        privatePaths: [] as string[],
        restrictions: [] as NodeRestriction[],
      };
      let cursor: string | null | undefined;
      // Guard against a server bug handing back a repeated cursor (would freeze
      // the tab). Workspace-global metadata is merged key by key, so a future
      // server that omits it on later pages can't null out the first page's.
      const seen = new Set<string>();
      do {
        if (cursor) {
          if (seen.has(cursor)) {
            // Bail out rather than freeze, but say so — the list the caller gets
            // back is truncated, and silence here reads as "that's the whole
            // workspace".
            console.error(`list pagination: repeated cursor ${cursor} — file list truncated`);
            break;
          }
          seen.add(cursor);
        }
        const page = await $fetch<ListPage>(`${base}/api/workspaces/${workspaceId}/list`, {
          credentials,
          // details: dates, last modifier and the "new to you" flag the folder
          // view and the tree show. Only this app asks; sync clients don't.
          query: { prefix, details: "1", ...(cursor ? { cursor } : {}) },
        });
        const { entries: pageEntries, nextCursor, ...pageMeta } = page;
        entries.push(...pageEntries);
        Object.assign(meta, pageMeta);
        cursor = nextCursor;
      } while (cursor);
      return { entries, ...meta };
    },

    setNodeIcon: (workspaceId: string, path: string, icon: string | null) =>
      $fetch<{ path: string; icon: string | null }>(
        `${base}/api/workspaces/${workspaceId}/node-icon`,
        { method: "PUT", credentials, body: { path, icon } },
      ),

    // Mark a file/folder private to the caller, or clear it (private=false).
    setNodePrivate: (
      workspaceId: string,
      path: string,
      kind: "file" | "folder",
      makePrivate: boolean,
    ) =>
      $fetch<{ path: string; private: boolean }>(
        `${base}/api/workspaces/${workspaceId}/node-private`,
        { method: "PUT", credentials, body: { path, kind, private: makePrivate } },
      ),

    // Persist a folder's custom child order (full ordered list of sibling paths).
    setNodeOrder: (workspaceId: string, paths: string[]) =>
      $fetch<{ ok: boolean; count: number }>(`${base}/api/workspaces/${workspaceId}/node-order`, {
        method: "PUT",
        credentials,
        body: { paths },
      }),

    // Move/rename a file (path change). Omit baseVersion to move the current version.
    // `updateLinks` also rewrites the links that reached it, in notes this
    // member can edit, so they follow it to the new path.
    move: (workspaceId: string, from: string, to: string, opts?: { updateLinks?: boolean }) =>
      $fetch<{ path: string; version: number; links?: MoveLinks }>(
        `${base}/api/workspaces/${workspaceId}/move`,
        { method: "POST", credentials, body: { from, to, updateLinks: opts?.updateLinks } },
      ),

    // The notes that link to a file ("Linked from").
    /** Every tag on a note this member can read, with the notes carrying it. */
    tags: (workspaceId: string) =>
      $fetch<WorkspaceTags>(`${base}/api/workspaces/${workspaceId}/tags`, { credentials }),
    links: (workspaceId: string, path: string) =>
      $fetch<FileLinks>(`${base}/api/workspaces/${workspaceId}/links`, {
        credentials,
        query: { path },
      }),

    // Re-path a folder's own ACL + metadata when the folder is moved/renamed.
    // The per-file content moves don't carry the folder's virtual-path ACL, so
    // the UI calls this first to keep the moved subtree private on arrival.
    moveFolderMeta: (workspaceId: string, from: string, to: string) =>
      $fetch<{ from: string; to: string; ok: boolean }>(
        `${base}/api/workspaces/${workspaceId}/move-folder`,
        { method: "POST", credentials, body: { from, to } },
      ),

    // Update an existing file with compare-and-swap against `baseVersion`.
    // Returns a typed conflict result (never throws) when the version is stale —
    // the server keeps the rejected bytes as a conflicted copy.
    writeFile: (
      workspaceId: string,
      path: string,
      body: string | Uint8Array,
      opts: { baseVersion: number; contentType?: string },
    ): Promise<WriteResult> =>
      filePut(base, credentials, workspaceId, path, body, {
        path,
        baseVersion: opts.baseVersion,
        contentType: opts.contentType,
      }),

    // Create a new file (create-only). Maps an existing path to a conflict
    // result. Seeds an empty file with a newline (0-byte bodies are rejected).
    createFile: (
      workspaceId: string,
      path: string,
      body: string | Uint8Array = NEW_FILE_SEED,
      contentType?: string,
    ): Promise<WriteResult> =>
      filePut(base, credentials, workspaceId, path, body, { path, create: true, contentType }),

    // Materialize an empty folder by writing its hidden `.keep` placeholder.
    createFolder: (workspaceId: string, folderPath: string): Promise<WriteResult> => {
      const keepPath = `${folderPath.replace(/\/$/, "")}/${KEEP_FILE}`;
      return filePut(base, credentials, workspaceId, keepPath, NEW_FILE_SEED, {
        path: keepPath,
        create: true,
      });
    },

    // Upload raw bytes to a path. Create-only by default; pass overwrite+
    // baseVersion to replace an existing file via compare-and-swap.
    uploadFile: (
      workspaceId: string,
      path: string,
      bytes: Uint8Array,
      opts: { contentType?: string; overwrite?: boolean; baseVersion?: number } = {},
    ): Promise<WriteResult> =>
      filePut(base, credentials, workspaceId, path, bytes, {
        path,
        contentType: opts.contentType,
        create: !opts.overwrite,
        baseVersion: opts.overwrite ? opts.baseVersion : undefined,
      }),

    // Delete a file (requires the base version). Returns a typed conflict /
    // not-found result rather than throwing on the expected 412/404 paths.
    deleteFile: (workspaceId: string, path: string, baseVersion: number): Promise<DeleteResult> =>
      $fetch
        .raw(`${base}/api/workspaces/${workspaceId}/files/${encodePath(path)}`, {
          method: "DELETE",
          credentials,
          headers: { "if-match": `"${baseVersion}"` },
          ignoreResponseError: true,
        })
        .then((res) => parseDeleteResponse(res.status, res._data as never)),

    readFile: (workspaceId: string, path: string) =>
      $fetch<string>(`${base}/api/workspaces/${workspaceId}/files/${encodePath(path)}`, {
        credentials,
        responseType: "text",
      }),

    /**
     * The bytes AND their identity, as one answer.
     *
     * Two reads of "the same file" can disagree: the viewer caches a body under
     * path + version forever, and a version number is reused when a path is
     * deleted and recreated — so a hash fetched separately (from the change
     * feed, say) can describe different content from the body on screen. Anything
     * that must name what a person actually looked at — pinning a public link
     * that will then EXECUTE those bytes — has to read both from one response.
     */
    readFileSnapshot: (
      workspaceId: string,
      path: string,
    ): Promise<{ body: string; version: number | null; contentHash: string | null }> =>
      $fetch
        .raw<string>(`${base}/api/workspaces/${workspaceId}/files/${encodePath(path)}`, {
          credentials,
          responseType: "text",
        })
        .then((res) => {
          const rawVersion =
            res.headers.get("x-treehouse-version") ??
            res.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "");
          const version = rawVersion ? Number.parseInt(rawVersion, 10) : Number.NaN;
          return {
            body: res._data ?? "",
            version: Number.isNaN(version) ? null : version,
            // Absent behind an older API or a header-stripping proxy. Null means
            // "cannot name these bytes", and every caller fails closed on it.
            contentHash: res.headers.get("x-treehouse-content-hash"),
          };
        }),

    // Read a file's bytes together with its current version (from the ETag), so
    // the editor's save uses an If-Match base that matches the bytes it loaded.
    readFileWithMeta: (
      workspaceId: string,
      path: string,
    ): Promise<{ body: string; version: number | null }> =>
      $fetch
        .raw<string>(`${base}/api/workspaces/${workspaceId}/files/${encodePath(path)}`, {
          credentials,
          responseType: "text",
        })
        .then((res) => {
          // Prefer x-treehouse-version: a CDN in front of the API can weaken or
          // strip the ETag, and a null version here makes the editor save without
          // an If-Match base. ETag stays as the fallback for older servers.
          const raw =
            res.headers.get("x-treehouse-version") ??
            res.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "");
          const version = raw ? Number.parseInt(raw, 10) : Number.NaN;
          return { body: res._data ?? "", version: Number.isNaN(version) ? null : version };
        }),

    // `download: true` asks the server for `Content-Disposition: attachment` —
    // the API is cross-origin from the app, so an anchor's `download` attribute
    // alone is ignored and the file would open in the tab instead of saving.
    fileUrl: (workspaceId: string, path: string, opts?: { download?: boolean }) =>
      `${base}/api/workspaces/${workspaceId}/files/${encodePath(path)}${opts?.download ? "?download=1" : ""}`,

    // Read a prior version's bytes as text (for the version-view sheet).
    readFileVersion: (workspaceId: string, path: string, version: number) =>
      $fetch<string>(`${base}/api/workspaces/${workspaceId}/version`, {
        credentials,
        responseType: "text",
        query: { path, version },
      }),

    // Direct URL to a prior version's bytes (media previews, downloads).
    // `download: true` asks for an attachment, as `fileUrl` does.
    fileVersionUrl: (
      workspaceId: string,
      path: string,
      version: number,
      opts?: { download?: boolean },
    ) =>
      `${base}/api/workspaces/${workspaceId}/version?path=${encodeURIComponent(path)}&version=${version}${opts?.download ? "&download=1" : ""}`,

    // Restore a prior version's bytes as a new head version (non-destructive).
    restoreFile: (workspaceId: string, path: string, targetVersion: number) =>
      $fetch<{ path: string; version: number; restoredFrom: number }>(
        `${base}/api/workspaces/${workspaceId}/restore`,
        { method: "POST", credentials, body: { path, targetVersion } },
      ),

    // Deleted files, newest first. `before` is the previous page's nextBefore.
    trash: (workspaceId: string, opts: { before?: number; prefix?: string; limit?: number } = {}) =>
      $fetch<{ items: TrashItem[]; nextBefore: number | null }>(
        `${base}/api/workspaces/${workspaceId}/trash`,
        { credentials, query: opts },
      ),

    // What a recovery (trash restore, point-in-time restore, undo) would change.
    recoveryPreview: (workspaceId: string, body: RecoveryRequest) =>
      $fetch<RecoveryPreview>(`${base}/api/workspaces/${workspaceId}/recovery/preview`, {
        method: "POST",
        credentials,
        body,
      }),

    // Run it. The server re-plans and checks every change against the version
    // it was planned from, so this is safe to call straight after a preview.
    recoveryApply: (workspaceId: string, body: RecoveryRequest) =>
      tracked(
        $fetch<RecoveryOutcome>(`${base}/api/workspaces/${workspaceId}/recovery/apply`, {
          method: "POST",
          credentials,
          body,
        }),
        "recovery_applied",
        (r) => ({ kind: body.kind, applied: r.applied.length, skipped: r.skipped.length }),
      ),

    // The workspace's members: drives the members panel, and resolves a change
    // event's actorId -> display name + avatar in the activity timeline.
    getMembers: (workspaceId: string) =>
      $fetch<{ members: WorkspaceMember[] }>(`${base}/api/workspaces/${workspaceId}/members`, {
        credentials,
      }),

    // Remove someone from a workspace (owner/admin only). Also revokes the
    // ex-member's sync keys for this workspace, server-side.
    // Who can reach a file or folder: each person's level, or `restricted: false`
    // to open it back up.
    setNodeAccess: (
      workspaceId: string,
      body:
        | { path: string; restricted: false }
        | {
            path: string;
            kind: "file" | "folder";
            everyone: string;
            grants: { userId: string; level: string }[];
          },
    ) =>
      $fetch<{ path: string; restricted: boolean }>(
        `${base}/api/workspaces/${workspaceId}/node-access`,
        { method: "PUT", credentials, body },
      ),

    // Restricted items no remaining member can reach, by name only. Owners only.
    getOrphans: (workspaceId: string) =>
      $fetch<{ orphans: { path: string; kind: string }[] }>(
        `${base}/api/workspaces/${workspaceId}/orphans`,
        { credentials },
      ),

    claimOrphan: (workspaceId: string, path: string) =>
      $fetch<{ path: string; claimed: boolean }>(
        `${base}/api/workspaces/${workspaceId}/orphans-claim`,
        { method: "POST", credentials, body: { path } },
      ),

    setMemberRole: (workspaceId: string, userId: string, role: "member" | "viewer") =>
      $fetch<{ ok: boolean; userId: string; role: string }>(
        `${base}/api/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`,
        { method: "PUT", credentials, body: { role } },
      ),

    removeMember: (workspaceId: string, userId: string) =>
      $fetch<{ ok: boolean; removedUserId: string }>(
        `${base}/api/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE", credentials },
      ),

    // Active shares for a path (no passwordHash). `inherited` are folder shares
    // on an ancestor that already cover this path.
    getShares: (workspaceId: string, path: string) =>
      $fetch<{ shares: ShareView[]; inherited: ShareView[] }>(
        `${base}/api/workspaces/${workspaceId}/shares`,
        { credentials, query: { path } },
      ),

    createShare: (workspaceId: string, body: CreateShareBody) =>
      tracked(
        $fetch<{ share: ShareView }>(`${base}/api/workspaces/${workspaceId}/shares`, {
          method: "POST",
          credentials,
          body,
        }),
        "share_created",
        // Never the token (a bearer credential) and never the path.
        () => ({
          passwordProtected: Boolean((body as { password?: string | null }).password),
          hasExpiry: (body as { expiresInDays?: number | null }).expiresInDays != null,
        }),
      ),

    // Change what an existing link may do, keeping its URL — the link is often
    // already with the person who reported that the page does not respond.
    // `pin` fixes the link to the version being looked at as it is enabled — the
    // safe answer to "this will run whatever the file becomes". Derived
    // server-side; the client only asks for it.
    // Whether a shared HTML page may run its own scripts. Deliberately the only
    // thing this changes: a pinned link is made at creation, where the person is
    // looking at the file.
    setShareScripts: (workspaceId: string, shareId: string, allowScripts: boolean) =>
      $fetch<{ share: ShareView }>(`${base}/api/workspaces/${workspaceId}/shares/${shareId}`, {
        method: "PATCH",
        credentials,
        body: { allowScripts },
        // A deadline, because a request that hangs is indistinguishable from one
        // about to succeed: without it the control sits there disabled with
        // nothing said. A timeout lands in the caller's "we cannot vouch for this
        // any more" path, which is the honest description either way.
        timeout: 15_000,
      }),

    revokeShare: (workspaceId: string, shareId: string) =>
      $fetch<{ ok: boolean }>(`${base}/api/workspaces/${workspaceId}/shares/${shareId}`, {
        method: "DELETE",
        credentials,
      }),

    // Newest-first (order=desc) so the activity panel shows recent events even
    // once a workspace has more than `limit` lifetime changes.
    changes: (workspaceId: string, limit = 100) =>
      $fetch<{ changes: ChangeEvent[] }>(`${base}/api/workspaces/${workspaceId}/changes`, {
        credentials,
        query: { limit, order: "desc" },
      }),

    // Incremental change feed (ascending, seq > sinceSeq) plus the current
    // `head` seq. The reliable monotonic cursor for live collision polling;
    // pass 0 to read from the start of the feed.
    changesSince: (workspaceId: string, sinceSeq: number, limit = 500) =>
      $fetch<{ changes: ChangeFeedEvent[]; head: number; nextSeq?: number }>(
        `${base}/api/workspaces/${workspaceId}/changes`,
        { credentials, query: { sinceSeq, limit } },
      ),

    // Recent workspace activity for the feed: newest-first window plus `head`.
    // The server's desc path orders by createdAt, so re-sort by `seq` here — a
    // move's two events share a createdAt and must not split at the boundary.
    changesRecent: (
      workspaceId: string,
      limit = 200,
    ): Promise<{ changes: ChangeFeedEvent[]; head: number }> =>
      $fetch<{ changes: ChangeFeedEvent[]; head: number }>(
        `${base}/api/workspaces/${workspaceId}/changes`,
        { credentials, query: { limit, order: "desc" } },
      ).then((r) => ({ changes: [...r.changes].sort((a, b) => b.seq - a.seq), head: r.head })),

    // Opted-in variants of the two feed reads above. Comment events are excluded
    // server-side unless `includeComments` is asked for (KTD5), so the surfaces
    // that want review chatter call these — and only these. They are separate
    // methods, not a flag on the originals, because the un-opted callers (the
    // History tab, the share dialog, the CLI-shaped editor poll) share query
    // keys and must not have comment traffic appear underneath them.
    changesRecentWithComments: (
      workspaceId: string,
      limit = 200,
    ): Promise<{
      changes: ChangeFeedEvent[];
      head: number;
      operations: RecoveryOperationInfo[];
    }> =>
      $fetch<{ changes: ChangeFeedEvent[]; head: number; operations?: RecoveryOperationInfo[] }>(
        `${base}/api/workspaces/${workspaceId}/changes`,
        { credentials, query: { limit, order: "desc", includeComments: 1 } },
      ).then((r) => ({
        changes: [...r.changes].sort((a, b) => b.seq - a.seq),
        head: r.head,
        operations: r.operations ?? [],
      })),

    changesSinceWithComments: (workspaceId: string, sinceSeq: number, limit = 500) =>
      $fetch<{ changes: ChangeFeedEvent[]; head: number; nextSeq?: number }>(
        `${base}/api/workspaces/${workspaceId}/changes`,
        { credentials, query: { sinceSeq, limit, includeComments: 1 } },
      ),

    // --- Comments -----------------------------------------------------------

    // One page of threads on a file (open + resolved; the caller buckets them).
    // The server resolves every anchor against the current version on read, so
    // `anchorStatus`/`currentText` describe the file as it is right now. The
    // page is capped server-side, so `total`/`nextOffset` come back with it and
    // the caller pages rather than silently showing a prefix.
    listComments: (workspaceId: string, path: string, offset = 0) =>
      $fetch<CommentPage>(`${base}/api/workspaces/${workspaceId}/comments`, {
        credentials,
        query: { path, offset: offset || undefined },
      }),

    // A tail page of ONE thread's replies. `entriesOffset` applies to every
    // thread in a response, so paging one thread's replies has to be its own
    // single-thread read rather than a wider page of the list above.
    listCommentEntries: (
      workspaceId: string,
      threadId: string,
      entriesOffset: number,
      entriesLimit = COMMENT_ENTRY_PAGE,
    ) =>
      $fetch<CommentPage>(`${base}/api/workspaces/${workspaceId}/comments`, {
        credentials,
        query: { threadId, entriesOffset, entriesLimit },
      }).then((r) => r.threads[0]?.entries ?? []),

    // Create a thread. Anchor failures are expected outcomes, not exceptions:
    // ignoreResponseError turns the 409s into typed results so the caller can
    // keep the user's drafted body on screen (KTD10 — never discard a draft).
    createComment: (workspaceId: string, body: CreateCommentBody): Promise<CreateCommentResult> =>
      $fetch
        .raw<{
          thread?: CommentThreadView;
          error?: string;
          occurrences?: number;
          base_version?: number;
          current_version?: number;
          reason?: string;
        }>(`${base}/api/workspaces/${workspaceId}/comments`, {
          method: "POST",
          credentials,
          body,
          ignoreResponseError: true,
        })
        .then((res): CreateCommentResult => {
          const data = res._data;
          if (res.status === 201 && data?.thread) return { status: "created", thread: data.thread };
          switch (data?.error) {
            case "anchor_ambiguous":
              return { status: "ambiguous", occurrences: data.occurrences ?? 0 };
            case "anchor_not_found":
              return { status: "not_found_text" };
            case "base_version_conflict":
              return {
                status: "conflict",
                baseVersion: data.base_version ?? 0,
                currentVersion: data.current_version ?? 0,
                reason: data.reason ?? "",
              };
            default:
              return { status: "error", error: data?.error ?? `HTTP ${res.status}` };
          }
        }),

    replyToComment: (workspaceId: string, threadId: string, body: string, dedupeKey?: string) =>
      $fetch<{ entry: CommentEntryView; deduped: boolean }>(
        `${base}/api/workspaces/${workspaceId}/comments/${threadId}/replies`,
        { method: "POST", credentials, body: { body, dedupeKey } },
      ),

    // Resolve and reopen are one boolean — there is deliberately no delete.
    setCommentResolved: (workspaceId: string, threadId: string, resolved: boolean) =>
      $fetch<{
        resolved: boolean;
        resolvedAt: string | null;
        resolvedAtVersion: number | null;
        resolvedBy: CommentAttribution | null;
        changed: boolean;
      }>(`${base}/api/workspaces/${workspaceId}/comments/${threadId}/resolved`, {
        method: "PUT",
        credentials,
        body: { resolved },
      }),

    // The exact bytes a thread was written against, by thread id (the hash pin
    // is server-side — no route takes one from a client). 410 is TERMINAL: the
    // version is gone and must never fall back to the current bytes (R9), so it
    // comes back as a typed result rather than an exception to retry.
    readCommentPinnedContent: (
      workspaceId: string,
      threadId: string,
    ): Promise<PinnedContentResult> =>
      $fetch
        .raw<string>(`${base}/api/workspaces/${workspaceId}/comments/${threadId}/pinned-content`, {
          credentials,
          responseType: "text",
          ignoreResponseError: true,
        })
        .then((res): PinnedContentResult => {
          if (res.status === 410) return { status: "gone" };
          if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };
          const v = Number.parseInt(res.headers.get("x-treehouse-pinned-version") ?? "", 10);
          return {
            status: "ok",
            text: res._data ?? "",
            pinnedVersion: Number.isNaN(v) ? null : v,
          };
        }),

    // What happened to one file since the caller last looked (recap + the bytes
    // the track-changes view diffs against). Read-only: it never advances the
    // watermark, so a refresh can't discard a pending recap.
    getFileReadState: (workspaceId: string, path: string) =>
      $fetch<FileReadStateView>(`${base}/api/workspaces/${workspaceId}/file-read-state`, {
        credentials,
        query: { path },
      }),

    // Mark this file seen at the version that was ON SCREEN — not whatever is
    // current when this lands. A reader who never reloaded past the "this file
    // changed" banner has not seen the new version, and recording it would
    // swallow their recap. The hash and feed position still come from the
    // server (no route accepts a hash from a client); `version` only says which
    // snapshot to look up.
    putFileReadState: (workspaceId: string, path: string, version?: number) =>
      $fetch<{ lastSeenSeq: number; lastSeenVersion: number }>(
        `${base}/api/workspaces/${workspaceId}/file-read-state`,
        { method: "PUT", credentials, body: { path, version } },
      ),

    // The caller's activity-feed watermark for a workspace (null if never set).
    getReadState: (workspaceId: string) =>
      $fetch<{ lastSeenSeq: number | null }>(`${base}/api/workspaces/${workspaceId}/read-state`, {
        credentials,
      }),

    // Advance the caller's watermark (monotonic, cookie-session only server-side).
    putReadState: (workspaceId: string, lastSeenSeq: number) =>
      $fetch<{ lastSeenSeq: number }>(`${base}/api/workspaces/${workspaceId}/read-state`, {
        method: "PUT",
        credentials,
        body: { lastSeenSeq },
      }),

    listKeys: () => $fetch<{ keys: ApiKeyInfo[] }>(`${base}/api/keys`, { credentials }),

    createKey: (
      name: string,
      actorType: "agent" | "human",
      scope: { access?: "read" | "write"; folder?: string; workspaceId?: string } = {},
    ) =>
      tracked(
        $fetch<{ id: string; key: string; name: string; actorType: string }>(`${base}/api/keys`, {
          method: "POST",
          credentials,
          body: { name, actorType, ...scope },
        }),
        "api_key_created",
        // actorType only — the key itself and its user-chosen label stay put.
        () => ({ actorType }),
      ),

    revokeKey: (id: string) =>
      $fetch<{ ok: boolean }>(`${base}/api/keys/${id}`, { method: "DELETE", credentials }),

    // OAuth consent for an MCP client. `oauthQuery` is the signed query the API
    // put on the consent page's URL. Accepting returns the client's callback URL
    // (carrying the authorization code) to send the browser to.
    oauthConsentInfo: (oauthQuery: string) =>
      $fetch<OAuthConsentInfo>(`${base}/api/oauth/consent`, {
        credentials,
        query: { oauth_query: oauthQuery },
      }),
    submitOAuthConsent: (oauthQuery: string, accept: boolean, name?: string) =>
      $fetch<{ url: string }>(`${base}/api/oauth/consent`, {
        method: "POST",
        credentials,
        body: { oauth_query: oauthQuery, accept, name },
      }),

    listConnections: () =>
      $fetch<{ connections: McpConnectionInfo[] }>(`${base}/api/mcp-connections`, {
        credentials,
      }),
    renameConnection: (id: string, name: string) =>
      $fetch<{ ok: boolean }>(`${base}/api/mcp-connections/${id}`, {
        method: "PATCH",
        credentials,
        body: { name },
      }),
    disconnectConnection: (id: string) =>
      $fetch<{ ok: boolean }>(`${base}/api/mcp-connections/${id}`, {
        method: "DELETE",
        credentials,
      }),

    // Approve a CLI device-code login for a chosen workspace (mints a scoped key
    // delivered to the waiting CLI; the key is never returned to the browser).
    // `keyName` labels the minted key honestly in key management (the desktop app
    // passes "Treehouse Desktop"); omitted, the server falls back to "treehouse-cli".
    approveDevice: (
      userCode: string,
      workspaceId: string,
      actorType: "agent" | "human" = "human",
      keyName?: string,
      scope: { access?: "read" | "write"; folder?: string } = {},
    ) =>
      $fetch<{ ok: boolean }>(`${base}/api/device/approve`, {
        method: "POST",
        credentials,
        body: { user_code: userCode, workspaceId, actorType, keyName, ...scope },
      }),

    // Create a shareable invite link for a workspace (joining grants org access).
    createInvite: (
      workspaceId: string,
      opts: { expiresInDays?: number; maxUses?: number | null; role?: "member" | "viewer" } = {},
    ) =>
      tracked(
        $fetch<{ token: string; url: string; expiresAt: string; maxUses: number | null }>(
          `${base}/api/invites`,
          { method: "POST", credentials, body: { workspaceId, ...opts } },
        ),
        "invite_created",
        // Not the token or the URL — both are credentials that grant org access.
        () => ({ expiresInDays: opts.expiresInDays ?? null, maxUses: opts.maxUses ?? null }),
      ),

    // Preview an invite link (renders "Join <workspace>" on the accept page).
    // The response also carries a legacy `organizationName`; it is deliberately
    // left off this type because organizations are never shown to users.
    getInvite: (token: string) =>
      $fetch<{
        valid: boolean;
        expired: boolean;
        exhausted: boolean;
        workspace: { id: string; name: string; icon?: string | null; color?: string | null } | null;
        inviterName: string | null;
        role?: "member" | "viewer";
      }>(`${base}/api/invites/${encodeURIComponent(token)}`, { credentials }),

    // Joins the invite's workspace — and only that workspace.
    acceptInvite: (token: string) =>
      $fetch<{ ok: boolean; alreadyMember: boolean; workspaceId: string }>(
        `${base}/api/invites/${encodeURIComponent(token)}/accept`,
        { method: "POST", credentials },
      ),
  };
}