// Resolution of relative references found in rendered documents (markdown
// images/links, editor image srcs) to workspace paths. Shared because the API
// resolves the same references when it indexes links between notes, and the two
// must agree on what a link points at. Rendering never rewrites the stored
// bytes. Fail-closed: anything that can't be resolved cleanly inside the
// workspace root is "unresolvable" and the caller leaves the original reference
// untouched (broken beats wrong-file).

/** A real scheme ("https:", "mailto:") — not a Windows drive or a lone colon in a name. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export type ResolvedRef =
  /** Has a scheme or is protocol-relative (`//host/…`) — pass through unchanged. */
  | { kind: "external" }
  /** Fragment-only (`#heading`) or empty — leave native/inert. */
  | { kind: "fragment" }
  /** Resolves to a workspace path ("" = workspace root). Query/fragment split off. */
  | { kind: "workspace"; path: string; fragment: string | null }
  /** Escapes the root, fails to decode, or contains unsafe bytes — leave untouched. */
  | { kind: "unresolvable" };

/** Directory of a workspace file path ("" at the root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Classify and resolve a document reference against the directory of the file
 * being rendered (`baseDir`, "" at the workspace root). Root-absolute refs
 * (`/a/b.png`) resolve from the workspace root; `.`/`..` segments are
 * normalized; percent-encoded segments are decoded to match stored paths
 * (entries store raw, unencoded paths).
 */
export function resolveRef(baseDir: string, ref: string): ResolvedRef {
  if (SCHEME_RE.test(ref) || ref.startsWith("//")) return { kind: "external" };

  const { pathPart, fragment } = splitRef(ref);
  if (pathPart === "") return { kind: "fragment" };
  if (pathPart.includes("\\") || pathPart.includes("\0")) return { kind: "unresolvable" };

  const segments = decodeSegments(pathPart);
  if (!segments) return { kind: "unresolvable" }; // malformed percent-encoding

  const base = pathPart.startsWith("/") || !baseDir ? [] : baseDir.split("/");
  const path = normalizeSegments(base, segments);
  return path === null ? { kind: "unresolvable" } : { kind: "workspace", path, fragment };
}

/** Split off the fragment, then the query: neither takes part in path matching. */
function splitRef(ref: string): { pathPart: string; fragment: string | null } {
  const hash = ref.indexOf("#");
  const fragment = hash === -1 ? null : ref.slice(hash + 1);
  const beforeHash = hash === -1 ? ref : ref.slice(0, hash);
  const q = beforeHash.indexOf("?");
  return { pathPart: q === -1 ? beforeHash : beforeHash.slice(0, q), fragment };
}

function decodeSegments(pathPart: string): string[] | null {
  try {
    return pathPart.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
}

/**
 * Stack-normalize `segments` against `base`. Null when `..` pops past the root
 * (a traversal outside the workspace: unresolvable, never clamped) or a
 * decoded segment smuggles a separator.
 */
function normalizeSegments(base: string[], segments: string[]): string | null {
  const stack = [...base];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue; // "a//b", "./", leading "/" artifacts
    if (seg === "..") {
      if (stack.pop() === undefined) return null;
      continue;
    }
    // A decoded segment containing "/" means an encoded slash (%2F) smuggled a
    // multi-segment path past the split — fail closed, never re-split.
    if (/[/\\\0]/.test(seg)) return null;
    stack.push(seg);
  }
  return stack.join("/");
}