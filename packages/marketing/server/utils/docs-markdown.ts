/**
 * Markdown twins for docs pages (`/docs/<path>.md`, `/llms-docs.txt`).
 *
 * nuxt-ai-ready builds a content page's twin by stringifying the stored
 * minimark body with `minimark/stringify`, which leaves MDC components in the
 * output (`<callout type="info">`, `::quick-link{...}`) and drops data-backed
 * components to nothing. Agents read these twins as the canonical page, so we
 * serialise the body ourselves: every MDC component is flattened into plain
 * markdown (callout -> blockquote with a bold label, quick-links -> a link list,
 * code-group -> its code blocks in order), links and images are made absolute,
 * and the page gets its H1, release banner, plan line, hub child list and
 * related links so a single twin stands on its own.
 *
 * Wired in via nuxt.config (it replaces the module's content lookup, see
 * `server/lib/docs-content.ts`). Pure - no Nuxt auto-imports - so it unit-tests
 * in plain Vitest.
 */
import {
  DOCS_ROOT,
  buildDocsTree,
  docsRelease,
  findDocsNode,
  normalizeDocsPath,
  resolveRelatedDocs,
  type DocsPageMeta,
} from "../../app/utils/docs-tree";

/** A minimark node: text, or `[tag, props, ...children]`. */
export type MinimarkNode = string | [string, Record<string, unknown>, ...MinimarkNode[]];

export interface MinimarkBody {
  type?: string;
  value?: MinimarkNode[];
}

export interface DocsMarkdownContext {
  /** Canonical site origin, e.g. `https://trytree.house`. */
  siteUrl: string;
  /** Absolute HTML URL of the page being rendered. */
  pageUrl: string;
}

type Element = [string, Record<string, unknown>, ...MinimarkNode[]];

const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "table",
  "hr",
  "div",
  "details",
  "callout",
  "quick-links",
  "quick-link",
  "code-group",
  "demo-video",
]);

// Keep in step with the labels in app/components/content/Callout.vue.
const CALLOUT_LABELS: Record<string, string> = {
  note: "Note",
  info: "Info",
  tip: "Tip",
  warning: "Warning",
  agent: "For agents",
};

function isElement(node: MinimarkNode): node is Element {
  return Array.isArray(node);
}

function children(node: Element): MinimarkNode[] {
  return node.slice(2) as MinimarkNode[];
}

