import { readFileSync } from "node:fs";
import path from "node:path";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  type ISnowFootprint,
  type ISnowFootprintSample,
  SnowField,
  snowDiscFootprint,
} from "../src/snow-field.js";
import { Heightfield } from "../src/world.js";

/**
 * The fixture was produced by running the original ICEFIELD study's own snow code — the same
 * functions copied verbatim from lines 85-193 of the supplied document — through one deterministic
 * scenario. Comparing against it is how the extraction proves it reproduced the source's
 * footprint state and deposition instead of re-inventing them.
 */
interface ISourceSnapshot {
  readonly activeCells: number;
  readonly samples: readonly (readonly number[])[];
}

interface ISourceFixture {
  readonly afterDepth: ISourceSnapshot;
  readonly afterRecovery: ISourceSnapshot;
  readonly afterReset: ISourceSnapshot;
  readonly afterStamps: ISourceSnapshot;
  readonly penetrations: readonly number[];
  readonly points: readonly (readonly [number, number])[];
  readonly scenario: {
    readonly depth: number;
    readonly depthOverride: number;
    readonly recovery: {
      readonly deposition: number;
      readonly dt: number;
      readonly steps: number;
      readonly wind: number;
    };
    readonly resolution: number;
    readonly size: number;
    readonly stamps: readonly {
      readonly angle: number;
      readonly hardness: number;
      readonly mass: number;
      readonly x: number;
      readonly z: number;
    }[];
  };
  readonly source: string;
  readonly steps: number;
  readonly lastSink: number;
}

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures", "snow-field-source.json"), "utf8"),
) as ISourceFixture;

const CHANNELS = ["indent", "bank", "compaction", "disturbance"] as const;
/** The study's boot covered 0.074 m² and pushed 80 kg times gravity through it. */
const SOURCE_BOOT_AREA = 0.074;
const SOURCE_BOOT_MASS = 80;
const GRAVITY = 9.81;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The study's terrain function, kept here so the fixture can rebuild the same ground. */
function sourceTerrain(x: number, z: number): number {
  const radius = Math.hypot(x, z);
  const hills =
    smoothstep(14, 42, radius) * (0.8 + 0.85 * Math.sin(x * 0.085 + 1) * Math.cos(z * 0.075));
  return (
    0.2 * Math.sin(x * 0.16) * Math.cos(z * 0.12) +
    0.09 * Math.sin(x * 0.39 + z * 0.21) +
    0.07 * Math.cos(z * 0.53 - x * 0.24) +
    hills
  );
}

const ZERO_SAMPLE: ISnowFootprintSample = {
  bank: 0,
  coverage: 0,
  disturbance: 0,
  relief: 0,
  shape: 0,
};

/**
 * The study's rounded boot sole with its chevrons, groove and raised rim, expressed through the
 * generalized footprint contract. Boot design belongs to a game; this copy exists only so the
 * source fixture can be reproduced exactly.
 */
function sourceBootFootprint(): ISnowFootprint {
  return {
    extent: 0.48,
    sample: (x, z) => {
      const width = 0.13 + smoothstep(-0.22, 0.15, z) * 0.013;
      const qx = Math.abs(x) - (width - 0.052);
      const qz = Math.abs(z) - (0.255 - 0.052);
      const sdf =
        Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - 0.052;
      if (sdf > 0.105) return ZERO_SAMPLE;
      const tread = Math.max(0, Math.cos(z * 83 + Math.abs(x) * 30)) ** 8;
      const groove = (1 - smoothstep(0.009, 0.023, Math.abs(x))) * 0.004;
      const rim = sdf > 0 ? Math.exp(-(((sdf - 0.027) / 0.027) ** 2)) : 0;
      return {
        bank: rim * (0.78 + 0.22 * Math.sin(x * 94 + z * 63)),
        coverage: 1 - smoothstep(-0.038, 0.008, sdf),
        disturbance: rim * 0.5,
        relief: 0.012 * tread + groove,
        shape: 0.9 + 0.1 * smoothstep(-0.2, 0.15, z),
      };
    },
  };
}

