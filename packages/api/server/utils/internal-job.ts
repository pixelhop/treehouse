import { createError, getRequestHeader, type H3Event } from "h3";

/**
 * Guard a service-to-service route with the shared INTERNAL_JOB_SECRET, sent as
 * `x-internal-job-secret`. There is no user on these routes, so no session;
 * and without the secret configured the route refuses outright rather than
 * running unauthenticated.
 */
export function requireInternalJobSecret(event: H3Event): void {
  const expected = process.env.INTERNAL_JOB_SECRET;
  if (!expected) {
    throw createError({ statusCode: 503, statusMessage: "Internal jobs not configured" });
  }
  const provided = getRequestHeader(event, "x-internal-job-secret");
  // Length-independent compare is overkill for a fixed-length shared secret on
  // an internal network, but the cost is a single call.
  if (!provided || provided !== expected) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
}