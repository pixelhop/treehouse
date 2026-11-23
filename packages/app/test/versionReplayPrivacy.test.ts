/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const source = readFileSync(
  new URL("../app/components/FileInfoPanel.vue", import.meta.url),
  "utf8",
);

describe("historical-version replay privacy", () => {
  it("blocks both file-content sheets from session replay", () => {
    expect(source).toMatch(/ref="originalHost" class="ph-no-capture min-h-0 flex-1 overflow-auto/);

    const versionSheet = source.split("<!-- Version-view sheet -->")[1];
    expect(versionSheet).toContain('<div class="ph-no-capture min-h-0 flex-1 overflow-auto p-4">');
  });
});