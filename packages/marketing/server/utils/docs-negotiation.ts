/**
 * Whether an `Accept` header asks for markdown ahead of HTML. Pure, for
 * server/middleware/docs-assets.ts and its tests.
 *
 * `text/markdown` wins when it is listed with a quality at least as high as
 * `text/html` (or HTML isn't listed). A bare `*\/*`, a browser's usual header,
 * never selects markdown.
 */
export function docsPrefersMarkdown(accept: string | undefined | null): boolean {
  if (!accept) return false;
  const quality = new Map<string, number>();
  for (const part of accept.split(",")) {
    const [type = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    quality.set(type.trim(), q ? Number(q.slice(2)) || 0 : 1);
  }
  const md = quality.get("text/markdown") ?? quality.get("text/x-markdown");
  if (md === undefined || md <= 0) return false;
  const html = quality.get("text/html");
  return html === undefined || md >= html;
}