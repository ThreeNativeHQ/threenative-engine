import { Scene } from "three";
import { vec3 } from "three/tsl";
import { describe, expect, it, vi } from "vitest";
import { createRealisticOcean } from "../template-assets/realistic-ocean/src/realisticOcean.js";
import {
  SEA,
  SEA_STATE,
  createRealisticMaps,
  createRealisticSea,
  createRealisticWaterMesh,
} from "../template-assets/realistic-ocean/src/render/realisticSea.js";
import { SeaMaps } from "../template-assets/realistic-ocean/src/render/realisticSeaMaps.js";

// Real Three.js/engine nodes, not a fake shader API. This catches graph construction and lifecycle
// errors; it does not compile WGSL or prove pixels without a WebGPU adapter.
function fakeMirror() {
  return {
    reflectionAt: () => vec3(0.2, 0.3, 0.4),
    dispose: vi.fn(),
  };
}

function fakeContext(options: { failOnAdd?: number } = {}) {
  const scene = new Scene();
  const cancelled: boolean[] = [];
  const dispatched: unknown[][] = [];
  let adds = 0;
  const ctx = {
    renderer: {
      kind: "webgpu",
      raw: { isWebGPURenderer: true },
      softwareAdapter: undefined,
      compute: (nodes: unknown) => dispatched.push(Array.isArray(nodes) ? nodes : [nodes]),
    },
    scene,
    camera: undefined,
    every: () => {
      const index = cancelled.push(false) - 1;
      return {
        cancel: () => {
          cancelled[index] = true;
        },
      };
    },
    add: (object: Parameters<Scene["add"]>[0]) => {
      adds += 1;
      if (adds === options.failOnAdd) throw new Error("add failed");
      scene.add(object);
      return object;
    },
  } as unknown as Parameters<typeof createRealisticOcean>[0];
  return { ctx, scene, cancelled, dispatched };
}

describe("realistic ocean graph", () => {
  it("builds three cascades and a material with every shaded channel", () => {
    const ocean = createRealisticSea();
    const maps = createRealisticMaps(ocean);
    const mirror = fakeMirror();
    const surface = createRealisticWaterMesh(ocean, maps, mirror);
    try {
      expect(ocean.cascades).toHaveLength(3);
      expect(ocean.resolution).toBe(SEA.resolution);
      const material = surface.mesh.material as unknown as Record<string, unknown>;
      for (const channel of [
        "positionNode",
        "normalNode",
        "colorNode",
        "emissiveNode",
        "roughnessNode",
      ])
        expect(material[channel], channel).toBeDefined();
      // Both foam grids and every cascade's derivatives are reachable by the material.
      expect(maps.foam(0)).toBeDefined();
      expect(maps.foam(1)).toBeDefined();
      for (let c = 0; c < 3; c += 1) {
        expect(maps.slope(c)).toBeDefined();
        expect(maps.shear(c)).toBeDefined();
      }
      expect(() => maps.foam(2)).toThrow("no foam level");
      expect(() => maps.slope(3)).toThrow("no cascade");
    } finally {
      surface.dispose();
      maps.detach();
      ocean.detach();
    }
    expect(mirror.dispose).toHaveBeenCalledTimes(1);
  });

  it("builds the cheap software material without the maps' normals, foam or mirror", () => {
    const ocean = createRealisticSea();
    const maps = createRealisticMaps(ocean);
    const surface = createRealisticWaterMesh(ocean, maps, fakeMirror(), { software: true });
    try {
      const material = surface.mesh.material as unknown as Record<string, unknown>;
      expect(material.positionNode).toBeDefined();
      expect(material.emissiveNode).toBeNull();
      expect(material.normalNode).toBeNull();
    } finally {
      surface.dispose();
      maps.detach();
      ocean.detach();
    }
  });

  it("rejects a non-finite sun and keeps the old one", () => {
    const ocean = createRealisticSea();
    const maps = createRealisticMaps(ocean);
    const surface = createRealisticWaterMesh(ocean, maps, fakeMirror(), { software: true });
    try {
      expect(() => surface.setSun([0, 0, 0])).toThrow("non-zero");
      expect(() => surface.setSun([Number.NaN, 1, 0])).toThrow("non-zero");
      surface.setSun([2, 2, 0]);
    } finally {
      surface.dispose();
      maps.detach();
      ocean.detach();
    }
  });

  it("refuses a foam grid on a cascade the sea does not have", () => {
    const ocean = createRealisticSea();
    try {
      expect(
        () =>
          new SeaMaps(ocean, {
            foamHalfLife: 4,
            foamThreshold: 0.8,
            foamGain: 4,
            foamCascades: [5],
          }),
      ).toThrow("does not have");
      expect(
        () =>
          new SeaMaps(ocean, {
            foamHalfLife: 0,
            foamThreshold: 0.8,
            foamGain: 4,
            foamCascades: [0],
          }),
      ).toThrow("foamHalfLife");
    } finally {
      ocean.detach();
    }
  });
});

