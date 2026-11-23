/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

function maskedInterpolationCount(source: string, expression: string): number {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const maskedElement = new RegExp(
    `<[^>]+class="[^"]*\\bph-mask\\b[^"]*"[^>]*>\\s*{{\\s*${escaped}\\s*}}`,
    "g",
  );
  return [...source.matchAll(maskedElement)].length;
}

describe("PostHog DOM privacy chokepoints", () => {
  it("masks folder headings and listing names without masking the generic root fallback", () => {
    const source = read("../app/components/viewers/FolderView.vue");

    expect(maskedInterpolationCount(source, "name")).toBe(1);
    // Each row's name is rendered by FolderRowName.
    expect(
      maskedInterpolationCount(read("../app/components/viewers/FolderRowName.vue"), "node.name"),
    ).toBe(1);
    // Who last changed a row: member names are personal too.
    expect(maskedInterpolationCount(read("../app/components/viewers/FolderRow.vue"), "who")).toBe(
      1,
    );
    expect(source).toContain("<span v-else>Workspace</span>");
  });

  it("masks calendar titles, chips and user-specific notice fragments while leaving dates readable", () => {
    const source = read("../app/components/viewers/CalendarView.vue");

    expect(maskedInterpolationCount(source, "name")).toBe(1);
    expect(maskedInterpolationCount(source, "chipLabel(entry)")).toBe(3);
    expect(maskedInterpolationCount(source, "notice.label")).toBe(2);
    expect(maskedInterpolationCount(source, "notice.conflictCopyPath")).toBe(1);

    expect(maskedInterpolationCount(source, "label")).toBe(0);
    expect(maskedInterpolationCount(source, "dayHeading(day.date)")).toBe(0);
    expect(maskedInterpolationCount(source, "cell.day")).toBe(0);
    expect(source).toContain("{{ label }}</span>");
    expect(source).toContain("{{ dayHeading(day.date) }}");
    expect(source).toContain("{{ cell.day }}");
  });

  it("masks names and paths at dialogs, missing routes and desktop-folder surfaces", () => {
    const iconDialog = read("../app/components/NodeIconDialog.vue");
    const workspace = read("../app/components/WorkspaceView.vue");
    const localFolder = read("../app/components/LocalFolderSection.vue");

    expect(maskedInterpolationCount(iconDialog, "name")).toBe(1);
    expect(maskedInterpolationCount(workspace, "ws.selectedPath.value")).toBe(1);
    expect(maskedInterpolationCount(localFolder, "folder.folderName")).toBe(1);
    expect(maskedInterpolationCount(localFolder, "error")).toBe(1);
  });
});