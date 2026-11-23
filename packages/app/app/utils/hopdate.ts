// Theme bridge for the Hopdate "What's new" widget (components/WhatsNew.vue).
//
// Hopdate wants a "#rrggbb" primary colour and a light/dark mode. Treehouse's
// theme is a set of --th-* CSS variables in any CSS colour syntax (presets use
// hex, a custom theme may use rgb(), hsl() or oklch()), so the widget is fed
// the colours the browser actually resolved rather than the raw strings.

export type Rgb = readonly [number, number, number];

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The widget theme for a Treehouse palette: its accent, and dark when the
 * surface is. */
export function hopdateTheme(accent: Rgb, surface: Rgb) {
  return {
    mode: luminance(surface) < 0.4 ? ("dark" as const) : ("light" as const),
    primaryColor: rgbToHex(accent),
  };
}

/**
 * Resolve a CSS colour (any syntax the browser understands, including var())
 * to RGB. Painted onto a 1×1 canvas because getComputedStyle hands modern
 * syntaxes such as oklch() back unchanged. Client only.
 */
export function resolveCssColor(color: string): Rgb | null {
  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.display = "none";
  document.body.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();

  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx || !computed) return null;
  ctx.fillStyle = computed;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r ?? 0, g ?? 0, b ?? 0];
}