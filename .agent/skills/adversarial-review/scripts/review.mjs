// Cross-provider adversarial PR review. Detects which provider wrote the PR,
// runs the *other* provider's CLI read-only against a disposable checkout of
// the PR head, and posts its findings as one GitHub review with inline
// comments. See ../SKILL.md.
//
//   node review.mjs --pr 12 [--reviewer codex|claude] [--model <id>]
//                   [--effort <level>] [--findings <file>] [--dry-run] [--force]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "<!-- adversarial-review";

const REVIEWERS = {
  codex: {
    provider: "openai",
    model: process.env.ADVERSARIAL_REVIEW_CODEX_MODEL || "gpt-6.1-sol",
    effort: process.env.ADVERSARIAL_REVIEW_CODEX_EFFORT || "high",
  },
  claude: {
    provider: "anthropic",
    model: process.env.ADVERSARIAL_REVIEW_CLAUDE_MODEL || "claude-opus-5-5",
    effort: process.env.ADVERSARIAL_REVIEW_CLAUDE_EFFORT || "high",
  },
};

// Attribution each agent leaves on commits and PR bodies by default. Matched
// case-insensitively: Codex writes `Co-authored-by`, Claude `Co-Authored-By`.
const AUTHOR_SIGNALS = {
  anthropic: [
    /noreply@anthropic\.com/i,
    /claude\.com\/claude-code/i,
    /generated with \[claude code\]/i,
    /logo=claude/i,
  ],
  openai: [/noreply@openai\.com/i, /generated with \[codex\]/i, /openai\.com\/codex/i],
};

/** Decide which provider authored a PR from its body and commit messages. */
export function detectAuthor({ body = "", commits = [] }) {
  const texts = [
    { source: "PR body", text: body },
    ...commits.map((c) => ({
      source: `commit ${c.oid.slice(0, 7)}`,
      text: `${c.messageHeadline}\n${c.messageBody}`,
    })),
  ];
  const evidence = { anthropic: [], openai: [] };
  for (const { source, text } of texts) {
    for (const [provider, patterns] of Object.entries(AUTHOR_SIGNALS)) {
      if (patterns.some((p) => p.test(text))) evidence[provider].push(source);
    }
  }
  const a = evidence.anthropic.length;
  const o = evidence.openai.length;
  const provider = a && !o ? "anthropic" : o && !a ? "openai" : a || o ? "mixed" : "unknown";
  return { provider, evidence };
}

/** The reviewer is always the provider that did not write the PR. */
export function pickReviewer(authorProvider) {
  if (authorProvider === "anthropic") return "codex";
  if (authorProvider === "openai") return "claude";
  return null;
}

/**
 * Map each file in a unified diff to the head-side lines GitHub accepts review
 * comments on (added and context lines), keyed to their hunk so multi-line
 * ranges can be checked for staying inside one hunk.
 */
export function parseDiff(diff) {
  const files = new Map();
  let current = null;
  let hunk = -1;
  let newLine = 0;
  // File headers only appear between `diff --git` and the first hunk. Inside a
  // hunk, `+++ x` is an added line that starts with "++" (e.g. `++count;`).
  let inHeader = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = null;
      inHeader = true;
      continue;
    }
    if (inHeader && raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      current = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (current && !files.has(current)) files.set(current, new Map());
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      hunk += 1;
      inHeader = false;
      continue;
    }
    if (!current || (inHeader && raw.startsWith("--- ")) || raw.startsWith("\\")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      files.get(current).set(newLine, hunk);
      newLine += 1;
    }
  }
  return files;
}

function anchor(finding, files) {
  const lines = files.get(finding.path);
  if (!lines?.has(finding.line)) return null;
  const start = finding.start_line;
  if (start == null || start === finding.line) return { line: finding.line };
  if (start < finding.line && lines.get(start) === lines.get(finding.line)) {
    return { start_line: start, line: finding.line };
  }
  return { line: finding.line };
}

const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"];

function findingText(f, { withSuggestion }) {
  const parts = [`**[${f.severity}] ${f.title}**`, "", f.body];
  if (withSuggestion && f.suggestion != null) {
    parts.push("", "```suggestion", f.suggestion.replace(/\n$/, ""), "```");
  }
  return parts.join("\n");
}

