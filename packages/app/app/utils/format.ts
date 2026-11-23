/** Last path segment, e.g. "dir/sub/file.md" → "file.md". */
export function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** Human-readable byte size, e.g. 2048 → "2 KB", 1536 → "1.5 KB". */
export function prettyBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = size;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/** Line and word counts for a text blob (file-info panel stats). */
export function textStats(text: string): { lines: number; words: number } {
  const lines = text.split("\n").length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { lines, words };
}

const TYPE_NAMES: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/html": "HTML page",
  "text/plain": "Plain text",
  "text/csv": "CSV",
  "application/json": "JSON",
  "application/pdf": "PDF",
  "image/svg+xml": "SVG image",
};

/** A content type in words a person would use ("Markdown", "PNG image"), falling
 *  back to the raw type for anything without an everyday name. */
export function friendlyType(contentType: string): string {
  const named = TYPE_NAMES[contentType];
  if (named) return named;
  const [family, sub] = contentType.split("/");
  if (sub && (family === "image" || family === "video" || family === "audio")) {
    return `${sub.toUpperCase()} ${family}`;
  }
  return contentType;
}