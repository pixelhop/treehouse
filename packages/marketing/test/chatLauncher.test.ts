// @vitest-environment happy-dom
// oxlint-disable-next-line typescript/triple-slash-reference -- load the SFC test shim
/// <reference path="./vue.d.ts" />
// oxlint-disable-next-line typescript/triple-slash-reference -- the widget globals
/// <reference path="../app/types/chat-thing.d.ts" />
import { mount, type VueWrapper } from "@vue/test-utils";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SCRIPT_URL = "https://chatthing.ai/chat-widget.js";
const LAUNCHER = "#treehouse-chat-launcher";
const TEASER = "[data-chat-teaser]";
const TEASER_DISMISSED_KEY = "treehouse:chat-teaser-dismissed";
const TEASER_DELAY_MS = 6000;

let botId: string;
let routePath: string;
let state: Map<string, Ref<unknown>>;
let ChatLauncher: object;
let scripts: HTMLScriptElement[];
let wrapper: VueWrapper | undefined;

async function mountLauncher(): Promise<VueWrapper> {
  wrapper = mount(ChatLauncher, {
    attachTo: document.body,
    global: { stubs: { transition: false } },
  });
  await nextTick();
  return wrapper;
}

/** What the real SDK does to an adopted trigger when the window opens/closes. */
async function sdkSetsPressed(button: HTMLElement, pressed: boolean) {
  button.setAttribute("aria-pressed", String(pressed));
  // MutationObserver callbacks are microtasks; let them and the re-render run.
  await Promise.resolve();
  await nextTick();
}

beforeAll(async () => {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { chatThing: { botId, scriptUrl: SCRIPT_URL } },
  }));
  vi.stubGlobal("ref", ref);
  vi.stubGlobal("watch", watch);
  vi.stubGlobal("computed", computed);
  vi.stubGlobal("onMounted", onMounted);
  vi.stubGlobal("onBeforeUnmount", onBeforeUnmount);
  vi.stubGlobal("useRoute", () => ({ path: routePath }));
  vi.stubGlobal("useState", (key: string, init: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(init()));
    return state.get(key);
  });

  ChatLauncher = (await import("../app/components/ChatLauncher.client.vue")).default;
});

beforeEach(() => {
  botId = "bot-123";
  routePath = "/";
  state = new Map();
  localStorage.clear();
  scripts = [];
  delete window.chatThing;
  delete window.chatThingConfig;
  // Capture the SDK script instead of letting happy-dom fetch it.
  const append = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    if (node instanceof HTMLScriptElement) {
      scripts.push(node);
      return node;
    }
    return append(node);
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChatLauncher", () => {
  it("renders nothing without a bot id", async () => {
    botId = "";
    const w = await mountLauncher();

    expect(w.find(LAUNCHER).exists()).toBe(false);
    expect(scripts).toHaveLength(0);
  });

  it("loads nothing from Chat Thing until it is clicked", async () => {
    const w = await mountLauncher();

    expect(w.find(LAUNCHER).attributes("aria-label")).toBe("Ask Treehouse a question");
    expect(scripts).toHaveLength(0);
    expect(window.chatThingConfig).toBeUndefined();
  });

  it("loads the widget once, adopting this button as the trigger", async () => {
    const w = await mountLauncher();
    const button = w.find<HTMLButtonElement>(LAUNCHER);

    await button.trigger("click");
    await button.trigger("click");

    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toBe(SCRIPT_URL);
    expect(window.chatThingConfig).toMatchObject({
      botId: "bot-123",
      selectors: { widgetTrigger: "#treehouse-chat-launcher" },
    });
    expect(button.attributes("id")).toBe("treehouse-chat-launcher");
    expect(button.attributes("aria-busy")).toBe("true");
  });

  it("opens the chat when the script loads and follows the SDK's open state", async () => {
    const w = await mountLauncher();
    const button = w.find<HTMLButtonElement>(LAUNCHER);
    const show = vi.fn();

    await button.trigger("click");
    window.chatThing = { show };
    scripts[0]!.onload?.(new Event("load"));

    expect(show).toHaveBeenCalledOnce();

    await sdkSetsPressed(button.element, true);
    expect(button.attributes("aria-label")).toBe("Close chat");
    expect(button.attributes("aria-busy")).toBe("false");

    await sdkSetsPressed(button.element, false);
    expect(button.attributes("aria-label")).toBe("Ask Treehouse a question");
  });

  it("drops the spinner when a click cancels an open still in progress", async () => {
    const w = await mountLauncher();
    const button = w.find<HTMLButtonElement>(LAUNCHER);

    await button.trigger("click");
    window.chatThing = { show: vi.fn() };
    scripts[0]!.onload?.(new Event("load"));
    await button.trigger("click");

    expect(button.attributes("aria-busy")).toBe("false");
    expect(scripts).toHaveLength(1);
  });

  it("retries on the next click when the script fails to load", async () => {
    const w = await mountLauncher();
    const button = w.find<HTMLButtonElement>(LAUNCHER);

    await button.trigger("click");
    scripts[0]!.onerror?.(new Event("error"));
    await nextTick();

    expect(button.attributes("aria-busy")).toBe("false");

    await button.trigger("click");
    expect(scripts).toHaveLength(2);
  });
});

describe("ChatLauncher teaser", () => {
  async function mountAndWait(): Promise<VueWrapper> {
    vi.useFakeTimers();
    const w = await mountLauncher();
    expect(w.find(TEASER).exists()).toBe(false);
    vi.advanceTimersByTime(TEASER_DELAY_MS);
    await nextTick();
    return w;
  }

  it("appears after a delay, without loading anything", async () => {
    const w = await mountAndWait();

    expect(w.find(TEASER).text()).toContain("Questions about Treehouse?");
    expect(scripts).toHaveLength(0);
  });

  it("speaks to the docs on docs pages", async () => {
    routePath = "/docs/files";
    const w = await mountAndWait();

    expect(w.find(TEASER).text()).toContain("Can't find what you need?");
  });

  it("opens the chat when clicked, and does not come back", async () => {
    const w = await mountAndWait();

    await w.find(`${TEASER} button`).trigger("click");

    expect(scripts).toHaveLength(1);
    expect(w.find(TEASER).exists()).toBe(false);
    expect(localStorage.getItem(TEASER_DISMISSED_KEY)).toBe("1");
  });

  it("stays closed once dismissed, on this and later visits", async () => {
    const w = await mountAndWait();

    await w.find(`${TEASER} button[aria-label="Dismiss"]`).trigger("click");

    expect(w.find(TEASER).exists()).toBe(false);
    expect(scripts).toHaveLength(0);

    w.unmount();
    const again = await mountAndWait();
    expect(again.find(TEASER).exists()).toBe(false);
  });

  it("is retired by opening the chat from the launcher", async () => {
    vi.useFakeTimers();
    const w = await mountLauncher();

    await w.find(LAUNCHER).trigger("click");
    vi.advanceTimersByTime(TEASER_DELAY_MS);
    await nextTick();

    expect(w.find(TEASER).exists()).toBe(false);
    expect(localStorage.getItem(TEASER_DISMISSED_KEY)).toBe("1");
  });

  it("waits for the cookie banner to be answered", async () => {
    state.set("cookie-banner-visible", ref(true));
    const w = await mountAndWait();

    expect(w.find(TEASER).exists()).toBe(false);

    state.get("cookie-banner-visible")!.value = false;
    await nextTick();
    expect(w.find(TEASER).exists()).toBe(true);
  });
});