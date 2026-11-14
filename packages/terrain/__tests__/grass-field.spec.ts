import { readFileSync } from "node:fs";
import { GRASS_FIELD_ATTRIBUTES, GrassField3D } from "@threenative/core";
import {
  BufferAttribute,
  BufferGeometry,
  type InstancedBufferGeometry,
  type Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
} from "three";
import { describe, expect, it } from "vitest";
import { grassFieldFromBiome, validateBiome } from "../src/index.js";

const forest = JSON.parse(
  readFileSync(new URL("../starter/forest/biome.data.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { grass: Record<string, unknown>[] };

// The shipped forest row, given a height ceiling so the band is exercised as well as the slope.
const biome = validateBiome(
  {
    ...forest,
    grass: [
      { ...forest.grass[0], height: [0, 14], heightFalloff: 4, slope: [0, 25], slopeFalloff: 10 },
    ],
  },
  "forest-ceiling",
);
const row = biome.grass[0] as (typeof biome.grass)[number];

// A valley: a flat floor that climbs into a 45° wall and past the 14 m ceiling.
const heightAt = (x: number, z: number): number => Math.max(0, Math.abs(x) - 10) + 0 * z;

function blade() {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2]);
  return { geometry, lods: [{ start: 0, count: 3 }], reach: 1 };
}

describe("grassFieldFromBiome", () => {
  it("grows no blade past the row's slope band or above its height ceiling", () => {
    const placement = grassFieldFromBiome(biome, { heightAt, waterLevel: null });
    expect(placement).not.toBeNull();
    const field = new GrassField3D({
      ...(placement as NonNullable<typeof placement>),
      blade: blade(),
      bounds: { maxX: 40, maxZ: 12, minX: -40, minZ: -12 },
      density: 6,
      drawDistance: 60,
      material: () => new MeshBasicMaterial(),
    });
    field.prewarm();
    const camera = new PerspectiveCamera();
    camera.position.set(0, 3, 0);
    camera.updateMatrixWorld();
    field.update(camera);
    let blades = 0;
    let flat = 0;
    for (const mesh of field.children as Mesh[]) {
      const geo = mesh.geometry as InstancedBufferGeometry;
      const root = geo.getAttribute(GRASS_FIELD_ATTRIBUTES.root);
      const clump = geo.getAttribute(GRASS_FIELD_ATTRIBUTES.clump);
      for (let i = 0; i < geo.instanceCount; i++) {
        const nx = clump.getZ(i);
        const nz = clump.getW(i);
        const slope = (Math.acos(Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz))) * 180) / Math.PI;
        expect(slope).toBeLessThanOrEqual(row.slope[1] + row.slopeFalloff + 1e-3);
        expect(root.getY(i)).toBeLessThanOrEqual(
          (row.height as readonly [number, number])[1] + 1e-3,
        );
        blades++;
        if (slope < 1) flat++;
      }
    }
    // The floor grows: the guard is not met by an empty field.
    expect(flat).toBeGreaterThan(100);
    expect(blades).toBeGreaterThan(flat);
  });

  it("returns null for a biome with no grass rows, and fails closed on a missing height", () => {
    expect(grassFieldFromBiome({ ...biome, grass: [] }, { heightAt })).toBeNull();
    expect(() => grassFieldFromBiome(biome, {} as never)).toThrow(/heightAt/);
  });
});
