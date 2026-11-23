import { describe, expect, it, vi } from "vite-plus/test";
import { viewerKind } from "shared";
import { fillsCanvas, MediaViewer, VIEWERS } from "../app/utils/viewers";
import { viewerContext } from "./viewerContext";

describe("viewer registry", () => {
  it("fetches the body only for kinds whose viewer reads text", () => {
    expect(VIEWERS.markdown.needsBody).toBe(true);
    expect(VIEWERS.html.needsBody).toBe(true);
    expect(VIEWERS.text.needsBody).toBe(true);
    expect(VIEWERS.image.needsBody).toBe(false);
    expect(VIEWERS.binary.needsBody).toBe(false);
  });

  it("offers a source toggle only where there is a rendering to toggle away from", () => {
    const toggles = Object.entries(VIEWERS)
      .filter(([, v]) => v.sourceToggle)
      .map(([k]) => k);
    expect(toggles.sort()).toEqual(["html", "markdown"]);
  });

  it("routes markdown to the WYSIWYG editor, other text to the code editor, media nowhere", () => {
    expect(VIEWERS.markdown.editor).toBe("markdown");
    expect(VIEWERS.text.editor).toBe("code");
    expect(VIEWERS.html.editor).toBe("code");
    expect(VIEWERS.image.editor).toBeNull();
    expect(VIEWERS.binary.editor).toBeNull();
  });

  it("hands text viewers the loaded content and the view mode", () => {
    const ctx = viewerContext({ content: "<p>hi</p>", mode: "source", htmlScripts: true });
    expect(VIEWERS.html.render(ctx).props).toMatchObject({
      source: "<p>hi</p>",
      mode: "source",
      scripts: true,
    });
    expect(VIEWERS.text.render(ctx).props).toMatchObject({
      source: "<p>hi</p>",
      path: "notes.md",
      contentType: "text/markdown",
    });
  });

  it("points media viewers at the file's URL, and reports a failed load", () => {
    const onMediaError = vi.fn();
    const ctx = viewerContext({ onMediaError });
    const image = VIEWERS.image.render(ctx).props;
    expect(image.src).toBe("/raw/notes.md");
    (image.onError as () => void)();
    expect(onMediaError).toHaveBeenCalledOnce();
    expect(VIEWERS.binary.render(ctx).props).toMatchObject({ href: "/raw/notes.md", size: 12 });
  });

  it("plays video and audio from the file's URL, and downloads from an attachment URL", () => {
    const onMediaError = vi.fn();
    const entry = { path: "clips/demo.mp4", contentType: "video/mp4", version: 2, size: 4096 };
    const ctx = viewerContext({ entry, onMediaError });
    for (const kind of ["video", "audio"] as const) {
      const def = VIEWERS[kind];
      // Never a fetched body: the player streams byte ranges itself.
      expect(def.needsBody, kind).toBe(false);
      expect(def.editor, kind).toBeNull();
      expect(def.sourceToggle, kind).toBe(false);
      expect(def.fullBleed, kind).toBe(false);
      const { component, props } = def.render(ctx);
      expect(component, kind).toBe(MediaViewer);
      expect(props, kind).toMatchObject({
        kind,
        src: "/raw/clips/demo.mp4",
        downloadHref: "/raw/clips/demo.mp4?download=1",
        name: "clips/demo.mp4",
        size: 4096,
      });
      (props.onError as () => void)();
    }
    expect(onMediaError).toHaveBeenCalledTimes(2);
  });
});

describe("viewer selection", () => {
  it("routes media files to the player by type, or by extension when stored as bytes", () => {
    const pick = (contentType: string, path: string) =>
      VIEWERS[viewerKind(contentType, path)].render(
        viewerContext({ entry: { path, contentType, version: 1, size: 1 } }),
      ).props.kind;
    expect(pick("video/mp4", "a.mp4")).toBe("video");
    expect(pick("application/octet-stream", "a.webm")).toBe("video");
    expect(pick("audio/mpeg", "a.mp3")).toBe("audio");
    expect(pick("audio/x-m4a", "a.m4a")).toBe("audio");
    expect(viewerKind("video/x-matroska", "a.mkv")).toBe("binary");
  });
});

describe("fillsCanvas", () => {
  it("gives rendered HTML the whole canvas", () => {
    expect(fillsCanvas("html")).toBe(true);
    expect(fillsCanvas("html", "rendered")).toBe(true);
  });

  it("keeps source view, other kinds and an empty selection in the reading column", () => {
    expect(fillsCanvas("html", "source")).toBe(false);
    expect(fillsCanvas("markdown")).toBe(false);
    expect(fillsCanvas("image")).toBe(false);
    expect(fillsCanvas(null)).toBe(false);
  });
});