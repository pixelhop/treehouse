import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { defineNitroPlugin } from "nitropack/runtime";
import { runtimeHealthLine } from "../utils/runtime-health";

const WINDOW_MS = 60_000;
/** A baseline line every 15 minutes; stalls are reported in the minute they happen. */
const BASELINE_EVERY = 15;
const MB = 1024 * 1024;

/**
 * Report event-loop stalls and memory, once a minute at most.
 *
 * Production pods were restarted by their liveness probe after `/api/health`,
 * which does no work, repeatedly took over a second to answer. That means the
 * event loop itself was blocked, and nothing the API logged said so or showed
 * whether memory was climbing. This is the missing evidence: when the loop
 * stalls, how badly, and what the heap looked like at the time.
 *
 * Off under the test runner, like key maintenance.
 */
export default defineNitroPlugin(() => {
  if (process.env.VITEST) return;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let window = 0;
  setInterval(() => {
    window++;
    const mem = process.memoryUsage();
    const out = runtimeHealthLine(
      {
        // The histogram is in nanoseconds.
        maxDelayMs: delay.max / 1e6,
        p99DelayMs: delay.percentile(99) / 1e6,
        heapUsedMb: mem.heapUsed / MB,
        heapLimitMb: getHeapStatistics().heap_size_limit / MB,
        rssMb: mem.rss / MB,
        uptimeHours: process.uptime() / 3600,
      },
      window,
      BASELINE_EVERY,
    );
    delay.reset();
    if (out) console[out.level](out.line);
  }, WINDOW_MS).unref();
});