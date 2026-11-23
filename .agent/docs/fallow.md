# Fallow code health

Fallow is pinned to **3.32.0** in the root `package.json` and the GitHub Action
in `.github/workflows/ci.yml`. Update the CLI, action SHA, configuration schema
URL and this document together. Run `pnpm install` at the repository root
before using the commands.

## Local commands

```bash
pnpm fallow:health       # Whole-repo score, complexity and file findings; advisory
pnpm fallow:dead-code    # Unused code/dependencies and cycles; exits 1 on findings
pnpm fallow:audit        # New findings compared with origin/main; pass/warn/fail
pnpm fallow:production   # Separate production-only health report; advisory
pnpm fallow:report       # Full JSON: dead code, duplication, complexity and targets
pnpm test:fallow         # Unit tests for the CI score-summary renderer
```

Fetch `origin/main` before a local audit. The base is explicit because a
branch's upstream may be its own remote branch after pushing. Fallow's audit
creates its own temporary base-analysis snapshot; it is not a development
checkout and does not start application services.

Use `--format json --output-file <path>` to retain a report. Keep local reports
and caches under the gitignored `.fallow/` directory. `fallow report --from
<report.json> --format github-summary` renders a saved report without reanalysis.

Before committing or opening a PR, run `pnpm fallow:audit` and fix any new
error-level findings rather than suppressing them.

## Configuration and exceptions

`.fallowrc.jsonc` relies on automatic Nuxt/Nitro/workspace discovery. Its
`entry` globs cover files invoked by convention or runbooks rather than by
source imports: the root and per-package `scripts/`, and the desktop shell's
preload bundle. `packages/marketing/build/` is first-party source despite its
name, so it is un-ignored.

Its exact dependency exceptions document indirect consumers (`pinia` for
`@pinia/nuxt`, `rolldown` for Nuxt's peer requirement, `~icons` and
`@iconify-json/simple-icons` for unplugin-icons, `@posthog/cli` for its spawned
binary). `ignoreDependencies` suppresses both unused and unlisted findings, so
those packages must remain declared; review each exception when its consumer
changes.

Keep the normal complexity thresholds and analyze tests in the main report.
Test files only opt out of CRAP, which is meaningless for test code.
Production-only health is a separate measurement, not a replacement for the
whole-repo score. Updating config can move a score without changing application
code; compare both revisions under the same config before claiming improvement.
Do not accept `fallow recommend` output without checking this monorepo's actual
conventions.

## CI reports and gating

The `fallow` job checks out the PR head and scans it with the pinned action. It
retains a detailed health report, a full combined findings report and a separate
production-only health report. For PRs, it checks out the merge base of the PR
head and event base SHA in `.fallow/base`, so unrelated changes landing on
`main` do not distort the delta. Pushes compare with the event's previous SHA.
The base installs its own locked dependencies (which generates its Prisma,
Nitro and Nuxt types). Its disposable checkout is removed after scoring, before
Fallow caches are saved. Both score scans use the **head configuration and head
CLI**, keeping the score comparison consistent even when the PR changes Fallow
configuration.

The sticky PR comment shows scores and their delta to one decimal place, plus
penalties and a link to workflow artifacts. Runs without a valid comparison
base show a standalone score and skip the audit; they do not invent a zero
baseline. Score rendering (`.github/scripts/fallow-summary.mjs`) fails on
malformed reports or incompatible versions and formula versions.

The score and backlog are advisory. The audit uses `gate: all` against
baselines saved from the fully installed base checkout, with
`fail-on-issues: true`: introduced error-level findings fail the job; warning
findings and inherited findings do not. Repository rules must require the
`Fallow code health` status check to make that failure a merge restriction.

CI writes reports and baselines to the gitignored `.fallow-reports/`, not
`.fallow/`. Every invocation of the Fallow action restores its `.fallow` cache,
which is keyed only on package manifests and can hold an earlier run's files.
Keeping reports outside it stops a cache hit from replacing this run's
baselines.

The `fallow-reports` artifact retains JSON and the score summary for 14 days,
including on audit failure. The base checkout, action shell scripts and caches
are not uploaded.

Chat Thing additionally feeds measured Istanbul coverage into a server-only
`fallow health --coverage` run. Add that here once a package has enough tests
for coverage-informed CRAP scores to be meaningful.