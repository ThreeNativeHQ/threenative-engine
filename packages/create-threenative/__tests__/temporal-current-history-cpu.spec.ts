// Execute the actual generated history graph with the existing CPU TSL bridge. Only Three's
// projection primitive and the WGSL polygon primitive are supplied as CPU arithmetic here.
import { Matrix4, PerspectiveCamera, Vector4, WebGPUCoordinateSystem } from "three";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_SAMPLE_POSITIONS } from "../templates/starter/src/render/temporalCurrentFootprintMath.js";
import {
  currentSampleOverlap,
  raw4FootprintWeights,
} from "./fixtures/temporal-footprint-oracle.js";
import { GridTexture, Value, cpuTSL } from "./temporal-resolve-cpu-grid.js";
const projectionReads = vi.hoisted(() => [] as number[][]);
vi.mock("three/tsl", () => ({
  ...cpuTSL,
  uint: (v: number) => new Value([v]),
  If: (v: Value, fn: () => void) => {
    if (v.values[0]) fn();
  },
  wgslFn: () => (sample: Value, minimum: Value, maximum: Value) =>
    new Value([
      currentSampleOverlap(
        defined(sample.values[0]),
        minimum.values as [number, number],
        maximum.values as [number, number],
      ),
    ]),
  getViewPosition: (uv: Value, depth: Value, inverse: { value: Matrix4 }) => {
    projectionReads.push([...uv.values]);
    const point = new Vector4(
      2 * defined(uv.values[0]) - 1,
      1 - 2 * defined(uv.values[1]),
      depth.values[0],
      1,
    ).applyMatrix4(inverse.value);
    return new Value([point.x / point.w, point.y / point.w, point.z / point.w]);
  },
  viewZToPerspectiveDepth: (z: Value, near: Value, far: Value) =>
    z.add(near).mul(far).div(far.sub(near).mul(z)),
  viewZToOrthographicDepth: (z: Value, near: Value, far: Value) => z.add(near).div(near.sub(far)),
}));
import { createTemporalCurrentFootprint } from "../templates/starter/src/render/temporalCurrentFootprint.js";
import { temporalDepthHasDisocclusion } from "../templates/starter/src/render/temporalDepthSamples.js";
import { createExperimentalTemporalResolve } from "../templates/starter/src/render/temporalResolve.js";

class SampleGrid extends GridTexture {
  reads = 0;
  constructor(private readonly sampled: (x: number, y: number, sample: number) => number[]) {
    super(426, 240, () => []);
  }
  override load(p: Value) {
    const placeholder = new Value([]) as Value & { level(sample: Value): Value };
    placeholder.level = (sample) => {
      this.reads++;
      return new Value(
        this.sampled(defined(p.values[0]), defined(p.values[1]), defined(sample.values[0])),
      );
    };
    return placeholder;
  }
}
const matrix = (value: Matrix4) => ({
  value,
  mul: (v: Value) =>
    new Value(
      new Vector4(...(v.values as [number, number, number, number])).applyMatrix4(value).toArray(),
    ),
});
function graph(prior: number[] = [0.9, 0.9, 0.9, 0.9], rgb: number[] = [0.2, 0.2, 0.2, 1]) {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  const depth = new SampleGrid(() => [0.9, 0, 0, 1]);
  const motion = new SampleGrid(() => [0, 0, 0, 1]);
  const colour = new SampleGrid(() => rgb);
  const node = {
    camera,
    beautyNode: new GridTexture(426, 240, () => [0.2, 0.2, 0.2, 1]),
    depthThreshold: 0.0005,
    _cameraNearFar: new Value([camera.near, camera.far]),
    _previousCameraProjectionMatrixInverse: matrix(camera.projectionMatrixInverse),
    _previousCameraWorldMatrix: matrix(new Matrix4()),
    _cameraWorldMatrixInverse: matrix(new Matrix4()),
    _currentJitterUV: new Value([0, 0]),
    _previousJitterUV: new Value([0, 0]),
  };
  const current = createTemporalCurrentFootprint(
    { colour, motion, depth, previousDepth: new GridTexture(426, 240, () => prior) } as never,
    node as never,
    new Value([0, 0]) as never,
  );
  return { current, depth, motion, colour, node };
}
const legacy = (valid: Value) => ({
  get: (name: string) =>
    ({ hasValidHistory: valid, historyUV: new Value([0.5, 0.5]), offsetUV: new Value([0, 0]) })[
      name
    ],
});
const evaluate = (current: ReturnType<typeof graph>["current"], valid = new Value([1])) =>
  current.historyValidity(
    new Value([0.5, 0.5]) as never,
    new Value([640, 360]) as never,
    legacy(valid) as never,
  ) as unknown as { get(name: string): Value };

