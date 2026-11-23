// Where a viewer reads file bytes from, and how it addresses other files.
//
// Two surfaces render the same documents: the signed-in workspace (reads via the
// authenticated workspace API, links to `/w/<id>/<path>`) and a public share
// (reads via the token-scoped share API, links to `/s/<token>?p=<path>`).
// Everything else about rendering is identical, so the viewers take a FileSource
// rather than a workspace id and the two surfaces differ only in what they pass.
import { appRouteFor } from "./markdownRefs";

export interface FileSource {
  /**
   * Cache scope for file bytes — the workspace id, or a share token. File
   * content is immutable for a given version, so [key, path, version] is a
   * safe permanent cache key.
   */
  key: string;
  /** Read a file's text content. */
  readText: (path: string) => Promise<string>;
  /** URL for a path's raw bytes (used for images, downloads and media refs). */
  fileUrl: (path: string) => string;
  /**
   * URL that saves a path's bytes rather than showing them. The API is on
   * another origin, where an anchor's `download` attribute is ignored, so this
   * asks the server for an attachment.
   */
  downloadUrl: (path: string) => string;
  /** In-app page that displays a path. */
  pageUrl: (path: string) => string;
  /**
   * Whether paths OTHER than the open document are reachable. False for a
   * single-file share, which serves exactly one path: a relative reference in
   * that document resolves to something this source cannot address, so media is
   * left as authored and links are defused rather than both being pointed at
   * the shared file itself.
   */
  reachesSiblings: boolean;
  /**
   * The paths a `[[wikilink]]` may resolve to: every file the reader can see in
   * the workspace, or a folder share's own files. Absent for a single-file
   * share, where wikilinks render unresolved. Never a wider list than the
   * reader may see — resolution picks among these by name, so a hidden file in
   * the list would change where a visible link goes.
   */
  paths?: () => readonly string[];
}

/** A FileSource backed by the authenticated workspace API. */
export function workspaceFileSource(
  api: {
    readFile: (wsId: string, path: string) => Promise<string>;
    fileUrl: (wsId: string, path: string, opts?: { download?: boolean }) => string;
  },
  workspaceId: string,
  paths?: () => readonly string[],
): FileSource {
  return {
    key: workspaceId,
    readText: (path) => api.readFile(workspaceId, path),
    fileUrl: (path) => api.fileUrl(workspaceId, path),
    downloadUrl: (path) => api.fileUrl(workspaceId, path, { download: true }),
    pageUrl: (path) => appRouteFor(workspaceId, path),
    reachesSiblings: true,
    paths,
  };
}