import { describe, expect, it } from "vite-plus/test";
import { legacyRepeatKey } from "../server/utils/schedulers";

describe("legacyRepeatKey", () => {
  // Observed in Redis after BullMQ 5.78 added each job the way the queues plugin
  // did before BullMQ 6, e.g.
  // { jobId: "example-jobs-heartbeat", repeat: { every: 60_000 } }.
  it.each([
    ["example-jobs", "example-jobs-heartbeat", 60_000, "8ad1c987d2b155516d405c2c6f2938eb"],
    ["billing-jobs", "billing-reconcile", 60 * 60_000, "3272289d461aff5268af0abcd8d45b3c"],
    ["billing-jobs", "share-view-prune", 24 * 60 * 60_000, "d18ac68cea67e9b75422d19bf51c93fc"],
  ])("matches the key BullMQ 5 created for %s/%s", (name, jobId, every, key) => {
    expect(legacyRepeatKey(name, jobId, every)).toBe(key);
  });

  it("differs for any other schedule, so those are never removed", () => {
    const heartbeat = legacyRepeatKey("example-jobs", "example-jobs-heartbeat", 60_000);
    expect(legacyRepeatKey("example-jobs", "example-jobs-nightly", 60_000)).not.toBe(heartbeat);
    expect(legacyRepeatKey("example-jobs", "example-jobs-heartbeat", 30_000)).not.toBe(heartbeat);
  });
});