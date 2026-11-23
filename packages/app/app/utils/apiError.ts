/**
 * The message an API error carries for people (the route's `statusMessage`),
 * or `fallback` when it has none — a network failure, or a response that
 * isn't the API's own.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { data?: { statusMessage?: unknown } } | null)?.data?.statusMessage;
  return typeof message === "string" && message ? message : fallback;
}