import { describe, expect, it } from "vite-plus/test";
import { mapPool } from "../app/utils/concurrency";
import { uniqueName, uploadPath } from "../app/utils/upload";

describe("mapPool", () => {
  it("preserves input order in the results", async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let active = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return null;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty list", async () => {
    expect(await mapPool([], 4, async (n) => n)).toEqual([]);
  });

  it("rejects and stops pulling new tasks once one throws", async () => {
    let started = 0;
    await expect(
      mapPool([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
        started += 1;
        if (n === 1) throw new Error("boom");
        await Promise.resolve();
        return n;
      }),
    ).rejects.toThrow("boom");
    // With 2 workers, only the in-flight pair start before the failure halts it —
    // far fewer than all 8.
    expect(started).toBeLessThan(8);
  });
});

describe("uploadPath", () => {
  it("joins into a folder or stays at the root", () => {
    expect(uploadPath("docs", "a.md")).toBe("docs/a.md");
    expect(uploadPath("", "a.md")).toBe("a.md");
  });
});

describe("uniqueName", () => {
  const taken = (set: string[]) => (p: string) => set.includes(p);

  it("returns the path unchanged when free", () => {
    expect(uniqueName("docs/a.md", taken([]))).toBe("docs/a.md");
  });

  it("appends (1) before the extension on a collision", () => {
    expect(uniqueName("docs/a.md", taken(["docs/a.md"]))).toBe("docs/a (1).md");
  });

  it("skips to the next free index", () => {
    expect(uniqueName("a.md", taken(["a.md", "a (1).md"]))).toBe("a (2).md");
  });

  it("handles extensionless names", () => {
    expect(uniqueName("README", taken(["README"]))).toBe("README (1)");
  });
});