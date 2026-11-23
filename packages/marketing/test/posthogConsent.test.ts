// @vitest-environment happy-dom
// oxlint-disable-next-line typescript/triple-slash-reference -- load the SFC test shim
/// <reference path="./vue.d.ts" />
import { mount, type VueWrapper } from "@vue/test-utils";
import { onMounted, ref } from "vue";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const posthogMocks = vi.hoisted(() => ({
  __loaded: false,
  init: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: posthogMocks,
}));

type RuntimePostHog = { key: string; host: string };
type Plugin = () => unknown;

let runtimePostHog: RuntimePostHog;
let plugin: Plugin;
let CookieBanner: object;

function setRuntimeConfig(posthog: Partial<RuntimePostHog> = {}) {
  runtimePostHog = { key: "phc_test", host: "/ph", ...posthog };
}

async function mountBanner(): Promise<VueWrapper> {
  const wrapper = mount(CookieBanner, {
    global: {
      stubs: { transition: false },
    },
  });
  await wrapper.vm.$nextTick();
  return wrapper;
}

beforeAll(async () => {
  vi.stubGlobal("defineNuxtPlugin", (candidate: Plugin) => candidate);
  vi.stubGlobal("useRuntimeConfig", () => ({ public: { posthog: runtimePostHog } }));
  vi.stubGlobal("ref", ref);
  vi.stubGlobal("onMounted", onMounted);
  vi.stubGlobal("useState", (_key: string, init: () => unknown) => ref(init()));

  const pluginModule = await import("../app/plugins/posthog.client");
  plugin = pluginModule.default as unknown as Plugin;
  CookieBanner = (await import("../app/components/CookieBanner.vue")).default;
});

beforeEach(() => {
  vi.clearAllMocks();
  posthogMocks.__loaded = false;
  localStorage.clear();
  setRuntimeConfig();
});

describe("marketing PostHog plugin consent gate", () => {
  it("does not initialise the SDK without a configured key", () => {
    setRuntimeConfig({ key: "" });
    localStorage.setItem("treehouse:analytics-consent", "accepted");

    plugin();

    expect(posthogMocks.init).not.toHaveBeenCalled();
  });

  it.each([null, "rejected"])("does not initialise for %s consent", (consent) => {
    if (consent) localStorage.setItem("treehouse:analytics-consent", consent);

    plugin();

    expect(posthogMocks.init).not.toHaveBeenCalled();
  });

  it("initialises once when stored consent is accepted", () => {
    localStorage.setItem("treehouse:analytics-consent", "accepted");

    plugin();

    expect(posthogMocks.init).toHaveBeenCalledOnce();
    expect(posthogMocks.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "/ph" }),
    );
  });

  it("does not initialise again when PostHog is already loaded", () => {
    localStorage.setItem("treehouse:analytics-consent", "accepted");
    posthogMocks.__loaded = true;

    plugin();

    expect(posthogMocks.init).not.toHaveBeenCalled();
  });
});

describe("CookieBanner", () => {
  it("is absent when there is no configured key", async () => {
    setRuntimeConfig({ key: "" });

    const wrapper = await mountBanner();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(posthogMocks.init).not.toHaveBeenCalled();
  });

  it("stays hidden for rejected consent without initialising", async () => {
    localStorage.setItem("treehouse:analytics-consent", "rejected");

    const wrapper = await mountBanner();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(posthogMocks.init).not.toHaveBeenCalled();
  });

  it("stores acceptance and initialises exactly once", async () => {
    const wrapper = await mountBanner();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await wrapper.get("button:last-of-type").trigger("click");

    expect(localStorage.getItem("treehouse:analytics-consent")).toBe("accepted");
    expect(posthogMocks.init).toHaveBeenCalledOnce();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("stores rejection without initialising", async () => {
    const wrapper = await mountBanner();

    await wrapper.get("button:first-of-type").trigger("click");

    expect(localStorage.getItem("treehouse:analytics-consent")).toBe("rejected");
    expect(posthogMocks.init).not.toHaveBeenCalled();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("does not initialise after acceptance when PostHog is already loaded", async () => {
    posthogMocks.__loaded = true;
    const wrapper = await mountBanner();

    await wrapper.get("button:last-of-type").trigger("click");

    expect(localStorage.getItem("treehouse:analytics-consent")).toBe("accepted");
    expect(posthogMocks.init).not.toHaveBeenCalled();
  });
});