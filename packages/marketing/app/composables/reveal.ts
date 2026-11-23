import type { Directive } from "vue";

/**
 * v-reveal — sets `data-revealed` the first time the element scrolls into
 * view.
 *
 * One-shot: entrances play once, not on every pass. A data attribute rather
 * than a class on purpose: Vue rewrites the whole class attribute whenever an
 * element's `:class` binding re-renders, which would silently strip a
 * directive-added class — an attribute Vue doesn't bind survives patches.
 * The hidden initial state must live in CSS behind
 * `prefers-reduced-motion: no-preference`, so this attribute going unapplied
 * (reduced motion, no IntersectionObserver) never hides content — it only
 * ever adds motion.
 */
export const vReveal: Directive<HTMLElement> = {
  mounted(el) {
    if (typeof IntersectionObserver === "undefined") {
      el.dataset.revealed = "";
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.dataset.revealed = "";
          io.disconnect();
        }
      },
      { threshold: 0.18 },
    );
    io.observe(el);
  },
};