/** Build the REST payload for one COMMENT review from reviewer output. */
export function buildReview({ result, diff, headSha, reviewer, model, author }) {
  const files = parseDiff(diff);
  const findings = [...result.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const comments = [];
  const unanchored = [];
  for (const f of findings) {
    const position = anchor(f, files);
    if (!position) {
      unanchored.push(f);
      continue;
    }
    // A suggestion must replace exactly the anchored range.
    const exact = (position.start_line ?? position.line) === (f.start_line ?? f.line);
    comments.push({
      path: f.path,
      ...(position.start_line ? { start_line: position.start_line, start_side: "RIGHT" } : {}),
      line: position.line,
      side: "RIGHT",
      body: findingText(f, { withSuggestion: exact }),
    });
  }
  const counts = SEVERITY_ORDER.map(
    (s) => `${findings.filter((f) => f.severity === s).length} ${s}`,
  ).join(" · ");
  const authorLabel =
    author === "anthropic" ? "Anthropic" : author === "openai" ? "OpenAI" : author;
  const body = [
    `## Adversarial review: \`${model}\` (${reviewer})`,
    "",
    `Cross-provider review of work authored by ${authorLabel}. Verdict: **${result.verdict.replace("_", " ")}** · ${counts}`,
    "",
    result.summary,
    ...(unanchored.length
      ? [
          "",
          "### Findings outside the diff",
          "",
          ...unanchored.map(
            (f) => `- \`${f.path}:${f.line}\` ${findingText(f, { withSuggestion: false })}`,
          ),
        ]
      : []),
    "",
    `${MARKER} reviewer=${reviewer} model=${model} head=${headSha} -->`,
  ].join("\n");
  return { commit_id: headSha, event: "COMMENT", body, comments };
}

/**
 * Saved findings are only valid for the exact PR head they reviewed: line
 * numbers and suggestions point at that commit's code.
 */
export function checkSavedFindings(saved, { repo, number, headSha }) {
  if (saved?.repo !== repo || Number(saved?.pr) !== Number(number)) {
    throw new Error(`Saved findings are for ${saved?.repo}#${saved?.pr}, not ${repo}#${number}`);
  }
  if (saved.headSha !== headSha) {
    throw new Error(
      `Saved findings reviewed ${saved.headSha}, but the PR head is now ${headSha}. ` +
        "Run a fresh review instead of posting stale findings.",
    );
  }
  return saved;
}

/**
 * Findings and their line anchors belong to the commit that was reviewed.
 * Refuse to post them once the PR head has moved on.
 */
export function assertHeadUnchanged({ reviewedSha, currentSha, findingsPath }) {
  if (currentSha !== reviewedSha) {
    throw new Error(
      `The PR head moved from ${reviewedSha} to ${currentSha} while the review ran, so its ` +
        `line anchors no longer match. Findings for the reviewed commit are in ${findingsPath}. ` +
        "Run the review again for the new head.",
    );
  }
}

/**
 * `git diff` arguments for the reviewed commit, pinning every setting the
 * line parser depends on so user Git config can't change the output.
 */
export function reviewedDiffArgs(mergeBase, headSha) {
  return [
    "-c",
    "diff.suppressBlankEmpty=false",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    mergeBase,
    headSha,
  ];
}

export function validateResult(result) {
  const ok =
    result &&
    typeof result.summary === "string" &&
    ["approve", "comment", "request_changes"].includes(result.verdict) &&
    Array.isArray(result.findings) &&
    result.findings.every(
      (f) =>
        typeof f.path === "string" &&
        Number.isInteger(f.line) &&
        (f.start_line == null || Number.isInteger(f.start_line)) &&
        SEVERITY_ORDER.includes(f.severity) &&
        typeof f.title === "string" &&
        typeof f.body === "string",
    );
  if (!ok) throw new Error("Reviewer output does not match review-schema.json");
  return result;
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--force") args.force = true;
    else if (flag.startsWith("--")) args[flag.slice(2)] = argv[++i];
  }
  return args;
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const gh = (...args) => run("gh", args);

function renderPrompt(vars) {
  const template = fs.readFileSync(path.join(SCRIPT_DIR, "reviewer-prompt.md"), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ""));
}

