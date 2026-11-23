// Pure date and month-grid math for the folder calendar view. No date library:
// everything works on `YYYY-MM-DD` strings and UTC-anchored arithmetic, so day
// placement is identical regardless of the host timezone (the front-matter
// `date` value parses as a plain string under the YAML 1.2 core schema — see
// frontmatterData.ts — and never as a local-time Date). The grid is Monday-first.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Weekday column headers, Monday-first to match `buildMonthGrid`. */
export const WEEKDAYS_MON_FIRST = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const DAY_MS = 86_400_000;

export interface DayCell {
  /** `YYYY-MM-DD` key for this cell. */
  date: string;
  /** Day-of-month number (1-31). */
  day: number;
  /** True when the cell belongs to the grid's target month (not padding). */
  inMonth: boolean;
  /** True when the cell matches the `today` argument passed to `buildMonthGrid`. */
  isToday: boolean;
}

export type CalendarWeek = DayCell[]; // always length 7

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Normalize an arbitrary front-matter value to a `YYYY-MM-DD` key, or `null`
 * when it is not a real calendar date. Accepts a leading date with an optional
 * time component (`2026-06-15T10:00:00Z` → `2026-06-15`) and rejects impossible
 * dates (`2026-02-30`). UTC round-trip is the validity check.
 */
export function toDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return iso(year, month, day);
}

/** True when `value` is a real calendar date (see `toDateKey`). */
export function isValidDate(value: unknown): boolean {
  return toDateKey(value) !== null;
}

/**
 * Build the Monday-first weeks for `month` (1-12) of `year`. Includes the
 * leading/trailing padding days needed to fill whole weeks, flagged
 * `inMonth: false`. The number of weeks is the minimum to cover the month (4-6).
 * Pass `today` (a `YYYY-MM-DD` key) to flag the current day.
 */
export function buildMonthGrid(year: number, month: number, today?: string | null): CalendarWeek[] {
  const firstMs = Date.UTC(year, month - 1, 1);
  const firstDow = new Date(firstMs).getUTCDay(); // 0 Sun .. 6 Sat
  const offset = (firstDow + 6) % 7; // days before the 1st to reach Monday
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const startMs = firstMs - offset * DAY_MS;

  const out: CalendarWeek[] = [];
  for (let w = 0; w < weeks; w++) {
    const week: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(startMs + (w * 7 + d) * DAY_MS);
      const y = dt.getUTCFullYear();
      const mo = dt.getUTCMonth() + 1;
      const day = dt.getUTCDate();
      const key = iso(y, mo, day);
      week.push({
        date: key,
        day,
        inMonth: mo === month && y === year,
        isToday: today != null && key === today,
      });
    }
    out.push(week);
  }
  return out;
}

/**
 * Bucket dated items onto `YYYY-MM-DD` keys. Items whose `date` is missing or
 * not a real calendar date are dropped; multiple items on one day are kept in
 * input order.
 */
export function groupByDate<T extends { date?: unknown }>(items: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = Object.create(null);
  for (const item of items) {
    const key = toDateKey(item.date);
    if (key === null) continue;
    (out[key] ??= []).push(item);
  }
  return out;
}

/** Shift `(year, month)` by `delta` whole months, wrapping the year. */
export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  const monthIdx = ((zeroBased % 12) + 12) % 12;
  return { year: Math.floor(zeroBased / 12), month: monthIdx + 1 };
}

/** Human label for a month, e.g. `June 2026`. */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}
/**
 * Whether a calendar drop should result in a write, and why not when it
 * shouldn't.
 *
 * This is the guard for a real security boundary, not just a UX nicety. The
 * rescheduler writes through the signed-in workspace, but the same CalendarView
 * also renders inside a PUBLIC SHARE — where there is no route workspace id, so
 * `useWorkspaceData()` falls back to the visitor's own last-opened workspace. A
 * drop on a stranger's shared calendar would therefore have read and written a
 * same-path file in the visitor's OWN workspace.
 *
 * `canReschedule` is checked first and unconditionally, so no combination of the
 * other inputs can reach a write on a read-only calendar.
 */
export type RescheduleBlock = "read-only" | "no-drag" | "unknown-entry" | "same-day" | "in-flight";

export function decideReschedule(input: {
  /** False on a read-only calendar (a public share) — no write is ever allowed. */
  canReschedule: boolean;
  /** Path of the entry being dragged, or null if no drag is in progress. */
  dragPath: string | null;
  /** The entry's current date, or undefined if it isn't in this calendar. */
  currentDate: string | undefined;
  /** The day it was dropped on. */
  toDate: string;
  /** True while an earlier reschedule for this same entry is still settling. */
  inFlight: boolean;
}): { proceed: true; path: string } | { proceed: false; reason: RescheduleBlock } {
  if (!input.canReschedule) return { proceed: false, reason: "read-only" };
  if (!input.dragPath) return { proceed: false, reason: "no-drag" };
  if (input.currentDate === undefined) return { proceed: false, reason: "unknown-entry" };
  if (input.currentDate === input.toDate) return { proceed: false, reason: "same-day" };
  // A second drop is ignored until the first settles, so two fast drags can't
  // both read the same base version and make the later one lose the version
  // race (which the server would resolve into a conflicted copy).
  if (input.inFlight) return { proceed: false, reason: "in-flight" };
  return { proceed: true, path: input.dragPath };
}