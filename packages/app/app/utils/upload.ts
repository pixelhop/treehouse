// Helpers for multi-file upload.

/** Join a file name into a destination folder ("" = workspace root). */
export function uploadPath(destDir: string, name: string): string {
  return destDir ? `${destDir}/${name}` : name;
}

/**
 * Find a non-colliding name by inserting " (n)" before the extension, e.g.
 * "report.md" → "report (1).md". Used for the "keep both" upload strategy.
 */
export function uniqueName(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 1;
  let candidate = `${dir}${stem} (${i})${ext}`;
  while (taken(candidate)) {
    i += 1;
    candidate = `${dir}${stem} (${i})${ext}`;
  }
  return candidate;
}