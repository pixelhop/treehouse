// The resolved current workspace id, republished as plain shared state.
//
// Why this exists: `useWorkspaceData` is a normal (unmemoised) composable, so
// every call constructs four vue-query observers plus a session subscription.
// `useFileTreeUi` needs the workspace id and nothing else, and it is called from
// every recursive FileTree instance — once per rendered folder — so reading it
// from here meant ~4 observers per folder for a value that is one string.
//
// It must be republished rather than derived from the route: `workspaceId` below
// is a three-step fallback (route param, then last-opened, then first workspace),
// and the sidebar renders on /dashboard and /workspace where there is no
// workspaceId route param at all.
export const ACTIVE_WS_KEY = "th:activeWorkspaceId";