// A ViewerContext for registry tests: a markdown file at version 3 from a source
// that addresses files by path. Override whatever the test is about.
import type { ViewerContext } from "../app/utils/viewers";

export function viewerContext(overrides: Partial<ViewerContext> = {}): ViewerContext {
  return {
    entry: { path: "notes.md", contentType: "text/markdown", version: 3, size: 12 },
    fileSource: {
      key: "w1",
      readText: async () => "",
      fileUrl: (path) => `/raw/${path}`,
      downloadUrl: (path) => `/raw/${path}?download=1`,
      pageUrl: (path) => `/w/w1/${path}`,
      reachesSiblings: true,
    } as ViewerContext["fileSource"],
    content: "# Notes",
    mode: "rendered",
    markdownRefs: null,
    htmlRefs: null,
    htmlScripts: false,
    commentsWorkspaceId: null,
    onMediaError: () => {},
    ...overrides,
  };
}