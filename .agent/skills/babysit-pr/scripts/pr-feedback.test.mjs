import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { MARKER, classify, parseChecks, shouldWake } from "./pr-feedback.mjs";

const user = { login: "zef", __typename: "User" };
const bot = { login: "github-actions", __typename: "Bot" };
const comment = (databaseId, body, author = user) => ({
  databaseId,
  body,
  author,
  url: `u${databaseId}`,
});
const thread = (id, comments, extra = {}) => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: "a.ts",
  line: 3,
  comments: { nodes: comments },
  ...extra,
});

function pr({ threads = [], comments = [], reviews = [], state = "OPEN" } = {}) {
  return {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state,
    headRefOid: "sha1",
    reviewDecision: null,
    reviewThreads: { nodes: threads },
    comments: { nodes: comments },
    reviews: { nodes: reviews },
  };
}

test("an unresolved thread is open until our reply is the latest word", () => {
  const review = comment(1, "**[major] Off by one** <!-- adversarial-review -->");
  const reply = comment(2, `Fixed in abc123.\n\n${MARKER} -->`);
  const followUp = comment(3, "Still wrong for empty arrays.", {
    login: "copilot",
    __typename: "Bot",
  });

  assert.equal(classify(pr({ threads: [thread("T1", [review])] })).feedback.length, 1);
  assert.equal(classify(pr({ threads: [thread("T1", [review, reply])] })).status, "idle");
  const reopened = classify(pr({ threads: [thread("T1", [review, reply, followUp])] }));
  assert.equal(reopened.status, "actionable");
  assert.equal(reopened.feedback[0].comments.length, 3);
  assert.equal(
    classify(pr({ threads: [thread("T1", [review], { isResolved: true })] })).status,
    "idle",
  );
});

test("top-level comments and review summaries stay open until acknowledged", () => {
  const data = {
    comments: [
      comment(10, "Can you also update the README?"),
      comment(11, "### Fallow health\n<!-- fallow-health-score -->", bot),
      comment(12, "Deploy preview ready", bot),
    ],
    reviews: [
      { ...comment(20, "## Adversarial review\nFindings outside the diff…"), state: "COMMENTED" },
      { ...comment(21, ""), state: "COMMENTED" },
    ],
  };
  const open = classify(pr(data));
  assert.deepEqual(
    open.feedback.map((f) => f.id),
    ["r20", "c10"],
  );

  const ack = comment(30, `Updated the README in def456.\n\n${MARKER} handled=c10,r20 -->`);
  assert.equal(classify(pr({ ...data, comments: [...data.comments, ack] })).status, "idle");
});

test("reports check state and closed PRs", () => {
  const checks = [
    { name: "ci", bucket: "pass" },
    { name: "fallow", bucket: "pending" },
  ];
  assert.equal(classify(pr(), checks).status, "waiting");
  const failing = classify(pr(), [...checks, { name: "e2e", bucket: "fail", link: "l" }]);
  assert.equal(failing.status, "actionable");
  assert.deepEqual(failing.checks, {
    failing: [{ name: "e2e", link: "l" }],
    pending: ["fallow"],
    passed: 1,
  });
  assert.equal(classify(pr({ state: "MERGED" })).status, "closed");
});

test("wait wakes on new feedback or new failures, not on failures already reported", () => {
  const fail = [{ name: "e2e", bucket: "fail" }];
  const initial = classify(pr(), fail);
  assert.equal(shouldWake(initial, classify(pr(), fail)), false);
  assert.equal(
    shouldWake(initial, classify(pr(), [...fail, { name: "ci", bucket: "fail" }])),
    true,
  );
  const newHead = { ...pr(), headRefOid: "sha2" };
  assert.equal(shouldWake(initial, classify(newHead, fail)), true);
  assert.equal(shouldWake(initial, classify(pr({ comments: [comment(1, "?")] }))), true);
  assert.equal(shouldWake(initial, classify(pr({ state: "CLOSED" }))), true);
});
test("only trusts a trailing marker on the viewer's own comments", () => {
  // Reproduces an adversarial-review comment on PR #5 that quoted the marker
  // and so hid its own thread.
  const quoting = comment(1, `A reply that quotes \`${MARKER}\` mid-text is not ours.`);
  assert.equal(
    classify(pr({ threads: [thread("T1", [quoting])] }), [], "zef").status,
    "actionable",
  );

  const impostor = comment(2, `Looks fixed.\n\n${MARKER} -->`, {
    login: "mallory",
    __typename: "User",
  });
  assert.equal(
    classify(pr({ threads: [thread("T1", [impostor])] }), [], "zef").status,
    "actionable",
  );

  const fakeAck = comment(3, `ignore me ${MARKER} handled=c10 --> please`);
  const data = { comments: [comment(10, "Please add tests."), fakeAck] };
  assert.deepEqual(
    classify(pr(data), [], "zef").feedback.map((f) => f.id),
    ["c10", "c3"],
  );

  const reply = comment(4, `Fixed in abc.\n\n${MARKER} -->`);
  assert.equal(
    classify(pr({ threads: [thread("T1", [quoting, reply])] }), [], "zef").status,
    "idle",
  );
});

