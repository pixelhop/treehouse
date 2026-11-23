import { PostHog } from "posthog-node";
import { redactUrl } from "shared";

/**
 * Server-side PostHog: exceptions from route handlers, plus the handful of
 * events only the server can report honestly (an agent writing a file through
 * MCP is invisible to any browser).
 *
 * Same contract as the browser side (packages/app/app/plugins/posthog.client.ts):
 * when `POSTHOG_KEY` is unset this is a no-op, so local dev, tests, CI and
 * self-hosted instances need no PostHog account and generate no traffic.
 *
 * NOTHING derived from a file name, folder path, share token or request body
 * goes into an event or an exception here. This API's own routes embed file
 * paths (`/api/workspaces/:id/files/:path`), so request paths must be run
 * through `redactUrl` before they are attached to anything.
 */

/** The subset we use. Narrow so the disabled stub below stays honest. */
export interface ServerAnalytics {
  capture: (args: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  }) => void;
  captureException: (
    error: unknown,
    distinctId?: string,
    properties?: Record<string, unknown>,
  ) => void;
  shutdown: () => Promise<void>;
}

const disabled: ServerAnalytics = {
  capture: () => {},
  captureException: () => {},
  shutdown: async () => {},
};

let cached: ServerAnalytics | null = null;

/**
 * The process-wide client, built on first use.
 *
 * Batched deliberately: this runs inside request handlers, and an unbatched
 * client would turn every captured event into its own outbound HTTP request on
 * the critical path of somebody's file write.
 */
export function useAnalytics(): ServerAnalytics {
  if (cached) return cached;

  const key = process.env.POSTHOG_KEY;
  if (!key) {
    cached = disabled;
    return cached;
  }

  const client = new PostHog(key, {
    host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com",
    flushAt: 20,
    flushInterval: 10_000,
  });

  cached = {
    capture: (args) => client.capture(args),
    captureException: (error, distinctId, properties) =>
      client.captureException(
        error instanceof Error ? error : new Error(String(error)),
        distinctId,
        properties,
      ),
    shutdown: () => client.shutdown(),
  };
  return cached;
}

/**
 * A request path with every user-authored segment removed, safe to attach to an
 * exception. `/api/workspaces/ws_1/files/Finances/Tax.md` becomes
 * `/api/workspaces/ws_1/files/<redacted>`.
 *
 * Thin alias for the shared `redactUrl`, which knows the API's route shapes as
 * well as the app's. It has to know both anyway: the BROWSER emits API URLs too
 * — session replay records network request URLs, and a download link's href
 * points straight at `/api/workspaces/:id/files/<the user's path>`. One
 * implementation means the server and the browser cannot disagree about which
 * paths are safe to log.
 */
export function redactApiPath(path: string): string {
  return redactUrl(path);
}