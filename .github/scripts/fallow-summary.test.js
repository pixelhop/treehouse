import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { readHealth, renderSummary } from "./fallow-summary.mjs";

function report(score, version = "3.32.0", formula = 2) {
  return {
    kind: "health",
    version,
    health_score: {
      score,
      grade: "B",
      formula_version: formula,
      penalties: {
        circular_deps: 3.2,
        unit_size: 10,
        hotspot: null,
        complexity: 0,
      },
    },
    summary: { files_analyzed: 2544, functions_analyzed: 20000 },
  };
}

function summary(head, base) {
  return renderSummary({
    head,
    base,
    production: report(80),
    reportUrl: "https://example.test/run",
  });
}

test("preserves fractional improvements and labels separate measurements", () => {
  const body = summary(report(76.9), report(72.1));
  assert.match(body, /72\.1 → 76\.9 \(\+4\.8\)/);
  assert.match(body, /Production-only health: \*\*80\.0/);
  assert.match(body, /same Fallow version and head configuration/);
  assert.ok(body.indexOf("unit size") < body.indexOf("circular deps"));
  assert.doesNotMatch(body, /hotspot|NaN|undefined/);
});

test("reports regressions with their negative sign", () => {
  assert.match(summary(report(70.9), report(72.1)), /\(-1\.2\)/);
});

test("does not invent a delta when there is no base", () => {
  const body = summary(report(76.9), null);
  assert.match(body, /no delta is calculated/);
  assert.doesNotMatch(body, /→/);
});

test("rejects incompatible versions and score formulas", () => {
  assert.throws(() => summary(report(77), report(70, "3.4.0")), /different Fallow versions/);
  assert.throws(() => summary(report(77), report(70, "3.32.0", 1)), /different Fallow versions/);
});

test("fails on missing or malformed reports instead of publishing a bogus score", () => {
  const dir = mkdtempSync(join(tmpdir(), "fallow-summary-"));
  const path = join(dir, "health.json");
  try {
    assert.throws(() => readHealth(path));
    writeFileSync(path, JSON.stringify({ kind: "health", health_score: { score: null } }));
    assert.throws(() => readHealth(path), /invalid health score/);
    writeFileSync(path, "not json");
    assert.throws(() => readHealth(path));
    writeFileSync(path, JSON.stringify(report(76.9)));
    assert.equal(readHealth(path).health_score.score, 76.9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});