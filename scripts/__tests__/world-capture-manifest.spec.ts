import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, it } from "vitest";
import type { IStandalonePlaytestReport } from "../../packages/playtest/src/runner/shared.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { buildWorldVisualBundle } from "../world-visual-gate.js";

const repo = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const write = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const labels = [
  "phase477-pose-start",
  ...Array.from({ length: 32 }, (_, i) => `phase477-walk-${String(i + 1).padStart(2, "0")}`),
  "phase477-pose-end",
];

async function fixture() {
  const root = await makeTempDir("world-capture-manifest-");
  roots.push(root);
  const capture = {
    adapter: { vendor: "nvidia", description: "NVIDIA RTX 2080" },
    browserArgs: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    captureMethod: "page.screenshot" as const,
    rendererKind: "webgpu" as const,
    target: "web",
    viewport: { width: 16, height: 16 },
  };
  const landmarks = [
    { id: "yard_crate_a", position: [-100, 1, 0] },
    { id: "yard_crate_b", position: [-30, 1, -20] },
  ];
  // Synthetic runner-shaped data for schema integration only, never actual capture evidence.
  const report = {
    pass: true,
    runtime: "web",
    target: "web",
    scenario: "phase477-world-capture",
    capture,
    assertionResults: [{ id: "diagnostics", pass: true }],
    diagnostics: [],
    observations: {
      console: [],
      hud: {},
      network: [],
      resources: {},
      componentSeries: labels.map((label, i) => {
        const step = Math.min(i, 32);
        const x = Math.min(-160 + (step * 64) / 6, 180);
        return {
          label,
          tick: 11 * i,
          snapshots: {
            world: {
              cameraPosition: [x, 24, 0],
              cameraTarget: [x + 40, 10, 0],
              flyTimeMs: (step * 1_000) / 6,
              landmarks,
            },
          },
        };
      }),
    },
  } satisfies Pick<
    IStandalonePlaytestReport,
    | "pass"
    | "runtime"
    | "target"
    | "scenario"
    | "capture"
    | "assertionResults"
    | "diagnostics"
    | "observations"
  >;
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i / 4) % 256;
    png.data[i + 1] = 100;
    png.data[i + 2] = 255 - ((i / 4) % 256);
    png.data[i + 3] = 255;
  }
  write(path.join(root, "report.json"), report);
  write(path.join(root, "capture.json"), capture);
  for (const label of labels) writeFileSync(path.join(root, `${label}.png`), PNG.sync.write(png));
  return { root, report, capture };
}
function run(root: string, ...flags: string[]) {
  return spawnSync(
    path.join(repo, "node_modules/.bin/tsx"),
    ["scripts/world-capture-manifest.ts", root, "unit-test-build", "30", ...flags],
    { cwd: repo, encoding: "utf8" },
  );
}
/** Rewrites the synthetic WorldProbe route as another game's capture, at the same sample count. */
function asOtherWorld(report: ReturnType<typeof read>, xAt: (i: number) => number) {
  report.scenario = "machinefall-world-capture";
  for (const [i, sample] of report.observations.componentSeries.entries()) {
    sample.snapshots.world.cameraPosition = [xAt(i), 6, 0];
    sample.snapshots.world.cameraTarget = [xAt(i) + 12, 3, 0];
  }
  return report;
}
/** A game's own setup step (a loading overlay, a drain) samples the series with no capture label. */
function setupSample(label: string, landmarks: unknown) {
  return {
    label,
    tick: 3,
    snapshots: {
      world: {
        cameraPosition: [-9999, 9999, -9999],
        cameraTarget: [-9999, 9999, -9999],
        flyTimeMs: 0,
        landmarks,
      },
    },
  };
}

