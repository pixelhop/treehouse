// Theme resolution + application. A workspace has a default theme (server,
// shared); a user can override it per workspace (localStorage). Effective theme
// = personal override ?? workspace default ?? DEFAULT_THEME. Presets apply via a
// data-theme attribute; a custom theme injects its --th-* vars in a <style>.

/**
 * The palette used when nothing else is chosen. This is NOT just a fallback
 * string: `applyTheme` removes the data-theme attribute for it rather than
 * setting one, so its values are the ones that must live in `:root` in
 * tailwind.css. The two are a pair — change one and the other's preset silently
 * renders in the wrong palette.
 */
export const DEFAULT_THEME = "treehouse";

export interface ThemeChoice {
  theme: string; // preset id or "custom"
  themeCss?: string | null; // when theme === "custom"
}

// swatch = [app, surface, accent, fg] for the picker preview.
export const THEME_PRESETS = [
  { id: "light", label: "Light", swatch: ["#fafafa", "#ffffff", "#2563eb", "#171717"] },
  { id: "dark", label: "Dark", swatch: ["#0a0a0a", "#171717", "#3b82f6", "#fafafa"] },
  { id: "dracula", label: "Dracula", swatch: ["#282a36", "#2f3140", "#bd93f9", "#f8f8f2"] },
  { id: "nord", label: "Nord", swatch: ["#2e3440", "#3b4252", "#88c0d0", "#eceff4"] },
  {
    id: "solarized-light",
    label: "Solarized Light",
    swatch: ["#fdf6e3", "#fbf6e9", "#268bd2", "#073642"],
  },
  { id: "rose-pine", label: "Rosé Pine", swatch: ["#191724", "#1f1d2e", "#c4a7e7", "#e0def4"] },
  { id: "treehouse", label: "Treehouse", swatch: ["#f7f4ed", "#ffffff", "#2e7d5b", "#23372b"] },
] as const;

// The overridable variables, in editor order (label for the colour-picker form).
export const THEME_TOKENS = [
  { var: "--th-app", label: "App background" },
  { var: "--th-surface", label: "Surface" },
  { var: "--th-surface-2", label: "Surface (raised)" },
  { var: "--th-border", label: "Border" },
  { var: "--th-fg", label: "Text" },
  { var: "--th-fg-muted", label: "Text — muted" },
  { var: "--th-fg-subtle", label: "Text — subtle" },
  { var: "--th-accent", label: "Accent" },
  { var: "--th-accent-fg", label: "Accent text" },
  { var: "--th-danger", label: "Danger" },
  { var: "--th-success", label: "Success" },
  { var: "--th-warning", label: "Warning" },
  { var: "--th-agent", label: "Agent" },
  { var: "--th-human", label: "Human" },
] as const;

const OVERRIDES_KEY = "th:overrides";

const ALLOWED_VARS = new Set<string>(THEME_TOKENS.map((t) => t.var));
// Colour-ish values only: hex, rgb()/hsl()/oklch(), named colours, percentages.
// Notably excludes `{ } < > ; : / @ "` so a value can't break out of the
// `:root{…}` rule or smuggle url()/@import — closing the stored-CSS-injection hole.
const SAFE_VALUE = /^[a-zA-Z0-9#\s,.%()+-]{1,64}$/;

/** Parse a custom theme block into a map, keeping only known tokens + safe values. */
export function parseThemeCss(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    const key = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (ALLOWED_VARS.has(key) && SAFE_VALUE.test(value)) out[key] = value;
  }
  return out;
}

/** Render a token→value map back to a CSS block (known tokens only, in order). */
export function buildThemeCss(map: Record<string, string>): string {
  return THEME_TOKENS.filter((t) => map[t.var])
    .map((t) => `${t.var}: ${map[t.var]};`)
    .join("\n");
}

/** Strip a custom theme block down to safe, known declarations. */
export function sanitizeThemeCss(css: string): string {
  return buildThemeCss(parseThemeCss(css));
}

/** Apply a theme to the document (client only). */
export function applyTheme(choice: ThemeChoice | null) {
  if (!import.meta.client) return;
  const html = document.documentElement;
  let style = document.getElementById("th-custom") as HTMLStyleElement | null;
  const theme = choice?.theme ?? DEFAULT_THEME;

  if (theme === "custom") {
    html.removeAttribute("data-theme");
    if (!style) {
      style = document.createElement("style");
      style.id = "th-custom";
      document.head.appendChild(style);
    }
    // Sanitize at the render boundary so even an unsanitized stored value (e.g. a
    // workspace default set by another member) cannot inject arbitrary CSS.
    style.textContent = `:root{${sanitizeThemeCss(choice?.themeCss ?? "")}}`;
  } else {
    if (style) style.textContent = "";
    if (theme && theme !== DEFAULT_THEME) html.setAttribute("data-theme", theme);
    else html.removeAttribute("data-theme");
  }
}

/** Snapshot the currently-applied --th-* values as an editable CSS block. */
export function snapshotThemeCss(): string {
  if (!import.meta.client) return "";
  const cs = getComputedStyle(document.documentElement);
  return THEME_TOKENS.map((t) => `${t.var}: ${cs.getPropertyValue(t.var).trim()};`).join("\n");
}

export function useTheme() {
  const ws = useWorkspaceData();

  const overrides = useState<Record<string, ThemeChoice>>(OVERRIDES_KEY, () => {
    if (import.meta.client) {
      try {
        return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}");
      } catch {
        // ignore corrupt storage
      }
    }
    return {};
  });

  function persist() {
    if (import.meta.client) localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides.value));
  }

  const currentOverride = computed(() =>
    ws.workspaceId.value ? (overrides.value[ws.workspaceId.value] ?? null) : null,
  );

  const workspaceDefault = computed<ThemeChoice>(() => ({
    theme: ws.workspace.value?.theme ?? DEFAULT_THEME,
    themeCss: ws.workspace.value?.themeCss ?? null,
  }));

  const effective = computed<ThemeChoice>(() => currentOverride.value ?? workspaceDefault.value);

  function setOverride(choice: ThemeChoice) {
    const id = ws.workspaceId.value;
    if (!id) return;
    overrides.value = { ...overrides.value, [id]: choice };
    persist();
  }

  function clearOverride() {
    const id = ws.workspaceId.value;
    if (!id) return;
    const next = { ...overrides.value };
    delete next[id];
    overrides.value = next;
    persist();
  }

  return {
    presets: THEME_PRESETS,
    tokens: THEME_TOKENS,
    effective,
    currentOverride,
    workspaceDefault,
    setOverride,
    clearOverride,
  };
}