import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { H3Adapter } from "@bull-board/h3";
import { Queue } from "bullmq";
import type { JobSchedulerTemplateOptions } from "bullmq";
import { useQueue, useWorker } from "../utils/queues";
import { legacyRepeatKey } from "../utils/schedulers";
import billingJobWorker from "../jobs/billing/worker";

const HOUR = 60 * 60_000;

/**
 * Keeps exactly one repeating job with scheduler id `id` on `queue`, every
 * `every` ms. Jobs are named after their queue, as they always have been.
 *
 * BullMQ 6 schedules repeating jobs with job schedulers; upserting by `id`
 * keeps a single schedule across restarts. A worker that ran BullMQ 5 left the
 * same job under a hashed repeat key, which BullMQ 6 would keep running
 * alongside the scheduler, so that key is removed first. Removing it is a
 * no-op once it's gone.
 */
async function schedule(
  queue: Queue | undefined,
  id: string,
  every: number,
  data: Record<string, unknown>,
  opts: JobSchedulerTemplateOptions,
): Promise<void> {
  if (!queue) return;
  await queue.removeJobScheduler(legacyRepeatKey(queue.name, id, every));
  await queue.upsertJobScheduler(id, { every }, { name: queue.name, data, opts });
}

export default defineNitroPlugin(async (nitroApp) => {
  const serverAdapter = new H3Adapter();
  serverAdapter.setBasePath("/admin/queues");
  serverAdapter.setStaticPath("/admin/queues", "./admin/queues");

  // The starter template's demo queue ran a job every minute. Its scheduler lives
  // in Redis, so it would keep enqueueing jobs nothing consumes: remove it, along
  // with whatever it left behind. A no-op once it's gone; delete after one deploy.
  // Best effort: a failed clean-up must not stop the real queues starting.
  try {
    const retiredQueue = await useQueue("example-jobs");
    await retiredQueue.removeJobScheduler("example-jobs-heartbeat");
    await retiredQueue.removeJobScheduler(
      legacyRepeatKey("example-jobs", "example-jobs-heartbeat", 60_000),
    );
    await retiredQueue.obliterate({ force: true });
    await retiredQueue.close();
  } catch (error) {
    console.error("Could not remove the retired example-jobs queue:", error);
  }

  // Billing maintenance. Registered unconditionally — reconcileSubscriptions is
  // a no-op without a Stripe client, and the prune job is useful either way.
  const billingQueue = await useQueue("billing-jobs");
  await useWorker("billing-jobs", billingJobWorker);
  // Hourly: frequent enough that a missed webhook is corrected the same day,
  // rare enough to stay far inside Stripe's rate limits.
  await schedule(
    billingQueue,
    "billing-reconcile",
    HOUR,
    { task: "reconcile" },
    { removeOnComplete: 50, removeOnFail: 50 },
  );
  await schedule(
    billingQueue,
    "share-view-prune",
    24 * HOUR,
    { task: "prune" },
    { removeOnComplete: 20, removeOnFail: 20 },
  );

  // create the bull board monitor UI
  const bullQueues: Queue[] = [];
  if (billingQueue) {
    bullQueues.push(billingQueue);
  }

  createBullBoard({
    queues: bullQueues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });

  nitroApp.router.use("/admin/queues/**", serverAdapter.registerHandlers().handler);
  nitroApp.router.use("/admin/queues", serverAdapter.registerHandlers().handler);
});