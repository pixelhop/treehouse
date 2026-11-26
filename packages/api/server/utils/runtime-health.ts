/** What one sampling window saw, in the units the log line uses. */
export interface RuntimeWindow {
  /** Longest event-loop delay in the window, ms. */
  maxDelayMs: number;
  /** 99th-percentile event-loop delay in the window, ms. */
  p99DelayMs: number;
  heapUsedMb: number;
  heapLimitMb: number;
  rssMb: number;
  uptimeHours: number;
}

/**
 * A delay this long already shows: requests on this process wait, and at 1 s
 * the kubelet's health probe times out (three in a row restart the pod).
 */
export const STALL_MS = 500;

/**
 * The log line for one window, or null when there is nothing to say.
 *
 * A stall is always a warning. Otherwise a quiet baseline is logged every
 * `baselineEvery` windows, so heap and delay can be read against the process's
 * age: production stalls got worse the longer a pod ran, and without a
 * baseline there is no telling a slow leak from a load pattern.
 */
export function runtimeHealthLine(
  w: RuntimeWindow,
  window: number,
  baselineEvery: number,
): { level: "warn" | "log"; line: string } | null {
  const stalled = w.maxDelayMs >= STALL_MS;
  if (!stalled && window % baselineEvery !== 0) return null;
  const delay = stalled
    ? `event loop blocked for up to ${Math.round(w.maxDelayMs)} ms`
    : `event loop max ${Math.round(w.maxDelayMs)} ms`;
  const line =
    `[runtime] ${delay} (p99 ${Math.round(w.p99DelayMs)} ms) in the last minute; ` +
    `heap ${Math.round(w.heapUsedMb)} of ${Math.round(w.heapLimitMb)} MB, ` +
    `rss ${Math.round(w.rssMb)} MB, up ${w.uptimeHours.toFixed(1)} h`;
  return { level: stalled ? "warn" : "log", line };
}