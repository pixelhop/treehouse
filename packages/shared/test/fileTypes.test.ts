import { describe, expect, it } from "vite-plus/test";
import {
  contentTypeFor,
  extensionForContentType,
  FILE_TYPES,
  type FileExtension,
  isMarkdownPath,
  isPlayableMediaType,
  knownExtension,
  servedContentType,
  viewerKind,
  withoutMarkdownExtension,
} from "../index";

const entries = Object.entries(FILE_TYPES) as Array<
  [FileExtension, (typeof FILE_TYPES)[FileExtension]]
>;

describe("contentTypeFor", () => {
  it("maps known extensions, case-insensitively", () => {
    expect(contentTypeFor("notes/a.md")).toBe("text/markdown");
    expect(contentTypeFor("PHOTO.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("config.yaml")).toBe("application/yaml");
    expect(contentTypeFor("scripts/deploy.sh")).toBe("application/x-sh");
    expect(contentTypeFor("App.vue")).toBe("text/x-vue");
    expect(contentTypeFor("App.tsx")).toBe("text/typescript");
  });

  it("returns octet-stream, or the given fallback, for anything else", () => {
    expect(contentTypeFor("movie.mkv")).toBe("application/octet-stream");
    expect(contentTypeFor("movie.mkv", "video/x-matroska")).toBe("video/x-matroska");
    expect(contentTypeFor("README")).toBe("application/octet-stream");
  });

  it("reads the extension from the file name only", () => {
    // A dot in a folder name is not the file's extension.
    expect(contentTypeFor("notes.md/todo")).toBe("application/octet-stream");
    // A file named after an extension, or a dotfile, has none.
    expect(contentTypeFor("md")).toBe("application/octet-stream");
    expect(contentTypeFor(".env")).toBe("application/octet-stream");
    expect(knownExtension("a/b.c/deploy.SH")).toBe("sh");
  });
});

describe("extensionForContentType", () => {
  it("maps a content type back to its usual extension", () => {
    expect(extensionForContentType("text/markdown; charset=utf-8")).toBe("md");
    expect(extensionForContentType("text/typescript")).toBe("ts");
    expect(extensionForContentType("application/yaml")).toBe("yaml");
    expect(extensionForContentType("video/mp4")).toBe("mp4");
    expect(extensionForContentType("audio/ogg")).toBe("ogg");
    expect(extensionForContentType("video/x-matroska")).toBeNull();
  });
});

describe("media types", () => {
  it("maps video and audio extensions to the types browsers play", () => {
    expect(contentTypeFor("clips/Demo.MP4")).toBe("video/mp4");
    expect(contentTypeFor("clip.m4v")).toBe("video/mp4");
    expect(contentTypeFor("clip.webm")).toBe("video/webm");
    expect(contentTypeFor("clip.mov")).toBe("video/quicktime");
    expect(contentTypeFor("clip.ogv")).toBe("video/ogg");
    expect(contentTypeFor("song.mp3")).toBe("audio/mpeg");
    expect(contentTypeFor("song.m4a")).toBe("audio/mp4");
    expect(contentTypeFor("song.aac")).toBe("audio/aac");
    expect(contentTypeFor("song.wav")).toBe("audio/wav");
    expect(contentTypeFor("song.flac")).toBe("audio/flac");
    expect(contentTypeFor("song.ogg")).toBe("audio/ogg");
    expect(contentTypeFor("song.oga")).toBe("audio/ogg");
    expect(contentTypeFor("song.opus")).toBe("audio/ogg");
  });

  it("stores media as bytes, never as text", () => {
    for (const [ext, type] of entries) {
      if (/^(audio|video)\//.test(type.contentType)) expect(type.text, ext).toBe(false);
    }
  });

  it("knows which types play inline", () => {
    expect(isPlayableMediaType("video/mp4")).toBe(true);
    expect(isPlayableMediaType("Audio/MPEG; charset=binary")).toBe(true);
    // Types the table doesn't name are not offered to the player.
    expect(isPlayableMediaType("video/x-matroska")).toBe(false);
    expect(isPlayableMediaType("video/mp2t")).toBe(false);
    expect(isPlayableMediaType("image/png")).toBe(false);
  });
});

describe("servedContentType", () => {
  it("serves the stored type when it says something", () => {
    expect(servedContentType("video/quicktime", "clip.mov")).toBe("video/quicktime");
    expect(servedContentType("text/markdown; charset=utf-8", "a.md")).toBe(
      "text/markdown; charset=utf-8",
    );
    // A name doesn't override a real type, even a wrong-looking one.
    expect(servedContentType("text/plain", "clip.mp4")).toBe("text/plain");
  });

  it("names media that was stored as octet-stream by its extension", () => {
    expect(servedContentType("application/octet-stream", "clips/demo.mp4")).toBe("video/mp4");
    expect(servedContentType("application/octet-stream", "talk.mp3")).toBe("audio/mpeg");
    expect(servedContentType("", "talk.webm")).toBe("video/webm");
  });

  it("leaves every other octet-stream file alone", () => {
    expect(servedContentType("application/octet-stream", "page.html")).toBe(
      "application/octet-stream",
    );
    expect(servedContentType("application/octet-stream", "photo.png")).toBe(
      "application/octet-stream",
    );
    expect(servedContentType("application/octet-stream", "movie.mkv")).toBe(
      "application/octet-stream",
    );
    expect(servedContentType("", "mystery")).toBe("application/octet-stream");
  });
});

describe("viewerKind", () => {
  it("shows every text file type as text, never as a download", () => {
    for (const [ext, type] of entries) {
      if (!type.text) continue;
      expect(viewerKind(type.contentType, `file.${ext}`), ext).not.toBe("binary");
      // The same file stored as octet-stream (an older CLI) is rescued by its extension.
      expect(viewerKind("application/octet-stream", `file.${ext}`), ext).not.toBe("binary");
    }
  });

  it("classifies the newly typed code and config files as text", () => {
    for (const path of ["config.yaml", "deploy.sh", "App.vue", "App.tsx", "data.xml"]) {
      expect(viewerKind(contentTypeFor(path), path), path).toBe("text");
    }
  });

  it("keeps the existing classifications", () => {
    expect(viewerKind("text/markdown")).toBe("markdown");
    expect(viewerKind("text/html")).toBe("html");
    expect(viewerKind("application/json")).toBe("text");
    expect(viewerKind("text/plain")).toBe("text");
    expect(viewerKind("image/svg+xml")).toBe("image");
    expect(viewerKind("application/pdf", "doc.pdf")).toBe("binary");
    expect(viewerKind("application/zip")).toBe("binary");
    expect(viewerKind("application/octet-stream", "mystery")).toBe("binary");
  });

  it("plays video and audio, by type or, failing that, by extension", () => {
    expect(viewerKind("video/mp4")).toBe("video");
    expect(viewerKind("video/quicktime", "clip.mov")).toBe("video");
    expect(viewerKind("video/webm")).toBe("video");
    expect(viewerKind("audio/mpeg")).toBe("audio");
    expect(viewerKind("audio/ogg", "voice.opus")).toBe("audio");
    // Synced before the table knew the extension.
    expect(viewerKind("application/octet-stream", "clips/demo.mp4")).toBe("video");
    expect(viewerKind("application/octet-stream", "talk.flac")).toBe("audio");
    // A browser's own name for the type, which the table doesn't use.
    expect(viewerKind("audio/x-m4a", "memo.m4a")).toBe("audio");
    expect(viewerKind("audio/x-wav", "take.wav")).toBe("audio");
    // A container the table doesn't name stays a download.
    expect(viewerKind("video/x-matroska", "film.mkv")).toBe("binary");
    // Every media extension in the table gets a player.
    for (const [ext, type] of entries) {
      const kind = viewerKind(type.contentType, `file.${ext}`);
      if (type.contentType.startsWith("video/")) expect(kind, ext).toBe("video");
      if (type.contentType.startsWith("audio/")) expect(kind, ext).toBe("audio");
    }
  });

  it("lets the extension rescue a browser's unhelpful guess", () => {
    // Chrome uploads .ts files as MPEG transport streams.
    expect(viewerKind("video/mp2t", "app.ts")).toBe("text");
    expect(viewerKind("application/x-yaml", "config.yaml")).toBe("text");
    // A type that already has a viewer is not second-guessed.
    expect(viewerKind("text/plain", "notes.md")).toBe("text");
  });
});

describe("markdown paths", () => {
  it("matches .md and .markdown, case-insensitively", () => {
    expect(isMarkdownPath("posts/a.md")).toBe(true);
    expect(isMarkdownPath("posts/B.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("posts/cover.png")).toBe(false);
    expect(isMarkdownPath("posts/notes.txt")).toBe(false);
  });

  it("strips the extension from a markdown name only", () => {
    expect(withoutMarkdownExtension("Launch plan.md")).toBe("Launch plan");
    expect(withoutMarkdownExtension("v1.2 notes.MARKDOWN")).toBe("v1.2 notes");
    expect(withoutMarkdownExtension("cover.png")).toBe("cover.png");
  });
});