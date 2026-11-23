/**
 * The raw-markdown path for a docs page: append `.md` to the page URL. Resolves
 * to the `.md` twin nuxt-ai-ready serves for every docs page, so an agent (or
 * the "Copy page" menu) can fetch any doc as markdown by adding `.md` to its
 * URL. `/docs/x/` and `/docs/x` both map to `/docs/x.md`.
 */
export function docMarkdownPath(routePath: string): string {
  return `${routePath.replace(/\/$/, "")}.md`;
}

/** Assistants the "Copy page" menu can open with the page preloaded. */
export type AiProvider = "chatgpt" | "claude";

const AI_PROVIDER_BASE: Record<AiProvider, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
};

/** A deep link that opens the assistant prefilled with a prompt to read the page. */
export function aiDeepLink(provider: AiProvider, absoluteMdUrl: string): string {
  const prompt = `Read the Treehouse documentation at ${absoluteMdUrl} and help me with it.`;
  return `${AI_PROVIDER_BASE[provider]}?q=${encodeURIComponent(prompt)}`;
}