function prop(node: Element, name: string): string {
  const value = node[1]?.[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function isBlock(node: MinimarkNode): boolean {
  return isElement(node) && BLOCK_TAGS.has(node[0]);
}

function textContent(node: MinimarkNode): string {
  if (!isElement(node)) return node;
  return children(node).map(textContent).join("");
}

function absoluteHref(href: string, ctx: DocsMarkdownContext): string {
  if (!href) return href;
  if (href.startsWith("#")) return `${ctx.pageUrl}${href}`;
  if (href.startsWith("/") && !href.startsWith("//")) {
    return `${ctx.siteUrl.replace(/\/+$/, "")}${href}`;
  }
  return href;
}

function inlineCode(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function renderInline(nodes: MinimarkNode[], ctx: DocsMarkdownContext): string {
  return nodes.map((node) => renderInlineNode(node, ctx)).join("");
}

type Renderer = (node: Element, ctx: DocsMarkdownContext) => string;

function renderInnerInline(node: Element, ctx: DocsMarkdownContext): string {
  return renderInline(children(node), ctx);
}

/** Wrap trimmed inline content in `marker`; empty content renders nothing. */
function emphasis(marker: string): Renderer {
  return (node, ctx) => {
    const text = renderInnerInline(node, ctx).trim();
    return text ? `${marker}${text}${marker}` : "";
  };
}

function renderLink(node: Element, ctx: DocsMarkdownContext): string {
  const href = absoluteHref(prop(node, "href"), ctx);
  const text = renderInnerInline(node, ctx).trim() || href;
  return href ? `[${text}](${href})` : text;
}

function renderImage(node: Element, ctx: DocsMarkdownContext): string {
  const src = absoluteHref(prop(node, "src"), ctx);
  return src ? `![${prop(node, "alt")}](${src})` : "";
}

const bold = emphasis("**");
const italic = emphasis("*");
const strikethrough: Renderer = (node, ctx) => `~~${renderInnerInline(node, ctx)}~~`;

const INLINE_RENDERERS: Record<string, Renderer> = {
  strong: bold,
  b: bold,
  em: italic,
  i: italic,
  del: strikethrough,
  s: strikethrough,
  code: (node) => inlineCode(textContent(node)),
  br: () => "\n",
  a: renderLink,
  img: renderImage,
};

function renderInlineNode(node: MinimarkNode, ctx: DocsMarkdownContext): string {
  if (!isElement(node)) return node;
  const render = INLINE_RENDERERS[node[0]];
  if (render) return render(node, ctx);
  // Unknown inline wrappers (span, kbd, sup ...) keep their text.
  return BLOCK_TAGS.has(node[0]) ? renderBlock(node, ctx) : renderInnerInline(node, ctx);
}

/** Render a mix of block + inline nodes as markdown blocks. */
function renderBlocks(nodes: MinimarkNode[], ctx: DocsMarkdownContext): string[] {
  const blocks: string[] = [];
  let inlineRun: MinimarkNode[] = [];
  const flush = () => {
    const text = renderInline(inlineRun, ctx).trim();
    if (text) blocks.push(text);
    inlineRun = [];
  };
  for (const node of nodes) {
    if (isBlock(node)) {
      flush();
      const block = renderBlock(node as Element, ctx).trim();
      if (block) blocks.push(block);
    } else {
      inlineRun.push(node);
    }
  }
  flush();
  return blocks;
}

function joinBlocks(blocks: string[]): string {
  return blocks.join("\n\n");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function indentContinuation(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line, index) => (index === 0 || !line.trim() ? line : `${pad}${line}`))
    .join("\n");
}

function renderList(node: Element, ctx: DocsMarkdownContext): string {
  const ordered = node[0] === "ol";
  const start = Number(node[1]?.start) || 1;
  const items = children(node).filter(
    (child): child is Element => isElement(child) && child[0] === "li",
  );
  const loose = items.some((item) =>
    children(item).some((child) => isElement(child) && child[0] === "p"),
  );
  const lines = items.map((item, index) => {
    const marker = ordered ? `${start + index}. ` : "- ";
    const body = renderBlocks(children(item), ctx).join(loose ? "\n\n" : "\n");
    return `${marker}${indentContinuation(body, marker.length)}`;
  });
  return lines.join(loose ? "\n\n" : "\n");
}

function renderCode(node: Element): string {
  const code = (prop(node, "code") || textContent(node)).replace(/\n+$/, "");
  const language = prop(node, "language");
  const filename = prop(node, "filename");
  const fence = code.includes("```") ? "````" : "```";
  const block = `${fence}${language}\n${code}\n${fence}`;
  return filename ? `**${filename}**\n\n${block}` : block;
}

function tableCell(node: MinimarkNode, ctx: DocsMarkdownContext): string {
  const text = isElement(node) ? renderInline(children(node), ctx) : node;
  return text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function renderTable(node: Element, ctx: DocsMarkdownContext): string {
  const rows: string[][] = [];
  let headerRows = 0;
  const collect = (el: Element, inHead: boolean) => {
    for (const child of children(el)) {
      if (!isElement(child)) continue;
      if (child[0] === "tr") {
        rows.push(
          children(child)
            .filter(isElement)
            .map((cell) => tableCell(cell, ctx)),
        );
        if (inHead) headerRows += 1;
      } else {
        collect(child, inHead || child[0] === "thead");
      }
    }
  };
  collect(node, false);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? "");
  const line = (row: string[]) => `| ${pad(row).join(" | ")} |`;
  const header = rows[0] ?? [];
  const body = rows.slice(Math.max(headerRows, 1));
  return [
    line(header),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

function renderQuickLink(node: Element, ctx: DocsMarkdownContext): string {
  const title = prop(node, "title") || textContent(node).trim();
  const href = absoluteHref(prop(node, "href"), ctx);
  const description = prop(node, "description");
  const link = href ? `[${title}](${href})` : title;
  return `- ${link}${description ? `: ${description}` : ""}`;
}

function renderHeading(node: Element, ctx: DocsMarkdownContext): string {
  const text = renderInnerInline(node, ctx)
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return text ? `${"#".repeat(Number(node[0].slice(1)))} ${text}` : "";
}

/** Contents only: code-group, div, details and unknown wrappers. */
function renderContents(node: Element, ctx: DocsMarkdownContext): string {
  return joinBlocks(renderBlocks(children(node), ctx));
}

function renderCallout(node: Element, ctx: DocsMarkdownContext): string {
  const label = prop(node, "title") || CALLOUT_LABELS[prop(node, "type")] || CALLOUT_LABELS.note;
  const body = renderContents(node, ctx);
  return quote(body ? `**${label}**\n\n${body}` : `**${label}**`);
}

/** A screen recording: its poster as an image, then a link to the video. */
function renderDemoVideo(node: Element, ctx: DocsMarkdownContext): string {
  const caption = prop(node, "caption") || "Screen recording";
  const poster = absoluteHref(prop(node, "poster"), ctx);
  const src = absoluteHref(prop(node, "src"), ctx);
  return [poster && `![${caption}](${poster})`, src && `[Watch the video: ${caption}](${src})`]
    .filter(Boolean)
    .join("\n\n");
}

function renderQuickLinks(node: Element, ctx: DocsMarkdownContext): string {
  return children(node)
    .filter(isElement)
    .map((child) =>
      child[0] === "quick-link" ? renderQuickLink(child, ctx) : renderBlock(child, ctx),
    )
    .filter(Boolean)
    .join("\n");
}

const BLOCK_RENDERERS: Record<string, Renderer> = {
  p: (node, ctx) => renderInnerInline(node, ctx).trim(),
  h1: renderHeading,
  h2: renderHeading,
  h3: renderHeading,
  h4: renderHeading,
  h5: renderHeading,
  h6: renderHeading,
  ul: renderList,
  ol: renderList,
  blockquote: (node, ctx) => quote(renderContents(node, ctx)),
  pre: renderCode,
  table: renderTable,
  hr: () => "---",
  callout: renderCallout,
  "demo-video": renderDemoVideo,
  "quick-links": renderQuickLinks,
  "quick-link": renderQuickLink,
};

function renderBlock(node: Element, ctx: DocsMarkdownContext): string {
  const render = BLOCK_RENDERERS[node[0]] ?? renderContents;
  return render(node, ctx);
}

/** Serialise a minimark body to plain markdown with every MDC component flattened. */
export function minimarkToMarkdown(
  body: MinimarkBody | null | undefined,
  ctx: DocsMarkdownContext,
): string {
  const nodes = (body?.value ?? []).filter((node) => !(isElement(node) && node[0] === "style"));
  return joinBlocks(renderBlocks(nodes, ctx));
}

export interface DocsTwinPage extends DocsPageMeta {
  body?: MinimarkBody | null;
}

const PLAN_NAMES: Record<string, string> = {
  seedling: "Seedling",
  grove: "Grove",
  forest: "Forest",
};

export const EARLY_ACCESS_NOTICE =
  "Early access - this feature is being rolled out gradually and may not be in your workspace yet.";
export const UNRELEASED_NOTICE =
  "Unreleased - this page documents a feature that is not available yet.";

/**
 * The full markdown twin for one docs page: H1, release notice, plan line,
 * flattened body, the hub's child list and related links. `pages` is the whole
 * docs collection (metadata only) for hub children and related titles.
 */
export function renderDocsTwin(
  page: DocsTwinPage,
  pages: DocsPageMeta[],
  ctx: Omit<DocsMarkdownContext, "pageUrl">,
): string {
  const path = normalizeDocsPath(page.path);
  const siteUrl = ctx.siteUrl.replace(/\/+$/, "");
  const full: DocsMarkdownContext = { ...ctx, pageUrl: `${siteUrl}${path}` };
  const blocks: string[] = [`# ${page.title || ""}`.trim()];

  const release = docsRelease(page);
  if (release === "early-access") blocks.push(quote(`**${EARLY_ACCESS_NOTICE}**`));
  if (release === "unreleased") blocks.push(quote(`**${UNRELEASED_NOTICE}**`));

  // The description is the page's lede on the web (rendered under the H1), so
  // the twin carries it too rather than starting cold on the first section.
  if (page.description) blocks.push(page.description.trim());

  const plans = (page.plans ?? []).map((plan) => PLAN_NAMES[plan] ?? plan);
  if (plans.length) blocks.push(`**Available on:** ${plans.join(", ")} plans.`);

  const body = minimarkToMarkdown(page.body, full);
  if (body) blocks.push(body);

  // Hub twins list their children; the docs home's body already links every
  // section (same rule as the rendered page).
  const node = path === DOCS_ROOT ? undefined : findDocsNode(buildDocsTree(pages), path);
  if (node?.children.length) {
    blocks.push(
      [
        "## In this section",
        "",
        ...node.children.map(
          (child) =>
            `- [${child.title}](${siteUrl}${child.path})${child.description ? `: ${child.description}` : ""}`,
        ),
      ].join("\n"),
    );
  }

  const related = resolveRelatedDocs(pages, page.related);
  if (related.length) {
    blocks.push(
      [
        "## Related",
        "",
        ...related.map(
          (link) =>
            `- [${link.title}](${siteUrl}${link.path})${link.description ? `: ${link.description}` : ""}`,
        ),
      ].join("\n"),
    );
  }

  return `${joinBlocks(blocks)}\n`;
}