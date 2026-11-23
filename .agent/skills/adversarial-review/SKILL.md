---
name: adversarial-review
description: Get a cross-provider adversarial review of a pull request. Detects which provider's model wrote the PR (Anthropic/Claude Code or OpenAI/Codex) and runs the OTHER provider's local CLI read-only to review it, posting findings as inline GitHub PR review comments. Use after opening a PR, or when asked for an adversarial, second-opinion or cross-model review of a PR.
---

# Adversarial review

A model is a poor judge of its own work. This skill has a PR reviewed by a
model from a **different provider** than the one that wrote it, and posts the
findings to the PR so they can be handled with the `babysit-pr` skill.

| PR written by                      | Reviewed by                                 |
| ---------------------------------- | ------------------------------------------- |
| Anthropic (Claude Code, e.g. Opus) | local `codex` CLI, `gpt-6.1-sol`, high      |
| OpenAI (Codex, e.g. GPT)           | local `claude` CLI, `claude-opus-5-5`, high |

## Requirements

- `gh` authenticated with write access to the repository.
- The reviewer's CLI installed and logged in: `codex` (OpenAI) or `claude`
  (Anthropic). Only the reviewer's CLI is needed, not both.
- The PR is open and its head is pushed.

## Steps

1. **Find the PR.** Use the number the user gave, otherwise the PR for the
   current branch (`gh pr view --json number,url`). If there is no PR, stop and
   say so; do not open one.

2. **Run the review** from the repository root:

   ```bash
   node .agent/skills/adversarial-review/scripts/review.mjs --pr <number>
   ```

   It takes several minutes. Run it as a background command if your harness
   supports that, or with a timeout of at least 20 minutes. It does this:
   - Detects the authoring provider from commit trailers and the PR body
     (`noreply@anthropic.com`, "Generated with Claude Code" →
     Anthropic; `noreply@openai.com`, "Generated with Codex" → OpenAI) and
     picks the other provider as reviewer.
   - Checks out the PR head in a temporary git worktree, so your working tree
     is untouched, and runs the reviewer CLI there read-only with
     `scripts/reviewer-prompt.md` and the `scripts/review-schema.json` output
     schema. The checkout is untrusted PR code, so the reviewer gets no tool
     that acts outside it. The diff, stat and commit log are saved next to
     the checkout for it to read.
     - Codex runs without the user's config (so no MCP servers), with apps,
       plugins, hooks, browser and computer use, and web search disabled. A
       permission profile allows no writes and no network, and denies reads
       by default: only the platform's minimal runtime paths, the review
       directory and Codex's own install are readable. Codex's temp directory
       points inside the review directory and `/tmp` is denied. Its `git`
       commands can't reach the repository's `.git`, which is why the diff is
       saved. The Codex process gets an allowlisted environment (what the CLI
       needs to run and authenticate), and the commands it runs see only the
       core variables (home, path, shell, user, temp), so nothing you
       exported, such as a database URL, can be printed by PR code.
     - Claude runs with `--safe-mode`, user settings only and no MCP servers,
       so hooks, MCP servers or plugins added by the PR never execute. It has
       no shell, only `Read`, `Grep` and `Glob`, scoped to the review
       directory.
   - Posts **one** `COMMENT` review pinned to the head commit. It puts findings
     on diff lines as inline comments and lists the rest in the review body.
     The review body carries the verdict and a hidden marker. GitHub won't
     let you approve or request changes on your own PR, so the verdict is text.
   - Skips the run if this reviewer has already reviewed this head commit
     (`--force` overrides).

3. **If authorship can't be detected** (`unknown` or `mixed`), pass the
   reviewer explicitly. If _you_ wrote the PR, review with the other provider:
   Claude agents pass `--reviewer codex`; Codex agents pass `--reviewer claude`.
   Ask the user only if you didn't write it and can't tell who did.

4. **Report back**: the review URL, the reviewer model, the verdict, and the
   finding counts by severity. Do not start fixing findings unless the user
   asked for that; that is what `babysit-pr` is for. If the user wants both,
   run `babysit-pr` next.

## Options

| Flag / env var                                       | Purpose                                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `--reviewer codex\|claude`                           | Override detection                                        |
| `--model <id>`, `--effort <level>`                   | Override the reviewer model or reasoning effort           |
| `ADVERSARIAL_REVIEW_CODEX_MODEL` / `_CODEX_EFFORT`   | Defaults for Codex (`gpt-6.1-sol`, `high`)                |
| `ADVERSARIAL_REVIEW_CLAUDE_MODEL` / `_CLAUDE_EFFORT` | Defaults for Claude (`claude-opus-5-5`, `high`)           |
| `--dry-run`                                          | Run the review but print the payload instead of posting   |
| `--findings <file>`                                  | Post findings JSON from a previous run without re-running |
| `--force`                                            | Review again even if this head was already reviewed       |

Each run leaves the reviewer log, `findings.json` and `review-payload.json`
in a temp directory printed as `artifacts`. If posting failed, fix the cause
and re-post with `--findings <artifacts>/findings.json` rather than paying for
a second review. Saved findings record the repo, PR and head commit they
reviewed. They are refused once the PR head has moved, because their line
numbers and suggestions would land on the wrong code.

## Failure handling

- **Reviewer CLI not installed or not logged in:** stop and tell the user
  which CLI to set up. Do not fall back to reviewing with your own provider;
  that defeats the point.
- **The reviewer exits non-zero or returns invalid JSON:** read `reviewer.log`
  in the artifacts directory and report the cause.
- **GitHub rejects an inline comment:** the script retries once with every
  finding listed in the review body, so findings are never silently dropped.