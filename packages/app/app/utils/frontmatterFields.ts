// The parts of front-matter handling that don't need a YAML parser: classifying
// already-parsed values for display, and loading the parser when it is needed.
//
// The `yaml` package is the largest dependency most screens would otherwise
// load up front (~30 KB gzipped), and most screens never read front matter.
// Code that loads eagerly (the workspace and share views, the sidebar, the info
// panel) reaches frontmatterData.ts through `loadFrontMatterData()` instead of a
// static import. Code that only runs inside an already-lazy chunk (the markdown
// viewer, the editors) can import frontmatterData.ts directly.

export type FrontMatterFieldKind = "scalar" | "boolean" | "date" | "array" | "complex";

// A date-ish string: YYYY-MM-DD, optionally with a time component.
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Classify a top-level value for display/editing. Dates are detected by string
 * shape (the core schema keeps them as strings). `complex` covers nested objects
 * and arrays whose items are not all primitives — those are shown read-only and
 * deferred to source mode for editing (KTD4).
 */
export function frontMatterFieldKind(value: unknown): FrontMatterFieldKind {
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (typeof value === "string") return DATE_RE.test(value) ? "date" : "scalar";
  if (typeof value === "number" || value === null || value === undefined) return "scalar";
  if (Array.isArray(value)) {
    return value.every((item) => item !== null && typeof item !== "object") ? "array" : "complex";
  }
  return "complex";
}

/** The YAML-backed parse/serialize helpers, fetched on first use. */
export function loadFrontMatterData() {
  return import("./frontmatterData");
}