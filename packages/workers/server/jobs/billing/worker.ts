import type { Job } from "bullmq";
import { usePrismaClient } from "db";
import { useJobLogger } from "../../utils/jobs";

// Scheduled billing maintenance. Two tasks share one worker because they run on
// the same cadence and both exist to keep durable state honest.
//
// Note the asymmetry in how they are performed. `prune` only needs the database,
// which this package already depends on, so it runs here. `reconcile` needs the
// Stripe client, which lives in packages/api — and this package deliberately
// depends only on `db`. Reaching across that boundary would break the workers
// build, so the API is asked to do it over the private network instead.

export interface BillingJobData {
  task: "reconcile" | "prune";
}

/** Retention for the share-view dedup ledger, in days. */
const VIEW_DEDUP_RETENTION_DAYS = 3;

export default async function billingJobWorker(job: Job<BillingJobData>) {
  const logger = useJobLogger(job);

  if (job.data.task === "prune") {
    // `ShareViewDay` grows with public traffic and answers only "has this
    // visitor been counted today?". The durable counts live on `share` and
    // `share_usage` and are untouched by this.
    const cutoff = new Date(Date.now() - VIEW_DEDUP_RETENTION_DAYS * 86_400_000);
    const { count } = await usePrismaClient().shareViewDay.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    await logger.log(
      `Pruned ${count} share view dedup rows older than ${VIEW_DEDUP_RETENTION_DAYS}d`,
    );
    return { removed: count };
  }

  const base = process.env.INTERNAL_API_URL;
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (!base || !secret) {
    // Not an error: a deployment without billing configured has nothing to
    // reconcile, and the repeatable job should not fail forever because of it.
    await logger.log("Reconcile skipped — INTERNAL_API_URL / INTERNAL_JOB_SECRET not set");
    return { skipped: true };
  }

  const res = await fetch(`${base}/api/internal/billing/reconcile`, {
    method: "POST",
    headers: { "x-internal-job-secret": secret },
  });
  if (!res.ok) {
    // Thrown so BullMQ records the failure and retries on its own backoff —
    // swallowing it would make a broken reconciliation look healthy.
    throw new Error(`Reconcile failed: ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as {
    checked: number;
    corrected: number;
    orphaned: number;
    errors: number;
  };
  await logger.log(
    `Reconciled ${result.checked} subscriptions: ${result.corrected} corrected, ` +
      `${result.orphaned} orphaned, ${result.errors} errors`,
  );
  return result;
}