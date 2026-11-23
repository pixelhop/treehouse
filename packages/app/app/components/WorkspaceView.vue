<script setup lang="ts">
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import IconSidebar from "~icons/solar/sidebar-minimalistic-bold-duotone";
import IconPen from "~icons/solar/pen-2-linear";
import IconRefresh from "~icons/solar/refresh-linear";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import IconCopy from "~icons/solar/copy-linear";
import IconDocument from "~icons/solar/document-text-linear";
import IconPlay from "~icons/solar/play-circle-linear";
import IconStop from "~icons/solar/stop-circle-linear";
import IconBoard from "~icons/solar/clipboard-list-linear";
import type { FileModifier, FileReadStateView } from "~/composables/useTreehouseApi";
import { actorShortName } from "~/utils/activity";
import type { BoardContext } from "~/composables/useBoardActions";
import type { Crumb } from "~/components/PathBreadcrumb.vue";
import { cardFields, cardLabel, declaredColumns, distinctStatuses } from "~/utils/board";
import { isMarkdownPath } from "shared";
import { basename } from "~/utils/format";
import { workspaceFileSource } from "~/utils/fileSource";
import { containsExecutableScript, contentIdentity } from "~/utils/htmlScripts";
import { needsSetup } from "~/utils/setupPrompt";
import {
  boardAvailable,
  findDefaultPage,
  folderHeading,
  resolveDefaultView,
  viewerKind,
  visibleNodes,
} from "~/utils/treehouse";
import { VIEWERS, fillsCanvas } from "~/utils/viewers";

const ws = useWorkspaceData();
// Where the viewers read bytes from and how they address other files — the
// authenticated workspace API here, the token-scoped share API on a public link
// (see utils/fileSource.ts).
const api = useTreehouseApi();
// `paths` is what a [[wikilink]] may resolve to: the files this member can see
// (the listing is already filtered for them server-side).
const fileSource = computed(() =>
  workspaceFileSource(api, ws.workspaceId.value ?? "", () => ws.entries.value.map((e) => e.path)),
);
// Shared/persisted so collapsing the details panel survives file navigation
// (this component remounts per route) and page reloads.
const {
  open: rightOpen,
  toggle: toggleRight,
  show: showRight,
  close: closeRight,
  compact: detailsCompact,
} = useDetailsPanel();

// Comment interaction state lives here, above both the viewer and the panel:
// the two are siblings, and toggling edit mode destroys the viewer outright, so
// state owned by either would lose the focused thread and any half-typed reply
// at exactly the wrong moment (KTD3).
const commentUi = provideCommentUi();
// The viewer can't reach the details panel; when it focuses a thread or starts a
// draft it raises a request, and the panel is opened for it.
watch(
  () => commentUi.panelRequest.value,
  () => showRight(),
);

// Workspace activity: the glance drawer. The feed polls on any open workspace
// surface; the glance is a peek (it never advances the watermark — only the
// full /activity view does). The control that opens it lives in the sidebar
// footer, so the flag is shared state rather than a local ref.
const activityUi = useActivityUi();
const showActivity = activityUi.open;
activityUi.registerGlanceHost();
const activityFeed = useActivityFeed(ws.workspaceId);
const { events: activityEvents, loading: activityLoading, error: activityError } = activityFeed;
// The unread count itself is the sidebar's business now; this surface only
// needs the "new since you were here" divider for the drawer.
const { dividerSeq: activityDividerSeq } = useActivityWatermark(ws.workspaceId, {
  events: activityFeed.events,
  head: activityFeed.head,
});
const { byId: activityMembers } = useWorkspaceMembers(ws.workspaceId);
// Who last changed a row of the folder listing, named the way the tabs name
// them: "You", the member, or the agent's own label.
const session = useAuthClient().useSession();
const viewerId = computed(() => session.value.data?.user?.id ?? null);
function modifierName(m: FileModifier): string {
  const member = activityMembers.value.get(m.actorId ?? "");
  return actorShortName(m, viewerId.value, member?.name ?? null);
}
const activityPaths = computed(() => ws.entries.value.map((e) => e.path));
function openActivityFull() {
  showActivity.value = false;
  const id = ws.workspaceId.value;
  if (id) navigateTo(`/w/${id}/activity`);
}
// The calendar's write capability. Constructed HERE, in the authenticated
// workspace surface, and handed to CalendarView as a prop — the public share
// renders the same component without it and so has no write path at all.
const { reschedule: rescheduleEntry } = useCalendarReschedule();
// The board's write capability, the same way: bound to this folder below and
// passed to BoardView, which a public share renders without one.
const boardWriter = useBoardActions();

const viewMode = ref<"rendered" | "source">("rendered");
const editing = ref(false);
// A choice made about the page on screen right now, overriding the standing
// answer for these bytes: `true` from the top bar on a file with no grant,
// `false` to stop a page that a grant would otherwise run. Null means "no
// override, use what was decided before". Cleared whenever the bytes change, so
// it can never carry into a document it was not about.
const runScriptsOverride = ref<boolean | null>(null);
// Folder pages: a folder with a default page (README/index) fronts it, with the
// file listing and (when children are dated, or carry a status) a calendar or
// board one toggle away. Resets per navigation; `userPickedView` marks a manual
// choice so the declared default doesn't override the user once they've
// switched.
type FolderViewMode = "page" | "files" | "calendar" | "board";
const folderView = ref<FolderViewMode>("page");
const userPickedView = ref(false);
// The board card open in the drawer, if any.
const openCardPath = ref<string | null>(null);

