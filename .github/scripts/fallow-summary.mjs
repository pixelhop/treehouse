import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function readHealth(path) {
  const report = JSON.parse(fs.readFileSync(path, "utf8"));
  const message = `Missing or invalid health score in ${path}`;
  assert.equal(report.kind, "health", message);
  assert.ok(Number.isFinite(report.health_score?.score), message);
  assert.ok(Number.isInteger(report.health_score?.formula_version), message);
  assert.equal(typeof report.version, "string", message);
  assert.ok(report.version, message);
  return report;
}

function scoreComparison(head, base) {
  const current = head.health_score.score.toFixed(1);
  if (!base) return `**${current} (${head.health_score.grade})**`;
  const message = "Cannot compare scores from different Fallow versions or formulas";
  assert.equal(base.version, head.version, message);
  assert.equal(base.health_score.formula_version, head.health_score.formula_version, message);
  const delta = head.health_score.score - base.health_score.score;
  return `**${base.health_score.score.toFixed(1)} → ${current} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}) · ${head.health_score.grade}**`;
}

function renderSummary({ head, base, production, reportUrl }) {
  const penalties = Object.entries(head.health_score.penalties || {})
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `| ${key.replaceAll("_", " ")} | −${value.toFixed(1)} |`);
  return [
    "<!-- fallow-health-score -->",
    `### Fallow health: ${scoreComparison(head, base)}`,
    "",
    `Whole repo · ${head.summary.files_analyzed} files · ${head.summary.functions_analyzed} functions · Fallow ${head.version}`,
    "",
    base
      ? "Base and head use the same Fallow version and head configuration."
      : "No comparison base is available for this run; no delta is calculated.",
    "",
    "| Penalty | Points |",
    "| --- | --- |",
    ...(penalties.length ? penalties : ["| None | 0.0 |"]),
    "",
    `Production-only health: **${production.health_score.score.toFixed(1)} (${production.health_score.grade})**. This excludes test/dev files and is a separate measurement, not a score improvement.`,
    "",
    "The scores are advisory. The audit fails on newly introduced error-level findings; inherited findings remain visible.",
    "",
    `[Download full findings, production health and audit JSON from the workflow artifacts](${reportUrl}).`,
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const body = renderSummary({
    head: readHealth(process.env.HEAD_RESULTS),
    base: process.env.BASE_RESULTS ? readHealth(process.env.BASE_RESULTS) : null,
    production: readHealth(process.env.PRODUCTION_RESULTS),
    reportUrl: process.env.REPORT_URL,
  });
  fs.mkdirSync(".fallow-reports", { recursive: true });
  fs.writeFileSync(".fallow-reports/summary.md", body);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  }
}

export { readHealth, renderSummary };