import type { IAssetLoader } from "@threenative/core";
import { DataTexture, LinearMipmapLinearFilter, RepeatWrapping, type Texture } from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  BIOMES as AUTHORED_BIOMES,
  type IWorldBiome,
  type WorldName,
  alpineSnowCover,
  elevationBand,
  measureBiome,
} from "../src/render/biomes.js";
import { loadPack } from "../src/render/pack.js";
import { createPropSurfaces, createRockGround } from "../src/render/propMaterials.js";
import { createTerrain } from "../src/render/terrain.js";

const BIOMES = Object.fromEntries(
  Object.entries(AUTHORED_BIOMES).map(([world, biome]) => [world, measureBiome(biome, [-10, 90])]),
) as Record<WorldName, IWorldBiome>;

function scalarValues(node: { traverse: (visit: (child: unknown) => void) => void }): number[] {
  const values: number[] = [];
  node.traverse((child) => {
    const value = (child as { value?: unknown }).value;
    if (typeof value === "number") values.push(value);
  });
  return values;
}

it("resolves every world's actual bands under scale and offset without sharing snapshots", () => {
  for (const authored of Object.values(AUTHORED_BIOMES)) {
    const heights = [10, 110];
    const first = measureBiome(authored, heights);
    const snapshot = JSON.stringify(first);
    heights[1] = 210;
    const moved = measureBiome(authored, [525, 775]);
    for (const key of Object.keys(first.heightBands) as Array<keyof typeof first.heightBands>) {
      expect(moved.heightBands[key]).toEqual(
        first.heightBands[key].map((value) => value * 2.5 + 500),
      );
    }
    expect(moved.snowBand).toEqual(first.snowBand.map((value) => value * 2.5 + 500));
    expect(first.elevationRange).toEqual([10, 110]);
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(first).not.toBe(moved);
  }
  const alpine = measureBiome(AUTHORED_BIOMES.alpine, [0, 1000]);
  const moved = measureBiome(AUTHORED_BIOMES.alpine, [500, 3000]);
  expect(scalarValues(alpineSnowCover(alpine))).toEqual(expect.arrayContaining([600, 850]));
  expect(scalarValues(alpineSnowCover(moved))).toEqual(expect.arrayContaining([2000, 2625]));
});

it.each([
  { heights: [] },
  { heights: [0, Number.NaN] },
  { heights: [0, Number.POSITIVE_INFINITY] },
  { heights: [0, Number.MAX_VALUE] },
])("rejects malformed elevation samples %j", ({ heights }) => {
  expect(() => measureBiome(AUTHORED_BIOMES.forest, heights)).toThrow(
    /elevation.*(?:empty|nonfinite)/u,
  );
});

it("keeps a flat world's actual range and emits finite constant elevation and snow graphs", () => {
  const flat = measureBiome(AUTHORED_BIOMES.alpine, [123, 123, 123]);
  expect(flat.elevationRange).toEqual([123, 123]);
  expect(flat.snowBand).toEqual([123, 123]);
  expect(scalarValues(elevationBand(flat, flat.snowBand))).toEqual([0]);
  expect(scalarValues(alpineSnowCover(flat)).every(Number.isFinite)).toBe(true);
  expect(scalarValues(alpineSnowCover(flat))).not.toContain(123);
});

it.each(["alpine", "tundra"] as const)(
  "requires actual elevations before loading %s stones",
  async (world) => {
    await expect(loadPack(undefined, world)).rejects.toThrow(/measured terrain elevations/u);
  },
);

/** Every texture a TSL node tree samples, so a test can see whether a map survived. */
function sampledTextures(node: unknown): Set<Texture> {
  const found = new Set<Texture>();
  (node as { traverse?: (visit: (value: unknown) => void) => void } | null)?.traverse?.((value) => {
    const texture = (value as { value?: Texture }).value;
    if (texture?.isTexture) found.add(texture);
  });
  return found;
}