// Kinds with a rendered⇄source toggle (utils/viewers.ts) get it in the top bar,
// so it never pushes the document content down.
const kind = computed(() =>
  ws.selectedEntry.value
    ? viewerKind(ws.selectedEntry.value.contentType, ws.selectedEntry.value.path)
    : null,
);
const hasToggle = computed(() => !!kind.value && VIEWERS[kind.value].sourceToggle);
// Editable kinds get an Edit button; the markdown and code editors own their
// own source/format controls while editing.
const editable = computed(() => !!kind.value && VIEWERS[kind.value].editor !== null);
// Whether this member can change what's open: the workspace may be fine and this
// folder view-only.
const canWriteHere = computed(() =>
  ws.selectedPath.value ? ws.canWritePath(ws.selectedPath.value) : !ws.viewOnly.value,
);

watch(
  () => ws.selectedPath.value,
  () => {
    viewMode.value = "rendered";
    editing.value = false;
    runScriptsOverride.value = null;
    folderView.value = "page";
    userPickedView.value = false;
    openCardPath.value = null;
  },
);

// --- Catch-up: what happened here since you last looked (R11/R12) -----------
// The read state is READ on open and WRITTEN on leaving (or on dismissing the
// recap) — never on mount, so a refresh mid-recap still shows the recap (KTD7).
const qc = useQueryClient();

const catchUpPath = computed(() =>
  kind.value === "markdown" ? ws.selectedEntry.value?.path : undefined,
);
const readStateQuery = useQuery({
  queryKey: computed(() => ["file-read-state", ws.workspaceId.value, catchUpPath.value]),
  queryFn: () => api.getFileReadState(ws.workspaceId.value as string, catchUpPath.value as string),
  enabled: computed(() => !!ws.workspaceId.value && !!catchUpPath.value),
  // Never refetched mid-visit: the recap describes the moment you arrived, and
  // a background refresh landing after you read it would quietly rewrite it.
  staleTime: Number.POSITIVE_INFINITY,
});

// Held locally for the visit, so dismissing the recap (which drops the query)
// doesn't also take away the "see the changes" toggle.
const fileState = ref<FileReadStateView | null>(null);
const recapDismissed = ref(false);
const showChanges = ref(false);
// Plain variable, not a ref: the path watcher below has to see the file we are
// LEAVING, and a reactive read would already have moved on.
let openFilePath: string | null = null;
// The version whose bytes each visited path last had ON SCREEN. Keyed by path
// rather than held as a single variable because the leaving-file watcher below
// fires after `selectedEntry` has already moved on — the same reason
// `openFilePath` exists. Reloading past the change banner refetches the entry
// and updates this; sitting on the banner does not, which is the whole point.
const seenVersion = new Map<string, number>();

watchEffect(() => {
  const data = readStateQuery.data.value;
  if (!data) return;
  fileState.value = data;
  openFilePath = data.path;
});

watchEffect(() => {
  const entry = ws.selectedEntry.value;
  if (entry) seenVersion.set(entry.path, entry.version);
});

/** Record that this file has been seen at the version that was on screen. */
async function markFileSeen(path: string) {
  const id = ws.workspaceId.value;
  if (!id) return;
  try {
    await api.putFileReadState(id, path, seenVersion.get(path));
  } catch {
    // Best effort — a failed watermark just means the recap shows again.
  }
  qc.removeQueries({ queryKey: ["file-read-state", id, path] });
}

// Every file is marked seen on leaving, not only markdown with a recap: the
// same row is what clears the tree's "new" marker. `prev` names the file being
// left when there was no recap query to set `openFilePath`.
watch(
  () => ws.selectedPath.value,
  (_path, prev) => {
    const leaving = prev && seenVersion.has(prev) ? prev : openFilePath;
    if (leaving) void markFileSeen(leaving);
    openFilePath = null;

    fileState.value = null;
    recapDismissed.value = false;
    showChanges.value = false;
  },
);
onBeforeUnmount(() => {
  const open = ws.selectedEntry.value?.path ?? openFilePath;
  if (open) void markFileSeen(open);
});

