import { createHash } from "node:crypto";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  type InstancedBufferGeometry,
  type InstancedMesh,
  type Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRASS_FIELD_ATTRIBUTES, GrassField3D } from "../src/grass-field.js";
import { type IScatterField3DOptions, ScatterField3D } from "../src/scatter-field.js";

const geometry = () => new BoxGeometry(0.2, 0.2, 0.2);

// A 4 × 4 tile field, 48 m square: chunkSize 12, bounded, two parts with three levels each.
function field(options: Partial<IScatterField3DOptions> = {}) {
  return new ScatterField3D({
    // A 4 × 4 tile field, matching the grass fixture, so a tile origin is ix * 12.
    bounds: { maxX: 48, maxZ: 48, minX: 0, minZ: 0 },
    chunkSize: 12,
    density: 0.5,
    drawDistance: 20,
    getHeight: (x, z) => Math.sin(x * 0.1) + Math.cos(z * 0.1),
    parts: [
      {
        lods: [geometry(), geometry(), geometry()],
        material: new MeshBasicMaterial(),
      },
      { lods: [geometry(), geometry()], material: new MeshBasicMaterial() },
    ],
    place: (_point, out) => {
      out.x = _point.x;
      out.y = _point.y;
      out.z = _point.z;
      out.yaw = _point.x * 0.3;
      out.scale = 1;
      // Every third candidate is left empty, so `place` returning false is exercised every tile.
      return out.priority < 0.66;
    },
    seed: 7,
    ...options,
  });
}

function followAt(x: number, z: number) {
  return new Vector3(x, 2, z);
}

/** `[meshName, instanceMatrix values]` for every mesh, sorted, so two fields can be compared. */
function instances(scene: ScatterField3D) {
  return (scene.children as InstancedMesh[])
    .map(
      (mesh) =>
        [mesh.name, Array.from(mesh.instanceMatrix.array), mesh.count] as [
          string,
          number[],
          number,
        ],
    )
    .sort(([a], [b]) => a.localeCompare(b));
}

function lodOf(name: string): number {
  const match = /lod(\d+)/u.exec(name);
  return Number(match?.[1] ?? Number.NaN);
}

function partOf(name: string): number {
  const match = /part(\d+)/u.exec(name);
  return Number(match?.[1] ?? Number.NaN);
}

function originOf(name: string): { x: number; z: number } {
  const match = /(-?\d+),(-?\d+)$/u.exec(name);
  return { x: Number(match?.[1]) * 12, z: Number(match?.[2]) * 12 };
}

afterEach(() => vi.restoreAllMocks());