/** Directories the Codex binary needs to start: each symlink hop and its install root. */
export function codexInstallPaths(env = process.env, home = os.homedir()) {
  const paths = new Set();
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    let hop = path.join(dir, "codex");
    if (!fs.existsSync(hop)) continue;
    for (let i = 0; i < 10; i++) {
      paths.add(path.dirname(hop));
      if (!fs.lstatSync(hop).isSymbolicLink()) break;
      hop = path.resolve(path.dirname(hop), fs.readlinkSync(hop));
    }
    paths.add(path.dirname(path.dirname(fs.realpathSync(path.join(dir, "codex")))));
    break;
  }
  // The standalone installer links through ~/.codex/packages/.../current.
  const packages = path.join(home, ".codex", "packages");
  if (fs.existsSync(packages)) paths.add(packages);
  // Never re-allow the home directory or anything above it (e.g. for
  // ~/bin/codex, whose "install root" would be the home directory itself).
  const homes = [home, fs.existsSync(home) ? fs.realpathSync(home) : home];
  return [...paths].filter((p) => homes.every((h) => p !== h && !h.startsWith(p + path.sep)));
}

/**
 * Permission profile for the Codex reviewer, which reads untrusted PR content.
 * Reads are denied by default: only the platform's minimal runtime paths, the
 * review directory (checkout and saved context) and Codex's own install are
 * readable. `:minimal` includes the temp directories, so Codex runs with
 * TMPDIR inside the review directory and /tmp is denied. No writes, no
 * network.
 */
export function codexReadRules({
  reviewDir,
  home = os.homedir(),
  installPaths = codexInstallPaths(),
}) {
  const rules = new Map([
    [":root", "deny"],
    [":minimal", "read"],
    ["/tmp", "deny"],
    ["/private/tmp", "deny"],
    [home, "deny"],
  ]);
  for (const dir of [reviewDir, fs.realpathSync(reviewDir), ...installPaths]) {
    if (!rules.has(dir)) rules.set(dir, "read");
  }
  return [...rules].map(([p, access]) => `${JSON.stringify(p)}=${JSON.stringify(access)}`);
}

/**
 * Codex runs without the user's config (and so no MCP servers), with
 * connected apps, plugins, hooks, browsers and web search disabled, under the
 * read profile above. Commands it runs in the checkout see only Codex's core
 * environment (home, path, shell, user and temp directories), so nothing the
 * caller exported, such as a database URL, can be printed by PR code.
 */
export function codexIsolationArgs(profile) {
  return [
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "hooks",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "computer_use",
    "-c",
    'web_search="disabled"',
    "-c",
    `permissions.review.filesystem={${codexReadRules(profile).join(",")}}`,
    "-c",
    "permissions.review.network={enabled=false}",
    "-c",
    'default_permissions="review"',
    "-c",
    'shell_environment_policy.inherit="core"',
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
  ];
}

// What the Codex CLI itself needs: to run, to find its auth (in CODEX_HOME,
// or an API key), and to reach the API through a proxy or custom CA.
const CODEX_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * Environment for the Codex process: an allowlist, not the caller's whole
 * environment. Defence in depth under the shell policy above, which already
 * keeps even these variables away from the commands Codex runs.
 */
export function codexEnv(env, tmpdir) {
  const out = Object.fromEntries(
    Object.entries(env).filter(([k]) => CODEX_ENV.has(k) || k.startsWith("LC_")),
  );
  return { ...out, TMPDIR: tmpdir };
}

/**
 * Claude gets read-only file tools scoped to the review directory (the
 * checkout and the saved diff), and no shell: even git subcommands can write
 * files (`git diff --output=...`).
 */
export function claudeToolArgs(dirs) {
  const roots = [...new Set(dirs.flatMap((dir) => [dir, fs.realpathSync(dir)]))];
  const rules = roots.flatMap((root) =>
    ["Read", "Grep", "Glob"].map((tool) => `${tool}(/${root}/**)`),
  );
  return ["--tools", "Read,Grep,Glob", "--allowedTools", rules.join(" ")];
}

