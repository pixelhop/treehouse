import { createHash } from "node:crypto";

/**
 * The key BullMQ 5 stored a repeatable job under:
 * `md5("<name>:<jobId>:<endDate>:<tz>:<every>")`, with no end date or time zone
 * here. BullMQ 6 keeps scheduling such a key alongside the job scheduler that
 * replaces it, so it has to be removed explicitly. Deriving the exact key
 * leaves every other scheduler for the same job name alone.
 */
export function legacyRepeatKey(name: string, jobId: string, every: number): string {
  return createHash("md5").update(`${name}:${jobId}:::${every}`).digest("hex");
}