describe("realistic ocean lifecycle", () => {
  it("registers the sea, its maps and its mesh exactly once, and dispatches each pass once per step", () => {
    const { ctx, scene, dispatched } = fakeContext();
    const water = createRealisticOcean(ctx, { reflection: false });
    try {
      expect(scene.children).toContain(water.ocean);
      expect(scene.children).toContain(water.maps);
      expect(scene.children).toContain(water.mesh);
      expect(scene.children).toHaveLength(3);
      // The first dispatch clears the foam grids, then derivatives and foam: two `compute()` calls
      // would be two command-buffer submits.
      water.maps.process(ctx.renderer as never);
      expect(dispatched).toHaveLength(1);
      const first = dispatched[0] as unknown[];
      water.maps.process(ctx.renderer as never);
      const second = dispatched[1] as unknown[];
      expect(first.length - second.length).toBe(2);
      expect(dispatched).toHaveLength(2);
      water.reset();
      water.maps.process(ctx.renderer as never);
      expect((dispatched[2] as unknown[]).length).toBe(first.length);
    } finally {
      water.dispose();
    }
  });

  it("releases every resource once on dispose, however many times it is called", () => {
    const { ctx, scene, cancelled } = fakeContext();
    const water = createRealisticOcean(ctx, { reflection: false });
    const geometry = vi.fn();
    water.mesh.geometry.addEventListener("dispose", geometry);
    water.dispose();
    water.dispose();
    expect(water.disposed).toBe(true);
    expect(water.ocean.released).toBe(true);
    expect(water.maps.released).toBe(true);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(scene.children).toHaveLength(0);
    expect(cancelled).toEqual([true]);
    expect(() => water.follow(1, 2)).toThrow("disposed");
    expect(() => water.reset()).toThrow("disposed");
    expect(() => water.sampleHeight(0, 0)).toThrow("disposed");
  });

  it("disposes through scene removal of the mesh", () => {
    const { ctx, scene } = fakeContext();
    const water = createRealisticOcean(ctx, { reflection: false });
    scene.remove(water.mesh);
    expect(water.disposed).toBe(true);
    expect(water.ocean.released).toBe(true);
    expect(water.maps.released).toBe(true);
  });

  it("survives repeated create and dispose with nothing left behind", () => {
    const { ctx, scene, cancelled } = fakeContext();
    for (let i = 0; i < 6; i += 1) createRealisticOcean(ctx, { reflection: false }).dispose();
    expect(scene.children).toHaveLength(0);
    expect(cancelled).toHaveLength(6);
    expect(cancelled.every(Boolean)).toBe(true);
  });

  it("releases what it built when initialization fails, and reports the original failure", () => {
    const { ctx, scene } = fakeContext({ failOnAdd: 2 });
    expect(() => createRealisticOcean(ctx, { reflection: false })).toThrow("add failed");
    expect(scene.children).toHaveLength(0);
  });

  it("refuses a renderer that is not WebGPU", () => {
    const { ctx } = fakeContext();
    const webgl = {
      ...(ctx as object),
      renderer: { kind: "webgl", raw: {} },
    } as unknown as Parameters<typeof createRealisticOcean>[0];
    expect(() => createRealisticOcean(webgl)).toThrow("requires ThreeNative's WebGPU renderer");
  });

  it("reports no height before a copy lands, never zero", () => {
    const { ctx } = fakeContext();
    const water = createRealisticOcean(ctx, { reflection: false });
    try {
      expect(water.sampleHeight(3, 4)).toBeUndefined();
      vi.spyOn(water.ocean, "sampleHeight").mockReturnValue({
        height: 0.4,
        staleFrames: 3,
        verticalVelocity: 0.1,
      });
      expect(water.sampleHeight(3, 4)).toMatchObject({ height: 0.4, staleFrames: 3 });
    } finally {
      water.dispose();
    }
  });

  it("keeps the shipped sea state internally consistent", () => {
    expect(SEA.windSpeed).toBe(SEA_STATE.wind.speed);
    expect(SEA.readbackResolution).toBeGreaterThan(0);
    // The CPU height copy must be finer than a hull is long, over the broadest cascade.
    expect((SEA.cascades[0]?.patchSize ?? 0) / SEA.readbackResolution).toBeLessThanOrEqual(3);
  });
});
