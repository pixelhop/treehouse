import { defineNitroPlugin } from "nitropack/runtime";
import { redactApiPath, useAnalytics } from "../utils/analytics";

/**
 * Report server-side exceptions to PostHog.
 *
 * Half of what breaks in Treehouse breaks here rather than in the browser — a
 * failed blob decrypt, a Prisma timeout, an MCP tool throwing on a malformed
 * path — and none of it is visible to the client-side error tracking. Without
 * this, "the app is broken" arrives as a support message rather than as an
 * alert.
 *
 * What is attached to an exception is deliberately thin: the redacted path and
 * the method, nothing else. NOT the request body (file contents), NOT the query
 * string, and NOT the Authorization or Cookie headers (live credentials). An
 * error report is not a place to be generous with context.
 *
 * No-ops entirely when POSTHOG_KEY is unset.
 */
export default defineNitroPlugin((nitroApp) => {
  const analytics = useAnalytics();

  nitroApp.hooks.hook("error", (error, { event }) => {
    // 4xx are the client's problem and would drown the real signal — a stream of
    // 404s from a crawler is not an incident.
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return;

    analytics.captureException(error, undefined, {
      // The API embeds file paths in its routes, so this MUST be redacted.
      path: event ? redactApiPath(event.path) : undefined,
      method: event?.method,
      statusCode: status,
    });
  });

  // Events are batched, so without this a redeploy drops whatever is still in
  // the buffer — which is exactly the window when the interesting errors happen.
  nitroApp.hooks.hook("close", async () => {
    await analytics.shutdown();
  });
});