describe("procedural foliage lighting", () => {
  const image = (path: string) => {
    const texture = new DataTexture(new Uint8Array([80, 150, 50, 255]), 1, 1);
    texture.userData.path = path;
    return texture;
  };
  const sky = image("sky.hdr");
  const assets = {
    resolve: async () => [],
    model: async () => {
      throw new Error("Optional model absent");
    },
    texture: async (path: string) => image(path),
  } as unknown as IAssetLoader;
  // Every role the procedural starter draws as an alpha-cut, double-sided surface. An imported pine
  // brings its own material; a machine without the licensed pack draws these, and without an
  // image-based light a needle card is a flat paddle — the paperboard the engine warns about.
  const cutouts = ["crown", "needles", "pine", "impostor", "fern", "petal"] as const;

  it("gives every cutout surface the sky light", async () => {
    const surfaces = await createPropSurfaces(assets, undefined, undefined, sky);
    try {
      for (const role of cutouts) {
        const material = surfaces.materials[role] as { envMap?: unknown; envMapIntensity?: number };
        expect(material.envMap, role).toBe(sky);
        expect(material.envMapIntensity, role).toBeCloseTo(1.13, 5);
      }
    } finally {
      surfaces.dispose();
    }
  });

  it("keeps the crown's needle relief in its normal", async () => {
    const surfaces = await createPropSurfaces(assets);
    try {
      const crown = surfaces.materials.crown as MeshStandardNodeMaterial;
      // The bent crown normal is the geometry's own; the relief bump perturbs it, so the two are one
      // node. A bare geometry normal drops the relief and the needles shade as flat card.
      const paths = [...sampledTextures(crown.normalNode)].map((texture) => texture.userData.path);
      expect(paths).toContain("needle-surface.png");
    } finally {
      surfaces.dispose();
    }
  });

  it("does not paint a ground-colour skirt on tundra stone", async () => {
    expect(
      await createRockGround(
        assets,
        { heights: [0, 0, 0, 0], resolution: 2, size: 8 },
        BIOMES.tundra,
      ),
    ).toBeUndefined();
  });

  it("gives tundra boulders textured snow and sky light", async () => {
    const surfaces = await createPropSurfaces(assets, undefined, BIOMES.tundra, sky);
    try {
      const stone = surfaces.materials.stone as MeshStandardNodeMaterial;
      const paths = [...sampledTextures(stone.colorNode)].map((texture) => texture.userData.path);
      expect(paths).toContain(BIOMES.tundra.maps.snow.diffuse);
      expect(stone.envMap).toBe(sky);
      expect(paths).toContain("lichen_rock/lichen_rock_diff_512.jpg");
      expect(sampledTextures(stone.emissiveNode).size).toBeGreaterThan(0);
      expect(stone.metalness).toBe(0);
      expect(stone.roughness).toBeGreaterThanOrEqual(0.9);
    } finally {
      surfaces.dispose();
    }
  });

  it.each(["coastal", "desert"] as const)(
    "binds dry stone colour, GL normal and packed AO/roughness for %s",
    async (world) => {
      const requests: { path: string; data?: boolean; wrap?: number }[] = [];
      const loader = {
        ...assets,
        texture: async (path: string, options?: { data?: boolean; wrap?: number }) => {
          requests.push({ path, data: options?.data, wrap: options?.wrap });
          return image(path);
        },
      } as unknown as IAssetLoader;
      const surfaces = await createPropSurfaces(loader, undefined, BIOMES[world], sky);
      try {
        const stone = surfaces.materials.stone as MeshStandardNodeMaterial;
        const paths = (node: unknown) =>
          [...sampledTextures(node)].map((texture) => texture.userData.path);
        expect(paths(stone.colorNode)).toContain("rock_boulder_dry/rock_boulder_dry_diff_512.jpg");
        expect(paths(stone.normalNode)).toContain(
          "rock_boulder_dry/rock_boulder_dry_nor_gl_512.jpg",
        );
        expect(paths(stone.roughnessNode)).toContain(
          "rock_boulder_dry/rock_boulder_dry_arm_512.jpg",
        );
        expect(paths(stone.aoNode)).toContain("rock_boulder_dry/rock_boulder_dry_arm_512.jpg");
        expect(requests.filter(({ path }) => path.includes("rock_boulder_dry"))).toEqual([
          {
            path: "rock_boulder_dry/rock_boulder_dry_diff_512.jpg",
            data: false,
            wrap: RepeatWrapping,
          },
          {
            path: "rock_boulder_dry/rock_boulder_dry_nor_gl_512.jpg",
            data: true,
            wrap: RepeatWrapping,
          },
          {
            path: "rock_boulder_dry/rock_boulder_dry_arm_512.jpg",
            data: true,
            wrap: RepeatWrapping,
          },
        ]);
        for (const [node, channel] of [
          [stone.roughnessNode, "y"],
          [stone.aoNode, "x"],
        ] as const) {
          const channels: string[] = [];
          (
            node as unknown as {
              traverse: (visit: (value: { components?: string }) => void) => void;
            }
          ).traverse((value) => {
            if (value.components) channels.push(value.components);
          });
          expect(channels).toContain(channel);
        }
        for (const texture of sampledTextures(stone.colorNode)) {
          expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
          expect(texture.anisotropy).toBe(8);
        }
        expect(
          requests.some(
            ({ path }) => path.includes("mossy_rock") || path.endsWith("cliff_side_rough_1k.jpg"),
          ),
        ).toBe(false);
        expect(paths(stone.emissiveNode)).toContain(
          "rock_boulder_dry/rock_boulder_dry_diff_512.jpg",
        );
        expect(stone.envMap).toBeNull();
      } finally {
        surfaces.dispose();
      }
    },
  );

  it.each(["forest", "alpine", "tundra"] as const)(
    "repeats the retained stone maps in %s",
    async (world) => {
      const requests: { path: string; wrap?: number }[] = [];
      const loader = {
        ...assets,
        texture: async (path: string, options?: { wrap?: number }) => {
          requests.push({ path, wrap: options?.wrap });
          return image(path);
        },
      } as unknown as IAssetLoader;
      const surfaces = await createPropSurfaces(loader, undefined, BIOMES[world]);
      try {
        for (const slot of ["stone.albedo", "stone.normal"] as const) {
          const path = surfaces.inputs[slot]?.userData.path;
          expect(requests.find((request) => request.path === path)?.wrap).toBe(RepeatWrapping);
        }
      } finally {
        surfaces.dispose();
      }
    },
  );
});

it("continues tundra terrain normals through the first horizon collar ring", () => {
  const resolution = 9;
  const { mesh } = createTerrain(
    {
      size: 512,
      resolution,
      heights: Array(resolution ** 2).fill(30),
      colors: Array(resolution ** 2 * 3).fill(1),
      waterLevel: null,
    },
    undefined,
    BIOMES.tundra,
  );
  try {
    const horizon = mesh.children[0] as import("three").Mesh;
    const normals = horizon.geometry.getAttribute("normal");
    const perimeter = (resolution - 1) * 4;
    for (let vertex = 0; vertex < perimeter; vertex++)
      expect(normals.getY(perimeter + vertex)).toBeGreaterThan(0.999);
  } finally {
    mesh.geometry.dispose();
    (mesh.material as import("three").Material).dispose();
  }
});
