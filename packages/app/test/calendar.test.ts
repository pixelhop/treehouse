import { describe, expect, it } from "vite-plus/test";
import {
  addMonths,
  buildMonthGrid,
  decideReschedule,
  groupByDate,
  isValidDate,
  monthLabel,
  toDateKey,
} from "../app/utils/calendar";

const utcDow = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

describe("toDateKey", () => {
  it("accepts a date-only string", () => {
    expect(toDateKey("2026-06-15")).toBe("2026-06-15");
  });

  it("extracts the date from a value with a time component", () => {
    expect(toDateKey("2026-06-15T10:00:00Z")).toBe("2026-06-15");
  });

  it("rejects impossible calendar dates", () => {
    expect(toDateKey("2026-02-30")).toBeNull();
    expect(toDateKey("2026-13-01")).toBeNull();
    expect(toDateKey("2026-00-10")).toBeNull();
  });

  it("rejects non-date and non-string values", () => {
    expect(toDateKey("not a date")).toBeNull();
    expect(toDateKey(20260615)).toBeNull();
    expect(toDateKey(undefined)).toBeNull();
  });

  it("accepts a leap day in a leap year but not a common year", () => {
    expect(toDateKey("2024-02-29")).toBe("2024-02-29");
    expect(toDateKey("2026-02-29")).toBeNull();
  });
});

describe("isValidDate", () => {
  it("mirrors toDateKey validity", () => {
    expect(isValidDate("2026-06-15")).toBe(true);
    expect(isValidDate("2026-02-30")).toBe(false);
  });
});

describe("buildMonthGrid", () => {
  it("returns whole Monday-first weeks covering the month", () => {
    const weeks = buildMonthGrid(2026, 6); // June 2026
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(utcDow(weeks[0]![0]!.date)).toBe(1); // first column is a Monday
    const inMonth = weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(30); // June has 30 days
    expect(inMonth[0]!.date).toBe("2026-06-01");
    expect(inMonth[inMonth.length - 1]!.date).toBe("2026-06-30");
  });

  it("has no leading padding when the month starts on a Monday", () => {
    // 2026-06-01 is a Monday.
    const weeks = buildMonthGrid(2026, 6);
    expect(weeks[0]![0]!.date).toBe("2026-06-01");
    expect(weeks[0]![0]!.inMonth).toBe(true);
  });

  it("handles February in leap and common years", () => {
    expect(
      buildMonthGrid(2024, 2)
        .flat()
        .filter((c) => c.inMonth),
    ).toHaveLength(29);
    expect(
      buildMonthGrid(2026, 2)
        .flat()
        .filter((c) => c.inMonth),
    ).toHaveLength(28);
  });

  it("flags today when it falls in the visible month", () => {
    const weeks = buildMonthGrid(2026, 6, "2026-06-15");
    const today = weeks.flat().filter((c) => c.isToday);
    expect(today).toHaveLength(1);
    expect(today[0]!.date).toBe("2026-06-15");
  });

  it("flags no cell when today is outside the visible grid", () => {
    // A date well beyond the month's trailing padding never matches a cell.
    const weeks = buildMonthGrid(2026, 6, "2026-09-15");
    expect(weeks.flat().some((c) => c.isToday)).toBe(false);
  });

  it("starts every week on Monday and places the 1st correctly across months", () => {
    for (const [y, m] of [
      [2026, 2],
      [2026, 3],
      [2026, 11],
    ] as const) {
      const flat = buildMonthGrid(y, m).flat();
      expect(utcDow(flat[0]!.date)).toBe(1); // first column is a Monday
      const first = flat.find((c) => c.inMonth)!;
      expect(first.date).toBe(`${y}-${String(m).padStart(2, "0")}-01`);
      expect(first.inMonth).toBe(true);
    }
  });

  it("places dates stably with no timezone off-by-one at boundaries", () => {
    const jan = buildMonthGrid(2026, 1)
      .flat()
      .filter((c) => c.inMonth);
    expect(jan[0]!.date).toBe("2026-01-01");
    expect(jan[jan.length - 1]!.date).toBe("2026-01-31");
  });
});

