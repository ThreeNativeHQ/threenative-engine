#!/usr/bin/env node
/**
 * The renderer's own check: metric direction, missing values, and escaping. `node check-render.mjs`.
 *
 * The three things a dashboard gets wrong silently are all here — a lower-is-better metric shown
 * as an improvement when it regressed, a missing measurement printed as a number, and a recorded
 * name that escapes its own element and rewrites the page.
 */
import assert from "node:assert/strict";

import { escapeHtml, embedJson, delta, goalProgress, safeLink, render } from "./render.mjs";

// Direction: improving a lower-is-better metric is a positive delta.
assert.deepEqual(delta(20, 15, "lower-is-better"), { absolute: 5, percent: 25 });
assert.deepEqual(delta(20, 25, "lower-is-better"), { absolute: -5, percent: -25 });
assert.deepEqual(delta(20, 25, "higher-is-better"), { absolute: 5, percent: 25 });

// A zero baseline has no percentage, ever, and a missing side is unavailable rather than zero.
assert.equal(delta(0, 5, "lower-is-better").percent, undefined);
assert.deepEqual(delta(undefined, 5, "lower-is-better"), { absolute: undefined, percent: undefined });
assert.deepEqual(delta(20, undefined, "lower-is-better"), { absolute: undefined, percent: undefined });
// JSON has no undefined: a field the campaign has not recorded yet arrives as null.
assert.deepEqual(delta(null, 5, "lower-is-better"), { absolute: undefined, percent: undefined });
assert.deepEqual(delta(20, null, "lower-is-better"), { absolute: undefined, percent: undefined });

// Goal progress is clamped, and a target the incumbent already meets says so instead of a number.
assert.equal(goalProgress(20, 15, 10, "lower-is-better").percent, 50);
assert.equal(goalProgress(20, 5, 10, "lower-is-better").percent, 100);
assert.equal(goalProgress(20, undefined, 10, "lower-is-better").kind, "unavailable");
assert.equal(goalProgress(20, 15, undefined, "lower-is-better").kind, "no-numeric-target");

// Links stay inside the campaign directory; a path, an absolute path or a scheme is inert.
assert.equal(safeLink("raw/baseline-01/run.log"), "raw/baseline-01/run.log");
assert.equal(safeLink("/etc/passwd"), undefined);
assert.equal(safeLink("https://example.com"), undefined);
assert.equal(safeLink("../../outside.txt"), undefined);
assert.equal(safeLink("notes/x.md"), "notes/x.md");

// Escaping, including the script-embedding case: `<` cannot terminate the data element.
assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
assert.equal(embedJson({ a: "</script><script>alert(1)</script>" }).includes("<"), false);

const hostile = JSON.parse(JSON.stringify(minimalCampaign()));
hostile.benchmarks[0].workload = "<script>alert(1)</script>";
hostile.benchmarks[0].current = undefined;
hostile.benchmarks[0].currentReason = '<img src=x onerror="alert(2)">';
hostile.experiments[0].hypothesis = "</details><script>alert(3)</script>";
const html = render(hostile);
assert.equal(html.includes("<script>alert"), false, "recorded text must not open a script element");
assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "workload name must be escaped");
assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"), "reason must be escaped");

// A pending baseline is words, not a zero.
const pending = JSON.parse(JSON.stringify(minimalCampaign()));
for (const benchmark of pending.benchmarks) {
  benchmark.baseline = undefined;
  benchmark.best = undefined;
  benchmark.current = undefined;
}
const pendingHtml = render(pending);
assert.ok(pendingHtml.includes("baseline pending"), "a pending baseline must say so");
assert.equal(/>0\.00 </u.test(pendingHtml), false, "a missing measurement must not print as a number");

// The same fields as JSON delivers them: null, which must not read as a measured zero or throw.
const nulled = JSON.parse(JSON.stringify(minimalCampaign()));
nulled.benchmarks[0].baseline = null;
nulled.benchmarks[0].best = null;
nulled.benchmarks[0].current = null;
nulled.benchmarks[0].goal = null;
nulled.benchmarks[0].noiseMargin = null;
nulled.benchmarks[0].samples = null;
nulled.benchmarks[0].repeats = null;
const nulledHtml = render(nulled);
assert.ok(nulledHtml.includes("baseline pending"), "a null baseline must say pending");
assert.ok(nulledHtml.includes("uncalibrated"), "a null noise margin must say uncalibrated");

