import { defineNitroPlugin } from "nitropack/runtime";
import {
  type KeyMaintenanceSummary,
  maintenanceSetup,
  recordKeyMaintenanceRun,
  runKeyMaintenance,
} from "../utils/key-maintenance";
import { useBlobStore } from "../utils/storage";

/** Long enough after boot not to compete with readiness. */
const FIRST_RUN_MS = 10_000;
const INTERVAL_MS = 10 * 60_000;

/**
 * Run key maintenance (utils/key-maintenance.ts) on boot and every ten minutes:
 * re-seal data keys under a new BLOB_KEK, and carry out a data-key rotation
 * asked for with BLOB_DEK_ROTATE_BEFORE. Failures are logged and retried on the
 * next run; maintenance never takes the API down.
 *
 * Nothing runs without encryption configured, nor under the test runner, which
 * drives runKeyMaintenance directly.
 */
export default defineNitroPlugin(() => {
  if (process.env.VITEST) return;
  const setup = maintenanceSetup(process.env, useBlobStore);
  if (!setup) return;
  // Loud, and the status endpoint says the same: a bad value must not look like
  // a rotation that is running. Re-sealing under a new KEK carries on.
  if (setup.error) console.error(`[keys] ${setup.error} Data-key rotation is NOT running.`);
  const swept = new Set<string>();
  let running = false;
  let first = true;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runKeyMaintenance({ ...setup.options, swept });
      recordKeyMaintenanceRun(summary);
      report(summary, first);
    } catch (err) {
      console.error("[keys] maintenance run failed; retrying on the next run", err);
    } finally {
      running = false;
      first = false;
    }
  };
  setTimeout(run, FIRST_RUN_MS).unref();
  setInterval(run, INTERVAL_MS).unref();
});

/** One line per run: always the first, then only runs that did something. */
function report(s: KeyMaintenanceSummary, first: boolean): void {
  if (!first && Object.values(s).every((n) => n === 0)) return;
  console.log(
    `[keys] maintenance: ${Object.entries(s)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
}