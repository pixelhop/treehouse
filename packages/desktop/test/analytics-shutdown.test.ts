import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const posthog = vi.hoisted(() => ({
  shutdown: vi.fn(async () => {}),
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    shutdown = posthog.shutdown;
  },
}));

vi.mock("cli/src/paths", () => ({
  appDir: () => "/tmp/treehouse-test",
  ensureAppDir: vi.fn(),
}));

describe("shutdownAnalytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("TREEHOUSE_POSTHOG_KEY", "test-key");
    posthog.shutdown.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives PostHog a short deadline so app quit cannot wait for its 30s default", async () => {
    const { shutdownAnalytics } = await import("../src/analytics");

    await shutdownAnalytics();

    expect(posthog.shutdown).toHaveBeenCalledOnce();
    expect(posthog.shutdown).toHaveBeenCalledWith(1_000);
  });
});