function fixtureTerrain(): Heightfield {
  return Heightfield.fromSampler({
    columns: fixture.scenario.resolution,
    depth: fixture.scenario.size,
    origin: { x: 0, z: 0 },
    rows: fixture.scenario.resolution,
    sampleHeight: sourceTerrain,
    width: fixture.scenario.size,
  });
}

function snapshot(snow: SnowField): ISourceSnapshot {
  const samples = fixture.points.map(([x, z]) => {
    const value = snow.sample(x, z);
    return [value.indent, value.bank, value.compaction, value.disturbance];
  });
  return { activeCells: snow.activeCells, samples };
}

/** Worst per-channel difference over every fixture point, plus an exact active-cell comparison. */
function worstDifference(actual: ISourceSnapshot, expected: ISourceSnapshot): number {
  expect(actual.activeCells, "active cells").toBe(expected.activeCells);
  let worst = 0;
  for (let index = 0; index < expected.samples.length; index += 1) {
    const actualSample = actual.samples[index] as readonly number[];
    const expectedSample = expected.samples[index] as readonly number[];
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = Math.abs(
        (actualSample[channel] as number) - (expectedSample[channel] as number),
      );
      if (difference > worst) worst = difference;
      if (difference > 1e-9)
        throw new Error(
          `${CHANNELS[channel]} at fixture point ${String(index)} (${String(
            (fixture.points[index] as readonly number[])[0],
          )}, ${String((fixture.points[index] as readonly number[])[1])}) differs by ${String(
            difference,
          )}.`,
        );
    }
  }
  return worst;
}

function replaySourceScenario(): SnowField {
  const snow = new SnowField({ field: fixtureTerrain(), depth: fixture.scenario.depth });
  for (const stamp of fixture.scenario.stamps) {
    snow.stamp({
      area: SOURCE_BOOT_AREA,
      footprint: sourceBootFootprint(),
      hardness: stamp.hardness,
      load: stamp.mass * GRAVITY,
      rotation: stamp.angle,
      x: stamp.x,
      z: stamp.z,
    });
  }
  return snow;
}

/** An axis-aligned box contact: a crate corner, a plank, a platform edge. */
function boxFootprint(halfWidth: number, halfLength: number): ISnowFootprint {
  const edge = 0.02;
  return {
    extent: Math.hypot(halfWidth, halfLength) + edge,
    sample: (x, z) => {
      const inside = Math.max(Math.abs(x) - halfWidth, Math.abs(z) - halfLength);
      if (inside > edge) return ZERO_SAMPLE;
      const coverage = 1 - smoothstep(-edge, edge, inside);
      return {
        bank: inside > 0 ? 1 - inside / edge : 0,
        coverage,
        disturbance: coverage,
        relief: 0,
        shape: 1,
      };
    },
  };
}

describe("SnowField source regression", () => {
  it("reproduces the source study's footprint state through the public field", () => {
    const snow = replaySourceScenario();
    expect(snow.steps).toBe(fixture.steps);
    expect(worstDifference(snapshot(snow), fixture.afterStamps)).toBeLessThan(1e-9);
  });

  it("reaches the source's penetration for the same mass, area and hardness", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: fixture.scenario.depth });
    const measured = fixture.scenario.stamps.map((stamp) =>
      snow.stamp({
        area: SOURCE_BOOT_AREA,
        footprint: sourceBootFootprint(),
        hardness: stamp.hardness,
        load: stamp.mass * GRAVITY,
        rotation: stamp.angle,
        x: stamp.x,
        z: stamp.z,
      }),
    );
    for (let index = 0; index < measured.length; index += 1)
      expect(measured[index]).toBeCloseTo(fixture.penetrations[index] as number, 9);
    expect(snow.steps).toBe(fixture.steps);
    expect(snow.lastSink).toBeCloseTo(fixture.lastSink, 9);
  });

  it("recovers, retunes depth and resets exactly as the source did", () => {
    const snow = replaySourceScenario();
    const { deposition, dt, steps, wind } = fixture.scenario.recovery;
    for (let tick = 0; tick < steps; tick += 1) snow.recover(dt, deposition, wind);
    expect(worstDifference(snapshot(snow), fixture.afterRecovery)).toBeLessThan(1e-9);

    snow.setDepth(fixture.scenario.depthOverride);
    expect(worstDifference(snapshot(snow), fixture.afterDepth)).toBeLessThan(1e-9);

    snow.reset();
    expect(worstDifference(snapshot(snow), fixture.afterReset)).toBeLessThan(1e-9);
    expect(snow.steps).toBe(0);
    expect(snow.lastSink).toBe(0);
    expect(snow.activeCells).toBe(0);
  });
});