// A first-ever visit shows nothing (there is no "since" to report), and a
// stored snapshot that isn't in this path's history degrades the same way.
const recap = computed(() => {
  const s = fileState.value;
  if (!s || s.firstVisit || s.staleBase || !s.changed || !s.recap) return null;
  if (recapDismissed.value) return null;
  return s.recap;
});
const recapSummary = computed(() => {
  const r = recap.value;
  if (!r) return [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (r.versions) parts.push(plural(r.versions, "new version"));
  if (r.newThreads) parts.push(plural(r.newThreads, "new comment"));
  if (r.replies) parts.push(plural(r.replies, "reply", "replies"));
  if (r.resolved) parts.push(`${r.resolved} resolved`);
  if (r.reopened) parts.push(`${r.reopened} reopened`);
  if (r.newlyOutdated) {
    parts.push(
      r.newlyOutdated === 1
        ? "1 comment no longer matches the text"
        : `${r.newlyOutdated} comments no longer match the text`,
    );
  }
  return parts;
});
function dismissRecap() {
  recapDismissed.value = true;
  if (openFilePath) void markFileSeen(openFilePath);
}

// The toggle only exists when there is a base to compare against.
const changesAvailable = computed(
  () => !!fileState.value?.base && !fileState.value.staleBase && !editing.value,
);
// The current bytes for the diff, fetched BY the version the key names and
// cached under "file-version" — a namespace of its own, never the viewers'
// "file" key. Both halves matter: `readFile` reads the mutable head, so a
// write landing mid-flight could cache newer bytes under an older version's
// label; and FileViewer fills the shared "file" key through exactly that head
// read, so an already-successful entry there would satisfy this query without
// this exact-version queryFn ever running. In this namespace every entry is,
// by construction, the revision its key says it is. Saves seed it directly
// (see useFileEditor) so Save → Done needs no refetch.
const currentTextQuery = useQuery({
  queryKey: computed(() => [
    "file-version",
    ws.workspaceId.value,
    ws.selectedEntry.value?.path,
    ws.selectedEntry.value?.version,
  ]),
  queryFn: ({ queryKey }) =>
    api.readFileVersion(queryKey[1] as string, queryKey[2] as string, queryKey[3] as number),
  enabled: computed(() => showChanges.value && !!ws.workspaceId.value && !!catchUpPath.value),
  staleTime: Number.POSITIVE_INFINITY,
});
function openChanges() {
  showChanges.value = true;
  recapDismissed.value = true;
}

// A file you just created is empty, so the rendered view has nothing to show —
// open it straight in the editor instead, which is what you asked for by making
// it. An effect rather than a watcher on the path: the entry only appears once
// the post-create file-list refresh lands, a tick or two after the navigation,
// and FileEditor needs it. Runs AFTER the reset above (registered later), so the
// `editing = false` on navigation can't undo it.
watchEffect(() => {
  const pending = ws.pendingEditPath.value;
  if (!pending) return;
  if (pending !== ws.selectedPath.value) {
    // Navigated elsewhere before the entry landed — the request is stale.
    ws.pendingEditPath.value = null;
    return;
  }
  if (!ws.selectedEntry.value) return; // still loading
  ws.pendingEditPath.value = null;
  if (editable.value && canWriteHere.value) editing.value = true;
});

// The folder being viewed: the selected folder, or the workspace root on the
// overview. selectedFolder itself stays untouched — breadcrumbs, FolderView,
// and the right panel all branch on it and root must not change their behavior.
const isRoot = computed(() => !ws.selectedPath.value);
// Hidden (dot-named) children follow the sidebar's "Show hidden files".
const { showHidden } = useSortPrefs();
const folderChildren = computed(() => {
  if (ws.selectedFolder.value)
    return visibleNodes(ws.selectedFolder.value.children, showHidden.value);
  return isRoot.value ? visibleNodes(ws.tree.value, showHidden.value) : null;
});

// Read each markdown child's front matter, so the calendar and board can be
// offered and a `view:` default honored. Returns empty until the per-file reads
// resolve, so nothing flashes before it's known.
const {
  loading: folderLoading,
  datedChildren,
  hasDatedChildren,
  boardCards,
  hasStatusChildren,
  defaultPageFrontMatter,
} = useFolderFrontMatter(fileSource, folderChildren, ws.entries);
const hasBoard = computed(() =>
  boardAvailable(defaultPageFrontMatter.value, hasStatusChildren.value),
);
const boardColumns = computed(() => declaredColumns(defaultPageFrontMatter.value));
const boardFields = computed(() => cardFields(defaultPageFrontMatter.value));
const declaredView = computed(() =>
  resolveDefaultView(defaultPageFrontMatter.value, hasDatedChildren.value),
);

// The folder's display heading — a README/index `title` overrides the raw
// folder name in the calendar and listing headings (breadcrumb stays the path).
const folderTitle = computed(() =>
  folderHeading(
    defaultPageFrontMatter.value,
    ws.selectedFolder.value?.name ?? ws.workspace.value?.name ?? "",
  ),
);

// Open in the calendar when the folder declares it (and has dated children),
// unless the user already picked a view this navigation. Runs reactively, so it
// applies once the async date detection resolves rather than on first paint.
watchEffect(() => {
  if (userPickedView.value) return;
  folderView.value = declaredView.value === "default" ? "page" : declaredView.value;
});

function pickView(view: FolderViewMode) {
  userPickedView.value = true;
  folderView.value = view;
}
const defaultPageNode = computed(() =>
  folderChildren.value ? findDefaultPage(folderChildren.value) : null,
);
// The default page renders through FileViewer, which needs the flat entry.
const defaultPageEntry = computed(() =>
  defaultPageNode.value
    ? (ws.entries.value.find((e) => e.path === defaultPageNode.value?.path) ?? null)
    : null,
);
const showDefaultPage = computed(() => !!defaultPageEntry.value && folderView.value === "page");
const defaultPageKind = computed(() =>
  defaultPageEntry.value
    ? viewerKind(defaultPageEntry.value.contentType, defaultPageEntry.value.path)
    : null,
);
// Folder treatment applies to selected folders always, and to the root only
// when it has a default page (otherwise the overview placeholder stays).
const folderMode = computed(
  () => !!ws.selectedFolder.value || (isRoot.value && !!defaultPageEntry.value),
);

// --- Board ------------------------------------------------------------------
// Everything a board action needs to know about this folder to write to it.
const boardContext = computed<BoardContext>(() => ({
  folderPath: ws.selectedFolder.value?.path ?? "",
  folderName: ws.selectedFolder.value?.name ?? ws.workspace.value?.name ?? "",
  defaultPagePath: defaultPageNode.value?.path ?? null,
  defaultPageFrontMatter: defaultPageFrontMatter.value,
  childNames: (folderChildren.value ?? []).map((c) => c.name),
}));
const boardActions = computed(() => boardWriter.bind(boardContext.value));

const openCardEntry = computed(() =>
  openCardPath.value ? (ws.entries.value.find((e) => e.path === openCardPath.value) ?? null) : null,
);
const openCardTitle = computed(() => {
  const card = boardCards.value.find((c) => c.path === openCardPath.value);
  return card ? cardLabel(card) : "";
});
function openCardPage() {
  const path = openCardPath.value;
  openCardPath.value = null;
  if (path) ws.select({ path, isDir: false });
}
async function editCard() {
  const path = openCardPath.value;
  openCardPath.value = null;
  if (!path) return;
  await ws.select({ path, isDir: false });
  // Set AFTER the navigation lands, as createFile does, so the request is never
  // live against the folder being left.
  ws.pendingEditPath.value = path;
}

// "Show as board": declare a folder that isn't one yet. Needs a markdown
// default page to hold the declaration (or none, and one is created) — an
// index.html front page has no front matter to put it in.
const canShowAsBoard = computed(
  () =>
    canWriteHere.value &&
    folderMode.value &&
    defaultPageFrontMatter.value?.view !== "board" &&
    (!defaultPageNode.value || isMarkdownPath(defaultPageNode.value.path)),
);
async function showAsBoard() {
  const res = await boardWriter.enableBoard(boardContext.value, distinctStatuses(boardCards.value));
  if (res.status !== "ok") {
    window.alert(
      "Couldn't turn this folder into a board. Its README may have changed. Refresh and try again.",
    );
    return;
  }
  // Let the new `view: board` declaration open the board once it's re-read.
  userPickedView.value = false;
}

const crumbs = computed(() => {
  const p = ws.selectedPath.value;
  if (!p) return [];
  const parts = p.split("/");
  const lastIsDir = !!ws.selectedFolder.value;
  return parts.map((name, i) => ({
    name,
    path: parts.slice(0, i + 1).join("/"),
    isDir: i < parts.length - 1 || lastIsDir,
  }));
});

// The last crumb is what is already open, so selecting it would do nothing.
// Instead it shows that file in the sidebar tree — "where is this?" answered
// from the path you were just reading. A closed sidebar opens first; the tree
// picks up the request as it mounts.
const treeUi = useFileTreeUi();
const sidebar = useSidebar();
function onCrumb(crumb: Crumb | null) {
  if (crumb && crumb.path === ws.selectedPath.value) {
    if (!sidebar.open.value) sidebar.toggle();
    treeUi.locate(crumb.path);
    return;
  }
  void ws.select(crumb && { path: crumb.path, isDir: crumb.isDir });
}

// A path we can't place yet: the file list is still loading (a deep link or a
// reload with a cold cache). Shown as loading, not as missing — before the list
// arrives every path looks absent.
const resolvingPath = computed(
  () =>
    ws.loading.value &&
    !!ws.selectedPath.value &&
    !ws.selectedEntry.value &&
    !ws.selectedFolder.value,
);
// A path that isn't a known file or folder (e.g. a deleted/bad link).
const notFound = computed(
  () =>
    !ws.loading.value &&
    !!ws.selectedPath.value &&
    !ws.selectedEntry.value &&
    !ws.selectedFolder.value,
);

// Full-bleed kinds (utils/viewers.ts) get the whole canvas, with no prose
// container or padding — including a folder's default page (the README/Files
// switcher lives in the top bar, so nothing pushes the page down). Source view
// stays in the padded column.
const canvasKind = computed(() =>
  ws.selectedEntry.value ? kind.value : showDefaultPage.value ? defaultPageKind.value : null,
);
const fullBleed = computed(() =>
  fillsCanvas(canvasKind.value, ws.selectedEntry.value ? viewMode.value : "rendered"),
);
// The scripts feature keys off this: only a rendered HTML page on the canvas
// can be offered its scripts.
const htmlFull = computed(() => fullBleed.value && canvasKind.value === "html");
// A board needs the width for its columns, so it leaves the reading column.
const boardFull = computed(
  () => folderMode.value && !notFound.value && !editing.value && folderView.value === "board",
);

// The scripts toggle only means anything where a rendered HTML page is on
// screen. Offering it anywhere else would be a control that does nothing.
const scriptsAvailable = computed(() => htmlFull.value && !editing.value);

// The HTML page currently on the canvas — the open file, or the default page
// fronting a folder. Both reach the full-bleed branch, so both can be offered
// their scripts.
const htmlEntry = computed(() =>
  htmlFull.value ? (ws.selectedEntry.value ?? defaultPageEntry.value) : null,
);
// Its bytes, read through the SAME query key the viewer uses (see FileViewer),
// with the same infinite staleTime — so this subscribes to the cached content
// rather than fetching the file a second time to look at it.
const htmlSourceQuery = useQuery({
  queryKey: computed(() => [
    "file",
    fileSource.value.key,
    htmlEntry.value?.path,
    htmlEntry.value?.version,
  ]),
  queryFn: () => fileSource.value.readText(htmlEntry.value!.path),
  enabled: computed(() => !!htmlEntry.value),
  staleTime: Number.POSITIVE_INFINITY,
});
// Only offer to run pages that have something to run. Asking about an inert
// document would be a prompt with no upside, and every needless permission
// prompt makes the next one cheaper to click through.
const htmlHasScripts = computed(
  () => scriptsAvailable.value && containsExecutableScript(htmlSourceQuery.data.value ?? ""),
);

// WHICH BYTES are on screen — the identity a grant is written against. Not the
// file version: the viewer reads the mutable head, so a write landing between
// the directory listing and that read serves content the listed version never
// described, and every newly created node starts at version 1, so a deleted-and-
// recreated path presents different bytes under the version a grant was given
// to. Digesting what is actually rendered sidesteps both.
//
// Cleared before each recomputation and guarded on the way out, so a slow digest
// can never land against content that has since been replaced — a stale identity
// here would be a grant applied to bytes nobody approved.
const htmlContentId = ref<string | null>(null);
watch(
  () => htmlSourceQuery.data.value,
  (source) => {
    htmlContentId.value = null;
    if (!source) return;
    void contentIdentity(source).then((id) => {
      if (htmlSourceQuery.data.value === source) htmlContentId.value = id;
    });
  },
  { immediate: true },
);

const scriptGrants = useHtmlScriptGrants(ws.workspaceId);
const scriptStance = computed(() =>
  htmlEntry.value ? scriptGrants.stanceFor(htmlEntry.value.path, htmlContentId.value) : "unasked",
);
/**
 * Whether the page in the frame is executing. DERIVED, not a flag someone
 * remembers to update: a standing allow depends on the grant store, the signed-in
 * user and the content identity, and all three settle at their own pace — the
 * session in particular arrives well after the first render. An earlier version
 * of this was a watcher, and a file with a perfectly good grant sat inert
 * forever because the user id landed after the watcher's last firing. A computed
 * cannot have an incomplete dependency list.
 */
const runScripts = computed(() => runScriptsOverride.value ?? scriptStance.value === "allowed");

// Any manual choice was about the bytes that were on screen when it was made.
watch(htmlContentId, () => {
  runScriptsOverride.value = null;
});

// Ask only when there is a question: something to run, and no answer on record
// for these bytes.
const showScriptsNotice = computed(
  () =>
    htmlHasScripts.value &&
    !runScripts.value &&
    (scriptStance.value === "unasked" || scriptStance.value === "stale"),
);

// One path for both the notice and the top-bar item, so a decision made in
// either place is treated the same. The override is what makes the top bar work
// even when the decision cannot be persisted (no identity to name it by); the
// `remember` is what makes it outlive the visit.
function decideScripts(allow: boolean) {
  runScriptsOverride.value = allow;
  const entry = htmlEntry.value;
  if (entry) scriptGrants.remember(entry.path, htmlContentId.value, allow);
}

// The agent hand-off card for a workspace nobody has organised yet. Root only —
// it answers "this place is empty, now what", which is only a question at the
// top. Gated on `!loading` so it never flashes in before the file list resolves
// and then vanishes, which would read as a glitch on the very first screen a
// new user sees.
const desktopFolders = useDesktopFolders();
onMounted(() => {
  void desktopFolders.refresh();
});
// Only the desktop shell knows a synced folder exists; in a browser this stays
// null and the prompt asks the user where the folder is instead.
const syncedFolderName = computed(() => {
  const id = ws.workspaceId.value;
  return id ? (desktopFolders.folderFor(id)?.folderName ?? null) : null;
});
const showSetupCard = computed(
  () => isRoot.value && !ws.loading.value && !!ws.workspace.value && needsSetup(ws.tree.value),
);

// --- Top bar ---------------------------------------------------------------
// One switcher for every way of looking at this file, one primary action, and
// a "⋯" for the rest. The bar used to carry two segmented controls in two
// different styles (Document/Changes and Rendered/Source) plus three text
// buttons of equal weight, which made "Edit" no more findable than "Refresh".

type FileView = "rendered" | "source" | "changes";

// The version count from the catch-up recap, read off the visit's held state
// rather than off `recap` — entering the changes view dismisses the recap, and
// a label that drops its count the moment you click it reads as a glitch.
const changesCount = computed(() => {
  const s = fileState.value;
  if (!s || s.firstVisit || s.staleBase || !s.changed) return 0;
  return s.recap?.versions ?? 0;
});

// Segments appear only when they apply: Source where the kind has one, Changes only
// when there is a base to compare against. Below two segments there is no
// choice to make, so the control doesn't appear at all.
const viewOptions = computed(() => {
  const opts: { value: FileView; label: string; title?: string }[] = [
    { value: "rendered", label: "Reading" },
  ];
  if (hasToggle.value) opts.push({ value: "source", label: "Source" });
  if (changesAvailable.value) {
    opts.push({
      value: "changes",
      label: changesCount.value ? `Changes · ${changesCount.value}` : "Changes",
      title: "What changed since you last looked",
    });
  }
  return opts;
});
const showViewSwitcher = computed(
  () => !folderMode.value && !editing.value && viewOptions.value.length > 1,
);
// A façade over viewMode + showChanges so the three segments are one value.
// The underlying pair stays as it was: the path watcher resets both, and
// `fullBleed`/FileViewer read `viewMode` directly.
const viewState = computed<FileView>({
  get: () => (showChanges.value ? "changes" : viewMode.value),
  set: (v) => {
    if (v === "changes") return openChanges();
    showChanges.value = false;
    viewMode.value = v;
  },
});

// The folder switcher: the same control, so a folder and a file look like one
// product. `pickView` records the manual choice (see `userPickedView`).
const folderViewOptions = computed(() => {
  const opts: { value: FolderViewMode; label: string; mask?: boolean }[] = [];
  if (defaultPageNode.value) {
    opts.push({ value: "page", label: defaultPageNode.value.name, mask: true });
  }
  if (hasDatedChildren.value) opts.push({ value: "calendar", label: "Calendar" });
  if (hasBoard.value) opts.push({ value: "board", label: "Board" });
  opts.push({ value: "files", label: "Files" });
  return opts;
});
const showFolderSwitcher = computed(() => folderMode.value && folderViewOptions.value.length > 1);

// "⋯" contents. Download and copy-path duplicate the details panel's Info tab
// on purpose: the panel is a place you go to read about a file, and these are
// things you do to the one already open.
const menuItemClass =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-fg no-underline transition hover:bg-surface-2 lg:py-1.5";
const openFileName = computed(() =>
  ws.selectedEntry.value ? basename(ws.selectedEntry.value.path) : "",
);
const downloadUrl = computed(() =>
  ws.selectedEntry.value && ws.workspaceId.value
    ? api.fileUrl(ws.workspaceId.value, ws.selectedEntry.value.path, { download: true })
    : "",
);
async function copyPath() {
  const path = ws.selectedEntry.value?.path ?? ws.selectedPath.value;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    // clipboard can be blocked — nothing useful to say about it here
  }
}
</script>

