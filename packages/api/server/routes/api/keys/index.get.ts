import { defineEventHandler } from "h3";
import { auth } from "../../../utils/auth";
import { requireCookieUser, webHeaders } from "../../../utils/workspace";

// List the current user's API keys (cookie session only — not reachable with an
// API key). better-auth stores metadata as a JSON string; parse it so the UI
// can read actorType/workspaceId.
export default defineEventHandler(async (event) => {
  await requireCookieUser(event);
  // listApiKeys returns { apiKeys, total, ... } — return just the array (the
  // previous code returned the whole wrapper, which the app couldn't iterate).
  const { apiKeys } = await auth.api.listApiKeys({ headers: webHeaders(event) });
  return {
    keys: apiKeys.map((k) => ({
      ...k,
      metadata: typeof k.metadata === "string" ? safeParse(k.metadata) : (k.metadata ?? null),
    })),
  };
});

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}