describe("groupByDate", () => {
  it("buckets items by date and keeps multiple per day in order", () => {
    const grouped = groupByDate([
      { path: "a.md", date: "2026-06-15" },
      { path: "b.md", date: "2026-06-15" },
      { path: "c.md", date: "2026-06-16" },
    ]);
    expect(grouped["2026-06-15"]!.map((i) => i.path)).toEqual(["a.md", "b.md"]);
    expect(grouped["2026-06-16"]!.map((i) => i.path)).toEqual(["c.md"]);
  });

  it("drops items with missing or invalid dates", () => {
    const grouped = groupByDate([
      { path: "a.md", date: "2026-06-15" },
      { path: "b.md", date: "nope" },
      { path: "c.md", date: undefined },
    ]);
    expect(Object.keys(grouped)).toEqual(["2026-06-15"]);
  });

  it("normalizes a timestamped date to its day key", () => {
    const grouped = groupByDate([{ path: "a.md", date: "2026-06-15T09:30:00Z" }]);
    expect(grouped["2026-06-15"]!).toHaveLength(1);
  });
});

describe("addMonths", () => {
  it("wraps forward across a year boundary", () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it("wraps backward across a year boundary", () => {
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("is a no-op for delta 0", () => {
    expect(addMonths(2026, 6, 0)).toEqual({ year: 2026, month: 6 });
  });

  it("shifts across multiple years in either direction", () => {
    expect(addMonths(2026, 6, 13)).toEqual({ year: 2027, month: 7 });
    expect(addMonths(2026, 6, -13)).toEqual({ year: 2025, month: 5 });
  });
});

describe("monthLabel", () => {
  it("renders a human month and year, including boundary months", () => {
    expect(monthLabel(2026, 6)).toBe("June 2026");
    expect(monthLabel(2026, 1)).toBe("January 2026");
    expect(monthLabel(2026, 12)).toBe("December 2026");
  });
});
describe("decideReschedule", () => {
  const base = {
    canReschedule: true,
    dragPath: "journal/2026-08-01-first.md",
    currentDate: "2026-08-01",
    toDate: "2026-08-12",
    inFlight: false,
  };

  it("allows a genuine move on a writable calendar", () => {
    expect(decideReschedule(base)).toEqual({ proceed: true, path: base.dragPath });
  });

  // The security boundary: the same CalendarView renders inside a public share,
  // where the rescheduler would otherwise write to the VISITOR'S OWN workspace.
  it("refuses every write on a read-only calendar", () => {
    expect(decideReschedule({ ...base, canReschedule: false })).toEqual({
      proceed: false,
      reason: "read-only",
    });
  });

  it("refuses read-only even when every other input is valid", () => {
    // No combination of drag/date/in-flight state can reach a write.
    for (const extra of [
      {},
      { inFlight: true },
      { currentDate: base.toDate },
      { dragPath: null },
      { currentDate: undefined },
    ]) {
      const d = decideReschedule({ ...base, ...extra, canReschedule: false });
      expect(d.proceed).toBe(false);
      // read-only is checked first, so it is always the reported reason.
      expect(d).toHaveProperty("reason", "read-only");
    }
  });

  it("ignores a drop with no drag in progress", () => {
    expect(decideReschedule({ ...base, dragPath: null })).toEqual({
      proceed: false,
      reason: "no-drag",
    });
  });

  it("ignores an entry that isn't in this calendar", () => {
    expect(decideReschedule({ ...base, currentDate: undefined })).toEqual({
      proceed: false,
      reason: "unknown-entry",
    });
  });

  it("skips a drop onto the day it already sits on", () => {
    expect(decideReschedule({ ...base, toDate: base.currentDate })).toEqual({
      proceed: false,
      reason: "same-day",
    });
  });

  it("ignores a second drop while the first is still settling", () => {
    // Two fast drags would otherwise both read the same base version, and the
    // later one would lose the version race into a server-side conflicted copy.
    expect(decideReschedule({ ...base, inFlight: true })).toEqual({
      proceed: false,
      reason: "in-flight",
    });
  });
});