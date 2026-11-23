// How listings are sorted, and whether they show hidden files, per person and
// per browser. Kept out of the workspace's shared state on purpose: the drag
// order in the sidebar is shared by everyone in the workspace, but choosing to
// look at it by date is yours.
import {
  type ListSort,
  type ListSortKey,
  nextListSort,
  parseListSort,
  TREE_SORTS,
  type TreeSort,
} from "~/utils/treehouse";

const TREE_KEY = "th:tree-sort";
const LIST_KEY = "th:list-sort";
const HIDDEN_KEY = "th:show-hidden";

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage disabled — the in-memory value still holds for this session
  }
}

function stored(key: string): string | null {
  return import.meta.client ? localStorage.getItem(key) : null;
}

export function useSortPrefs() {
  const treeSort = useState<TreeSort>(TREE_KEY, () => {
    const v = stored(TREE_KEY) as TreeSort;
    return TREE_SORTS.includes(v) ? v : "custom";
  });
  const listSort = useState<ListSort>(LIST_KEY, () => parseListSort(stored(LIST_KEY)));
  // Dot-named files (`.claude`, `.obsidian`) are mostly tool config that agents
  // and apps write for themselves, so they start hidden, as in Finder.
  const showHidden = useState<boolean>(HIDDEN_KEY, () => stored(HIDDEN_KEY) === "1");

  function setTreeSort(mode: TreeSort) {
    treeSort.value = mode;
    store(TREE_KEY, mode === "custom" ? null : mode);
  }

  /** A column header click (see nextListSort). */
  function toggleListSort(key: ListSortKey) {
    listSort.value = nextListSort(listSort.value, key);
    store(LIST_KEY, listSort.value ? JSON.stringify(listSort.value) : null);
  }

  function setShowHidden(show: boolean) {
    showHidden.value = show;
    store(HIDDEN_KEY, show ? "1" : null);
  }

  return { treeSort, setTreeSort, listSort, toggleListSort, showHidden, setShowHidden };
}