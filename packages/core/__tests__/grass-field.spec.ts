import {
  BufferAttribute,
  BufferGeometry,
  type InstancedBufferGeometry,
  type Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRASS_FIELD_ATTRIBUTES,
  GrassField3D,
  type IGrassField3DOptions,
  fastAtan2,
} from "../src/grass-field.js";

function blade() {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2]);
  return { geometry, lods: [{ start: 0, count: 3 }], reach: 1 };
}

// A 4 × 4 chunk field, 48 m square: chunkSize 12, bounded, a draw distance that holds a few chunks.
function field(options: Partial<IGrassField3DOptions> = {}) {
  return new GrassField3D({
    blade: blade(),
    material: () => new MeshBasicMaterial(),
    getHeight: (x, z) => Math.sin(x * 0.1) + Math.cos(z * 0.1),
    bounds: { minX: 0, minZ: 0, maxX: 48, maxZ: 48 },
    density: 4,
    drawDistance: 20,
    ...options,
  });
}

function cameraAt(x: number, z: number) {
  const camera = new PerspectiveCamera();
  camera.position.set(x, 2, z);
  camera.updateMatrixWorld();
  return camera;
}

function buffers(grass: GrassField3D) {
  return (grass.children as Mesh[])
    .map((mesh) => {
      const geo = mesh.geometry as InstancedBufferGeometry;
      return [mesh.name, Array.from(geo.getAttribute(GRASS_FIELD_ATTRIBUTES.root).array)] as const;
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

afterEach(() => vi.restoreAllMocks());

describe("GrassField3D", () => {
  it("scatters the same instance buffers from the same seed", () => {
    const a = field({ seed: 7 });
    const b = field({ seed: 7 });
    const c = field({ seed: 8 });
    for (const grass of [a, b, c]) {
      grass.prewarm();
      grass.update(cameraAt(24, 24));
    }
    expect(a.stats.chunks).toBe(16);
    expect(buffers(a)).toEqual(buffers(b));
    expect(buffers(a)).not.toEqual(buffers(c));
  });

  it("builds no chunk past the per-frame budget", () => {
    let now = 0;
    // Every clock read moves 1 ms: a 2.5 ms budget admits the first chunk and two more, never four.
    vi.spyOn(performance, "now").mockImplementation(() => {
      now += 1;
      return now;
    });
    const grass = field({ buildBudgetMs: 2.5 });
    grass.update(cameraAt(24, 24));
    expect(grass.stats.built).toBeGreaterThanOrEqual(1);
    expect(grass.stats.built).toBeLessThanOrEqual(3);
    expect(grass.stats.pending).toBeGreaterThan(0);
    let frames = 1;
    while (grass.stats.pending > 0 && frames < 50) {
      const before = grass.stats.built;
      grass.update(cameraAt(24, 24));
      expect(grass.stats.built - before).toBeLessThanOrEqual(3);
      frames++;
    }
    expect(grass.stats.pending).toBe(0);
  });

  it("rebuilds no chunk while the camera oscillates on the draw edge", () => {
    const grass = field({ bounds: null, drawDistance: 20 });
    grass.prewarm();
    grass.update(cameraAt(0, 0));
    const settled = grass.stats.built;
    for (let i = 0; i < 40; i++) grass.update(cameraAt(i % 2 === 0 ? 1 : 0, 0));
    const afterSwing = grass.stats.built;
    for (let i = 0; i < 40; i++) grass.update(cameraAt(i % 2 === 0 ? 1 : 0, 0));
    expect(afterSwing).toBeGreaterThanOrEqual(settled);
    expect(grass.stats.built).toBe(afterSwing);
  });

  it("thins far chunks and flattens grass under a pusher", () => {
    const grass = field({
      bounds: null,
      drawDistance: 60,
      thinStart: 5,
      thinEnd: 30,
      farDensity: 0.2,
    });
    grass.prewarm();
    grass.update(cameraAt(0, 0));
    const counts = (grass.children as Mesh[]).map((m) => {
      const d = Math.hypot(m.position.x + 6, m.position.z + 6);
      return [d, (m.geometry as InstancedBufferGeometry).instanceCount] as const;
    });
    const near = counts.filter(([d]) => d < 12).map(([, n]) => n);
    const far = counts.filter(([d]) => d > 40).map(([, n]) => n);
    expect(Math.min(...near)).toBeGreaterThan(Math.max(...far));
    grass.pushers[0]?.set(0, 0, 0, 1.2);
    expect(grass.pressAt(0.3, 0, 0)).toBeGreaterThan(grass.pressAt(3, 0, 0));
    expect(grass.pressAt(3, 0, 0)).toBe(0);
  });

  it("writes nothing to its meshes or uniforms while the camera stands still", () => {
    // On the owned engine every write crosses into the engine and can re-plan the frame.
    const grass = field();
    const camera = cameraAt(20, 20);
    for (let i = 0; i < 4; i++) grass.update(camera);
    const writes: string[] = [];
    const watch = (target: object, key: string, label: string) => {
      let value = (target as Record<string, unknown>)[key];
      Object.defineProperty(target, key, {
        configurable: true,
        get: () => value,
        set: (next: unknown) => {
          writes.push(label);
          value = next;
        },
      });
    };
    for (const mesh of grass.children as Mesh[]) {
      const geo = mesh.geometry as InstancedBufferGeometry;
      watch(mesh, "visible", `${mesh.name}.visible`);
      watch(mesh, "receiveShadow", `${mesh.name}.receiveShadow`);
      watch(geo, "instanceCount", `${mesh.name}.instanceCount`);
      vi.spyOn(geo, "setDrawRange").mockImplementation(() =>
        writes.push(`${mesh.name}.setDrawRange`),
      );
    }
    for (const [name, node] of Object.entries(grass.nodes))
      if (typeof node === "object" && node !== null && "value" in node)
        watch(node, "value", `nodes.${name}`);
    grass.update(camera);
    grass.update(camera);
    expect(writes).toEqual([]);
  });

  it("fails closed on a malformed field, naming it", () => {
    expect(() => field({ chunkSize: 0 })).toThrow(/chunkSize/);
    expect(() => field({ bounds: { minX: 5, minZ: 0, maxX: 1, maxZ: 9 } })).toThrow(/bounds\.minX/);
    expect(() => field({ bounds: { minX: 0, minZ: 0, maxX: Number.NaN, maxZ: 9 } })).toThrow(
      /bounds\.maxX/,
    );
  });
});

describe("fastAtan2", () => {
  it("stays within 1e-5 rad of Math.atan2 on every quadrant, both axes and the origin", () => {
    let worst = 0;
    const at = (y: number, x: number) => {
      worst = Math.max(worst, Math.abs(fastAtan2(y, x) - Math.atan2(y, x)));
    };
    for (let i = 0; i < 4096; i++) {
      const a = (i / 4096) * Math.PI * 2 - Math.PI;
      const r = 10 ** ((i % 7) - 3);
      at(Math.sin(a) * r, Math.cos(a) * r);
    }
    for (const [y, x] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
      [1, 1],
      [-1, -1],
      [0, 0],
    ] as const)
      at(y, x);
    expect(worst).toBeLessThan(1e-5);
  });
});
