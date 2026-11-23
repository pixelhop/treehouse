// PR feedback state for the babysit-pr skill. All state lives on the PR
// itself: every reply this skill posts carries a hidden marker, so a restarted
// or compacted agent sees exactly what is still unanswered. See ../SKILL.md.
//
//   node pr-feedback.mjs status [--pr N]
//   node pr-feedback.mjs wait   [--pr N] [--timeout 540] [--interval 60]
//   node pr-feedback.mjs reply  [--pr N] --thread <PRRT_id> --body-file <f> [--resolve]
//   node pr-feedback.mjs ack    [--pr N] --ids c123,r456 --body-file <f>

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- babysit-pr";
// Our marker only counts as the final line of a comment by the authenticated
// user, so a reviewer quoting it (or writing it mid-comment) can't hide feedback.
const OWN_MARKER = /<!-- babysit-pr(?: handled=([cr]\d+(?:,[cr]\d+)*))? -->\s*$/;
// Markers of bot-posted reports, not review feedback (CI summaries, previews).
// Only a bot's own report is skipped: a person quoting a marker is still talking.
const IGNORED_MARKERS = ["<!-- fallow-health-score -->"];

const COMMENT_FIELDS = "databaseId body url createdAt lastEditedAt author { login __typename }";
// Each connection is paginated separately; `gh api graphql --paginate` walks
// the one connection whose pageInfo is requested.
const QUERIES = {
  threads: `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
      number url state headRefOid reviewDecision
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated path line comments(last: 100) { nodes { ${COMMENT_FIELDS} } } }
      }
    } } }`,
  comments: `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
      comments(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    } } }`,
  reviews: `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
      reviews(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { state submittedAt ${COMMENT_FIELDS} }
      }
    } } }`,
};

const isBot = (c) => c.author?.__typename === "Bot";
const brief = (c) => ({ author: c.author?.login ?? "ghost", body: c.body, url: c.url });

/** Turn a raw PR snapshot into the feedback that still needs a response. */
export function classify(pr, checks = [], viewer = null) {
  const isOurs = (c) =>
    OWN_MARKER.test(c.body ?? "") && (viewer === null || c.author?.login === viewer);
  // When each review summary or top-level comment was last acknowledged.
  const handledAt = new Map();
  const everything = [
    ...pr.comments.nodes,
    ...pr.reviews.nodes,
    ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
  ];
  for (const c of everything.filter(isOurs)) {
    const ids = OWN_MARKER.exec(c.body)[1];
    for (const id of ids?.split(",") ?? []) {
      const at = c.createdAt ?? "";
      if (!handledAt.has(id) || at > handledAt.get(id)) handledAt.set(id, at);
    }
  }
  // Feedback edited after we answered it counts as new feedback.
  const editedSince = (c, answeredAt) => !!c.lastEditedAt && c.lastEditedAt > answeredAt;
  const isHandled = (c, id) => handledAt.has(id) && !editedSince(c, handledAt.get(id));

  // Inline threads, including bot reviewers: open until resolved, and
  // answered when our reply is the latest word.
  // A thread we replied to (and usually resolved) comes back if a reviewer
  // adds or edits a comment afterwards; resolving doesn't stop that.
  const threads = pr.reviewThreads.nodes
    .filter((t) => t.comments.nodes.length)
    .filter((t) => {
      const lastOurs = t.comments.nodes.findLast(isOurs);
      const repliedAt = lastOurs?.createdAt ?? "";
      const activityAfterReply =
        !!lastOurs &&
        t.comments.nodes.some(
          (c) => !isOurs(c) && ((c.createdAt ?? "") > repliedAt || editedSince(c, repliedAt)),
        );
      if (t.isResolved) return activityAfterReply;
      return !lastOurs || !isOurs(t.comments.nodes.at(-1)) || activityAfterReply;
    })
    .map((t) => ({
      kind: "thread",
      id: t.id,
      path: t.path,
      line: t.line,
      isOutdated: t.isOutdated,
      comments: t.comments.nodes.map(brief),
    }));

  // Review summaries (bot reviewers often put findings outside the diff there)
  // and top-level comments from people (bot comments are CI/preview reports)
  // that no `ack` has covered yet.
  const isReport = (c) => isBot(c) && IGNORED_MARKERS.some((m) => c.body.includes(m));
  const relevant = (c) => c.body?.trim() && !isOurs(c) && !isReport(c);
  const comments = pr.comments.nodes
    .filter((c) => relevant(c) && !isBot(c) && !isHandled(c, `c${c.databaseId}`))
    .map((c) => ({ kind: "comment", id: `c${c.databaseId}`, ...brief(c) }));
  const reviews = pr.reviews.nodes
    .filter((r) => relevant(r) && !isHandled(r, `r${r.databaseId}`))
    .map((r) => ({ kind: "review", id: `r${r.databaseId}`, state: r.state, ...brief(r) }));

  const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  const pending = checks.filter((c) => c.bucket === "pending");
  const feedback = [...threads, ...reviews, ...comments];

  let status = "idle";
  if (pr.state !== "OPEN") status = "closed";
  else if (feedback.length || failing.length) status = "actionable";
  else if (pending.length) status = "waiting";

  return {
    status,
    pr: {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headSha: pr.headRefOid,
      reviewDecision: pr.reviewDecision,
    },
    feedback,
    checks: {
      failing: failing.map((c) => ({ name: c.name, link: c.link })),
      pending: pending.map((c) => c.name),
      passed: checks.filter((c) => c.bucket === "pass").length,
    },
  };
}

