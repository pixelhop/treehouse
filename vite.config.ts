import { defineConfig } from "vite-plus";
import vue from "@vitejs/plugin-vue";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "marketing-test-alias",
      resolveId(source, importer) {
        const plugin = /^~\/plugins\/([\w-]+\.client)$/.exec(source)?.[1];
        if (plugin && importer?.includes("/packages/marketing/")) {
          return new URL(`./packages/marketing/app/plugins/${plugin}.ts`, import.meta.url).pathname;
        }
        return null;
      },
    },
  ],
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    // Agent worktrees under `.claude/worktrees/` are gitignored checkouts of
    // this same repo, so the default glob discovers their test files too and
    // runs every suite N+1 times — against stale code, with a shared database.
    // They are not part of this checkout's test surface.
    //
    // .claude/skills and .agents/skills symlink to .agent/skills so Claude Code
    // and Codex both discover the skills; test the canonical copy only once.
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**", ".claude/**", ".agents/**"],
  },
});