import { createError } from "h3";

/** Longest connection name accepted. */
export const CONNECTION_NAME_MAX = 80;

/**
 * A connection name from a request body, trimmed. Absent means "" (no name of
 * the user's own, so the app's registered name shows instead). Throws a 400 for
 * anything that isn't a string, or is too long.
 */
export function parseConnectionName(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    throw createError({ statusCode: 400, statusMessage: "name must be a string" });
  }
  const name = raw.trim();
  if (name.length > CONNECTION_NAME_MAX) {
    throw createError({
      statusCode: 400,
      statusMessage: `Name must be at most ${CONNECTION_NAME_MAX} characters`,
    });
  }
  return name;
}
/**
 * The consent page's submission: Allow or Cancel, the name typed, and the
 * signed query (still unverified — see `verifyConsentQuery`). Throws a 400 when
 * the decision is missing or the name is invalid.
 */
export function parseConsentBody(raw: unknown): {
  accept: boolean;
  name: string;
  oauthQuery: unknown;
} {
  const body = (raw ?? {}) as { accept?: unknown; name?: unknown; oauth_query?: unknown };
  if (typeof body.accept !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "accept (boolean) is required" });
  }
  return {
    accept: body.accept,
    name: parseConnectionName(body.name),
    oauthQuery: body.oauth_query,
  };
}