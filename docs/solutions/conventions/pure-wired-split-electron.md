---
title: Pure/wired split for Electron code — testable policy, thin wiring, QA checklist for the rest
module: desktop
date: 2026-07-07
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "adding any logic to packages/desktop"
  - "deciding where a new decision (routing, policy, state) should live"
tags:
  - electron
  - testing
  - pure-functions
  - qa-checklist
---

# Pure/wired split for Electron code — testable policy, thin wiring, QA checklist for the rest

## Context

Electron APIs can't run under vitest, and packaged-app behavior (Gatekeeper, TCC, tray rendering) can't run in CI at all. Without a discipline, decision logic leaks into Electron event handlers and ships untested.

## Guidance

Every module in `packages/desktop` is one of two kinds:

- **Pure** — no `electron` import beyond `import type`. All policy and decisions live here: the security allow-lists (`security.ts`, `origins.ts`), the onboarding state machine (`onboarding/machine.ts`, `state.ts`), the deep-link parser/router (`contract.ts`, `deep-link.ts`), daemon ownership decisions (`decideDaemonManagement`), status mapping (`status.ts`). Exhaustively unit-tested, I/O injected as effect interfaces.
- **Wired** — `windows.ts`, `tray.ts`, `main.ts`, `onboarding/effects.ts`: thin glue that calls Electron APIs and delegates every decision to a pure function. Covered by the packaged-app QA checklist (`docs/desktop/qa-checklist.md`), not unit tests.

Two rules keep the split honest:

1. **If a wired file grows a branch, extract it.** The code review caught real decisions hiding in wired files (launch-priority ordering in `main.ts`, per-folder action selection in `tray.ts`) — that's the smell that logic escaped the pure side.
2. **Whatever only a packaged build can prove goes on the QA checklist explicitly** — including credential-gated items (signing, notarization, auto-update) — so untestable ≠ unverified.

## Why This Matters

The 9-persona review of the desktop diff found its highest-severity issues almost exclusively where this split slipped: an untested pure module (`descriptor.ts` shipped with zero tests) and decisions living in wired files. Where the split held, the plan's test scenarios mapped 1:1 onto pure-function tests and survived adversarial review.

## When to Apply

All `packages/desktop` work, and any future Electron/native surface in the repo.