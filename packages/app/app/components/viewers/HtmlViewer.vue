<script setup lang="ts">
import DOMPurify from "dompurify";
import {
  injectLinkRelay,
  RELAY_ACK,
  relayedLinkPath,
  relayHandshakePort,
} from "~/utils/htmlLinkRelay";
import { framedLinkPath, type HtmlRefContext, rewriteHtmlRefs } from "~/utils/htmlRefs";
import { HTML_REFERRER_POLICY, HTML_SANDBOX, HTML_SCRIPTS_SANDBOX } from "~/utils/htmlSandbox";

// `refs` resolves relative references (images to raw bytes, links to the page
// showing that file). Optional so the component still works standalone; without
// it references are left as authored — but the rewrite still runs, because
// pinning the frame's base URL is what keeps an unresolved link inert instead of
// blank-loading the app into the frame. See utils/htmlRefs.ts.
const props = defineProps<{
  source: string;
  mode: "rendered" | "source";
  refs?: HtmlRefContext | null;
  /**
   * Run the page's own JavaScript, in a sandbox that trades our origin away to
   * afford it (utils/htmlSandbox.ts). Off unless a person asks for it on the
   * file in front of them — the default preview stays inert.
   */
  scripts?: boolean;
}>();

// Links must leave the frame either way, but by different exits — see
// HtmlRefContext.linkTarget.
const refs = computed<HtmlRefContext | null>(() =>
  props.refs ? { ...props.refs, linkTarget: props.scripts ? "_blank" : "_top" } : null,
);

// Two different documents, and the difference is the point.
//
// Inert mode sanitizes first: defense-in-depth behind a sandbox that already
// runs nothing. DOMPurify is kept >=3.4.x (CVE-2026-0540). WHOLE_DOCUMENT keeps
// <html>/<head>/<body> and <style> blocks so full HTML docs render intact.
//
// Scripts mode CANNOT sanitize — stripping <script> is exactly what DOMPurify is
// for, and this mode exists to run it. The sandbox becomes the only control,
// which is why that constant grants no same-origin: the page executes, in an
// origin that owns nothing. Reference rewriting still runs (it never introduces
// markup, only rewrites URLs the resolver classified) and still pins the base.
// It also gets our link relay, the one script of ours in the frame, with a
// nonce minted for this exact document — see utils/htmlLinkRelay.ts.
const rendered = computed(() => {
  if (props.mode !== "rendered" || !props.source) return { html: "", nonce: null };
  if (!props.scripts) {
    const html = DOMPurify.sanitize(props.source, { WHOLE_DOCUMENT: true });
    return { html: rewriteHtmlRefs(html, refs.value), nonce: null };
  }
  const nonce = crypto.randomUUID();
  const html = rewriteHtmlRefs(props.source, refs.value);
  return { html: injectLinkRelay(html, window.location.origin, nonce), nonce };
});
const safe = computed(() => rendered.value.html);

const sandbox = computed(() => (props.scripts ? HTML_SCRIPTS_SANDBOX : HTML_SANDBOX));

const frame = ref<HTMLIFrameElement | null>(null);

// Turn an internal link click into an SPA navigation. The frame is same-origin
// (and script-less), so the parent may attach this handler to the document the
// preview rendered — the untrusted HTML runs nothing of its own.
function onFrameClick(e: MouseEvent) {
  const path = framedLinkPath(e, window.location.origin);
  if (!path) return; // native behaviour: new tab, external link, full load
  e.preventDefault();
  void navigateTo(path);
}

// The scripts-mode counterpart: the frame is an opaque origin we can't reach
// into, so its relay sends links here over a private port instead. The port is
// accepted from this frame only, and only once per document: the relay's
// handshake, carrying that document's nonce, is posted before any page script
// runs, so it is always the first claim — a page posting its own later is
// ignored. Links arriving on the port are trusted clicks; the path check keeps
// them on our origin. Accepting is acknowledged over the port, and the relay
// intercepts nothing until it hears that.
let relayPort: MessagePort | null = null;
let claimedNonce: string | null = null;

// Detach before closing: a message already queued on the old port may still be
// delivered after `close()` (Firefox does), and a preview that has been replaced
// or unmounted must not move the app.
function closeRelay() {
  if (relayPort) relayPort.onmessage = null;
  relayPort?.close();
  relayPort = null;
}

function onRelayHandshake(e: MessageEvent) {
  const nonce = rendered.value.nonce;
  if (!nonce || nonce === claimedNonce) return;
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const port = relayHandshakePort(e.data, e.ports, nonce);
  if (!port) return;
  claimedNonce = nonce;
  closeRelay();
  relayPort = port;
  port.onmessage = (m) => {
    if (relayPort !== port || rendered.value.nonce !== nonce) return; // stale channel
    const path = relayedLinkPath(m.data, window.location.origin);
    if (path) void navigateTo(path);
  };
  port.postMessage(RELAY_ACK);
}

// A new document means the old relay is gone; drop its port with it.
watch(() => rendered.value.nonce, closeRelay);
onMounted(() => window.addEventListener("message", onRelayHandshake));
onBeforeUnmount(() => {
  window.removeEventListener("message", onRelayHandshake);
  closeRelay();
});

// Re-attached on every load, because each new srcdoc is a fresh document (the
// old one is discarded with its listener). If same-origin access ever fails,
// bail quietly: the anchors' target="_top" still navigates, just with a reload.
function onFrameLoad() {
  if (props.scripts) {
    // A deck's controls are keyboard controls, and keys go to whatever has
    // focus — which, on a freshly rendered frame, is the page around it. So the
    // arrow keys the user reaches for first would do nothing until they thought
    // to click. Focusing the element moves focus into the frame; it needs no
    // same-origin access, and there is no handler to attach in this mode.
    frame.value?.focus();
    return;
  }
  try {
    frame.value?.contentDocument?.addEventListener("click", onFrameClick);
  } catch {
    // No same-origin access — full-page-load fallback stands.
  }
}
</script>

<template>
  <!-- Keyed on the mode: `sandbox` is read when the document is created, so
       patching the attribute in place on a live frame would leave the old
       permissions in force until something else caused a reload. Toggling
       scripts has to build a new frame, not edit this one. -->
  <iframe
    v-if="mode === 'rendered'"
    ref="frame"
    :key="scripts ? 'scripts' : 'inert'"
    :srcdoc="safe"
    :sandbox="sandbox"
    :referrerpolicy="HTML_REFERRER_POLICY"
    title="HTML preview"
    class="h-full w-full flex-1 bg-surface"
    @load="onFrameLoad"
  />
  <pre
    v-else
    class="flex-1 overflow-auto rounded-lg border border-border bg-app p-4 text-sm text-fg"
  ><code>{{ source }}</code></pre>
</template>