// Remembers which HTML files this person has allowed to run, so a deck they
// present twice doesn't ask twice. The rules live in ~/utils/htmlScripts.ts;
// this only holds them and writes them down.
//
// localStorage, not the server: it is a per-person, per-browser judgement about
// content, not workspace configuration — one member trusting a file says nothing
// about what the next member should be handed.
//
// Which is exactly why the scope carries the USER id as well as the workspace.
// A browser is shared: sign out, sign in as someone else, and workspace-only
// scoping would hand the second account the first one's answers about files they
// have never seen. Nothing here is cleared on sign-out, so the key has to do
// that work instead.
import { useAuthClient } from "~/composables/useAuthClient";
import {
  normalizeGrants,
  type ScriptGrantStore,
  type ScriptStance,
  scriptStance,
  withScriptDecision,
} from "~/utils/htmlScripts";

const GRANTS_KEY = "th:html-scripts";

function load(): ScriptGrantStore {
  if (!import.meta.client) return {};
  try {
    return normalizeGrants(JSON.parse(localStorage.getItem(GRANTS_KEY) || "{}"));
  } catch {
    return {}; // corrupt storage — start clean, which prompts rather than runs
  }
}

/** `workspaceId` is the workspace whose files are being decided about. */
export function useHtmlScriptGrants(workspaceId: Readonly<Ref<string | null | undefined>>) {
  const store = useState<ScriptGrantStore>(GRANTS_KEY, load);
  const session = useAuthClient().useSession();

  // Null whenever either half is unknown — a signed-out or still-loading client
  // has no scope, and `scriptStance` reads that as "unasked" rather than
  // reaching into some other scope's answers.
  const scope = computed(() => {
    const userId = session.value.data?.user?.id;
    return userId && workspaceId.value ? `${userId}:${workspaceId.value}` : null;
  });

  function persist() {
    if (import.meta.client) localStorage.setItem(GRANTS_KEY, JSON.stringify(store.value));
  }

  /** Reads `store.value`, so callers can wrap this in a computed and stay reactive. */
  function stanceFor(path: string, contentId: string | null): ScriptStance {
    return scriptStance(store.value, scope.value, path, contentId);
  }

  /**
   * No identity, nothing to remember: a decision that cannot name the bytes it
   * was about is worse than no decision, because a later file would inherit it.
   * The choice still applies to the page in front of the user; it just doesn't
   * outlive it.
   */
  function remember(path: string, contentId: string | null, allow: boolean) {
    if (!scope.value || !contentId) return;
    store.value = withScriptDecision(store.value, scope.value, path, contentId, allow);
    persist();
  }

  return { stanceFor, remember };
}