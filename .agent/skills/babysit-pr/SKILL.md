---
name: babysit-pr
description: Watch an open pull request and work through its feedback until none is left. Fixes valid review comments, replies with reasoning when it disagrees, answers questions, resolves addressed threads and fixes CI failures caused by the PR, then keeps polling until the PR is quiet. Use when asked to babysit, shepherd or watch a PR, or to address all PR comments and keep going.
---

# Babysit a PR

Loop over a PR's feedback until there is none left: inline review threads
(human, bot or `adversarial-review`), review summaries, top-level comments and
failing checks.

Every reply this skill posts ends with a hidden `<!-- babysit-pr -->` marker.
`scripts/pr-feedback.mjs` uses those markers to work out what is still
unanswered, so the state survives restarts and context compaction. A marker
only counts as the final line of a comment by the authenticated `gh` user, so
a reviewer quoting it can't hide feedback. Always
reply through the script, never with raw `gh`, or the marker is lost and the
item reappears.

## Ground rules

- **Judge every comment on its merits.** A reviewer, including another model,
  can be wrong. Fix what is right. Push back, with evidence (code, tests, docs),
  on what is wrong. Ask when a comment is ambiguous. Never make a change you
  believe is wrong just to clear a comment.
- **Stay in scope.** Fix what the feedback is about. Note larger follow-ups in
  your reply instead of growing the PR.
- **Never** force-push, rewrite published history, merge, approve, close the
  PR, dismiss reviews, or edit or delete other people's comments.
- **Resolve only threads you fixed.** Leave a thread open when you disagreed
  or asked a question; the reviewer or a human decides.
- Follow the repo's validation rules before every push (AGENTS.md): at least
  `vp check`, the relevant tests and `pnpm fallow:audit`.

## Loop

Run commands from the repository root. `S=.agent/skills/babysit-pr/scripts`.
Omit `--pr` to use the current branch's PR.

1. **Check out the PR branch** (`gh pr checkout <n>`) and make sure the
   working tree is clean and up to date with the remote branch.

2. **Get what needs attention:**

   ```bash
   node $S/pr-feedback.mjs status --pr <n>
   ```

   `status` is one of:
   - `actionable`: there is unanswered `feedback` and/or `checks.failing`.
   - `waiting`: nothing to answer, but checks are still running.
   - `idle`: nothing to answer and checks are settled.
   - `closed`: the PR was merged or closed; stop.

   Each `feedback` item is a `thread` (inline, with all of its `comments`), a
   `review` summary or a top-level `comment`. Review summaries matter: the
   adversarial review and bot reviewers such as CodeRabbit list findings they
   could not place inline there. If a summary has nothing actionable, `ack` it
   in your round reply. Top-level comments from bots are CI and preview
   reports, and are skipped.

3. **Triage the whole batch before editing.** Read each item and the code it
   points at. Decide one of:
   - **fix**: the comment is right, or right enough;
   - **disagree**: it's wrong, already handled, or out of scope. Explain why
     concretely;
   - **answer**: it's a question or a request for clarification.

   For `isOutdated` threads, check whether the code already changed in a way
   that addresses them.

4. **Fix and push once per round.** Make every fix, run validation, then
   commit with a message that names what was addressed and push (normal push
   only). Batching avoids a CI run for every comment. If a failing check is
   caused by the PR, fix it in the same round. If it isn't (a flaky test,
   infrastructure, or a failure that's also on the base branch), don't
   change code for it; mention it in your round summary.

5. **Reply to everything you handled**, after pushing so you can cite the
   commit. Write each reply to a temp file, then:

   ```bash
   # inline thread: fixed → reply and resolve
   node $S/pr-feedback.mjs reply --pr <n> --thread <thread id> --body-file /tmp/reply.md --resolve
   # inline thread: disagree or answer → reply, leave open
   node $S/pr-feedback.mjs reply --pr <n> --thread <thread id> --body-file /tmp/reply.md
   # review summaries and top-level comments: one consolidated reply per round
   node $S/pr-feedback.mjs ack --pr <n> --ids r123,c456 --body-file /tmp/round.md
   ```

   Keep replies short and specific: "Fixed in `abc1234`: the loop now stops at
   `length - 1`" or "Not changing this: `parse()` already rejects empty input
   at `src/x.ts:40`, covered by `x.test.ts`". For a review summary that lists
   several findings, address each one in the `ack` body.

6. **Wait for more activity:**

   ```bash
   node $S/pr-feedback.mjs wait --pr <n>
   ```

   This polls every minute and returns as soon as there is new feedback, a new
   check failure or the PR closes, or after nine minutes (`timedOut: true`).
   It stays under a ten-minute shell-command limit; run it in the foreground
   and loop. In Claude Code you can instead end the turn and re-enter with
   `/loop`. Then go back to step 2.

## When to stop

Stop and give a final report when any of these is true:

- `status` is `closed`.
- Two `wait` calls in a row time out as `idle`: no unanswered feedback, no
  pending checks, and about twenty minutes with nothing new.
- You've done 10 fix rounds. Hand back to the user rather than looping
  forever with a reviewer you keep disagreeing with.
- You are blocked on a human decision (an open disagreement you can't
  settle, or a question only the user can answer). Say exactly what is needed.

The final report lists what was fixed (with commits), what you disagreed
with and why, open questions, the state of the checks, and the PR URL.

## Pairing with adversarial review

The usual flow for agent-written work is: open the PR, run
`adversarial-review` (the other provider reviews it), then `babysit-pr`. Don't
re-run the adversarial review after every round. Run it again only if the
user asks or a round substantially rewrote the change.