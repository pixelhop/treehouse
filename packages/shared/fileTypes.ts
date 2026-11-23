// What Treehouse knows about a file from its name: the content type it is
// stored and served as, and whether its bytes are text. This table is the one
// place that knowledge lives. The CLI uploads with it, the API falls back to it
// for a write that sends no type, and the app classifies files with it. The
// app's code-language table (packages/app/app/utils/codeLanguage.ts) is keyed by
// `FileExtension`, so it cannot name an extension this table doesn't know.
//
// Adding a file type is one entry here. Where several extensions share a
// content type, list the usual one first: it is the extension a bare content
// type maps back to (see `extensionForContentType`).

interface FileType {
  contentType: string;
  /** The bytes are text, so the app shows (and edits) them as text. */
  text: boolean;
}

const text = (contentType: string): FileType => ({ contentType, text: true });
const bytes = (contentType: string): FileType => ({ contentType, text: false });

export const FILE_TYPES = {
  // Documents
  md: text("text/markdown"),
  markdown: text("text/markdown"),
  txt: text("text/plain"),
  log: text("text/plain"),
  csv: text("text/csv"),
  // Web
  html: text("text/html"),
  htm: text("text/html"),
  css: text("text/css"),
  // Data and config
  json: text("application/json"),
  yaml: text("application/yaml"),
  yml: text("application/yaml"),
  toml: text("application/toml"),
  xml: text("application/xml"),
  // Code
  js: text("text/javascript"),
  mjs: text("text/javascript"),
  cjs: text("text/javascript"),
  jsx: text("text/javascript"),
  ts: text("text/typescript"),
  mts: text("text/typescript"),
  cts: text("text/typescript"),
  tsx: text("text/typescript"),
  vue: text("text/x-vue"),
  py: text("text/x-python"),
  sql: text("application/sql"),
  sh: text("application/x-sh"),
  bash: text("application/x-sh"),
  zsh: text("application/x-sh"),
  // Images. SVG is text, but it is shown as an image.
  svg: text("image/svg+xml"),
  png: bytes("image/png"),
  jpg: bytes("image/jpeg"),
  jpeg: bytes("image/jpeg"),
  gif: bytes("image/gif"),
  webp: bytes("image/webp"),
  // Video. M4V is Apple's name for an MPEG-4 file, and video/mp4 (rather than
  // the unregistered video/x-m4v) is the type every browser plays.
  mp4: bytes("video/mp4"),
  m4v: bytes("video/mp4"),
  webm: bytes("video/webm"),
  mov: bytes("video/quicktime"),
  ogv: bytes("video/ogg"),
  // Audio. An Opus file is an Ogg container, so it shares Ogg's type.
  mp3: bytes("audio/mpeg"),
  m4a: bytes("audio/mp4"),
  aac: bytes("audio/aac"),
  wav: bytes("audio/wav"),
  flac: bytes("audio/flac"),
  ogg: bytes("audio/ogg"),
  oga: bytes("audio/ogg"),
  opus: bytes("audio/ogg"),
  // Other binary
  pdf: bytes("application/pdf"),
  zip: bytes("application/zip"),
} satisfies Record<string, FileType>;

export type FileExtension = keyof typeof FILE_TYPES;

const OCTET_STREAM = "application/octet-stream";

const TEXT_TYPES = new Set(
  Object.values(FILE_TYPES)
    .filter((t) => t.text)
    .map((t) => t.contentType),
);

// The audio and video types the table names, which are the ones the app plays.
// Only these: a browser's guess for an extension it misreads (`video/mp2t` for
// a TypeScript file) must not turn a text file into a broken video.
const MEDIA_TYPES = new Set(
  Object.values(FILE_TYPES)
    .map((t) => t.contentType)
    .filter((ct) => ct.startsWith("audio/") || ct.startsWith("video/")),
);

/** True for an audio or video type in the table: one a browser plays inline. */
export function isPlayableMediaType(contentType: string): boolean {
  return MEDIA_TYPES.has(baseContentType(contentType));
}

/**
 * The file's extension when it is one in `FILE_TYPES`, else null. Only the
 * basename counts, so a dot in a folder name ("notes.md/todo") is not an
 * extension, and neither is a leading dot (".env").
 */
export function knownExtension(path: string): FileExtension | null {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = basename.slice(dot + 1).toLowerCase();
  return Object.hasOwn(FILE_TYPES, ext) ? (ext as FileExtension) : null;
}

/**
 * Guess a file's content-type from its extension. An extension the table
 * doesn't know gets `fallback`.
 */
export function contentTypeFor(path: string, fallback = OCTET_STREAM): string {
  const ext = knownExtension(path);
  return ext ? FILE_TYPES[ext].contentType : fallback;
}

/** The usual extension for a content type (the first listed for it), or null. */
export function extensionForContentType(contentType: string): FileExtension | null {
  const ct = baseContentType(contentType);
  for (const [ext, type] of Object.entries(FILE_TYPES)) {
    if (type.contentType === ct) return ext as FileExtension;
  }
  return null;
}

/** Strip any charset/param suffix and normalize, e.g. "text/HTML; charset=utf-8" → "text/html". */
export function baseContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export type ViewerKind = "markdown" | "html" | "text" | "image" | "video" | "audio" | "binary";

function kindOf(ct: string): ViewerKind {
  if (ct === "text/markdown") return "markdown";
  if (ct === "text/html") return "html";
  // SVG is image/* and renders safely inline via <img> (scripts don't run there).
  if (ct.startsWith("image/")) return "image";
  if (MEDIA_TYPES.has(ct)) return ct.startsWith("video/") ? "video" : "audio";
  if (TEXT_TYPES.has(ct) || ct.startsWith("text/")) return "text";
  return "binary";
}

/**
 * Decide how the web viewer should render a file from its content-type: markdown
 * and html get rich renderers, text/code is highlighted, images show inline,
 * video and audio play inline, and everything else is a binary download.
 *
 * When the stored type alone would make the file a download, the extension gets
 * a say. That covers a missing type, `application/octet-stream` (what older CLI
 * versions stored for any extension they didn't know, such as `.yaml` or
 * `.mp4`), and a browser's own guess on upload (`video/mp2t` for a `.ts` file,
 * `audio/x-m4a` for an `.m4a`).
 */
export function viewerKind(contentType: string, path = ""): ViewerKind {
  const kind = kindOf(baseContentType(contentType));
  return kind === "binary" ? kindOf(contentTypeFor(path)) : kind;
}

/**
 * The content type to serve stored bytes as. That is the stored type, except
 * for audio and video stored as `application/octet-stream`: the sync CLI stored
 * that for media until this table knew its extensions, and a file that hasn't
 * changed since is never uploaded again. A browser won't reliably play
 * octet-stream from another origin, so the extension supplies the real type.
 *
 * Only media is corrected. Promoting other types on the way out would change
 * how a file deliberately stored as bytes (an HTML page, say) is treated by
 * whatever opens its URL.
 */
export function servedContentType(stored: string, path: string): string {
  const base = baseContentType(stored);
  if (base && base !== OCTET_STREAM) return stored;
  const guess = contentTypeFor(path);
  return MEDIA_TYPES.has(guess) ? guess : stored || OCTET_STREAM;
}

/** True for a markdown file path. */
export function isMarkdownPath(path: string): boolean {
  return contentTypeFor(path) === "text/markdown";
}

/** A markdown file's name without its extension ("Launch plan.md" → "Launch plan"). */
export function withoutMarkdownExtension(name: string): string {
  return isMarkdownPath(name) ? name.slice(0, name.lastIndexOf(".")) : name;
}