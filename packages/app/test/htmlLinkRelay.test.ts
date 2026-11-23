import { Window } from "happy-dom";
import { describe, expect, it } from "vite-plus/test";
import {
  injectLinkRelay,
  RELAY_ACK,
  relayedLinkPath,
  relayHandshakePort,
} from "../app/utils/htmlLinkRelay";

const ORIGIN = "https://app.test";
const NONCE = "nonce-1";
const doc = new Window().document as unknown as Document;

/** The relay's source, as injected into a document. */
function relaySource(): string {
  const html = injectLinkRelay("<html><head></head><body></body></html>", ORIGIN, NONCE, doc);
  return html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
}

/**
 * Run the relay in a fresh happy-dom window standing in for the frame, with
 * `parent.postMessage` and the private port both recorded. The parent's
 * acknowledgement is delivered unless `ack: false`; `pageScript` runs after the
 * relay, as the page's own code would.
 */
function frameWithRelay(
  href: string,
  opts: { pageCancels?: boolean; ack?: false; pageScript?: string } = {},
) {
  const win = new Window({ url: "https://frame.test/" });
  const handshakes: unknown[][] = [];
  const sent: unknown[] = [];
  let relayPort: { onmessage: ((m: { data: unknown }) => void) | null } | null = null;
  Object.defineProperty(win, "parent", {
    value: { postMessage: (...a: unknown[]) => handshakes.push(a) },
  });
  // Record what the relay sends over its port, without a real channel.
  Object.defineProperty(win, "MessageChannel", {
    value: class {
      port1 = { onmessage: null, postMessage: (m: unknown) => sent.push(m) };
      port2 = { port: 2 };
      constructor() {
        relayPort = this.port1;
      }
    },
  });
  win.document.body.innerHTML = `<a href="${href}"><span id="t">go</span></a>`;
  if (opts.pageCancels) win.document.addEventListener("click", (e) => e.preventDefault());
  win.eval(relaySource());
  // The acknowledgement records whether the relay read it: reading would run a
  // page-patched `MessageEvent.data` getter with the event, and so the port.
  let ackRead = false;
  if (opts.ack !== false) {
    relayPort!.onmessage?.({
      get data() {
        ackRead = true;
        return RELAY_ACK;
      },
    });
  }
  if (opts.pageScript) win.eval(opts.pageScript);

  const target = win.document.getElementById("t")!;
  /** A click as the browser would dispatch it (trusted) unless `synthetic`. */
  function click(over: { button?: number; metaKey?: boolean; synthetic?: boolean } = {}) {
    const e = new win.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: over.button ?? 0,
      metaKey: over.metaKey ?? false,
    });
    if (!over.synthetic) Object.defineProperty(e, "isTrusted", { value: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  }
  return { win, handshakes, sent, click, ackRead: () => ackRead };
}

describe("injectLinkRelay", () => {
  it("puts the relay first in <head>, ahead of the page's own scripts", () => {
    const html = injectLinkRelay(
      "<html><head><script>page()</script></head><body></body></html>",
      ORIGIN,
      NONCE,
      doc,
    );
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain(JSON.stringify(NONCE));
    expect(scripts[1]).toBe("page()");
  });

  it("can't be closed early by a string it embeds", () => {
    const html = injectLinkRelay(
      "<html><head></head><body></body></html>",
      "x</script><b>",
      "n",
      doc,
    );
    expect(html).not.toContain("</script><b>");
  });

  it("returns the HTML unchanged with no DOM", () => {
    expect(injectLinkRelay("<p>x</p>", ORIGIN, NONCE)).toBe("<p>x</p>");
  });
});