it("extracts actual observed values and feeds the gate without rewriting captured artifacts", async () => {
  const f = await fixture();
  const before = readFileSync(path.join(f.root, "capture.json"));
  const result = run(f.root);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const file = path.join(f.root, "world-capture.json");
  const manifest = read(file);
  expect(manifest.walk).toHaveLength(33);
  expect(manifest.samePose.map((frame: { id: string }) => frame.id)).toEqual([
    labels[0],
    labels[8],
    labels[16],
    labels[24],
    // The walk's last frame: content that only appears there produces no transition to judge.
    labels[32],
  ]);
  expect(manifest.walk[8]).toMatchObject({
    position: f.report.observations.componentSeries[8]?.snapshots.world.cameraPosition,
    timeMs: f.report.observations.componentSeries[8]?.snapshots.world.flyTimeMs,
  });
  expect(readFileSync(path.join(f.root, "capture.json"))).toEqual(before);
  // Both synthetic arms exercise importer/gate schema interoperability, not visual acceptance.
  const out = path.join(f.root, "gate");
  expect(buildWorldVisualBundle(file, file, out).bundleSha256).toMatch(/^[a-f0-9]{64}$/);
});

it.each([
  "failed",
  "wrong-target",
  "missing-label",
  "nonfinite-pose",
  "truncated-route",
  "changed-landmark",
  "different-capture",
])("rejects %s evidence", async (defect) => {
  const f = await fixture();
  const report = read(path.join(f.root, "report.json"));
  const samples = report.observations.componentSeries;
  if (defect === "failed") report.pass = false;
  if (defect === "wrong-target") report.target = "desktop";
  if (defect === "missing-label") samples.splice(8, 1);
  if (defect === "nonfinite-pose") samples[8].snapshots.world.cameraPosition[0] = null;
  if (defect === "truncated-route") samples.at(-1).snapshots.world.cameraPosition[0] = 160;
  if (defect === "changed-landmark") samples[8].snapshots.world.landmarks[0].position[0] = 99;
  if (defect === "different-capture") report.capture.adapter.description = "another adapter";
  write(path.join(f.root, "report.json"), report);
  const result = run(f.root);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("TN_WORLD_CAPTURE_INVALID");
});

it("refuses to overwrite an existing manifest", async () => {
  const f = await fixture();
  const file = path.join(f.root, "world-capture.json");
  writeFileSync(file, "previous evidence");
  expect(run(f.root).status).toBe(2);
  expect(readFileSync(file, "utf8")).toBe("previous evidence");
});

it("imports another game's route under the names it names", async () => {
  const f = await fixture();
  const report = asOtherWorld(read(path.join(f.root, "report.json")), (i) => Math.min(i, 32));
  write(path.join(f.root, "report.json"), report);
  const flags = ["--scenario", "machinefall-world-capture", "--world", "Machinefall"];
  // The defaults must not silently accept another game's capture.
  expect(run(f.root).status).toBe(2);
  const result = run(f.root, ...flags);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const manifest = read(path.join(f.root, "world-capture.json"));
  expect(manifest.world).toBe("Machinefall");
  expect(manifest.route).toBe("machinefall-world-capture");
  expect(manifest.walk).toHaveLength(33);
  expect(manifest.samePose.map((frame: { id: string }) => frame.id)).toEqual([
    labels[0],
    labels[8],
    labels[16],
    labels[24],
    // The walk's last frame: content that only appears there produces no transition to judge.
    labels[32],
  ]);
});

it("rejects another game's capture whose walk never moves", async () => {
  const f = await fixture();
  const report = asOtherWorld(read(path.join(f.root, "report.json")), () => 5);
  write(path.join(f.root, "report.json"), report);
  const result = run(f.root, "--scenario", "machinefall-world-capture", "--world", "Machinefall");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Machinefall route never moved");
});

it("imports another game's turning route and endpoint hold without changing its observed poses", async () => {
  const f = await fixture();
  const report = asOtherWorld(read(path.join(f.root, "report.json")), (i) => {
    const step = Math.min(i, 30);
    return step <= 16 ? step : 16 - (step - 16) / 2;
  });
  write(path.join(f.root, "report.json"), report);
  const result = run(f.root, "--scenario", "machinefall-world-capture", "--world", "Machinefall");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const manifest = read(path.join(f.root, "world-capture.json"));
  expect(manifest.walk[17].position).toEqual([15.5, 6, 0]);
  expect(manifest.walk[30].position).toEqual([9, 6, 0]);
  expect(manifest.walk[32].position).toEqual([9, 6, 0]);
});

