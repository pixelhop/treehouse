import { createError, defineEventHandler, readBody, setCookie } from "h3";
import { requirePublicShare } from "../../../../utils/public-share";
import { shareCookieName, signShareUnlock, verifySharePassword } from "../../../../utils/shares";

// Verify a public share's password and, on success, set a short-lived signed
// cookie bound to THIS token so the opener isn't re-prompted per file. Throttled
// per token to bound brute force (the only barrier on a weak password).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

// Tokens that are never successfully unlocked would otherwise leave their
// failed-attempt records in the map forever. Sweep expired entries once the map
// grows past a small threshold so this unauthenticated endpoint can't be made to
// leak memory by hammering many distinct tokens.
function pruneExpiredAttempts(now: number) {
  if (attempts.size <= 1000) return;
  for (const [t, rec] of attempts) {
    if (now >= rec.resetAt) attempts.delete(t);
  }
}

export default defineEventHandler(async (event) => {
  const { token, share } = await requirePublicShare(event);

  const now = Date.now();
  pruneExpiredAttempts(now);
  const rec = attempts.get(token);
  const active = rec && now < rec.resetAt ? rec : null;
  if (active && active.count >= MAX_ATTEMPTS) {
    throw createError({ statusCode: 429, statusMessage: "Too many attempts — try again later" });
  }

  // No password on this share → nothing to unlock.
  if (!share.passwordHash) return { ok: true };

  const body = await readBody<{ password?: string }>(event);
  if (!body?.password || !verifySharePassword(body.password, share.passwordHash)) {
    const r = active ?? { count: 0, resetAt: now + WINDOW_MS };
    r.count++;
    attempts.set(token, r);
    throw createError({ statusCode: 401, statusMessage: "Incorrect password" });
  }

  attempts.delete(token);
  setCookie(event, shareCookieName(token), signShareUnlock(token), {
    httpOnly: true,
    secure: true,
    sameSite: "none", // the Cloudflare viewer calls the Railway API cross-site
    path: "/",
    maxAge: 60 * 60, // 1 hour
  });
  return { ok: true };
});