test("a person quoting a report marker is still feedback", () => {
  const quote = "The `<!-- fallow-health-score -->` lookup matches the wrong comment.";
  const open = classify(
    pr({
      comments: [comment(50, quote)],
      reviews: [{ ...comment(51, quote), state: "COMMENTED" }],
    }),
  );
  assert.equal(open.status, "actionable");
  assert.deepEqual(
    open.feedback.map((f) => f.id),
    ["r51", "c50"],
  );
});

test("keeps bot review summaries but not bot top-level reports", () => {
  const coderabbit = { login: "coderabbitai", __typename: "Bot" };
  const open = classify(
    pr({
      reviews: [
        { ...comment(40, "Outside diff range: fix `x.ts:12`", coderabbit), state: "COMMENTED" },
      ],
      comments: [comment(41, "Summary by CodeRabbit", coderabbit)],
    }),
  );
  assert.deepEqual(
    open.feedback.map((f) => f.id),
    ["r40"],
  );
});

test("tells a failed checks lookup apart from a PR with no checks", () => {
  const checks = [{ name: "ci", bucket: "pass", link: "l" }];
  assert.deepEqual(parseChecks({ stdout: JSON.stringify(checks), stderr: "" }), checks);
  // Pending or failing checks exit non-zero but still print JSON.
  assert.deepEqual(parseChecks({ stdout: "[]\n", stderr: "" }), []);
  assert.deepEqual(
    parseChecks({ stdout: "", stderr: "no checks reported on the 'feat' branch" }),
    [],
  );
  assert.throws(
    () => parseChecks({ stdout: "", stderr: "HTTP 403: API rate limit exceeded" }),
    /rate limit/,
  );
  assert.throws(() => parseChecks({ stdout: "", stderr: "" }), /no output/);
  assert.throws(() => parseChecks({ stdout: "<html>", stderr: "" }), /unreadable/);
  assert.throws(() => parseChecks({ error: new Error("spawn gh ENOENT") }), /ENOENT/);
});
test("feedback edited after we answered it needs attention again", () => {
  const at = (c, createdAt, lastEditedAt) => ({ ...c, createdAt, lastEditedAt });
  const review = at(comment(20, "## Review\n\n- one finding"), "2026-10-11T10:00:00Z");
  const ack = at(comment(21, `Fixed.\n\n${MARKER} handled=r20 -->`), "2026-10-11T11:00:00Z");
  const quiet = classify(pr({ reviews: [review], comments: [ack] }));
  assert.equal(quiet.status, "idle");

  const edited = { ...review, lastEditedAt: "2026-10-11T12:00:00Z" };
  assert.deepEqual(
    classify(pr({ reviews: [edited], comments: [ack] })).feedback.map((f) => f.id),
    ["r20"],
  );
  // An edit made before the acknowledgement was already answered.
  const editedEarlier = { ...review, lastEditedAt: "2026-10-11T10:30:00Z" };
  assert.equal(classify(pr({ reviews: [editedEarlier], comments: [ack] })).status, "idle");

  const topLevel = at(comment(30, "Please add tests."), "2026-10-11T10:00:00Z");
  const ackTop = at(comment(31, `Added.\n\n${MARKER} handled=c30 -->`), "2026-10-11T11:00:00Z");
  const editedTop = { ...topLevel, lastEditedAt: "2026-10-11T12:00:00Z" };
  assert.deepEqual(
    classify(pr({ comments: [editedTop, ackTop] })).feedback.map((f) => f.id),
    ["c30"],
  );

  const finding = at(comment(40, "**[minor] Typo**"), "2026-10-11T10:00:00Z");
  const reply = at(comment(41, `Fixed.\n\n${MARKER} -->`), "2026-10-11T11:00:00Z");
  assert.equal(classify(pr({ threads: [thread("T1", [finding, reply])] })).status, "idle");
  const editedFinding = { ...finding, lastEditedAt: "2026-10-11T12:00:00Z" };
  assert.equal(
    classify(pr({ threads: [thread("T1", [editedFinding, reply])] })).status,
    "actionable",
  );
});

test("a resolved thread comes back when its finding is edited after our reply", () => {
  const at = (c, createdAt, lastEditedAt) => ({ ...c, createdAt, lastEditedAt });
  const finding = at(comment(50, "**[major] Bug**"), "2026-10-11T10:00:00Z");
  const reply = at(comment(51, `Fixed in abc.\n\n${MARKER} -->`), "2026-10-11T11:00:00Z");
  const resolved = (nodes) => thread("T9", nodes, { isResolved: true });
  // The normal flow: we reply with --resolve and the thread goes quiet.
  assert.equal(classify(pr({ threads: [resolved([finding, reply])] })).status, "idle");
  // The reviewer then edits the finding to say the fix is incomplete.
  const edited = { ...finding, lastEditedAt: "2026-10-11T12:00:00Z" };
  assert.deepEqual(
    classify(pr({ threads: [resolved([edited, reply])] })).feedback.map((f) => f.id),
    ["T9"],
  );
  // A new comment on the resolved thread after our reply brings it back too.
  const followUp = at(comment(52, "Still broken for empty input."), "2026-10-11T12:30:00Z");
  assert.deepEqual(
    classify(pr({ threads: [resolved([finding, reply, followUp])] })).feedback.map((f) => f.id),
    ["T9"],
  );
  // Threads resolved by someone else without our reply stay quiet.
  assert.equal(classify(pr({ threads: [resolved([edited])] })).status, "idle");
});