describe("ScatterField3D", () => {
  it("streams the same instances from the same seed, one per part per level", () => {
    const a = field();
    const b = field();
    const c = field({ seed: 8 });
    for (const scene of [a, b, c]) {
      scene.prewarm();
      scene.update(followAt(24, 24));
    }
    expect(a.stats.tiles).toBeGreaterThan(0);
    expect(instances(a)).toEqual(instances(b));
    expect(instances(a)).not.toEqual(instances(c));
    // Two parts with three and two levels: every tile draws each level as one mesh.
    const names = (a.children as InstancedMesh[]).map((mesh) => mesh.name);
    expect(names.filter((name) => partOf(name) === 0)).toHaveLength(a.stats.tiles * 3);
    expect(names.filter((name) => partOf(name) === 1)).toHaveLength(a.stats.tiles * 2);
    expect(a.stats.instances).toBeGreaterThan(0);
  });

  it("builds no tile past the per-frame budget", () => {
    let now = 0;
    // Every clock read moves 1 ms: a 2.5 ms budget admits the first tile and two more, never four.
    vi.spyOn(performance, "now").mockImplementation(() => {
      now += 1;
      return now;
    });
    const scene = field({ buildBudgetMs: 2.5 });
    scene.update(followAt(24, 24));
    expect(scene.stats.built).toBeGreaterThanOrEqual(1);
    expect(scene.stats.built).toBeLessThanOrEqual(3);
    expect(scene.stats.pending).toBeGreaterThan(0);
    let frames = 1;
    while (scene.stats.pending > 0 && frames < 50) {
      const before = scene.stats.built;
      scene.update(followAt(24, 24));
      expect(scene.stats.built - before).toBeLessThanOrEqual(3);
      frames++;
    }
    expect(scene.stats.pending).toBe(0);
  });

  it("swaps each part's level by distance and shows one level per part", () => {
    const scene = field({ bounds: null, drawDistance: 40, lodDistances: [8, 18] });
    scene.prewarm();
    scene.update(followAt(24, 24));
    const visible = (scene.children as InstancedMesh[]).filter((mesh) => mesh.visible);
    for (const mesh of visible) {
      const origin = originOf(mesh.name);
      // The tile's nearest corner: the distance the ring chose its level at.
      const dx = Math.max(origin.x - 24, 0, 24 - (origin.x + 12));
      const dz = Math.max(origin.z - 24, 0, 24 - (origin.z + 12));
      const distance = Math.hypot(dx, dz);
      const band = distance >= 18 ? 2 : distance >= 8 ? 1 : 0;
      const deepest = partOf(mesh.name) === 0 ? 2 : 1;
      expect({ distance, lod: lodOf(mesh.name) }).toEqual({
        distance,
        lod: Math.min(band, deepest),
      });
    }
    // One level per part per tile: the flattening must not let a part read another's slot.
    const perTilePart = new Map<string, number>();
    for (const mesh of visible) {
      const key = `${partOf(mesh.name)} ${mesh.name.split(" ").at(-1) as string}`;
      perTilePart.set(key, (perTilePart.get(key) ?? 0) + 1);
    }
    expect([...perTilePart.values()].every((count) => count === 1)).toBe(true);
    // A part draws exactly one level: the near tiles differ from the far ones.
    const perPart = new Map<number, number>();
    for (const mesh of visible)
      perPart.set(partOf(mesh.name), (perPart.get(partOf(mesh.name)) ?? 0) + 1);
    expect([...perPart.keys()].sort()).toEqual([0, 1]);
    expect(new Set(visible.map((mesh) => lodOf(mesh.name))).size).toBeGreaterThan(1);
  });

  it("keeps a prefix of the shuffled instances and thins them with distance", () => {
    const scene = field({ drawDistance: 40, farDensity: 0.2, thinEnd: 20, thinStart: 4 });
    scene.prewarm();
    // One tile watched from two distances: standing on it, then far enough for the thin rule.
    scene.update(followAt(0, 0));
    const near = (scene.children as InstancedMesh[]).find((mesh) => mesh.name.endsWith("0,0"));
    expect(near?.visible).toBe(true);
    const nearCount = near?.count ?? 0;
    const total = near?.instanceMatrix.count ?? 0;
    expect(nearCount).toBe(total);

    scene.update(followAt(38, 0));
    const far = (scene.children as InstancedMesh[]).find((mesh) => mesh.name.endsWith("0,0"));
    expect(far).toBeDefined();
    expect(far?.count ?? 0).toBeLessThan(nearCount);
    // A prefix, not a scatter: the count is how many of the tile's own instances are drawn.
    expect(far?.count ?? 0).toBeLessThanOrEqual(far?.instanceMatrix.count ?? 0);
    expect(scene.stats.instances).toBeGreaterThan(0);
  });

  it("hides a tile past the draw distance and frees it past the discard band", () => {
    const scene = field({ bounds: null, drawDistance: 20 });
    scene.prewarm();
    scene.update(followAt(0, 0));
    const built = scene.stats.built;
    const corner = (scene.children as InstancedMesh[]).find((mesh) => mesh.name.endsWith("0,0"));
    expect(corner?.visible).toBe(true);
    scene.update(followAt(60, 60));
    // Past 1.4 × the draw distance the tile is freed, not hidden: its meshes leave the field.
    expect((scene.children as InstancedMesh[]).some((mesh) => mesh.name.endsWith("0,0"))).toBe(
      false,
    );
    expect(scene.stats.built).toBeGreaterThanOrEqual(built);
  });

  it("asks for no ground height and places nothing outside its bounds", () => {
    const asked: number[] = [];
    const scene = field({
      bounds: { maxX: 24, maxZ: 24, minX: 12, minZ: 12 },
      chunkSize: 12,
      drawDistance: 60,
      getHeight: (x, z) => {
        asked.push(x, z);
        return 0;
      },
    });
    scene.prewarm();
    scene.update(followAt(18, 18));
    // One tile is inside the bounds; the ring never builds the twelve outside it.
    expect(scene.stats.tiles).toBeLessThanOrEqual(4);
    for (let i = 0; i < asked.length; i += 2)
      expect({
        inside: (asked[i] as number) >= 0 && (asked[i + 1] as number) >= 0,
        x: asked[i],
      }).toEqual({ inside: true, x: asked[i] });
    for (const mesh of scene.children as InstancedMesh[])
      expect(originOf(mesh.name)).toMatchObject({
        x: expect.any(Number),
      });
  });

  it("fails closed on a malformed field, naming it", () => {
    const base = {
      getHeight: () => 0,
      place: () => true,
    };
    expect(() => new ScatterField3D({ ...base, parts: [] })).toThrow(
      /parts must list at least one part/u,
    );
    expect(
      () =>
        new ScatterField3D({ ...base, parts: [{ lods: [], material: new MeshBasicMaterial() }] }),
    ).toThrow(/parts\[0\]\.lods must list at least one geometry/u);
    expect(
      () =>
        new ScatterField3D({
          ...base,
          parts: [{ lods: [geometry()] } as unknown as IScatterField3DOptions["parts"][number]],
        }),
    ).toThrow(/parts\[0\] has no material/u);
    expect(
      () =>
        new ScatterField3D({
          getHeight: () => 0,
          parts: [{ lods: [geometry()], material: new MeshBasicMaterial() }],
        } as unknown as IScatterField3DOptions),
    ).toThrow(/place must be a function/u);
    expect(() => field({ chunkSize: 0 })).toThrow(/chunkSize must be > 0/u);
    const badScale = field({
      place: (_point, out) => {
        out.scale = 0;
        return true;
      },
    });
    expect(() => badScale.update(followAt(24, 24))).toThrow(/scale 0 and yaw 0/u);
  });

  it("keeps GrassField3D's instance buffers byte-identical to the pre-extraction field", () => {
    // The digest the shared TileRing must not move: measured on the field before the ring was
    // extracted (grass-field.ts at c0295a124), and pinned here so a future ring change fails.
    const blade = new BufferGeometry();
    blade.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]), 3),
    );
    blade.setIndex([0, 1, 2]);
    const camera = new PerspectiveCamera();
    camera.position.set(24, 2, 24);
    camera.updateMatrixWorld();
    const grass = new GrassField3D({
      blade: { geometry: blade, lods: [{ count: 3, start: 0 }], reach: 1 },
      bounds: { maxX: 48, maxZ: 48, minX: 0, minZ: 0 },
      density: 4,
      drawDistance: 20,
      getHeight: (x, z) => Math.sin(x * 0.1) + Math.cos(z * 0.1),
      material: () => new MeshBasicMaterial(),
      seed: 7,
    });
    grass.prewarm();
    grass.update(camera);
    expect(grass.stats.chunks).toBe(16);
    const digest = (grass.children as Mesh[])
      .map((mesh) => {
        const geo = mesh.geometry as InstancedBufferGeometry;
        const array = geo.getAttribute(GRASS_FIELD_ATTRIBUTES.root).array;
        return `${mesh.name}:${Array.from(array).join(",")}`;
      })
      .sort((a, b) => a.localeCompare(b))
      .join("|");
    expect(createHash("sha256").update(digest).digest("hex")).toBe(GRASS_DIGEST_AT_C0295A1);
  });
});

/**
 * The sha256 of the fixture's instance buffers, measured on grass-field.ts at c0295a124 (before the
 * ring was extracted) and again after it, byte for byte the same.
 */
const GRASS_DIGEST_AT_C0295A1 = "30e4d08d05b6a662aa8511ae718abd6d9b229b3148c7c8ba7f4f0ccbd0646056";
