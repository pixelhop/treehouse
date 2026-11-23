// Workspace-relative path normalization, shared by the file service and the
// access-control / share layers. Kept in its own module so acl.ts and files.ts
// can both depend on it without forming an import cycle.

/**
 * Normalize a workspace-relative path and reject traversal. Throws
 * `PathError` on `..`, absolute escapes, or null bytes — callers map this to a
 * 400. The result never starts with `/` and contains no `.`/`..` segments.
 */
export class PathError extends Error {}

export function normalizePath(input: string): string {
  if (input.includes("\0")) throw new PathError("path contains a null byte");
  // Reject backslashes: they are directory separators on Windows, so allowing
  // them would let "..\\..\\x" slip past the forward-slash traversal check.
  if (input.includes("\\")) throw new PathError("backslashes are not allowed in paths");
  const segments = input.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) throw new PathError("path traversal is not allowed");
  const path = segments.join("/");
  if (path.length === 0) throw new PathError("empty path");
  return path;
}