describe("SnowField canonical surface", () => {
  it("writes terrain plus depth plus bank minus indentation into the shared heightfield", () => {
    const field = fixtureTerrain();
    const pristine = fixtureTerrain();
    const snow = new SnowField({ field, depth: 0.28 });
    snow.stamp({
      area: 0.05,
      footprint: sourceBootFootprint(),
      load: 900,
      x: 0.4,
      z: -0.2,
    });
    for (let index = 0; index < 200; index += 1) {
      const x = -0.6 + index * 0.008;
      const sample = snow.sample(x, 0.05);
      expect(snow.heightAt(x, 0.05)).toBeCloseTo(
        pristine.heightAt(x, 0.05) + 0.28 + sample.bank - sample.indent,
        5,
      );
    }
  });

  it("keeps rendered vertices and collider samples within a millimetre of canonical heights", () => {
    const field = fixtureTerrain();
    const snow = new SnowField({ field, depth: 0.28 });
    const geometry = field.toGeometry();
    const centre = (field.rows >> 1) * field.columns + (field.columns >> 1);
    const before = geometry.getAttribute("position").getY(centre);
    snow.stamp({ area: 0.02, footprint: snowDiscFootprint(0.3), load: 2000, x: 0, z: 0 });
    const region = snow.dirtyRegion;
    expect(region).toBeDefined();
    field.refreshGeometry(geometry, region);
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const collider = field.toColliderHeights();
    expect(Math.abs(positions.getY(centre) - before)).toBeGreaterThan(0.02);

    let worst = 0;
    for (let row = 0; row < field.rows; row += 1) {
      const worldZ = field.origin.z - field.depth / 2 + (row * field.depth) / (field.rows - 1);
      for (let column = 0; column < field.columns; column += 1) {
        const index = row * field.columns + column;
        const worldX =
          field.origin.x - field.width / 2 + (column * field.width) / (field.columns - 1);
        const canonical = snow.heightAt(worldX, worldZ);
        worst = Math.max(worst, Math.abs(positions.getY(index) - canonical));
        worst = Math.max(
          worst,
          Math.abs((collider[column * field.rows + row] as number) - canonical),
        );
        worst = Math.max(worst, Math.abs(normals.getY(index) - snow.normalAt(worldX, worldZ).y));
      }
    }
    expect(worst).toBeLessThan(0.001);
  });

  it("keeps a windowed geometry refresh's bounds around every vertex", () => {
    // Flat, so the stamp's floor is below every height the bounds were first measured on.
    const field = Heightfield.fromSampler({
      columns: 65,
      depth: 4,
      origin: { x: 0, z: 0 },
      rows: 65,
      sampleHeight: () => 0,
      width: 4,
    });
    const snow = new SnowField({ field, depth: 0.28 });
    const geometry = field.toGeometry();
    field.refreshGeometry(geometry);
    snow.stamp({ area: 0.004, footprint: snowDiscFootprint(0.3), load: 5000, x: 0, z: 0 });
    field.refreshGeometry(geometry, snow.dirtyRegion);
    const box = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    if (box === null || sphere === null) throw new Error("refreshGeometry left no bounds");
    const position = geometry.getAttribute("position");
    const point = new Vector3();
    for (let index = 0; index < position.count; index += 1) {
      point.fromBufferAttribute(position, index);
      expect(box.containsPoint(point)).toBe(true);
      expect(sphere.containsPoint(point)).toBe(true);
    }
  });

  it("tracks a monotonic version and the dirty window of the surface it changed", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    const start = snow.version;
    snow.stamp({ area: 0.02, footprint: snowDiscFootprint(0.15), load: 400, x: -1, z: 2 });
    expect(snow.version).toBe(start + 1);
    const region = snow.dirtyRegion;
    expect(region?.columns).toBeLessThan(snow.columns);
    expect(region?.rows).toBeLessThan(snow.rows);
    expect(region?.column).toBeGreaterThan(0);
    expect(region?.row).toBeGreaterThan(0);
  });

  it("copies a channel window that matches sample at every cell, and rejects a window outside", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    snow.stamp({ area: 0.02, footprint: snowDiscFootprint(0.3), load: 2000, x: 0, z: 0 });
    const region = snow.dirtyRegion;
    if (region === undefined) throw new Error("the stamp reported no window");
    const indent = snow.copyChannel("indent", region);
    const compaction = snow.copyChannel("compaction", region, new Float32Array(1));
    let worst = 0;
    for (let row = 0; row < region.rows; row += 1) {
      for (let column = 0; column < region.columns; column += 1) {
        const x = snow.minimumX + (region.column + column) * snow.cellWidth;
        const z = snow.minimumZ + (region.row + row) * snow.cellDepth;
        const sample = snow.sample(x, z);
        const index = row * region.columns + column;
        worst = Math.max(worst, Math.abs((indent[index] as number) - sample.indent));
        worst = Math.max(worst, Math.abs((compaction[index] as number) - sample.compaction));
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(Math.max(...indent)).toBeGreaterThan(0.02);
    expect(() =>
      snow.copyChannel("indent", { column: snow.columns - 2, columns: 4, row: 0, rows: 1 }),
    ).toThrow(/inside the field/);
  });

  it("hands a renderer the union of every window written since it last looked", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    snow.takeDirtyRegion();
    snow.stamp({ area: 0.02, footprint: snowDiscFootprint(0.15), load: 400, x: -1, z: 2 });
    const first = snow.dirtyRegion;
    snow.stamp({ area: 0.02, footprint: snowDiscFootprint(0.15), load: 400, x: 1, z: -2 });
    const second = snow.dirtyRegion;
    const union = snow.takeDirtyRegion();
    if (first === undefined || second === undefined || union === undefined)
      throw new Error("each stamp must report a window");
    for (const part of [first, second]) {
      expect(union.column).toBeLessThanOrEqual(part.column);
      expect(union.row).toBeLessThanOrEqual(part.row);
      expect(union.column + union.columns).toBeGreaterThanOrEqual(part.column + part.columns);
      expect(union.row + union.rows).toBeGreaterThanOrEqual(part.row + part.rows);
    }
    expect(snow.takeDirtyRegion()).toBeUndefined();
  });
});

