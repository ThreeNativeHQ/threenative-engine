/** PRD-477: extract WorldProbe's observed route without inventing poses or capture provenance. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { IWorldCaptureManifest } from "./world-visual-gate.js";

const LABELS = [
  "phase477-pose-start",
  ...Array.from({ length: 32 }, (_, i) => `phase477-walk-${String(i + 1).padStart(2, "0")}`),
  "phase477-pose-end",
];
const DEFAULT_SCENARIO = "phase477-world-capture";
const DEFAULT_WORLD = "WorldProbe";

export interface IWorldCaptureNames {
  scenario?: string;
  world?: string;
}
function record(value: unknown): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "missing observation object",
  );
  return value as Record<string, unknown>;
}
function vector(value: unknown): [number, number, number] {
  assert(
    Array.isArray(value) &&
      value.length === 3 &&
      value.every((n) => typeof n === "number" && Number.isFinite(n)),
    "camera/landmark pose must have three finite coordinates",
  );
  return [value[0], value[1], value[2]];
}

/** WorldProbe's captured route is fixed; any other world only has to prove it actually walked. */
function assertRoute(
  worldName: string,
  first: { position: [number, number, number] },
  lastWalk: { position: [number, number, number] },
): void {
  if (worldName !== DEFAULT_WORLD) {
    assert(
      !isDeepStrictEqual(first.position, lastWalk.position),
      `${worldName} route never moved: the first and last walk positions are identical`,
    );
    return;
  }
  assert.deepEqual(
    first.position,
    [-160, 24, 0],
    "route must begin at the captured WorldProbe start",
  );
  assert.deepEqual(lastWalk.position, [180, 24, 0], "route did not reach the WorldProbe end");
}