// An experiment with no decision yet is still running, and must not render as "undefined".
const inFlight = JSON.parse(JSON.stringify(minimalCampaign()));
inFlight.experiments[0].decision = null;
inFlight.experiments[0].phase = null;
const inFlightHtml = render(inFlight);
assert.equal(inFlightHtml.includes(">undefined<"), false, "an undecided experiment must name its state");
assert.ok(inFlightHtml.includes(">running<"), "an undecided experiment reads as running");

process.stdout.write("render check: ok\n");

function minimalCampaign() {
  return {
    campaign: {
      id: "check",
      status: "running",
      phase: "baseline",
      startedAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
      heartbeatAt: "2026-09-19T00:00:00Z",
      deadlineAt: null,
      owner: { worktree: "/tmp/w", branch: "b", revision: "abc", revisionShort: "abc", dirty: false },
      evidence: ["gameplay"],
      nextHypothesis: "none",
    },
    contract: {
      primaryPlatform: "desktop",
      primaryWorkload: "flight",
      hashes: { executable: "deadbeef" },
    },
    environment: { cpu: "cpu", gpu: "gpu", display: "60 Hz" },
    benchmarks: [
      {
        id: "frame-p95",
        workload: "flight",
        platform: "desktop",
        metric: "frame p95",
        unit: "ms",
        direction: "lower-is-better",
        baseline: 18.5,
        best: 18.5,
        current: 18.0,
        goal: 16.67,
        noiseMargin: { kind: "relative", percent: 3 },
        samples: 2400,
        repeats: 3,
        gate: "passed",
        status: "keep",
      },
    ],
    history: { "frame-p95": [{ at: "2026-09-19T00:00:00Z", value: 18.5, decision: "baseline" }] },
    experiments: [
      {
        id: "exp-1",
        hypothesis: "h",
        bottleneckEvidence: "e",
        layer: "engine",
        files: ["a.ts"],
        candidate: "none",
        unit: "ms",
        scalar: { incumbent: 18.5, candidate: 18.0, relativePercent: 2.7 },
        pairs: "3",
        gameResult: "n/a",
        sentinelResult: "n/a",
        gates: "passed",
        decision: "keep",
        reason: "cleared the margin",
        duration: "10m",
        evidence: ["raw/baseline-01/run.log"],
        workload: "flight",
        platform: "desktop",
      },
    ],
    incumbent: { revisionShort: "abc" },
    coverage: {
      platforms: [{ name: "desktop", status: "measured" }],
      workloads: ["flight"],
      unresolved: [],
      reproduction: ["node tools/measure.mjs --id x"],
    },
    stopReason: null,
    nextAction: "none",
  };
}

// Scoreboard colours (Tempest campaign): lower is better; colour never comes without a label.
import { scoreStatus, renderScoreboard } from "./scoreboard.mjs";
assert.equal(scoreStatus({ legacy: 44, wasmStart: 118, wasmKept: 40 }).cls, "green");
assert.equal(scoreStatus({ legacy: 44, wasmStart: 118, wasmKept: 90 }).cls, "yellow");
assert.equal(scoreStatus({ legacy: 44, wasmStart: 118, wasmKept: 118, latest: { value: 100 } }).cls, "yellow");
assert.equal(scoreStatus({ legacy: 44, wasmStart: 118, wasmKept: 118, latest: { value: 118 } }).cls, "red");
assert.equal(scoreStatus({ legacy: null, wasmKept: 77 }).cls, "grey");
assert.equal(scoreStatus({ legacy: 44, wasmKept: null }).cls, "grey");
assert.equal(scoreStatus({ kind: "limit", limit: 0.01, wasmKept: 0.006 }).cls, "green");
assert.equal(scoreStatus({ kind: "limit", limit: 0.01, wasmKept: 0.02 }).cls, "red");
assert.ok(!renderScoreboard({ scoreboard: { rows: [{ metric: "<x>", legacy: 1, wasmKept: 2 }] }, history: {} }).includes("<x>"));
assert.equal(renderScoreboard({ history: {} }), "");
assert.equal(scoreStatus({ legacy: 44, target: 31, wasmStart: 118, wasmKept: 43.8 }).cls, "yellow");
assert.equal(scoreStatus({ legacy: 44, target: 31, wasmStart: 118, wasmKept: 30 }).cls, "green");
console.log("scoreboard check: ok");