describe("SnowField contact profiles", () => {
  it("prints a boot and a disc differently, and honours rotation", () => {
    const boot = new SnowField({ field: fixtureTerrain(), depth: 0.3 });
    const disc = new SnowField({ field: fixtureTerrain(), depth: 0.3 });
    const load = 80 * GRAVITY;
    boot.stamp({ area: SOURCE_BOOT_AREA, footprint: sourceBootFootprint(), load, x: 0, z: 0 });
    disc.stamp({
      area: SOURCE_BOOT_AREA,
      footprint: snowDiscFootprint(0.153),
      load,
      x: 0,
      z: 0,
    });

    // A disc is radially symmetric; the boot is long in z and narrow in x.
    expect(disc.sample(0.13, 0).indent).toBeCloseTo(disc.sample(0, 0.13).indent, 5);
    expect(boot.sample(0, 0.2).indent).toBeGreaterThan(boot.sample(0.2, 0).indent + 0.01);
    expect(boot.sample(0, 0).indent).toBeGreaterThan(0.02);

    const turned = new SnowField({ field: fixtureTerrain(), depth: 0.3 });
    turned.stamp({
      area: SOURCE_BOOT_AREA,
      footprint: sourceBootFootprint(),
      load,
      rotation: Math.PI / 2,
      x: 0,
      z: 0,
    });
    expect(turned.sample(0.2, 0).indent).toBeGreaterThan(turned.sample(0, 0.2).indent + 0.01);
    expect(turned.sample(0.2, 0).indent).toBeCloseTo(boot.sample(0, 0.2).indent, 5);
  });

  it("responds to pressure rather than to a fixed boot constant", () => {
    const depth = 0.3;
    const load = 80 * GRAVITY;
    const concentrated = new SnowField({ field: fixtureTerrain(), depth });
    const spread = new SnowField({ field: fixtureTerrain(), depth });
    const light = new SnowField({ field: fixtureTerrain(), depth });
    concentrated.stamp({
      area: 0.02,
      footprint: snowDiscFootprint(0.08),
      load,
      x: 0,
      z: 0,
    });
    spread.stamp({ area: 0.4, footprint: snowDiscFootprint(0.36), load, x: 0, z: 0 });
    light.stamp({ area: 0.02, footprint: snowDiscFootprint(0.08), load: load / 8, x: 0, z: 0 });

    expect(concentrated.sample(0, 0).indent).toBeGreaterThan(spread.sample(0, 0).indent + 0.05);
    expect(concentrated.sample(0, 0).indent).toBeGreaterThan(light.sample(0, 0).indent + 0.02);
    expect(spread.activeCells).toBeGreaterThan(concentrated.activeCells);
  });

  it("reaches the same indentation however the contact time is split", () => {
    const depth = 0.3;
    const load = 600;
    const once = new SnowField({ field: fixtureTerrain(), depth });
    const many = new SnowField({ field: fixtureTerrain(), depth });
    once.stamp({
      area: 0.03,
      duration: 0.3,
      footprint: snowDiscFootprint(0.12),
      load,
      x: 0,
      z: 0,
    });
    for (let tick = 0; tick < 18; tick += 1)
      many.stamp({
        area: 0.03,
        duration: 0.3 / 18,
        footprint: snowDiscFootprint(0.12),
        load,
        x: 0,
        z: 0,
      });
    expect(many.sample(0, 0).indent).toBeCloseTo(once.sample(0, 0).indent, 6);
    expect(many.sample(0.1, 0.05).indent).toBeCloseTo(once.sample(0.1, 0.05).indent, 6);

    // A resting contact that has already yielded does not keep sinking without limit.
    many.stamp({
      area: 0.03,
      duration: 5,
      footprint: snowDiscFootprint(0.12),
      load,
      x: 0,
      z: 0,
    });
    expect(many.sample(0, 0).indent).toBeLessThan(depth * 0.88);
  });

  it("presses any bounded shape, not just a boot: a rotated box leaves a rectangular print", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.3 });
    snow.stamp({
      area: 0.6,
      footprint: boxFootprint(0.5, 0.2),
      load: 300,
      x: 0,
      z: 0,
    });
    expect(snow.sample(0.45, 0).indent).toBeGreaterThan(0.01);
    expect(snow.sample(0, 0.15).indent).toBeGreaterThan(0.01);
    expect(snow.sample(0.45, 0.3).indent).toBeLessThan(0.001);
    expect(snow.sample(0.7, 0).indent).toBeLessThan(0.001);
  });

  it("stamps a rolling sphere as connected track instead of one repeated hole", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.3 });
    const footprint = snowDiscFootprint(0.25);
    for (let step = 0; step < 12; step += 1)
      snow.stamp({ area: 0.2, footprint, load: 10 * GRAVITY, x: -1 + step * 0.15, z: 0.5 });
    for (let step = 0; step < 12; step += 1)
      expect(snow.sample(-1 + step * 0.15, 0.5).indent).toBeGreaterThan(0.01);
    expect(snow.sample(-1, 1.5).indent).toBeLessThan(0.001);
  });
});