describe("the relay in the frame", () => {
  it("hands the parent its port, with the nonce, as soon as it runs", () => {
    const { handshakes } = frameWithRelay(`${ORIGIN}/w/ws1/a.md`);
    expect(handshakes).toEqual([
      [{ type: "treehouse:link-relay", nonce: NONCE }, ORIGIN, [{ port: 2 }]],
    ]);
  });

  it("sends a trusted plain click on an app link over the port, and cancels it", () => {
    const frame = frameWithRelay(`${ORIGIN}/w/ws1/Clients/README.md#top`);
    expect(frame.click()).toBe(true);
    expect(frame.sent).toEqual([{ href: `${ORIGIN}/w/ws1/Clients/README.md#top` }]);
  });

  it("leaves clicks alone until the parent has accepted the channel", () => {
    // A relay whose handshake lost (the page reloaded, spending its nonce) must
    // not cancel a click that nobody will act on.
    const frame = frameWithRelay(`${ORIGIN}/w/ws1/a.md`, { ack: false });
    expect(frame.click()).toBe(false);
    expect(frame.sent).toEqual([]);
  });

  it("takes the acknowledgement without reading it", () => {
    const frame = frameWithRelay(`${ORIGIN}/w/ws1/a.md`);
    expect(frame.ackRead()).toBe(false);
    expect(frame.click()).toBe(true);
  });

  it("never hands control to methods the page patched after it", () => {
    // A patched method called mid-click could reach the listener through
    // `.caller` and replay it later; the relay calls only what it bound first.
    const frame = frameWithRelay(`${ORIGIN}/w/ws1/a.md`, {
      pageScript: `
        window.called = [];
        Event.prototype.preventDefault = function () { called.push("preventDefault"); };
        Element.prototype.closest = function () { called.push("closest"); return null; };
      `,
    });
    expect(frame.click()).toBe(true);
    expect(frame.sent).toEqual([{ href: `${ORIGIN}/w/ws1/a.md` }]);
    expect((frame.win as unknown as { called: string[] }).called).toEqual([]);
  });

  it("ignores a click the page dispatched itself", () => {
    const frame = frameWithRelay(`${ORIGIN}/w/ws1/a.md`);
    expect(frame.click({ synthetic: true })).toBe(false);
    expect(frame.sent).toEqual([]);
  });

  it("leaves external links, modified clicks and middle-clicks alone", () => {
    const external = frameWithRelay("https://example.com/");
    expect(external.click()).toBe(false);
    expect(external.sent).toEqual([]);

    const app = frameWithRelay(`${ORIGIN}/w/ws1/a.md`);
    app.click({ metaKey: true });
    app.click({ button: 1 });
    expect(app.sent).toEqual([]);
  });

  it("defers to the page when it has already claimed the click", () => {
    const frame = frameWithRelay(`${ORIGIN}/w/ws1/a.md`, { pageCancels: true });
    frame.click();
    expect(frame.sent).toEqual([]);
  });

  it("ignores relative hrefs, as the inert preview does", () => {
    const frame = frameWithRelay("#section");
    frame.click();
    expect(frame.sent).toEqual([]);
  });
});

describe("relayHandshakePort", () => {
  const port = {} as MessagePort;
  const data = { type: "treehouse:link-relay", nonce: NONCE };

  it("returns the port for this document's nonce", () => {
    expect(relayHandshakePort(data, [port], NONCE)).toBe(port);
  });

  it("refuses a wrong nonce, a missing port, or another message", () => {
    expect(relayHandshakePort({ ...data, nonce: "stale" }, [port], NONCE)).toBe(null);
    expect(relayHandshakePort(data, [], NONCE)).toBe(null);
    expect(relayHandshakePort(data, [port, port], NONCE)).toBe(null);
    expect(relayHandshakePort({ type: "other", nonce: NONCE }, [port], NONCE)).toBe(null);
    expect(relayHandshakePort(null, [port], NONCE)).toBe(null);
  });
});

describe("relayedLinkPath", () => {
  it("returns the in-app path for a same-origin link", () => {
    expect(relayedLinkPath({ href: `${ORIGIN}/w/ws1/a.md?v=2#h` }, ORIGIN)).toBe(
      "/w/ws1/a.md?v=2#h",
    );
  });

  it("refuses anything off-origin or malformed", () => {
    expect(relayedLinkPath({ href: "https://evil.test/w" }, ORIGIN)).toBe(null);
    expect(relayedLinkPath({ href: "/w/ws1/a.md" }, ORIGIN)).toBe(null);
    expect(relayedLinkPath({ href: 42 }, ORIGIN)).toBe(null);
    expect(relayedLinkPath("navigate", ORIGIN)).toBe(null);
    expect(relayedLinkPath(null, ORIGIN)).toBe(null);
  });
});