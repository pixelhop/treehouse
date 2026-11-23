// Write path for dragging a calendar entry to a new day: a front-matter `date`
// patch through the shared version-CAS write (see useFrontMatterWrite).
import type { FrontMatterWriteResult } from "~/composables/useFrontMatterWrite";

export type RescheduleResult = FrontMatterWriteResult;

export function useCalendarReschedule() {
  const { patch } = useFrontMatterWrite();

  function reschedule(path: string, date: string): Promise<RescheduleResult> {
    return patch(path, { date });
  }

  return { reschedule };
}