import type { Ref } from "vue";

/**
 * Scroll-linked parallax for a set of layers inside a container.
 *
 * Layers are driven off the container's position in the viewport rather than
 * raw scrollY, so a section parallaxes the same way wherever it sits on the
 * page. Offsets are written to a CSS custom property (`--parallax-y`) instead
 * of an inline transform, which leaves the layer's own transforms (scale,
 * object-position nudges) free to compose in CSS.
 *
 * Motion is transform-only and rAF-batched. It disables itself entirely under
 * `prefers-reduced-motion: reduce`, and unobserved sections cost nothing —
 * an IntersectionObserver gates the scroll listener.
 */
export interface ParallaxLayer {
  /** Element to move. */
  el: Ref<HTMLElement | null>;
  /**
   * Pixels of travel per pixel of scroll. Positive drifts down (appears
   * further away / slower); negative drifts up (appears closer / faster).
   * Keep within roughly -0.4..0.4 — beyond that it reads as sliding, not depth.
   */
  speed: number;
  /** Optional cap on travel in px, so long scrolls can't detach a layer. */
  max?: number;
}

export function useParallax(container: Ref<HTMLElement | null>, layers: ParallaxLayer[]) {
  if (import.meta.server) return;

  let frame = 0;
  let active = false;
  let enabled = true;

  const apply = () => {
    frame = 0;
    const root = container.value;
    if (!root || !enabled) return;

    const rect = root.getBoundingClientRect();
    // 0 when the section's top sits at the viewport top; grows as it scrolls up.
    const travelled = -rect.top;

    for (const layer of layers) {
      const el = layer.el.value;
      if (!el) continue;
      let y = travelled * layer.speed;
      if (layer.max !== undefined) y = Math.max(-layer.max, Math.min(layer.max, y));
      el.style.setProperty("--parallax-y", `${y.toFixed(2)}px`);
    }
  };

  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  const reset = () => {
    for (const layer of layers) layer.el.value?.style.setProperty("--parallax-y", "0px");
  };

  let observer: IntersectionObserver | null = null;
  let motionQuery: MediaQueryList | null = null;

  const listen = () => {
    if (active) return;
    active = true;
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    apply();
  };

  const unlisten = () => {
    if (!active) return;
    active = false;
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const onMotionChange = () => {
    enabled = !motionQuery?.matches;
    if (enabled) apply();
    else reset();
  };

  onMounted(() => {
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener("change", onMotionChange);
    enabled = !motionQuery.matches;

    if (!container.value) return;
    observer = new IntersectionObserver(
      ([entry]) => (entry?.isIntersecting ? listen() : unlisten()),
      { rootMargin: "100px" },
    );
    observer.observe(container.value);
  });

  onBeforeUnmount(() => {
    unlisten();
    observer?.disconnect();
    motionQuery?.removeEventListener("change", onMotionChange);
  });
}