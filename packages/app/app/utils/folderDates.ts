// Pure selection/merge logic behind the calendar's folder-date detection. The
// IO (reading each markdown child's bytes) lives in the useFolderFrontMatter
// composable; everything here is pure so it can be unit-tested directly.
import { isMarkdownPath } from "shared";
import { toDateKey } from "./calendar";
import type { FrontMatterData } from "./frontmatterData";
import type { TreeNode } from "./treehouse";

export interface MarkdownCandidate {
  path: string;
  name: string;
  /** Current version, joined from the flat entry list (TreeNode lacks it). */
  version: number;
}

export interface DatedChild {
  path: string;
  name: string;
  /** `YYYY-MM-DD` publish day. */
  date: string;
  /** Front-matter `title`, when set — the calendar prefers it over the filename. */
  title?: string;
}

/**
 * The markdown children worth reading for a `date`, each joined to its current
 * version. Directories, non-markdown files, and any child missing from the
 * version map are excluded — the version is required for the read cache key.
 */
export function selectMarkdownCandidates(
  children: TreeNode[],
  versionByPath: Map<string, number>,
): MarkdownCandidate[] {
  const out: MarkdownCandidate[] = [];
  for (const child of children) {
    if (child.isDir || !isMarkdownPath(child.name)) continue;
    const version = versionByPath.get(child.path);
    if (version === undefined) continue;
    out.push({ path: child.path, name: child.name, version });
  }
  return out;
}

/**
 * Reduce candidates plus their parsed front matter to the dated entries the
 * calendar places. A candidate is included only when its front matter has a real
 * calendar `date`; everything else (undated drafts, unreadable files whose front
 * matter is absent) is dropped.
 */
export function collectDatedChildren(
  candidates: MarkdownCandidate[],
  frontMatterByPath: Record<string, FrontMatterData | null>,
): DatedChild[] {
  const out: DatedChild[] = [];
  for (const candidate of candidates) {
    const fm = frontMatterByPath[candidate.path];
    const date = fm ? toDateKey(fm.date) : null;
    if (date === null) continue;
    const title = typeof fm?.title === "string" ? fm.title : undefined;
    out.push({ path: candidate.path, name: candidate.name, date, title });
  }
  return out;
}