describe("actual current history graph", () => {
  it("uses each contributor's own motion, nearest prior channel and physical unprojection site with jitter", () => {
    const pixel = [0.50321, 0.50473] as const;
    const jitter = [0.25, -0.375] as const;
    const taps = defined(raw4FootprintWeights([426, 240], [640, 360], pixel, jitter));
    const closest = defined(taps[0]);
    const motionAt = (_x: number, _y: number, s: number) => [(s + 1) / 426, (s - 1) / 240, 0, 1];
    const g = graph();
    g.node._currentJitterUV = new Value([jitter[0] / 426, jitter[1] / 240]);
    g.node._previousJitterUV = new Value([-0.4 / 426, 0.2 / 240]);
    const depth = new SampleGrid((x, y, s) => [
      x === closest.x && y === closest.y && s === closest.sample ? 0.3 : 0.9,
      0,
      0,
      1,
    ]);
    const packetReads: number[][] = [];
    const current = createTemporalCurrentFootprint(
      {
        colour: g.colour,
        motion: new SampleGrid(motionAt),
        depth,
        previousDepth: new GridTexture(426, 240, (x, y) => {
          packetReads.push([x, y]);
          return [1, 1, 1, 1];
        }),
      } as never,
      g.node as never,
      new Value([...jitter]) as never,
    );
    projectionReads.length = 0;
    const result = current.historyValidity(
      new Value([...pixel]) as never,
      new Value([640, 360]) as never,
      legacy(new Value([1])) as never,
    ) as unknown as { get(name: string): Value };
    expect(result.get("hasValidHistory").values).toEqual([1]);
    expect(packetReads).toHaveLength(taps.length);
    expect(projectionReads).toHaveLength(taps.length);
    for (const [index, tap] of taps.entries()) {
      const site = defined(CURRENT_SAMPLE_POSITIONS[tap.sample]);
      const m = motionAt(tap.x, tap.y, tap.sample);
      const point = [
        tap.x + site[0] + jitter[0] - (defined(m[0]) * 426) / 2 + 0.4,
        tap.y + site[1] + jitter[1] + (defined(m[1]) * 240) / 2 - 0.2,
      ];
      let best = Number.POSITIVE_INFINITY;
      let winner = [0, 0, 0];
      for (let y = Math.floor(defined(point[1])) - 1; y <= Math.floor(defined(point[1])) + 1; y++)
        for (let x = Math.floor(defined(point[0])) - 1; x <= Math.floor(defined(point[0])) + 1; x++)
          for (let s = 0; s < 4; s++) {
            const priorSite = defined(CURRENT_SAMPLE_POSITIONS[s]);
            const d =
              (defined(point[0]) - x - priorSite[0]) ** 2 +
              (defined(point[1]) - y - priorSite[1]) ** 2;
            if (d < best) {
              best = d;
              winner = [x, y, s];
            }
          }
      const priorSite = defined(CURRENT_SAMPLE_POSITIONS[defined(winner[2])]);
      expect(packetReads[index]).toEqual(winner.slice(0, 2));
      expect(defined(projectionReads[index])[0]).toBeCloseTo(
        (defined(winner[0]) + priorSite[0]) / 426,
        12,
      );
      expect(defined(projectionReads[index])[1]).toBeCloseTo(
        (defined(winner[1]) + priorSite[1]) / 240,
        12,
      );
    }
    const selected = motionAt(closest.x, closest.y, closest.sample);
    expect(result.get("historyUV").values[0]).toBeCloseTo(pixel[0] - defined(selected[0]) / 2, 12);
    expect(result.get("historyUV").values[1]).toBeCloseTo(pixel[1] + defined(selected[1]) / 2, 12);
  });
  it("accepts a stable packet and adds a veto for a newly revealed contributing site", () => {
    expect(evaluate(graph().current).get("hasValidHistory").values).toEqual([1]);
    expect(evaluate(graph([0.2, 0.9, 0.9, 0.9]).current).get("hasValidHistory").values).toEqual([
      0,
    ]);
  });
  it("cannot revive either original .0005 veto even when every new site matches", () => {
    for (const [centre, point] of [
      [0.2, 1],
      [1, 0.2],
    ]) {
      const g = graph();
      const original = temporalDepthHasDisocclusion(
        new Value([0.9]) as never,
        new Value([defined(centre)]) as never,
        new Value([defined(point)]) as never,
        0.0005,
      ) as unknown as Value;
      expect(original.values).toEqual([1]);
      expect(evaluate(g.current, original.oneMinus()).get("hasValidHistory").values).toEqual([0]);
      expect(g.depth.reads).toBe(0);
    }
  });
  it("retains HDR current radiance and weighted moments through the production graph", () => {
    const g = graph();
    const hdr = new SampleGrid(() => [8, 4, 2, 1]);
    const node = { beautyNode: new GridTexture(426, 240, () => [8, 4, 2, 1]) };
    const current = createTemporalCurrentFootprint(
      {
        colour: hdr,
        motion: g.motion,
        depth: g.depth,
        previousDepth: new GridTexture(426, 240, () => [1, 1, 1, 1]),
      } as never,
      node as never,
      new Value([0, 0]) as never,
    );
    const sampled = current.reconstruct(
      new Value([0.5, 0.5]) as never,
      new Value([640, 360]) as never,
    ) as unknown as { get(name: string): Value };
    expect(sampled.get("color").values).toEqual([8, 4, 2, 1]);
    expect(sampled.get("variance").values).toEqual([0, 0, 0, 0]);
  });
  it("keeps mandatory RGB clipping when the new current provider accepts history", () => {
    const g = graph(undefined, [0, 0.2, 0, 1]);
    Reflect.set(g.node, "_historyRenderTarget", {
      texture: new GridTexture(640, 360, () => [1, 0, 0, 1]),
    });
    Reflect.set(g.node, "maxVelocityLength", 128);
    Reflect.set(g.node, "useSubpixelCorrection", true);
    const rejection = { historyValidity: () => evaluate(g.current) };
    const result = createExperimentalTemporalResolve(
      g.node as never,
      {} as never,
      new Value([0, 0]) as never,
      "linear",
      "ordinary",
      rejection as never,
      g.current,
    ) as unknown as Value;
    expect(result.values[0]).toBeLessThan(1e-6);
    expect(result.values[1]).toBeCloseTo(0.2, 6);
  });
});

function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture value.");
  return value;
}
