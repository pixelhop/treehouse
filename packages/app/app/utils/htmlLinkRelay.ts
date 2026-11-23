// In-place navigation for links inside a preview that is running its scripts.
//
// The inert preview is same-origin, so `HtmlViewer` reaches into the frame and
// turns an internal link click into an SPA navigation itself (`framedLinkPath`).
// The scripts sandbox gives that reach up on purpose — the document lands in an
// opaque origin — so internal links fell back to `target="_blank"`: a new tab in
// a browser, and in the desktop shell, which hands every new window to the
// system browser, a jump out of the app entirely.
//
// So the frame gets one script of OURS, ahead of the page's own, that relays
// link clicks to the parent. The hard part is that the page shares the frame's
// origin and can say anything the relay can say, so a message on its own
// proves nothing — not even "a click just happened": a click on the app around
// the frame (the "Allow" button, say) leaves the parent with user activation for
// a few seconds, which a freshly running page could ride.
//
// The relay therefore talks over a private channel instead of the public one:
//   1. Before any page script runs, it opens a `MessageChannel`, keeps one port
//      in its closure, and hands the other to the parent with a one-time nonce
//      the parent baked into this particular document.
//   2. The parent takes the FIRST handshake carrying that nonce, from that frame,
//      and no other. The relay's is first by construction; anything the page
//      posts later is a second claim and is dropped.
//   3. The parent acknowledges over the port. Until then the relay leaves clicks
//      alone — a relay whose handshake lost (the page reloaded itself, so its
//      nonce is already spent) must not cancel clicks nobody will act on. Any
//      message on the port IS the acknowledgement: only the parent holds the
//      other end, so the relay never has to read the message — and reading it
//      would run the page's getter if it had patched `MessageEvent.data`, with
//      the event, and through `currentTarget` the port itself, in hand.
//   4. The relay sends over its port only for a TRUSTED click (`isTrusted`, which
//      no script can forge) on a link to the app's origin.
// The page can't reach the port or the listener in the closure — strict mode
// keeps `Function.prototype.caller` from handing it the listener mid-click — so
// the only thing it can cause is what it could already cause with a real click
// and `window.open`: an in-app navigation, never off-origin, and never without
// the person clicking.
//
// When the relay doesn't act (the page claims the click first, the click carries
// a modifier, or the channel was never acknowledged), the anchor's
// `target="_blank"` still opens the link as before.

const HANDSHAKE = "treehouse:link-relay";

/** What the parent sends back over the port once it has accepted it. The relay
 * never reads it (see step 3 above); it is named for the parent's benefit. */
export const RELAY_ACK = "ack";

/**
 * The relay, as script source. `appOrigin` and `nonce` are serialized into it:
 * the frame's own origin is opaque, so it can't know which origin is "ours".
 *
 * The rule it follows: after the page's code has run, never hand page-patchable
 * code anything that leads to the port or the listener. Every method it calls is
 * captured — and bound, so a later patch to `Function.prototype.call` doesn't
 * reach it either — before the page runs, and strict mode stops `.caller` from
 * reaching the listener. What it does still read through prototype getters on a
 * click (the event's button and target, the URL's origin) leads nowhere: the
 * page sees the same click event itself, and a page that patched them could at
 * most choose which in-app URL a real click opens.
 *
 * A window-level bubbling listener, so the page's own handlers (on elements or
 * the document) run first and can claim a click by cancelling it — a deck that
 * routes its own links keeps working.
 */
function relayScript(appOrigin: string, nonce: string): string {
  // `<` escaped so no embedded string could ever close the script element early.
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  return `(() => {
  "use strict";
  const ORIGIN = ${json(appOrigin)};
  const uncurry = Function.prototype.call.bind(Function.prototype.bind, Function.prototype.call);
  const closest = uncurry(Element.prototype.closest);
  const getAttribute = uncurry(Element.prototype.getAttribute);
  const preventDefault = uncurry(Event.prototype.preventDefault);
  const Url = URL;
  const { port1, port2 } = new MessageChannel();
  const send = port1.postMessage.bind(port1);
  let accepted = false;
  port1.onmessage = () => { accepted = true; };
  parent.postMessage({ type: ${json(HANDSHAKE)}, nonce: ${json(nonce)} }, ORIGIN, [port2]);
  addEventListener("click", (e) => {
    if (!accepted || !e.isTrusted || e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    let url;
    try {
      const anchor = closest(e.target, "a[href]");
      if (!anchor) return;
      url = new Url(getAttribute(anchor, "href"));
    } catch { return; }
    if (url.origin !== ORIGIN) return;
    preventDefault(e);
    send({ href: url.href });
  });
})();`;
}

/**
 * Add the relay to a document headed for the scripts sandbox. First in <head>,
 * so it runs — and posts its handshake — before anything the page itself runs.
 * `nonce` must be fresh for every document handed to the frame. `doc` defaults
 * to the browser document; tests pass a happy-dom one. With no DOM at all the
 * HTML is returned unchanged (links then open in a new tab, as before).
 */
export function injectLinkRelay(
  html: string,
  appOrigin: string,
  nonce: string,
  doc?: Document,
): string {
  const d = doc ?? (typeof document === "undefined" ? undefined : document);
  if (!d) return html;

  const parsed = d.implementation.createHTMLDocument("");
  parsed.documentElement.innerHTML = html;
  const script = parsed.createElement("script");
  script.textContent = relayScript(appOrigin, nonce);
  parsed.head.insertBefore(script, parsed.head.firstChild);
  return parsed.documentElement.outerHTML;
}

/**
 * The relay's port, if `data` + `ports` are its handshake for `nonce`. Only
 * reads the payload: that the message came from the right frame, and that it is
 * the first claim on this nonce, are the caller's to check.
 */
export function relayHandshakePort(
  data: unknown,
  ports: readonly MessagePort[],
  nonce: string,
): MessagePort | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, nonce: claimed } = data as { type?: unknown; nonce?: unknown };
  if (type !== HANDSHAKE || claimed !== nonce || ports.length !== 1) return null;
  return ports[0] ?? null;
}

/**
 * The in-app path a relayed link asks for, or null to ignore it. Only an
 * absolute URL on `origin` passes — the same set `framedLinkPath` accepts for
 * the inert preview.
 */
export function relayedLinkPath(data: unknown, origin: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const { href } = data as { href?: unknown };
  if (typeof href !== "string") return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}