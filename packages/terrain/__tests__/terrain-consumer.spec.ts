import { createHash } from "node:crypto";
import {
  Mask,
  Terrain,
  bakeMesh,
  bakeTerrain,
  decodeRAW16,
  encodeGLB,
  encodeRAW16,
  makeExport,
} from "@threenative/terrain";
import { toGeometry } from "@threenative/terrain/three";
import { BufferGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";

describe("public terrain consumer", () => {
  it("returns measured erosion transport, respects masks and isolates cached arrays", () => {
    const terrain = new Terrain({ size: 64, resolution: 33, seed: 123 })
      .noise({ id: "hills", amplitude: 30, scale: 20 })
      .erode({ id: "rain", method: "hydraulic", droplets: 3000, erosion: 0.15 })
      .erode({ id: "talus", method: "thermal", iterations: 12, talus: 25 });
    const state = terrain.evaluate();
    expect(state.erosion).toBeDefined();
    for (const values of Object.values(state.erosion ?? {})) {
      expect(values.length).toBe(state.height.length);
      expect(values.every((value: number) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(values.some((value: number) => value > 0)).toBe(true);
    }
    expect(Terrain.fromJSON(terrain.toJSON()).evaluate().erosion).toEqual(state.erosion);
    state.erosion?.flow.fill(999);
    expect(terrain.evaluate().erosion?.flow.some((value) => value === 999)).toBe(false);
    terrain.update("rain", { mask: Mask.none() });
    terrain.update("talus", { opacity: 0 });
    expect(
      Object.values(terrain.evaluate().erosion ?? {}).every((a) => a.every((v: number) => v === 0)),
    ).toBe(true);
  });
  it("applies a brush operation over the whole world when no brush is given", () => {
    // A layer with no `at`/`points` means "everywhere", not "nowhere": the whole-grid fallback
    // used to allocate an uninitialised Float32Array, which is all zeros, so a brushless `smooth`
    // was silently a no-op and a brushless `sculpt` moved nothing.
    const rough = () =>
      new Terrain({ size: 64, resolution: 33, seed: 1 }).noise({
        id: "n",
        amplitude: 12,
        scale: 9,
      });
    const before = rough().evaluate().height;
    const smoothed = rough().smooth({ id: "sm", iterations: 4 }).evaluate().height;
    let moved = 0;
    for (let i = 0; i < before.length; i += 1)
      moved += Math.abs((before[i] as number) - (smoothed[i] as number));
    expect(moved / before.length).toBeGreaterThan(0.001);

    const sculpted = rough().sculpt({ id: "up", strength: 5 }).evaluate().height;
    for (let i = 0; i < sculpted.length; i += 1)
      expect((sculpted[i] as number) - (before[i] as number)).toBeCloseTo(5, 5);
  });

  it("rejects missing or nonnumeric height samples before changing a recipe", () => {
    const terrain = new Terrain({ size: 16, resolution: 17 });
    const before = terrain.toJSON();
    for (const values of [[0, 1, 2, "3"], [0, 1, 2, null], [0, 1, 2, undefined], new Array(4)]) {
      const command = {
        op: "upsert",
        layer: {
          id: "bad-map",
          type: "heightmap",
          params: { data: { width: 2, height: 2, values } },
        },
      };
      expect(() => terrain.applyPatch([command as never])).toThrow();
      expect(terrain.toJSON()).toEqual(before);
    }
  });
  it("applies a stamp's vertical offset to additive height", () => {
    const terrain = new Terrain({ size: 16, resolution: 17 })
      .noise({ id: "base", base: 5, amplitude: 0 })
      .stamp({ id: "peak", at: [0, 0], radius: 4, amplitude: 4, roughness: 0, offset: 1 });
    expect(terrain.evaluate().height[8 * 17 + 8]).toBe(10);
  });

  it("scales landform heights before offset for each blend and preserves the saved recipe", () => {
    for (const [blend, expected] of [
      ["add", 14],
      ["replace", 9],
      ["max", 9],
      ["min", 5],
    ] as const) {
      const terrain = new Terrain({ size: 16, resolution: 17 })
        .noise({ id: "base", base: 5, amplitude: 0 })
        .stamp({
          id: "peak",
          radius: [4, 2],
          amplitude: 4,
          roughness: 0,
          scale: 2,
          offset: 1,
          blend,
        });
      expect(terrain.evaluate().height[8 * 17 + 8]).toBe(expected);
      expect(Terrain.fromJSON(terrain.toJSON()).evaluate().height).toEqual(
        terrain.evaluate().height,
      );
      const before = terrain.toJSON();
      for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => terrain.update("peak", { params: { scale } })).toThrow();
        expect(terrain.toJSON()).toEqual(before);
      }
    }
  });

  it("transforms pasted and imported height footprints without clamping the outside", () => {
    const data = { width: 2, height: 2, values: [0, 2, 10, 12] };
    for (const type of ["paste", "heightmap"] as const) {
      const terrain = new Terrain({ size: 16, resolution: 17 }).noise({
        id: "base",
        base: 5,
        amplitude: 0,
      });
      terrain[type]({
        id: "mass",
        data,
        at: [2, -2],
        size: [8, 4],
        rotation: 90,
        scale: 2,
        offset: 3,
        falloff: 0,
      });
      const state = terrain.evaluate();
      expect(state.height[6 * 17 + 10]).toBe(15); // footprint centre: sample 6 * gain 2 + offset 3
      expect(state.height[8 * 17 + 10]).toBe(16); // +Z is source +X after 90 degrees
      expect(state.height[6 * 17 + 11]).toBe(10); // +X is source -Z, not an overhanging rotation
      expect(state.height[0]).toBe(5);
      expect(Terrain.fromJSON(terrain.toJSON()).evaluate().height).toEqual(state.height);
      expect(bakeTerrain(state).collision.heights).toEqual(state.height);
    }
    const original = new Terrain({ size: 16, resolution: 17 })
      .heightmap({ data, scale: 2, offset: 3 })
      .evaluate();
    expect(original.height[0]).toBe(3);
    expect(original.height[16 * 17 + 16]).toBe(27);
    expect(original.height[8 * 17 + 8]).toBe(15);
  });

  it("evaluates without DOM globals and replaces stable IDs deterministically", () => {
    expect(typeof document).toBe("undefined");
    const terrain = new Terrain({ size: 64, resolution: 33, seed: 123 })
      .noise({ id: "hills", amplitude: 12, scale: 30 })
      .flatten({ id: "pad", height: 3, mask: Mask.circle([0, 0], 8) });
    const first = terrain.evaluate();
    expect(first.height).toEqual(Terrain.fromJSON(terrain.toJSON()).evaluate().height);
    terrain.noise({ id: "hills", amplitude: 20, scale: 30 });
    expect(terrain.layers.map((layer) => layer.id)).toEqual(["hills", "pad"]);
    expect(terrain.evaluate().height).not.toEqual(first.height);
    first.height.fill(999);
    expect(terrain.evaluate().height.some((height) => height === 999)).toBe(false);
  });

  it("pins seeded noise and physically bounded erosion output", () => {
    const state = new Terrain({ size: 64, resolution: 33, seed: 123 })
      .noise({ id: "hills", amplitude: 12, scale: 30, warp: 7 })
      .erode({ id: "erode", method: "hydraulic", droplets: 90, maxSteps: 15 })
      .erode({ id: "talus", method: "thermal", iterations: 3, talus: 32 })
      .evaluate();
    // Round 17 bounds brush pickup by the downstream bed and retains suspended sediment at the
    // integration cutoff. This intentionally changes erosion; seeded noise remains unchanged.
    expect(createHash("sha256").update(state.height).digest("hex")).toBe(
      "95f7ac78b3fdd4d0c50077b83dbe6e0e9209861316a81ee8da9c682972a699b3",
    );
  });

  it("rolls back a failed multi-command edit and invalid configuration", () => {
    const terrain = new Terrain({ resolution: 17 }).noise({ id: "base" });
    const before = terrain.toJSON();
    expect(() =>
      terrain.applyPatch([
        { op: "update", id: "base", patch: { params: { amplitude: 4 } } },
        { op: "update", id: "missing", patch: { enabled: false } },
      ]),
    ).toThrow("Unknown layer");
    expect(terrain.toJSON()).toEqual(before);
    expect(() => terrain.setConfig({ size: Number.NaN })).toThrow();
    expect(terrain.toJSON()).toEqual(before);
    terrain.update("base", { mask: Mask.circle([0, 0], 8) });
    terrain.update("base", { mask: null });
    expect(terrain.layer("base").mask).toBeUndefined();
    terrain.update("base", { params: { amplitude: 4 } });
    expect(terrain.evaluate().height.every(Number.isFinite)).toBe(true);
  });

  it("supports shared brush centres and matches caller-owned geometry/collision", () => {
    const terrain = new Terrain({ size: 16, resolution: 17 }).sculpt({
      at: [0, 0],
      radius: 4,
      strength: 5,
    });
    const state = terrain.evaluate();
    expect(state.height[8 * 17 + 8]).toBe(5);
    const mesh = bakeMesh(state);
    const geometry = toGeometry(mesh);
    expect(geometry).toBeInstanceOf(BufferGeometry);
    expect(geometry.getAttribute("color")).toBeUndefined();
    expect(geometry.getAttribute("position").count).toBe(17 * 17);
    expect(geometry.index?.count).toBe(16 * 16 * 6);
    expect(mesh.positions.every(Number.isFinite)).toBe(true);
    const material = new MeshBasicMaterial({ color: "magenta" });
    const object = new Mesh(geometry, material);
    object.updateMatrixWorld(true);
    const hit = new Raycaster(new Vector3(0, 100, 0), new Vector3(0, -1, 0)).intersectObject(
      object,
    )[0];
    expect(hit?.point.y).toBeCloseTo(5, 5);
    expect(hit?.face?.normal.y).toBeGreaterThan(0);
    expect(bakeTerrain(state).collision.heights).toEqual(state.height);
    let disposed = false;
    geometry.addEventListener("dispose", () => {
      disposed = true;
    });
    expect(disposed).toBe(false);
    geometry.dispose();
    expect(disposed).toBe(true);
    expect(state.height[8 * 17 + 8]).toBe(5);
    material.dispose();
  });

  it("accepts explicit surface colours and rejects malformed palettes", () => {
    const state = new Terrain({ resolution: 17 }).evaluate();
    const palette = Array.from({ length: 8 }, () => [0.25, 0.5, 0.75] as const);
    const mesh = bakeMesh(state, { palette });
    expect(mesh.colors?.length).toBe(mesh.positions.length);
    expect(toGeometry(mesh).getAttribute("color").count).toBe(mesh.positions.length / 3);
    expect(() => bakeMesh(state, { palette: [] })).toThrow();
  });

  it("round-trips numerical exports and labels the legacy terrain-only GLB", async () => {
    const terrain = new Terrain({ resolution: 17 }).sculpt({ at: [0, 0], radius: 50, strength: 2 });
    const state = terrain.evaluate();
    const bytes = encodeRAW16(state.height, { min: 0, max: 3 });
    const decoded = decodeRAW16(bytes, { width: 17, height: 17, min: 0, max: 3 });
    expect(decoded.values[8 * 17 + 8]).toBeCloseTo(2, 4);
    expect(() =>
      decodeRAW16(bytes.subarray(1), { width: 17, height: 17, min: 0, max: 3 }),
    ).toThrow();
    const glb = await makeExport(state, terrain.toJSON(), "glb");
    expect(new DataView(glb.bytes.buffer).getUint32(0, true)).toBe(0x46546c67);
    expect(glb.name).toBe("terrain.glb");
  });
  it("rejects empty and malformed GLB mesh data before encoding", () => {
    const mesh = bakeMesh(new Terrain({ resolution: 17 }).evaluate());
    expect(() => encodeGLB([])).toThrow();
    const wrongArrays = { ...mesh };
    Reflect.set(wrongArrays, "positions", new Float64Array(mesh.positions));
    expect(() => encodeGLB(wrongArrays)).toThrow();
    mesh.positions[0] = Number.NaN;
    expect(() => encodeGLB(mesh)).toThrow();
    expect(() => toGeometry(mesh)).toThrow();
  });
});
