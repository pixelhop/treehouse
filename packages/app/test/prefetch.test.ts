import { describe, expect, it } from "vite-plus/test";
import {
  MAX_IN_FLIGHT,
  MAX_PREFETCH_BYTES,
  prefetchTarget,
  shouldPrefetchBody,
} from "../app/utils/prefetch";

const entries = [
  { path: "notes.md", size: 100 },
  { path: "docs/plan.md", size: 200 },
];
const base = {
  client: true,
  routePath: "/w/ws1/notes.md",
  workspaceId: "ws1",
  path: "docs/plan.md",
  listing: { entries },
};

describe("prefetchTarget", () => {
  it("finds the listed entry in the open workspace", () => {
    expect(prefetchTarget(base)).toEqual({ workspaceId: "ws1", entry: entries[1] });
  });

  it("does nothing on the server, on a public share, or with no workspace open", () => {
    expect(prefetchTarget({ ...base, client: false })).toBeNull();
    expect(prefetchTarget({ ...base, routePath: "/s/token123" })).toBeNull();
    expect(prefetchTarget({ ...base, workspaceId: null })).toBeNull();
  });

  it("does nothing for an empty path, an unlisted path, or before the listing loads", () => {
    expect(prefetchTarget({ ...base, path: "" })).toBeNull();
    expect(prefetchTarget({ ...base, path: "docs" })).toBeNull();
    expect(prefetchTarget({ ...base, listing: undefined })).toBeNull();
  });
});

describe("shouldPrefetchBody", () => {
  const ok = { needsBody: true, size: 1000, state: undefined, inFlight: 0 };

  it("fetches a small text file nobody has loaded yet", () => {
    expect(shouldPrefetchBody(ok)).toBe(true);
    // A query that errored or was never started has no data and isn't fetching.
    expect(shouldPrefetchBody({ ...ok, state: { fetchStatus: "idle" } })).toBe(true);
    expect(shouldPrefetchBody({ ...ok, size: MAX_PREFETCH_BYTES })).toBe(true);
  });

  it("skips media, big files, and anything cached or already loading", () => {
    expect(shouldPrefetchBody({ ...ok, needsBody: false })).toBe(false);
    expect(shouldPrefetchBody({ ...ok, size: MAX_PREFETCH_BYTES + 1 })).toBe(false);
    expect(shouldPrefetchBody({ ...ok, state: { data: "body" } })).toBe(false);
    expect(shouldPrefetchBody({ ...ok, state: { fetchStatus: "fetching" } })).toBe(false);
  });

  it("waits while the in-flight cap is reached", () => {
    expect(shouldPrefetchBody({ ...ok, inFlight: MAX_IN_FLIGHT - 1 })).toBe(true);
    expect(shouldPrefetchBody({ ...ok, inFlight: MAX_IN_FLIGHT })).toBe(false);
  });
});