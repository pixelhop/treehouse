/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const source = readFileSync(
  new URL("../app/components/CommentsPanel.vue", import.meta.url),
  "utf8",
);

describe("CommentsPanel session replay privacy", () => {
  it("blocks the complete comments subtree at its root", () => {
    const template = source.slice(source.indexOf("<template>"));
    const root = template.match(/<template>\s*(?:<!--[\s\S]*?-->\s*)*<([a-z][\w-]*)\b([^>]*)>/);

    expect(root?.[1]).toBe("div");
    expect(root?.[2]).toMatch(/class="[^"]*\bph-no-capture\b[^"]*"/);
  });
});