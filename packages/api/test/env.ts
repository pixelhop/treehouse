// Load the package .env synchronously at import time. `server/utils/auth.ts`
// constructs the Prisma client when imported (it reads DATABASE_URL eagerly),
// and vite-plus's own env injection lands too late for a top-level static
// import — so import this module first, then dynamic-import anything under
// `server/`.
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url).pathname });

/** Where the server-backed suites expect the API. */
export const SMOKE_BASE = process.env.SMOKE_BASE ?? "http://localhost:3010";

/**
 * Health probe with a DEADLINE. Without one, a peer that accepts the connection
 * and then says nothing hangs the whole gate indefinitely — a hung run is not a
 * failed run, and nobody learns anything from it.
 */
async function probe(base = SMOKE_BASE): Promise<boolean> {
  return fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
}

/**
 * Whether the API is up — and, under `REQUIRE_SERVER=1`, an assertion that it
 * is.
 *
 * Server-gated suites decide with `describe.skipIf(!serverUp)`, which is right
 * for a plain `vp test` and dangerous for a run that exists to PROVE an
 * authorization boundary: a skip reports the same green as a pass. Strict mode
 * therefore THROWS here rather than returning false, so the suite fails.
 *
 * This is checked per suite, not once for the run: a server that goes away for a
 * few seconds mid-run would otherwise let individual files skip while a
 * preflight and a postflight both saw it healthy.
 */
export async function serverAvailable(base = SMOKE_BASE): Promise<boolean> {
  const up = await probe(base);
  if (!up && process.env.REQUIRE_SERVER === "1") {
    throw new Error(
      `REQUIRE_SERVER=1 but no API is answering at ${base}. ` +
        `These suites must run, not skip — start the API or unset REQUIRE_SERVER.`,
    );
  }
  return up;
}

// Fail the import outright when the API is already down at load time, so the
// failure is attributed to the suite rather than to whatever it tries first.
if (process.env.REQUIRE_SERVER === "1") await serverAvailable();