it.each(["stationary", "nonchronological"])(
  "rejects another game's %s walk interval",
  async (defect) => {
    const f = await fixture();
    const report = asOtherWorld(read(path.join(f.root, "report.json")), (i) => Math.min(i, 32));
    const samples = report.observations.componentSeries;
    if (defect === "stationary")
      samples[8].snapshots.world.cameraPosition = samples[7].snapshots.world.cameraPosition;
    else samples[8].snapshots.world.flyTimeMs = samples[7].snapshots.world.flyTimeMs;
    write(path.join(f.root, "report.json"), report);
    const result = run(f.root, "--scenario", "machinefall-world-capture", "--world", "Machinefall");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("walk is not chronological or forward-moving");
  },
);

it("rejects an endpoint hold that departs before returning to the endpoint", async () => {
  const f = await fixture();
  const report = asOtherWorld(read(path.join(f.root, "report.json")), (i) => {
    const step = Math.min(i, 32);
    return step === 17 || step === 18 || step === 32 ? 12 : step;
  });
  write(path.join(f.root, "report.json"), report);
  const result = run(f.root, "--scenario", "machinefall-world-capture", "--world", "Machinefall");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("walk is not chronological or forward-moving");
});

it("still rejects a WorldProbe walk interval that reverses X", async () => {
  const f = await fixture();
  const report = read(path.join(f.root, "report.json"));
  const samples = report.observations.componentSeries;
  samples[8].snapshots.world.cameraPosition[0] = samples[7].snapshots.world.cameraPosition[0] - 1;
  write(path.join(f.root, "report.json"), report);
  const result = run(f.root);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("walk is not chronological or forward-moving");
});

it("imports only the capture labels when a game's setup steps sample too", async () => {
  const f = await fixture();
  const report = read(path.join(f.root, "report.json"));
  const series = report.observations.componentSeries;
  const landmarks = series[0].snapshots.world.landmarks;
  series.unshift(setupSample("loading-up", landmarks), setupSample("overlay-down", landmarks));
  series.push(setupSample("drain-loads", landmarks));
  write(path.join(f.root, "report.json"), report);
  const result = run(f.root);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const manifest = read(path.join(f.root, "world-capture.json"));
  // The 34 capture labels are the only frames: 33 in the walk, the 34th the settle compared to it.
  expect(manifest.walk.map((frame: { id: string }) => frame.id)).toEqual(labels.slice(0, 33));
  expect(JSON.stringify(manifest)).not.toContain("-9999");
});

it("still rejects a capture missing one label when setup samples pad the count", async () => {
  const f = await fixture();
  const report = read(path.join(f.root, "report.json"));
  const series = report.observations.componentSeries;
  const landmarks = series[0].snapshots.world.landmarks;
  series.splice(8, 1);
  series.push(setupSample("drain-loads", landmarks));
  write(path.join(f.root, "report.json"), report);
  expect(series).toHaveLength(34);
  const result = run(f.root);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("incomplete capture labels");
});

it("imports another game's eased settle height but still refuses a settle that moved", async () => {
  const f = await fixture();
  const report = asOtherWorld(read(path.join(f.root, "report.json")), (i) => Math.min(i, 32));
  const settle = report.observations.componentSeries.at(-1);
  settle.snapshots.world.cameraPosition[1] = 5.25;
  write(path.join(f.root, "report.json"), report);
  const flags = ["--scenario", "machinefall-world-capture", "--world", "Machinefall"];
  const eased = run(f.root, ...flags);
  expect(eased.stderr).toBe("");
  expect(eased.status).toBe(0);
  settle.snapshots.world.cameraPosition[0] = 33;
  write(path.join(f.root, "report.json"), report);
  const moved = run(f.root, ...flags);
  expect(moved.status).toBe(2);
  expect(moved.stderr).toContain("route moved during settle");
});

it("still refuses WorldProbe's own settle frame when only its height moved", async () => {
  const f = await fixture();
  const report = read(path.join(f.root, "report.json"));
  report.observations.componentSeries.at(-1).snapshots.world.cameraPosition[1] = 25;
  write(path.join(f.root, "report.json"), report);
  const result = run(f.root);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("route moved during settle");
});
