import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import {
  buildReview,
  codexEnv,
  codexInstallPaths,
  codexIsolationArgs,
  codexReadRules,
  claudeToolArgs,
  assertHeadUnchanged,
  checkSavedFindings,
  detectAuthor,
  parseDiff,
  pickReviewer,
  reviewedDiffArgs,
  validateResult,
} from "./review.mjs";

const commit = (messageBody, oid = "abcdef1234") => ({
  oid,
  messageHeadline: "feat: x",
  messageBody,
});

test("detects Claude Code work from its trailer, footer or badge", () => {
  for (const text of [
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    "![Claude Code](https://img.shields.io/badge/Opus-x?logo=claude)",
  ]) {
    assert.equal(detectAuthor({ body: text, commits: [] }).provider, "anthropic");
  }
  assert.equal(pickReviewer("anthropic"), "codex");
});

test("detects Codex work case-insensitively", () => {
  const result = detectAuthor({
    body: "",
    commits: [commit("co-authored-by: Codex <noreply@openai.com>")],
  });
  assert.equal(result.provider, "openai");
  assert.deepEqual(result.evidence.openai, ["commit abcdef1"]);
  assert.equal(pickReviewer("openai"), "claude");
});

test("refuses to guess for mixed or unattributed work", () => {
  const mixed = detectAuthor({
    body: "Generated with [Codex](https://openai.com/codex/).",
    commits: [commit("Co-Authored-By: Claude <noreply@anthropic.com>")],
  });
  assert.equal(mixed.provider, "mixed");
  assert.equal(detectAuthor({ body: "Fix typo", commits: [commit("")] }).provider, "unknown");
  assert.equal(pickReviewer("mixed"), null);
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
@@ -20,2 +21,2 @@ function later() {
 keep();
+added();
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone();
`;

test("maps head-side diff lines to hunks and skips deleted files", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual([...files.keys()], ["src/a.ts"]);
  const a = files.get("src/a.ts");
  assert.deepEqual([...a.keys()], [1, 2, 3, 4, 21, 22]);
  assert.equal(a.get(1), a.get(4));
  assert.notEqual(a.get(4), a.get(21));
});

const finding = (overrides) => ({
  path: "src/a.ts",
  line: 2,
  start_line: null,
  severity: "major",
  title: "Wrong constant",
  body: "b must stay 2 because callers divide by it.",
  suggestion: null,
  ...overrides,
});

function review(findings) {
  return buildReview({
    result: validateResult({ summary: "Changes constants.", verdict: "request_changes", findings }),
    diff: DIFF,
    headSha: "deadbeef",
    reviewer: "codex",
    model: "gpt-6.1-sol",
    author: "anthropic",
  });
}

test("anchors findings inside the diff and lists the rest in the body", () => {
  const payload = review([
    finding({ suggestion: "const b = 2;" }),
    finding({ line: 99, severity: "minor", title: "Outside" }),
    finding({ path: "src/other.ts", severity: "blocker", title: "Unchanged file" }),
  ]);
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.commit_id, "deadbeef");
  assert.equal(payload.comments.length, 1);
  assert.deepEqual(
    {
      path: payload.comments[0].path,
      line: payload.comments[0].line,
      side: payload.comments[0].side,
    },
    { path: "src/a.ts", line: 2, side: "RIGHT" },
  );
  assert.match(payload.comments[0].body, /```suggestion\nconst b = 2;\n```/);
  assert.match(payload.body, /Findings outside the diff/);
  assert.match(payload.body, /`src\/other\.ts:2` \*\*\[blocker\] Unchanged file/);
  assert.match(payload.body, /`src\/a\.ts:99`/);
  assert.match(payload.body, /request changes/);
  assert.match(
    payload.body,
    /<!-- adversarial-review reviewer=codex model=gpt-6\.1-sol head=deadbeef -->/,
  );
  // Most severe out-of-diff finding first.
  assert.ok(payload.body.indexOf("Unchanged file") < payload.body.indexOf("Outside"));
});

test("keeps multi-line ranges within one hunk and drops suggestions that no longer fit", () => {
  const [inHunk] = review([finding({ start_line: 1, line: 3 })]).comments;
  assert.equal(inHunk.start_line, 1);
  assert.equal(inHunk.line, 3);

  const [crossHunk] = review([finding({ start_line: 3, line: 21, suggestion: "x" })]).comments;
  assert.equal(crossHunk.start_line, undefined);
  assert.equal(crossHunk.line, 21);
  assert.doesNotMatch(crossHunk.body, /suggestion/);
});

test("rejects malformed reviewer output", () => {
  assert.throws(() => validateResult({ summary: "x", verdict: "lgtm", findings: [] }), /schema/);
  assert.throws(
    () => validateResult({ summary: "x", verdict: "comment", findings: [finding({ line: "2" })] }),
    /schema/,
  );
});
test("only re-posts saved findings for the exact PR head they reviewed", () => {
  const saved = { repo: "o/r", pr: 5, headSha: "aaa", reviewer: "codex", model: "m", result: {} };
  assert.equal(checkSavedFindings(saved, { repo: "o/r", number: "5", headSha: "aaa" }), saved);
  assert.throws(
    () => checkSavedFindings(saved, { repo: "o/r", number: 5, headSha: "bbb" }),
    /reviewed aaa, but the PR head is now bbb/,
  );
  assert.throws(
    () => checkSavedFindings(saved, { repo: "o/r", number: 6, headSha: "aaa" }),
    /not o\/r#6/,
  );
  // Raw reviewer output from before findings carried their commit is rejected too.
  assert.throws(() =>
    checkSavedFindings({ summary: "x" }, { repo: "o/r", number: 5, headSha: "aaa" }),
  );
});

test("assertHeadUnchanged refuses to post once the PR head has moved", () => {
  const findingsPath = "/tmp/x/findings.json";
  assert.doesNotThrow(() =>
    assertHeadUnchanged({ reviewedSha: "aaa", currentSha: "aaa", findingsPath }),
  );
  assert.throws(
    () => assertHeadUnchanged({ reviewedSha: "aaa", currentSha: "bbb", findingsPath }),
    /moved from aaa to bbb[\s\S]*\/tmp\/x\/findings\.json/,
  );
});

test("reviewedDiffArgs pins the git settings the line parser depends on", () => {
  const args = reviewedDiffArgs("base", "head");
  for (const setting of [
    "diff.suppressBlankEmpty=false",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
  ]) {
    assert.equal(args[args.indexOf(setting) - 1], "-c");
  }
  assert.deepEqual(args.slice(-2), ["base", "head"]);
});

test("the Codex reviewer runs without integrations, writes, network or broad reads", () => {
  const reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-scope-"));
  const args = codexIsolationArgs({
    reviewDir,
    home: "/Users/zef",
    installPaths: ["/Users/zef/.local/bin", "/opt/homebrew/bin"],
  });
  assert.ok(args.includes("--ignore-user-config"));
  for (const feature of ["apps", "plugins", "hooks", "browser_use", "computer_use"]) {
    assert.equal(args[args.indexOf(feature) - 1], "--disable");
  }
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('default_permissions="review"'));
  assert.ok(args.includes("permissions.review.network={enabled=false}"));
  assert.ok(args.includes('shell_environment_policy.inherit="core"'));
  const rules = codexReadRules({
    reviewDir,
    home: "/Users/zef",
    installPaths: ["/Users/zef/.local/bin", "/opt/homebrew/bin"],
  });
  assert.deepEqual(rules.slice(0, 5), [
    '":root"="deny"',
    '":minimal"="read"',
    '"/tmp"="deny"',
    '"/private/tmp"="deny"',
    '"/Users/zef"="deny"',
  ]);
  assert.ok(rules.includes(`${JSON.stringify(fs.realpathSync(reviewDir))}="read"`));
  assert.ok(rules.includes('"/Users/zef/.local/bin"="read"'));
  // Every path appears once, so the TOML inline table never has duplicate keys.
  const keys = rules.map((r) => r.slice(0, r.lastIndexOf("=")));
  assert.equal(new Set(keys).size, keys.length);
});

test("the Codex process gets an allowlisted environment, not the caller's", () => {
  const env = codexEnv(
    {
      HOME: "/Users/zef",
      PATH: "/usr/bin",
      LC_ALL: "en_GB.UTF-8",
      OPENAI_API_KEY: "sk-test",
      DATABASE_URL: "postgres://user:pass@db/app",
      PGPASSWORD: "pass",
      AWS_SECRET_ACCESS_KEY: "aws",
      TMPDIR: "/tmp/outer",
    },
    "/review/tmp",
  );
  assert.deepEqual(env, {
    HOME: "/Users/zef",
    PATH: "/usr/bin",
    LC_ALL: "en_GB.UTF-8",
    OPENAI_API_KEY: "sk-test",
    TMPDIR: "/review/tmp",
  });
});

test("codexInstallPaths never re-allows the home directory or its parents", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin", "codex"), "");
  const paths = codexInstallPaths({ PATH: path.join(home, "bin") }, home);
  assert.deepEqual(paths, [path.join(home, "bin")]);
});

test("the Claude reviewer gets scoped read-only file tools and no shell", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-scope-"));
  const args = claudeToolArgs([dir]);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  const rules = args[args.indexOf("--allowedTools") + 1].split(" ");
  assert.ok(rules.every((rule) => /^(Read|Grep|Glob)\(\/\/.+\/\*\*\)$/.test(rule)));
  assert.ok(rules.includes(`Read(/${fs.realpathSync(dir)}/**)`));
  assert.ok(!args.join(" ").includes("Bash"));
});

test("parseDiff treats added lines starting with ++ or -- as content, not headers", () => {
  const diff = [
    "diff --git a/src/count.js b/src/count.js",
    "--- a/src/count.js",
    "+++ b/src/count.js",
    "@@ -1,2 +1,4 @@",
    " let count = 0;",
    "+++ count;",
    "+-- count;",
    " export default count;",
  ].join("\n");
  const files = parseDiff(diff);
  assert.deepEqual([...files.keys()], ["src/count.js"]);
  assert.deepEqual([...files.get("src/count.js").keys()], [1, 2, 3, 4]);
});

test("reviewedDiffArgs disables textconv drivers", () => {
  assert.ok(reviewedDiffArgs("base", "head").includes("--no-textconv"));
});