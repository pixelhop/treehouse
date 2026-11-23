import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const posthogMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureException: vi.fn(),
  group: vi.fn(),
  identify: vi.fn(),
  init: vi.fn(),
  reset: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: posthogMocks,
}));

type Route = { path: string };
type RouteHook = (to: Route) => void;
type RouterHarness = {
  currentRoute: { value: Route };
  beforeHooks: RouteHook[];
  afterHooks: RouteHook[];
  beforeEach: (hook: RouteHook) => void;
  afterEach: (hook: RouteHook) => void;
};

type Plugin = (app: { hook: ReturnType<typeof vi.fn> }) => unknown;

let plugin: Plugin;
let activeRouter: RouterHarness;

function routerAt(path: string): RouterHarness {
  const beforeHooks: RouteHook[] = [];
  const afterHooks: RouteHook[] = [];
  return {
    currentRoute: { value: { path } },
    beforeHooks,
    afterHooks,
    beforeEach: (hook) => beforeHooks.push(hook),
    afterEach: (hook) => afterHooks.push(hook),
  };
}

function initialiseAt(path: string) {
  activeRouter = routerAt(path);
  plugin({ hook: vi.fn() });
  return activeRouter;
}

beforeAll(async () => {
  vi.stubGlobal("defineNuxtPlugin", (candidate: Plugin) => candidate);
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { posthog: { key: "phc_test", host: "/ph" } },
  }));
  vi.stubGlobal("useRouter", () => activeRouter);
  vi.stubGlobal("useAuthClient", () => ({ useSession: () => ({ value: { data: null } }) }));
  vi.stubGlobal("watch", vi.fn());

  const module = await import("../app/plugins/posthog.client");
  plugin = module.default as unknown as Plugin;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PostHog replay privacy configuration", () => {
  it("locally disables network request body and header recording", () => {
    initialiseAt("/w/workspace");

    const options = posthogMocks.init.mock.calls[0]?.[1] as
      | { session_recording?: { recordBody?: boolean; recordHeaders?: boolean } }
      | undefined;
    expect(options?.session_recording?.recordBody).toBe(false);
    expect(options?.session_recording?.recordHeaders).toBe(false);
  });
});

describe("PostHog never receives a byte-Worker grant", () => {
  // A grant URL (`/b/<keyId>.<sealed>`) opens one file's bytes for hours. It
  // reaches the browser as the target of an <img>/<video> redirect, and can be
  // pasted into a document as an image src.
  const GRANT = `t1.${"Ab9_-".repeat(140)}`;
  const GRANT_URL = `https://blobs.trytree.house/b/${GRANT}`;
  type Options = {
    before_send: (event: { properties: Record<string, unknown> }) => unknown;
    session_recording: {
      maskCapturedNetworkRequestFn: (request: { name: string }) => { name: string };
      maskAttributeFn: (name: string, value: string) => string;
    };
  };
  const options = () => {
    initialiseAt("/w/workspace");
    return posthogMocks.init.mock.calls[0]?.[1] as Options;
  };

  it("redacts it from replay network requests", () => {
    const masked = options().session_recording.maskCapturedNetworkRequestFn({ name: GRANT_URL });
    expect(masked.name).not.toContain(GRANT.slice(3, 40));
    expect(masked.name).toBe("https://blobs.trytree.house/b/<redacted>");
  });

  it("redacts it from replayed src and href attributes", () => {
    const { maskAttributeFn } = options().session_recording;
    for (const attr of ["src", "href"]) {
      expect(maskAttributeFn(attr, GRANT_URL)).not.toContain(GRANT.slice(3, 40));
    }
  });

  it("redacts it from URL-bearing event properties", () => {
    const event = {
      properties: { $current_url: GRANT_URL, $referrer: GRANT_URL, $session_entry_url: GRANT_URL },
    };
    options().before_send(event);
    expect(JSON.stringify(event)).not.toContain(GRANT.slice(3, 40));
  });
});

describe("PostHog replay route lifecycle", () => {
  it("stops recording immediately when initialised on a public share route", () => {
    initialiseAt("/s/public-token");

    expect(posthogMocks.stopSessionRecording).toHaveBeenCalledOnce();
    expect(posthogMocks.startSessionRecording).not.toHaveBeenCalled();
  });

  it("stops in beforeEach when navigating from a workspace to a share route", () => {
    const router = initialiseAt("/w/workspace");
    posthogMocks.startSessionRecording.mockClear();
    posthogMocks.stopSessionRecording.mockClear();

    for (const hook of router.beforeHooks) hook({ path: "/s/public-token" });

    expect(posthogMocks.stopSessionRecording).toHaveBeenCalledOnce();
    expect(posthogMocks.startSessionRecording).not.toHaveBeenCalled();

    for (const hook of router.afterHooks) hook({ path: "/s/public-token" });
    expect(posthogMocks.startSessionRecording).not.toHaveBeenCalled();
  });

  it("starts only in afterEach when returning from a share route to a workspace", () => {
    const router = initialiseAt("/s/public-token");
    posthogMocks.startSessionRecording.mockClear();
    posthogMocks.stopSessionRecording.mockClear();

    for (const hook of router.beforeHooks) hook({ path: "/w/workspace" });
    expect(posthogMocks.startSessionRecording).not.toHaveBeenCalled();

    for (const hook of router.afterHooks) hook({ path: "/w/workspace" });
    expect(posthogMocks.startSessionRecording).toHaveBeenCalledOnce();
  });
});