function reviewerTmp(outDir) {
  const dir = path.join(outDir, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCodex({ cwd, prompt, model, effort, outDir }) {
  const out = path.join(outDir, "reviewer-output.json");
  const log = fs.openSync(path.join(outDir, "reviewer.log"), "w");
  // Stdin must be closed: `codex exec` otherwise appends piped stdin to the prompt.
  const res = spawnSync(
    "codex",
    [
      "exec",
      ...codexIsolationArgs({ reviewDir: outDir }),
      "-m",
      model,
      "-c",
      `model_reasoning_effort=${effort}`,
      "--skip-git-repo-check",
      "--ephemeral",
      "-C",
      cwd,
      "--output-schema",
      path.join(SCRIPT_DIR, "review-schema.json"),
      "-o",
      out,
      prompt,
    ],
    // `:minimal` grants the temp directory; point it inside the review directory.
    { stdio: ["ignore", log, log], env: codexEnv(process.env, reviewerTmp(outDir)) },
  );
  if (res.status !== 0) throw new Error(`codex exec failed; see ${outDir}/reviewer.log`);
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

function runClaude({ cwd, prompt, model, effort, outDir }) {
  const schema = fs.readFileSync(path.join(SCRIPT_DIR, "review-schema.json"), "utf8");
  const res = spawnSync(
    "claude",
    [
      "-p",
      "--model",
      model,
      "--effort",
      effort,
      "--output-format",
      "json",
      "--json-schema",
      schema,
      // The checkout is untrusted PR code. Safe mode skips its hooks, MCP
      // servers, plugins, skills and CLAUDE.md; only user settings load.
      "--safe-mode",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      // Read-only: only these tools exist, and anything not pre-allowed is denied.
      "--permission-mode",
      "dontAsk",
      ...claudeToolArgs([outDir]),
      "--max-turns",
      "80",
      "--no-session-persistence",
      prompt,
    ],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  fs.writeFileSync(path.join(outDir, "reviewer.log"), `${res.stderr}\n${res.stdout}`);
  if (res.status !== 0) throw new Error(`claude -p failed; see ${outDir}/reviewer.log`);
  const output = JSON.parse(res.stdout);
  if (output.is_error || !output.structured_output) {
    throw new Error(`claude -p returned no structured output; see ${outDir}/reviewer.log`);
  }
  return output.structured_output;
}

function postReview(repo, number, payload) {
  const post = (body) =>
    spawnSync(
      "gh",
      ["api", "-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"],
      {
        input: JSON.stringify(body),
        encoding: "utf8",
      },
    );
  let res = post(payload);
  if (res.status !== 0 && payload.comments.length) {
    // One unplaceable comment fails the whole request (HTTP 422). Fall back to
    // listing every finding in the review body rather than losing them.
    const fallback = payload.comments
      .map((c) => `- \`${c.path}:${c.line}\` ${c.body.replace(/```suggestion[\s\S]*?```/g, "")}`)
      .join("\n");
    const body = payload.body.replace(
      MARKER,
      `### Inline findings (could not be anchored)\n\n${fallback}\n\n${MARKER}`,
    );
    res = post({ ...payload, body, comments: [] });
  }
  if (res.status !== 0) throw new Error(`Posting the review failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
  const number = args.pr || gh("pr", "view", "--json", "number", "-q", ".number");
  const pr = JSON.parse(
    gh(
      "pr",
      "view",
      String(number),
      "--json",
      "number,title,body,url,state,baseRefName,headRefOid,commits",
    ),
  );
  if (pr.state !== "OPEN") throw new Error(`PR #${number} is ${pr.state}`);

  const saved = args.findings
    ? checkSavedFindings(JSON.parse(fs.readFileSync(args.findings, "utf8")), {
        repo,
        number,
        headSha: pr.headRefOid,
      })
    : null;
  const author = detectAuthor(pr);
  const reviewer = saved?.reviewer || args.reviewer || pickReviewer(author.provider);
  if (!REVIEWERS[reviewer]) {
    throw new Error(
      `Could not tell which provider wrote PR #${number} (${author.provider}). ` +
        "Pass --reviewer codex (for Anthropic-authored work) or --reviewer claude (for OpenAI-authored work).",
    );
  }
  const { model: defaultModel, effort: defaultEffort } = REVIEWERS[reviewer];
  const model = saved?.model || args.model || defaultModel;
  const effort = args.effort || defaultEffort;
  const authorProvider =
    author.provider === "anthropic" || author.provider === "openai"
      ? author.provider
      : REVIEWERS[reviewer].provider === "openai"
        ? "anthropic"
        : "openai";

  if (!args.force && !args.dryRun) {
    const existing = JSON.parse(
      gh("api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/reviews`),
    ).flat();
    const dup = existing.find(
      (r) =>
        r.body?.includes(MARKER) &&
        r.body.includes(`reviewer=${reviewer}`) &&
        r.body.includes(`head=${pr.headRefOid}`),
    );
    if (dup) {
      console.log(JSON.stringify({ skipped: "already reviewed this head", url: dup.html_url }));
      return;
    }
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `adversarial-review-${number}-`));
  run("git", ["fetch", "--quiet", "origin", pr.baseRefName, `pull/${number}/head`]);
  const mergeBase = run("git", ["merge-base", `origin/${pr.baseRefName}`, pr.headRefOid]);
  // Anchor against the reviewed commit's diff, not whatever the PR head is now.
  const diff = run("git", reviewedDiffArgs(mergeBase, pr.headRefOid));
  let result;
  if (saved) {
    result = saved.result;
  } else {
    const worktree = path.join(outDir, "checkout");
    run("git", ["worktree", "add", "--quiet", "--detach", worktree, pr.headRefOid]);
    try {
      // The diff and log are saved up front, so a reviewer without a shell
      // (Claude) can read them as files.
      const contextDir = path.join(outDir, "context");
      fs.mkdirSync(contextDir);
      fs.writeFileSync(path.join(contextDir, "diff.patch"), diff);
      fs.writeFileSync(
        path.join(contextDir, "diff-stat.txt"),
        run("git", [...reviewedDiffArgs(mergeBase, pr.headRefOid), "--stat"]),
      );
      fs.writeFileSync(
        path.join(contextDir, "log.txt"),
        run("git", ["log", "--format=%h %s%n%b", `${mergeBase}..${pr.headRefOid}`]),
      );
      const prompt = renderPrompt({
        number,
        repo,
        title: pr.title,
        body: pr.body || "(empty)",
        headSha: pr.headRefOid,
        baseRef: pr.baseRefName,
        mergeBase,
        contextDir,
      });
      const runner = reviewer === "codex" ? runCodex : runClaude;
      console.error(`Reviewing PR #${number} with ${reviewer} (${model}, effort ${effort})…`);
      result = runner({ cwd: worktree, prompt, model, effort, outDir });
    } finally {
      run("git", ["worktree", "remove", "--force", worktree]);
    }
  }
  validateResult(result);
  fs.writeFileSync(
    path.join(outDir, "findings.json"),
    JSON.stringify({ repo, pr: Number(number), headSha: pr.headRefOid, reviewer, model, result }),
  );

  const payload = buildReview({
    result,
    diff,
    headSha: pr.headRefOid,
    reviewer,
    model,
    author: authorProvider,
  });
  fs.writeFileSync(path.join(outDir, "review-payload.json"), JSON.stringify(payload, null, 2));

  const summary = {
    pr: pr.url,
    author: author.provider,
    authorEvidence: author.evidence,
    reviewer,
    model,
    verdict: result.verdict,
    findings: result.findings.length,
    inline: payload.comments.length,
    artifacts: outDir,
  };
  if (args.dryRun) {
    console.log(JSON.stringify({ ...summary, dryRun: true, payload }, null, 2));
    return;
  }
  assertHeadUnchanged({
    reviewedSha: pr.headRefOid,
    currentSha: gh("pr", "view", String(number), "--json", "headRefOid", "-q", ".headRefOid"),
    findingsPath: path.join(outDir, "findings.json"),
  });
  const review = postReview(repo, number, payload);
  console.log(JSON.stringify({ ...summary, url: review.html_url }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}