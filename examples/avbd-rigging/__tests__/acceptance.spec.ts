import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type IPlaytestReport,
  type IPlaytestScenario,
  loadPlaytestScenario,
} from "@threenative/playtest";
import { describe, expect, it } from "vitest";
import { emitPerfSignalsWorld } from "../../../packages/playtest/src/evaluators/perf-signals-world.js";
import { riggingSampleChecks } from "../src/physics/measure.js";

const originalBytes = readFileSync(
  new URL("./fixtures/rigging-original.playtest.json", import.meta.url),
);
const original = JSON.parse(originalBytes.toString("utf8")) as IPlaytestScenario;
const scenario = await loadPlaytestScenario(
  new URL("..", import.meta.url).pathname,
  "playtests/rigging.playtest.json",
);
const held = [
  "mode",
  "nonfinitePositions",
  "nonfiniteRotations",
  "overflow",
  "colorClashes",
  "readbackFailures",
  "observationFailures",
  "cleanupFailed",
  "rendererControl.solverAllocations",
  "fixedColorsValidated",
  "pausedAdditionalSteps",
];

function setPath(state: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let object = state;
  for (const part of parts.slice(0, -1)) object = object[part] as Record<string, unknown>;
  const key = parts.at(-1);
  if (key === undefined) throw new Error("test path missing");
  object[key] = value;
}
function state(steps = 10004): Record<string, unknown> {
  return {
    mode: "candidate",
    measured: 1,
    steps,
    finiteTicks: steps,
    nonfinitePositions: 0,
    nonfiniteRotations: 0,
    overflow: 0,
    colorClashes: 0,
    ropeExtension: 0.004,
    sailStretch: 0.002,
    penetrationMaximum: 0.015,
    staleTicks: 8,
    anchorX: 0.508,
    windSpeed: 0,
    gustStrength: 0,
    paused: 0,
    pausedAdditionalSteps: 0,
    readbackBytes: 7628480,
    readbackFailures: 0,
    observationFailures: 0,
    cleanupFailed: 0,
    rendererControl: { solverAllocations: 0 },
    acceptedAnchorVelocity: 0,
    acceptedAnchorMoving: false,
    contactsMaximum: 2944,
    fixedColorsValidated: 1,
  };
}
function checks(value: Record<string, unknown>) {
  value.sampleChecks = riggingSampleChecks({
    ropeExtensionMaximum: value.ropeExtension as number,
    sailStretchP95: value.sailStretch as number,
    penetrationMaximum: value.penetrationMaximum as number,
    readbackBytes: value.readbackBytes as number,
    staleTicks: value.staleTicks as number,
  });
}
function fixture() {
  const before = state(60);
  Object.assign(before, {
    finiteTicks: 0,
    anchorX: 0,
    penetrationMaximum: 0,
    contactsMaximum: 0,
    readbackBytes: 246080,
  });
  checks(before);
  const after = state();
  checks(after);
  const windStart = scenario.steps.findIndex((s) => s.label === "step-wind");
  const gustStart = scenario.steps.findIndex((s) => s.label === "gust-wind");
  const windEnd = scenario.steps.findIndex((s) => s.label === "return-to-steady-load");
  const samples = scenario.steps.map((step, index) => {
    const value = state();
    if (index < 2)
      Object.assign(value, {
        measured: 0,
        readbackBytes: 0,
        ropeExtension: 1e9,
        sailStretch: 1e9,
        penetrationMaximum: 1e9,
      });
    if (index >= windStart && index < windEnd) value.windSpeed = 6;
    if (index >= gustStart && index < windEnd) value.gustStrength = 0.4;
    if (step.label?.startsWith("pause") === true) value.paused = 1;
    if (["translate-anchor", "translated", "accepted-moving-anchor"].includes(step.label ?? "")) {
      value.acceptedAnchorVelocity = 0.25;
      value.acceptedAnchorMoving = true;
    }
    checks(value);
    return { label: step.label, tick: index + 1, snapshots: { GameState: value } };
  });
  return { before, after, samples };
}
function evaluate(f: ReturnType<typeof fixture>) {
  const assertions: Parameters<typeof emitPerfSignalsWorld>[0]["assertions"] = [];
  const diagnostics: Parameters<typeof emitPerfSignalsWorld>[0]["diagnostics"] = [];
  emitPerfSignalsWorld({
    assertions,
    diagnostics,
    scenarioAssertions: scenario.assert ?? {},
    input: {
      scenario,
      report: {
        observations: {
          resources: { GameState: { before: f.before, after: f.after } },
          resourceSeries: f.samples,
        },
      } as unknown as IPlaytestReport,
    },
  });
  return { assertions, diagnostics };
}
function checkpoint(f: ReturnType<typeof fixture>, label: string) {
  const sample = f.samples.find((s) => s.label === label);
  if (sample === undefined) throw new Error(`test checkpoint ${label} missing`);
  return sample.snapshots.GameState;
}
function row(result: ReturnType<typeof evaluate>, path: string, temporal = "atSteps") {
  return result.assertions.find((a) => a.id === `resource.GameState.${path}.${temporal}`);
}