<template>
  <AppTopBar>
    <template #breadcrumb>
      <PathBreadcrumb
        :root-label="ws.workspace.value?.name ?? 'Workspace'"
        :crumbs="crumbs"
        leaf-title="Show in file tree"
        @select="onCrumb($event)"
      />
    </template>
    <!-- The view switcher: inline in a wide bar, folded into the "⋯" sheet on a
         phone. What stays in #actions below is only what earns its width. -->
    <template #menu>
      <!-- Folder pages: the default page (when present), the calendar (when the
           folder has dated children), and the file listing. In the top bar so it
           never pushes the page content down. Calendar is gated on dated
           children independently of the default page, so a README-less folder of
           dated posts still gets it. -->
      <SegmentedControl
        v-if="showFolderSwitcher"
        :model-value="folderView"
        :options="folderViewOptions"
        label="Folder view"
        @update:model-value="pickView"
      />
      <!-- Reading ⇄ Source ⇄ what changed since the last visit (R12). One
           control, so there is never a way into the marked-up view without an
           obvious way back out of it. -->
      <SegmentedControl
        v-else-if="showViewSwitcher"
        v-model="viewState"
        :options="viewOptions"
        label="View"
      />
    </template>
    <!-- Behind "⋯" at every width: the commands you reach for occasionally, and
         which were spending permanent bar width on themselves. -->
    <template #overflow>
      <!-- Folder mode: leave the folder for the page fronting it. -->
      <button
        v-if="folderMode && defaultPageNode"
        type="button"
        :class="menuItemClass"
        @click="ws.select({ path: defaultPageNode.path, isDir: false })"
      >
        <IconDocument class="h-4 w-4 shrink-0 text-fg-subtle" />
        Open file
      </button>
      <button v-if="canShowAsBoard" type="button" :class="menuItemClass" @click="showAsBoard()">
        <IconBoard class="h-4 w-4 shrink-0 text-fg-subtle" />
        Show as board
      </button>
      <!-- Interactive pages — a deck with arrow-key controls, a self-drawing
           chart — are dead without their JavaScript, but running it is a choice
           about one file, so it lives here rather than switching itself on. The
           title says what is actually being allowed; see utils/htmlSandbox.ts. -->
      <button
        v-if="scriptsAvailable"
        type="button"
        :class="menuItemClass"
        :title="
          runScripts
            ? 'Go back to the inert preview'
            : 'Let this page run its own JavaScript. It can reach the internet, but not your session, workspace or the app around it.'
        "
        @click="decideScripts(!runScripts)"
      >
        <component :is="runScripts ? IconStop : IconPlay" class="h-4 w-4 shrink-0 text-fg-subtle" />
        {{ runScripts ? "Stop scripts" : "Run scripts" }}
      </button>
      <button type="button" :class="menuItemClass" @click="ws.refresh()">
        <IconRefresh class="h-4 w-4 shrink-0 text-fg-subtle" />
        Refresh
      </button>
      <template v-if="ws.selectedEntry.value">
        <a :href="downloadUrl" :download="openFileName" :class="menuItemClass">
          <IconDownload class="h-4 w-4 shrink-0 text-fg-subtle" />
          Download
        </a>
        <button type="button" :class="menuItemClass" @click="copyPath()">
          <IconCopy class="h-4 w-4 shrink-0 text-fg-subtle" />
          Copy path
        </button>
      </template>
    </template>
    <template #actions>
      <!-- The one primary action on the screen. It stays put in the changes
           view too: hiding it there made the whole switcher jump sideways the
           moment you clicked "Changes", and editing from a diff is a perfectly
           reasonable thing to want. -->
      <button
        v-if="editable && !editing && canWriteHere"
        type="button"
        class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 text-sm font-medium text-accent-fg transition hover:opacity-90 lg:h-8"
        @click="editing = true"
      >
        <IconPen class="h-4 w-4" />
        Edit
      </button>
    </template>
    <template #trailing>
      <button
        type="button"
        :title="rightOpen ? 'Hide details' : 'Show details'"
        class="grid h-9 w-9 shrink-0 place-items-center rounded-md transition hover:bg-surface-2 lg:h-8 lg:w-8"
        :class="rightOpen ? 'text-fg' : 'text-fg-muted'"
        @click="toggleRight()"
      >
        <IconSidebar class="h-4 w-4 -scale-x-100" />
      </button>
    </template>
  </AppTopBar>

  <!-- A lapsed subscription, explained. Sits directly under the top bar so it
       is the first thing seen, and above the error slot because a billing state
       is the likely CAUSE of any write error below it. -->
  <BillingBanner
    v-if="ws.usage.value && ws.workspaceId.value"
    :workspace-id="ws.workspaceId.value"
    :billing="ws.usage.value.billing"
  />

  <div
    v-if="ws.error.value"
    class="mx-4 mt-3 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
  >
    {{ ws.error.value }}
  </div>

  <!-- Body: center viewer + right details -->
  <div class="relative flex min-h-0 flex-1">
    <!-- overflow-x-hidden, not overflow-auto: a single wide child (a markdown
         table, a long URL) used to slide the WHOLE document sideways, carrying
         headings and paragraphs off-screen with it. Wide children now scroll on
         their own axis (see .prose in tailwind.css). -->
    <section class="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      <!-- Edit mode: the editor owns the whole pane. -->
      <LazyFileEditor
        v-if="editing && ws.selectedEntry.value && ws.workspace.value"
        class="h-full"
        :workspace-id="ws.workspace.value.id"
        :entry="ws.selectedEntry.value"
        @close="editing = false"
      />
      <!-- Full-bleed kinds fill the whole canvas. `relative` so the scripts
           offer can float in a corner of it instead of taking layout space away
           from the page. -->
      <div v-else-if="fullBleed && ws.workspace.value" class="relative h-full">
        <FileViewer
          class="h-full"
          :file-source="fileSource"
          :entry="ws.selectedEntry.value ?? defaultPageEntry"
          :mode="viewMode"
          :kind="canvasKind"
          :html-scripts="runScripts"
        />
        <HtmlScriptsNotice
          v-if="showScriptsNotice"
          :changed="scriptStance === 'stale'"
          @allow="decideScripts(true)"
          @dismiss="decideScripts(false)"
        />
      </div>
      <!-- A board: full width, its columns scroll sideways. -->
      <div v-else-if="boardFull" class="min-h-full px-4 pt-6 pb-10 sm:px-8">
        <LazyBoardView
          :name="folderTitle"
          :cards="boardCards"
          :columns="boardColumns"
          :fields="boardFields"
          :loading="folderLoading"
          :actions="canWriteHere ? boardActions : undefined"
          @open="openCardPath = $event"
        />
      </div>
      <!-- Everything else: centered reading column. -->
      <!-- min-h-full, not h-full: with a fixed 100% height the padding box ends
           at the viewport and a long document overflows straight past its own
           bottom padding, leaving the last line jammed against the window edge.
           The generous pb is deliberate on top of that — text should stop well
           short of the frame, not touch it. -->
      <div v-else class="mx-auto min-h-full max-w-3xl px-4 pt-6 pb-24 sm:px-8 sm:pt-8 sm:pb-32">
        <!-- Sits ABOVE the seeded README rather than replacing it: the README is
             the same instructions in prose, and someone who wants to read before
             clicking should still be able to. -->
        <WorkspaceSetupCard
          v-if="showSetupCard && ws.workspace.value"
          class="mb-8"
          :workspace-name="ws.workspace.value.name"
          :workspace-id="ws.workspace.value.id"
          :folder-name="syncedFolderName"
        />
        <FileLoading v-if="resolvingPath" />
        <p v-else-if="notFound" class="text-sm text-fg-subtle">
          “<!-- ph-mask: a missing route still contains the user-authored file path. --><span
            class="ph-mask"
            >{{ ws.selectedPath.value }}</span
          >” isn’t in this workspace.
        </p>
        <template v-else-if="folderMode">
          <!-- Calendar view of the folder's dated children. -->
          <LazyCalendarView
            v-if="folderView === 'calendar'"
            :name="folderTitle"
            :children="datedChildren"
            :reschedule="canWriteHere ? rescheduleEntry : undefined"
            @select="ws.select($event)"
          />
          <!-- Default page renders read-only (editing lives on the file's own
               page via the top bar's "Open file"). html default pages never
               reach here — they take the full-bleed branch above. -->
          <FileViewer
            v-else-if="showDefaultPage && ws.workspace.value"
            :file-source="fileSource"
            :entry="defaultPageEntry"
          />
          <FolderView
            v-else
            :name="folderTitle"
            :icon="ws.selectedFolder.value?.icon"
            :children="folderChildren ?? []"
            :who-name="modifierName"
            @select="ws.select($event)"
          />
        </template>
        <template v-else-if="ws.workspace.value">
          <!-- Catch-up recap: what happened here while you were away (R11).
               Sits above the document, never over it, and says plainly what it
               is — a first-ever visit has nothing to report and shows nothing. -->
          <div
            v-if="recap && !showChanges"
            class="mb-6 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3"
          >
            <p class="text-sm font-medium text-fg">
              Updated since you last looked
              <span v-if="fileState?.lastSeenVersion != null" class="text-fg-subtle">
                · you last saw v{{ fileState.lastSeenVersion }}</span
              >
            </p>
            <p v-if="recapSummary.length" class="mt-1 text-sm text-fg-muted">
              {{ recapSummary.join(" · ") }}
            </p>
            <div class="mt-2.5 flex items-center gap-3">
              <button
                v-if="changesAvailable"
                type="button"
                class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg"
                @click="openChanges"
              >
                See what changed
              </button>
              <button
                type="button"
                class="text-xs text-fg-subtle hover:text-fg"
                @click="dismissRecap"
              >
                Dismiss
              </button>
            </div>
          </div>

          <!-- `current` and `current-version` both follow the LIVE entry:
               saving from the diff (Edit → Done) advances the entry version and
               with it the current-text query, and a visit-held version here
               would label bytes it no longer describes. The diff renders only
               once that exact version's text has LOADED — while the query is
               keyed to a version it hasn't fetched yet (first open, or the
               moment after a save bumps the version), diffing the base against
               an empty string would show the whole document as deleted. -->
          <template v-if="showChanges && fileState?.base && ws.selectedEntry.value">
            <LazyTrackChangesView
              v-if="currentTextQuery.isSuccess.value"
              :workspace-id="ws.workspace.value.id"
              :path="ws.selectedEntry.value.path"
              :base="fileState.base.text"
              :current="currentTextQuery.data.value ?? ''"
              :base-version="fileState.base.version"
              :current-version="ws.selectedEntry.value.version"
              @close="showChanges = false"
            />
            <p v-else-if="currentTextQuery.isError.value" class="text-sm text-danger">
              Couldn’t load the current version to compare.
              <button
                type="button"
                class="underline underline-offset-4"
                @click="currentTextQuery.refetch()"
              >
                Try again
              </button>
            </p>
            <p v-else class="text-sm text-fg-subtle">Loading changes…</p>
          </template>
          <FileViewer
            v-else
            :file-source="fileSource"
            :comments-workspace-id="ws.workspace.value.id"
            :entry="ws.selectedEntry.value"
            :mode="viewMode"
            :kind="kind"
          />
        </template>
      </div>
    </section>

    <!-- A board card, read without leaving the board. -->
    <LazyBoardCardDrawer
      v-if="boardFull && openCardEntry"
      :entry="openCardEntry"
      :file-source="fileSource"
      :title="openCardTitle"
      :editable="canWriteHere"
      @close="openCardPath = null"
      @open="openCardPage"
      @edit="editCard"
    />

    <!-- Compact: the details panel overlays the document with a scrim, the same
         way the sidebar does. Beside it there would be nothing left to detail. -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="rightOpen && detailsCompact"
        class="absolute inset-0 z-30 bg-black/40 lg:hidden"
        @click="closeRight()"
      />
    </Transition>
    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      leave-active-class="transition-transform duration-150 ease-in"
      enter-from-class="translate-x-full"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="rightOpen && ws.workspace.value"
        class="overflow-auto border-l border-border p-4"
        :class="
          detailsCompact
            ? 'absolute inset-y-0 right-0 z-40 w-[min(86vw,20rem)] bg-surface shadow-xl'
            : 'w-80 shrink-0'
        "
      >
        <RightPanel
          :workspace="ws.workspace.value"
          :entry="ws.selectedEntry.value"
          :folder="ws.selectedFolder.value"
          :file-count="ws.entries.value.length"
          :usage="ws.usage.value"
        />
      </aside>
    </Transition>
  </div>

  <ActivityGlance
    v-if="showActivity && ws.workspace.value"
    :workspace-id="ws.workspace.value.id"
    :events="activityEvents"
    :operations="activityFeed.operations.value"
    :divider-seq="activityDividerSeq"
    :members-by-id="activityMembers"
    :paths="activityPaths"
    :loading="activityLoading"
    :error="activityError"
    @close="showActivity = false"
    @see-all="openActivityFull"
  />
</template>