describe("SnowField validation", () => {
  it("rejects malformed contacts and dimensions before it mutates anything", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    const footprint = snowDiscFootprint(0.2);
    const version = snow.version;
    const contact = { area: 0.1, footprint, load: 100, x: 0, z: 0 };
    expect(() => snow.stamp({ ...contact, area: 0 })).toThrow(/area/);
    expect(() => snow.stamp({ ...contact, area: Number.NaN })).toThrow(/area/);
    expect(() => snow.stamp({ ...contact, load: -1 })).toThrow(/load/);
    expect(() => snow.stamp({ ...contact, x: Number.POSITIVE_INFINITY })).toThrow(/x/);
    expect(() => snow.stamp({ ...contact, duration: -1 })).toThrow(/duration/);
    expect(() =>
      snow.stamp({ ...contact, footprint: { extent: 0, sample: () => ZERO_SAMPLE } }),
    ).toThrow(/extent/);
    expect(() =>
      snow.stamp({
        ...contact,
        footprint: { extent: 1000, sample: () => ZERO_SAMPLE },
      }),
    ).toThrow(/cells/);
    expect(() => snow.recover(-1, 0.1, 0.1)).toThrow(/recovery seconds/);
    expect(() => snow.recover(1, -1, 0.1)).toThrow(/deposition/);
    expect(() => snow.setDepth(-0.1)).toThrow(/depth/);
    expect(() => new SnowField({ field: fixtureTerrain(), depth: Number.NaN })).toThrow(/depth/);
    expect(snow.version).toBe(version);
  });

  it("keeps Heightfield's error contract for heightAt and normalAt, and returns zeros in sample", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    expect(() => snow.heightAt(99, 0)).toThrow(/outside its resident region/);
    expect(() => snow.normalAt(0, -99)).toThrow(/outside its resident region/);
    expect(snow.sample(99, 99)).toEqual({ bank: 0, compaction: 0, disturbance: 0, indent: 0 });
  });

  it("reports a stamp entirely outside the snowfield as a no-op", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    const version = snow.version;
    expect(
      snow.stamp({
        area: 0.02,
        footprint: snowDiscFootprint(0.2),
        load: 800,
        x: 40,
        z: 40,
      }),
    ).toBe(0);
    expect(snow.version).toBe(version);
    expect(snow.steps).toBe(0);
  });

  it("clips a straddling contact at the boundary instead of wrapping or throwing", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    const edge = snow.minimumX + 0.1;
    expect(
      snow.stamp({
        area: 0.02,
        footprint: snowDiscFootprint(0.3),
        load: 800,
        x: edge,
        z: 0,
      }),
    ).toBeGreaterThan(0);
    expect(snow.sample(snow.minimumX + 0.01, 0).indent).toBeGreaterThan(0.01);
    expect(() => snow.sample(snow.minimumX - 1, 0)).not.toThrow();
  });

  it("treats zero depth as bare ground with no indentation at all", () => {
    const field = fixtureTerrain();
    const pristine = fixtureTerrain();
    const snow = new SnowField({ field, depth: 0 });
    expect(
      snow.stamp({ area: 0.02, footprint: snowDiscFootprint(0.2), load: 900, x: 0, z: 0 }),
    ).toBe(0);
    expect(snow.sample(0, 0).indent).toBe(0);
    expect(snow.heightAt(0.5, 0.5)).toBeCloseTo(pristine.heightAt(0.5, 0.5), 6);
  });

  it("buries indentation when depth shrinks and keeps tracks when it grows", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.3 });
    snow.stamp({ area: 0.02, footprint: snowDiscFootprint(0.25), load: 1200, x: 0, z: 0 });
    const deep = snow.sample(0, 0).indent;
    snow.setDepth(0.06);
    expect(snow.sample(0, 0).indent).toBeLessThan(deep);
    expect(snow.sample(0, 0).indent).toBeLessThanOrEqual(0.06 * 0.88 + 1e-6);
    snow.setDepth(0.4);
    expect(snow.sample(0, 0).indent).toBeGreaterThan(0);
  });

  it("reports the bytes it retains", () => {
    const snow = new SnowField({ field: fixtureTerrain(), depth: 0.28 });
    const cells = snow.columns * snow.rows;
    expect(snow.memoryBytes).toBe(cells * 5 * Float32Array.BYTES_PER_ELEMENT);
  });
});