describe("explicit rigging invariant and transition admission", () => {
  it("preserves every original runtime step, final comparator and physical bar", () => {
    expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(
      "e551c42445f3fcf2edec2ab350efd2c2e253337f1d3e209f42097bd5e15be57c",
    );
    const raw = JSON.parse(
      readFileSync(new URL("../playtests/rigging.playtest.json", import.meta.url), "utf8"),
    ) as IPlaytestScenario;
    expect(raw.steps).toEqual(original.steps);
    for (const old of original.assert?.resources ?? []) {
      const current = raw.assert?.resources?.find((a) => a.id === old.id && a.path === old.path);
      expect(current).toBeDefined();
      for (const key of ["equals", "gte", "lte", "throughoutSteps"] as const)
        if (old[key] !== undefined) expect(current?.[key]).toEqual(old[key]);
      for (const at of old.atSteps ?? []) expect(current?.atSteps).toContainEqual(at);
    }
    expect(raw.assert?.resources?.find((a) => a.path === "penetrationMaximum")?.lte).toBe(0.02);
  });
  it("admits explicitly checked valid initial invariants while retaining independent progress", () => {
    const result = evaluate(fixture());
    expect(result.assertions.length).toBeGreaterThan(30);
    expect(result.assertions.filter((a) => !a.pass)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(
      scenario.assert?.resources?.find((a) => a.path === "steps")?.allowTrivial,
    ).toBeUndefined();
    expect(
      scenario.assert?.resources?.find((a) => a.path === "finiteTicks")?.allowTrivial,
    ).toBeUndefined();
  });
  it.each(held)("rejects a post-start %s violation even when the final value recovers", (path) => {
    const f = fixture();
    setPath(
      checkpoint(f, "hanging-load"),
      path,
      path === "mode" ? "spring" : path === "fixedColorsValidated" ? 0 : 1,
    );
    expect(row(evaluate(f), path, "throughoutSteps")?.pass).toBe(false);
  });
  it.each(["windSpeed", "paused", "acceptedAnchorMoving"])(
    "rejects an unchanged %s transition trace",
    (path) => {
      const f = fixture();
      for (const sample of f.samples)
        setPath(sample.snapshots.GameState, path, path === "acceptedAnchorMoving" ? false : 0);
      expect(row(evaluate(f), path)?.pass).toBe(false);
    },
  );
  it.each(["ropeExtension", "sailStretch", "penetrationMaximum", "staleTicks"])(
    "rejects a post-start %s bound violation with valid endpoints",
    (path) => {
      const f = fixture();
      const label =
        path === "ropeExtension"
          ? "hanging-observation"
          : path === "staleTicks"
            ? "recent-physical-observation"
            : "step-settled";
      const value = checkpoint(f, label);
      value[path] = {
        ropeExtension: 0.031,
        sailStretch: 0.051,
        penetrationMaximum: 0.02415698730681404,
        staleTicks: 121,
      }[path];
      checks(value);
      const check = path === "staleTicks" ? "fresh" : path;
      expect(row(evaluate(f), `sampleChecks.${check}`)?.pass).toBe(false);
    },
  );
  it("retains the actual recorded 24.16 mm numeric failure", () => {
    const f = fixture();
    f.after.penetrationMaximum = 0.02415698730681404;
    checks(f.after);
    const result = evaluate(f);
    expect(
      result.assertions.find((a) => a.id === "resource.GameState.penetrationMaximum")?.pass,
    ).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED")).toBe(
      true,
    );
  });
  it("fails missing checkpoints and missing sampled-bound fields", () => {
    const f = fixture();
    f.samples = f.samples.filter((s) => s.label !== "step-settled");
    expect(row(evaluate(f), "sampleChecks.sailStretch")?.pass).toBe(false);
    const missing = fixture();
    checkpoint(missing, "hanging-observation").sampleChecks = undefined;
    expect(row(evaluate(missing), "sampleChecks.readback")?.pass).toBe(false);
  });
  it("requires post-reset measured readiness, not just a valid initial/final snapshot", () => {
    const f = fixture();
    checkpoint(f, "hanging-observation").measured = 0;
    expect(row(evaluate(f), "measured")?.pass).toBe(false);
    const bytes = fixture();
    const value = checkpoint(bytes, "hanging-observation");
    value.readbackBytes = 0;
    checks(value);
    expect(row(evaluate(bytes), "sampleChecks.readback")?.pass).toBe(false);
  });
});

it("rejects malformed sampled measurements instead of reporting passing phase predicates", () => {
  const valid = {
    ropeExtensionMaximum: 0.004,
    sailStretchP95: 0.002,
    penetrationMaximum: 0.015,
    readbackBytes: 246080,
    staleTicks: 8,
  };
  for (const [key, bad] of [
    ["ropeExtensionMaximum", Number.NaN],
    ["sailStretchP95", Number.POSITIVE_INFINITY],
    ["penetrationMaximum", -0.01],
    ["readbackBytes", 0.5],
    ["staleTicks", -1],
  ] as const)
    expect(() => riggingSampleChecks({ ...valid, [key]: bad })).toThrow(/TN_AVBD_MEASUREMENT/);
  expect(riggingSampleChecks({ ...valid, readbackBytes: 0 })).toEqual({
    readback: false,
    ropeExtension: false,
    sailStretch: false,
    penetrationMaximum: false,
    fresh: false,
  });
});

it("rejects a missing gust and residual accepted movement after the actual stop", () => {
  const noGust = fixture();
  for (const sample of noGust.samples) sample.snapshots.GameState.gustStrength = 0;
  expect(row(evaluate(noGust), "gustStrength")?.pass).toBe(false);
  const residual = fixture();
  const stopped = checkpoint(residual, "fast-stop-settled");
  stopped.acceptedAnchorVelocity = 0.1;
  stopped.acceptedAnchorMoving = false;
  expect(row(evaluate(residual), "acceptedAnchorVelocity")?.pass).toBe(false);
});