/** Whether `wait` should hand control back to the agent. */
export function shouldWake(initial, current) {
  if (current.status === "closed") return true;
  if (current.feedback.length) return true;
  // Failures already reported on this head don't re-wake; new ones do.
  const known = new Set(initial.checks.failing.map((c) => `${initial.pr.headSha}:${c.name}`));
  return current.checks.failing.some((c) => !known.has(`${current.pr.headSha}:${c.name}`));
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--resolve") args.resolve = true;
    else if (flag.startsWith("--")) args[flag.slice(2)] = argv[++i];
    else args._.push(flag);
  }
  return args;
}

const gh = (...args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

function context(args) {
  const repo = gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
  const number = Number(args.pr || gh("pr", "view", "--json", "number", "-q", ".number"));
  const viewer = gh("api", "user", "-q", ".login");
  return { repo, number, viewer };
}

function paginate(query, { repo, number }, key) {
  const [owner, name] = repo.split("/");
  const pages = JSON.parse(
    gh(
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `pr=${number}`,
    ),
  ).map((page) => page.data.repository.pullRequest);
  return { first: pages[0], nodes: pages.flatMap((page) => page[key].nodes) };
}

function snapshot(ctx) {
  const threads = paginate(QUERIES.threads, ctx, "reviewThreads");
  const pr = {
    ...threads.first,
    reviewThreads: { nodes: threads.nodes },
    comments: { nodes: paginate(QUERIES.comments, ctx, "comments").nodes },
    reviews: { nodes: paginate(QUERIES.reviews, ctx, "reviews").nodes },
  };
  return classify(pr, fetchChecks(ctx.number), ctx.viewer);
}

/**
 * Reads `gh pr checks` output. It exits non-zero while checks are pending or
 * failing and when none are reported, so the exit code alone means little:
 * JSON on stdout is authoritative, "no checks reported" means an empty list,
 * and anything else (rate limits, network errors) is a failed lookup that
 * must not be mistaken for "no checks".
 */
export function parseChecks({ stdout = "", stderr = "", error } = {}) {
  if (error) throw new Error(`Could not run gh pr checks: ${error.message}`);
  if (stdout.trim()) {
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`gh pr checks returned unreadable output: ${stdout.trim().slice(0, 200)}`);
    }
  }
  if (/no checks reported/i.test(stderr)) return [];
  throw new Error(`gh pr checks failed: ${stderr.trim() || "no output"}`);
}

function fetchChecks(number, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = spawnSync("gh", ["pr", "checks", String(number), "--json", "name,bucket,link"], {
      encoding: "utf8",
    });
    try {
      return parseChecks(res);
    } catch (error) {
      if (attempt >= attempts) throw error;
      // Transient failures (rate limits, network) get a short pause and a retry.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000 * attempt);
    }
  }
}

const readBody = (file) => fs.readFileSync(file, "utf8").trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "status";
  const ctx = context(args);

  if (command === "status") {
    console.log(JSON.stringify(snapshot(ctx), null, 2));
  } else if (command === "wait") {
    const timeout = Number(args.timeout || 540) * 1000;
    const interval = Number(args.interval || 60) * 1000;
    const started = Date.now();
    const initial = snapshot(ctx);
    let current = initial;
    while (!shouldWake(initial, current) && Date.now() - started + interval < timeout) {
      await new Promise((r) => setTimeout(r, interval));
      current = snapshot(ctx);
    }
    const timedOut = !shouldWake(initial, current);
    console.log(JSON.stringify({ ...current, timedOut }, null, 2));
  } else if (command === "reply") {
    if (!args.thread || !args["body-file"]) throw new Error("reply needs --thread and --body-file");
    const body = `${readBody(args["body-file"])}\n\n${MARKER} -->`;
    gh(
      "api",
      "graphql",
      "-f",
      "query=mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } } }",
      "-f",
      `id=${args.thread}`,
      "-f",
      `body=${body}`,
    );
    if (args.resolve) {
      gh(
        "api",
        "graphql",
        "-f",
        "query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }",
        "-f",
        `id=${args.thread}`,
      );
    }
    console.log(JSON.stringify({ replied: args.thread, resolved: Boolean(args.resolve) }));
  } else if (command === "ack") {
    if (!args.ids || !args["body-file"]) throw new Error("ack needs --ids and --body-file");
    if (!/^[cr]\d+(,[cr]\d+)*$/.test(args.ids)) throw new Error("--ids must look like c123,r456");
    const body = `${readBody(args["body-file"])}\n\n${MARKER} handled=${args.ids} -->`;
    const url = gh("pr", "comment", String(ctx.number), "--body", body);
    console.log(JSON.stringify({ acknowledged: args.ids.split(","), url }));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}