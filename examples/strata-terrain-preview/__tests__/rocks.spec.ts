import type { IPlacement } from "@threenative/terrain";
import { MeshStandardMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { boulder } from "../src/render/cover.js";
import { buildPropVariants, preparePose, variantFor } from "../src/render/props.js";

describe("weathered rock geometry", () => {
  it("retains the committed river-stone and boulder variant selection", () => {
    const variants = buildPropVariants();
    try {
      for (const asset of ["boulder", "riverrock"]) {
        const choices = Array.from({ length: 30 }, (_, id) =>
          variantFor({ id: `${asset}:${id}` } as IPlacement, asset),
        );
        expect(new Set(choices).size).toBe(asset === "boulder" ? 3 : 1);
        for (const choice of choices) expect(variants.get(`${asset}:${choice}`)).toHaveLength(1);
        expect(variantFor({ id: `${asset}:7` } as IPlacement, asset)).toBe(choices[7]);
      }
    } finally {
      for (const parts of variants.values()) for (const part of parts) part.geometry.dispose();
    }
  });
  it("buries the flat footprint below sloping ground by a margin", () => {
    const rock = boulder(0);
    const material = new MeshStandardMaterial();
    try {
      const placement = {
        id: "boulder:0",
        asset: "boulder",
        position: [0, 0, 0],
        normal: [0, 1, 0],
        scale: 1,
        rotation: 0,
        alignToNormal: false,
      } as IPlacement;
      const ground = (_placement: IPlacement, at: [number, number, number]) => ({
        height: at[0] * 0.7,
        offset: 0,
      });
      const { matrix } = preparePose(rock, material, placement, undefined, ground);
      const positions = rock.getAttribute("position");
      const base = rock.boundingBox?.min.y;
      const point = new Vector3();
      for (let i = 0; i < positions.count; i++) {
        if (positions.getY(i) !== base) continue;
        point.fromBufferAttribute(positions, i).applyMatrix4(matrix);
        expect(point.y - ground(placement, point.toArray()).height).toBeLessThanOrEqual(-0.05);
      }
    } finally {
      rock.dispose();
      material.dispose();
    }
  });

  it("retains the committed seed-zero scale envelope", () => {
    const rock = boulder(0);
    try {
      const size = rock.boundingBox?.getSize(new Vector3());
      expect(size?.x).toBeCloseTo(3.495191, 4);
      expect(size?.y).toBeCloseTo(2.586079, 4);
      expect(size?.z).toBeCloseTo(4.756217, 4);
    } finally {
      rock.dispose();
    }
  });

  it("repeats a seed and gives six seeds distinct silhouettes", () => {
    const rocks = Array.from({ length: 6 }, (_, seed) => boulder(seed));
    const repeat = boulder(0);
    try {
      const positions = rocks.map((rock) => Array.from(rock.getAttribute("position").array));
      expect(Array.from(repeat.getAttribute("position").array)).toEqual(positions[0]);
      expect(new Set(positions.map((values) => JSON.stringify(values))).size).toBe(6);
    } finally {
      repeat.dispose();
      for (const rock of rocks) rock.dispose();
    }
  });

  it.each([0, 1, 2, 3, 4, 5])("seed %i softens exposed fracture normals", (seed) => {
    const rock = boulder(seed);
    try {
      const position = rock.getAttribute("position");
      const normal = rock.getAttribute("normal");
      const point = new Vector3();
      // Exposed fracture edges interpolate through a bevel rather than a perpendicular jump.
      const neighbour = new Vector3();
      for (let i = 0; i < (rock.index?.count ?? 0); i += 3) {
        for (let edge = 0; edge < 3; edge++) {
          const a = rock.index?.getX(i + edge) ?? 0;
          const b = rock.index?.getX(i + ((edge + 1) % 3)) ?? 0;
          if (position.getY(a) < 0 || position.getY(b) < 0) continue;
          expect(
            point.fromBufferAttribute(normal, a).dot(neighbour.fromBufferAttribute(normal, b)),
          ).toBeGreaterThan(0.25);
        }
      }
    } finally {
      rock.dispose();
    }
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "seed %i shares vertices, smooth normals and a flat base within budget",
    (seed) => {
      const rock = boulder(seed);
      try {
        const position = rock.getAttribute("position");
        const normal = rock.getAttribute("normal");
        expect(rock.index).not.toBeNull();
        const triangles = (rock.index?.count ?? position.count) / 3;
        expect(triangles).toBe(500);
        expect(position.count).toBeLessThan(triangles);
        const point = new Vector3();
        for (let i = 0; i < position.count; i++) {
          expect(point.fromBufferAttribute(position, i).toArray().every(Number.isFinite)).toBe(
            true,
          );
          expect(point.fromBufferAttribute(normal, i).length()).toBeCloseTo(1, 5);
        }
        rock.computeBoundingBox();
        const box = rock.boundingBox;
        if (!box) throw new Error("Rock has no measured bounds");
        const size = box.getSize(point);
        expect(size.x).toBeGreaterThan(2.4);
        expect(size.x).toBeLessThan(5);
        expect(size.z).toBeGreaterThan(2.4);
        expect(size.z).toBeLessThan(5);
        expect(size.y).toBeGreaterThan(1.3);
        expect(size.y).toBeLessThan(2.8);
        const base = Array.from({ length: position.count }, (_, i) => position.getY(i)).filter(
          (y) => y <= box.min.y + 1e-5,
        );
        expect(base.length).toBeGreaterThan(6);
        expect(Math.max(...base) - Math.min(...base)).toBeLessThan(1e-6);
      } finally {
        rock.dispose();
      }
    },
  );
});
