import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  BASELINE_SHA,
  parseStartupReport,
  verifyStartupPackageIdentity,
  verifyStartupRuns,
} from "../verify-strata-startup.js";

function run(time = 100, arm: "before" | "after" = "after") {
  const values = {
    "resource.GameState.timeToReadyMs": time,
    "component.props.reveal.complete": true,
    "component.props.reveal.samples": 2,
    "component.props.reveal.elapsedMs": 3000,
    "component.props.reveal.publishedBatchesInView": 0,
    "component.props.reveal.shadowInvalidated": 0,
    "component.props.reveal.impostorPendingPeak": 0,
    diagnostics: 0,
  };
  return {
    arm,
    status: 0,
    report: {
      pass: true,
      diagnostics: [],
      observations: { console: [], hud: {}, network: [], resources: {} },
      capture: {
        adapter: { vendor: "google", architecture: "swiftshader" },
        rendererKind: "webgpu" as const,
        target: "web" as const,
        captureMethod: "page.screenshot" as const,
        browserArgs: [],
        viewport: { width: 1280, height: 720 },
      },
      assertionResults: Object.entries(values).map(([id, after]) => ({
        id,
        pass: true,
        details: { after },
      })),
    },
  };
}
function pairs(before = 100, after = 120) {
  return [
    run(before, "before"),
    run(after),
    run(after),
    run(before, "before"),
    run(before, "before"),
    run(after),
  ] as const;
}
function assertion(r: ReturnType<typeof run>, index: number) {
  const value = r.report.assertionResults[index];
  assert(value, `fixture assertion ${index} missing`);
  return value;
}

it("accepts three alternating pairs within the owner bound", () => {
  expect(verifyStartupRuns(pairs()).ratio).toBe(1.2);
});
it("rejects the controlled real startup regression", () => {
  expect(() => verifyStartupRuns(pairs(10599.9, 26130.1))).toThrow(/1.25/);
});
it("fails closed on missing observations, short samples, diagnostics and subprocess failure", () => {
  for (const mutate of [
    (r: ReturnType<typeof run>) => {
      Object.assign(r.report, { diagnostics: [{ code: "BAD" }] });
    },
    (r: ReturnType<typeof run>) => {
      Object.assign(r.report, { observations: {} });
    },
    (r: ReturnType<typeof run>) => {
      Object.assign(r.report.capture, { adapter: {} });
    },
    (r: ReturnType<typeof run>) => {
      assertion(r, 1).details.after = false;
    },
    (r: ReturnType<typeof run>) => {
      Object.assign(assertion(r, 2).details, { after: "2" });
    },
    (r: ReturnType<typeof run>) => {
      r.report.assertionResults = [];
    },
    (r: ReturnType<typeof run>) => {
      assertion(r, 2).details.after = 1;
    },
    (r: ReturnType<typeof run>) => {
      assertion(r, 3).details.after = 2999;
    },
    (r: ReturnType<typeof run>) => {
      r.status = 2;
    },
    (r: ReturnType<typeof run>) => {
      r.report.capture.adapter.vendor = "other";
    },
    (r: ReturnType<typeof run>) => {
      assertion(r, 7).pass = false;
    },
  ]) {
    const runs = pairs();
    mutate(runs[1]);
    expect(() => verifyStartupRuns(runs)).toThrow();
  }
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => verifyStartupRuns(pairs(100, value))).toThrow();
});
it("permits only historical BEFORE late counter failures", () => {
  const runs = pairs();
  runs[0].status = 1;
  runs[0].report.pass = false;
  assertion(runs[0], 4).pass = false;
  assertion(runs[0], 4).details.after = 5;
  expect(verifyStartupRuns(runs).ratio).toBe(1.2);
  assertion(runs[1], 4).pass = false;
  expect(() => verifyStartupRuns(runs)).toThrow();
});
it("pins reviewed old source and requires the real command inside benchmark", () => {
  expect(BASELINE_SHA).toBe("88b988cd70d5db7266eb0281e5f74bd0e030b3e7");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const section = ci.split("  benchmark:\n")[1];
  assert(section, "benchmark job missing");
  const benchmark = section.split("\n  # visuals")[0];
  assert(benchmark, "benchmark body missing");
  expect(benchmark).not.toContain("continue-on-error:");
  expect(benchmark).toContain("ref: 88b988cd70d5db7266eb0281e5f74bd0e030b3e7");
  expect(benchmark).toContain("path: .worktrees/strata-startup-baseline");
  const gateSection = benchmark.split("      - name: Enforce Strata startup median")[1];
  assert(gateSection, "startup gate missing");
  const gate = gateSection.split("\n      - ")[0];
  assert(gate, "startup gate body missing");
  expect(gate).toContain("EXPECTED_SOURCE_SHA: ${{ needs.scope.outputs.candidate_sha }}");
  expect(gate).toContain("timeout 9m pnpm tsx scripts/verify-strata-startup.ts");
  expect(gate).not.toMatch(/continue-on-error:|if:|\|\|\s*(true|:)|set \+e/);
});

it("parses real runner log framing and rejects absent or malformed reports", () => {
  expect(
    parseStartupReport(`{"captureLock":{}}\n${JSON.stringify(run().report, null, 2)}`),
  ).toEqual(run().report);
  for (const log of ["", "{}", '{"assertionResults": ['])
    expect(() => parseStartupReport(log)).toThrow();
});

it("requires all six runs in alternating pair order", () => {
  expect(() => verifyStartupRuns(pairs().slice(1))).toThrow();
  const runs = [...pairs()];
  runs.reverse();
  expect(() => verifyStartupRuns(runs)).toThrow();
});

it("accepts native command edits but rejects dependency or compiler identity changes", () => {
  const baseline = {
    name: "strata-terrain-preview",
    type: "module",
    version: "0.1.0",
    scripts: { "test:terrain:desktop": "old native staging" },
    dependencies: { "@threenative/core": "workspace:*", three: "catalog:" },
    devDependencies: { vite: "catalog:", typescript: "catalog:" },
    engines: { node: ">=20" },
  };
  const candidate = {
    ...baseline,
    scripts: {
      "test:terrain:desktop": "new native staging",
      "verify-native": "node scripts/verify-native.mjs",
    },
  };
  expect(() => verifyStartupPackageIdentity(baseline, candidate)).not.toThrow();
  expect(() =>
    verifyStartupPackageIdentity(baseline, {
      ...candidate,
      dependencies: { ...candidate.dependencies, three: "other" },
    }),
  ).toThrow(/dependencies/);
  expect(() =>
    verifyStartupPackageIdentity(baseline, { ...candidate, devDependencies: { vite: "other" } }),
  ).toThrow(/devDependencies/);
  expect(() =>
    verifyStartupPackageIdentity(baseline, { ...candidate, engines: { node: ">=24" } }),
  ).toThrow(/engines/);
});