export function worldCaptureManifest(
  input: unknown,
  capture: unknown,
  build: string,
  nearBandMeters: number,
  names: IWorldCaptureNames = {},
): IWorldCaptureManifest {
  const scenario = names.scenario ?? DEFAULT_SCENARIO;
  const worldName = names.world ?? DEFAULT_WORLD;
  const report = record(input);
  assert(
    report.pass === true &&
      report.runtime === "web" &&
      ["web", "browser"].includes(String(report.target)),
    "a passing web report is required",
  );
  assert(report.scenario === scenario, `wrong capture scenario: expected ${scenario}`);
  assert(
    Array.isArray(report.assertionResults) &&
      report.assertionResults.length > 0 &&
      report.assertionResults.every((row) => record(row).pass === true),
    "missing or failing assertions",
  );
  assert(
    Array.isArray(report.diagnostics) &&
      report.diagnostics.every((row) => record(row).severity !== "error"),
    "missing diagnostics or runtime errors",
  );
  assert(isDeepStrictEqual(report.capture, capture), "report and capture.json provenance differ");
  const provenance = record(capture);
  assert(
    provenance.target === "web" &&
      provenance.rendererKind === "webgpu" &&
      provenance.captureMethod === "page.screenshot",
    "a WebGPU browser capture is required",
  );
  assert(build.trim() !== "", "build must be nonempty");
  assert(
    Number.isFinite(nearBandMeters) && nearBandMeters > 0,
    "near band must be positive meters",
  );
  const series = record(report.observations).componentSeries;
  assert(Array.isArray(series), "incomplete capture labels");
  // Setup steps (a loading overlay, a drain) sample too; only the capture labels are frames.
  const samples = series.filter((value) => LABELS.includes(String(record(value).label)));
  assert(samples.length === LABELS.length, "incomplete capture labels");
  const frames = samples.map((value, index) => {
    const sample = record(value);
    const id = LABELS[index];
    assert(
      typeof id === "string" && sample.label === id,
      "capture labels are missing, duplicated or out of order",
    );
    const world = record(record(sample.snapshots).world);
    assert(
      typeof world.flyTimeMs === "number" &&
        Number.isFinite(world.flyTimeMs) &&
        world.flyTimeMs >= 0,
      "invalid observed flight time",
    );
    return {
      id,
      image: `${id}.png`,
      position: vector(world.cameraPosition),
      target: vector(world.cameraTarget),
      timeMs: world.flyTimeMs,
      landmarks: world.landmarks,
    };
  });
  const first = frames[0];
  const lastWalk = frames[32];
  const settled = frames[33];
  assert(
    first !== undefined && lastWalk !== undefined && settled !== undefined,
    "incomplete route",
  );
  assertRoute(worldName, first, lastWalk);
  assert(first.timeMs === 0, "flight began before the baseline capture");
  // A game's camera may ease its height after the walk stops; the route itself must not advance.
  let travelled: number[] = settled.position;
  let walked: number[] = lastWalk.position;
  if (worldName !== DEFAULT_WORLD) {
    travelled = [settled.position[0], settled.position[2]];
    walked = [lastWalk.position[0], lastWalk.position[2]];
  }
  assert.deepEqual(travelled, walked, "route moved during settle");
  assert(settled.timeMs === lastWalk.timeMs, "flight continued during settle");
  assert(
    Array.isArray(first.landmarks) && first.landmarks.length > 0,
    "missing authored landmarks",
  );
  const landmarks = first.landmarks.map((value) => {
    const landmark = record(value);
    assert(
      typeof landmark.id === "string" && landmark.id.trim() !== "",
      "missing landmark identity",
    );
    return { id: landmark.id, position: vector(landmark.position) };
  });
  assert(new Set(landmarks.map(({ id }) => id)).size === landmarks.length, "duplicate landmarks");
  for (const [index, frame] of frames.entries()) {
    assert(isDeepStrictEqual(frame.landmarks, first.landmarks), "landmarks changed during capture");
    if (index > 0 && index < 33) {
      const previous = frames[index - 1];
      assert(
        previous !== undefined &&
          frame.timeMs > previous.timeMs &&
          (worldName === DEFAULT_WORLD
            ? frame.position[0] > previous.position[0]
            : !isDeepStrictEqual(frame.position, previous.position) ||
              frames
                .slice(index, 33)
                .every((remaining) => isDeepStrictEqual(remaining.position, frame.position))),
        "walk is not chronological or forward-moving",
      );
    }
  }
  const observed = frames.map(({ landmarks: _landmarks, ...frame }) => frame);
  // The last walk pose is also scored at rest: content that only draws at the end of the route
  // produces no transition, so a same-pose row is the only place its absence can be seen.
  const walk = observed.slice(0, -1);
  return {
    schemaVersion: 1,
    world: worldName,
    build,
    route: scenario,
    seed: "20260925",
    nearBandMeters,
    capture: "capture.json",
    landmarks,
    samePose: [...new Set([0, 8, 16, 24, walk.length - 1])].map((index) => {
      const frame = observed[index];
      assert(frame !== undefined, "missing same-pose frame");
      const { timeMs: _time, ...pose } = frame;
      return pose;
    }),
    walk,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, build, nearBand, ...extra] = process.argv.slice(2);
    const usage =
      "usage: world-capture-manifest.ts <capture-directory> <build> <near-band-meters> [--scenario <name>] [--world <name>]";
    assert(directory && build && nearBand, usage);
    const names: IWorldCaptureNames = {};
    for (let index = 0; index < extra.length; index += 2) {
      const flag = extra[index];
      const value = extra[index + 1];
      assert(
        (flag === "--scenario" || flag === "--world") && value && !value.startsWith("--"),
        usage,
      );
      if (flag === "--scenario") names.scenario = value;
      else names.world = value;
    }
    const read = (name: string): unknown =>
      JSON.parse(readFileSync(path.join(directory, name), "utf8"));
    const manifest = worldCaptureManifest(
      read("report.json"),
      read("capture.json"),
      build,
      Number(nearBand),
      names,
    );
    for (const label of LABELS)
      assert(
        readFileSync(path.join(directory, `${label}.png`)).length > 0,
        `missing ${label} screenshot`,
      );
    const output = path.join(directory, "world-capture.json");
    // Never replace an earlier manifest or touch the runner's captured evidence.
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(
      `TN_WORLD_CAPTURE_INVALID: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
