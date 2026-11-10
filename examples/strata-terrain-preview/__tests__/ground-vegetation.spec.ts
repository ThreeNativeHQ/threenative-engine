import { Vector3 } from "three";
import { expect, it } from "vitest";
import { POPPY, WILDFLOWER, fernClump, grassClump, poppyCluster } from "../src/render/cover.js";
import { SPRUCE, spruceVariants } from "../src/render/spruce.js";

it("keeps contiguous grass, fern and flower stem vertices together in the wind", () => {
  const flowers = poppyCluster(73, { u0: 0.5, v0: 0, u1: 1, v1: 0.5 });
  for (const geometry of [grassClump(73), fernClump(73), flowers.stems]) {
    const position = geometry.getAttribute("position");
    const sway = geometry.getAttribute("sway");
    const weights = new Map<string, number>();
    for (let i = 0; i < position.count; i++) {
      const key = new Vector3().fromBufferAttribute(position, i).toArray().join(",");
      const previous = weights.get(key);
      if (previous !== undefined) expect(sway.getX(i), key).toBeCloseTo(previous, 6);
      weights.set(key, sway.getX(i));
    }
    geometry.dispose();
  }
  flowers.petals.dispose();
});

it("grows three distinct grass species deterministically within the original triangle budget", () => {
  const shapes = [];
  for (let species = 0; species < 3; species++) {
    const geometry = grassClump(73, species);
    const repeat = grassClump(73, species);
    expect(geometry.getAttribute("position").array).toEqual(repeat.getAttribute("position").array);
    expect(geometry.index?.count).toBe(252);
    geometry.computeBoundingBox();
    if (!geometry.boundingBox) throw new Error("Grass has no measured bounds");
    shapes.push(geometry.boundingBox.getSize(new Vector3()).toArray());
    geometry.dispose();
    repeat.dispose();
  }
  expect(new Set(shapes.map((shape) => shape.join(","))).size).toBe(3);
});

it("anchors the fern crown while keeping scanned fronds within the existing card budget", () => {
  const geometry = fernClump(73);
  const position = geometry.getAttribute("position");
  const sway = geometry.getAttribute("sway");
  expect(geometry.index?.count).toBeLessThanOrEqual(240);
  for (let i = 0; i < position.count; i++) {
    expect(position.getY(i)).toBeGreaterThanOrEqual(0);
    expect(sway.getX(i)).toBeGreaterThanOrEqual(0);
    expect(sway.getX(i)).toBeLessThanOrEqual(1);
    if (position.getY(i) === 0) expect(sway.getX(i)).toBe(0);
  }
  geometry.dispose();
});

it("keeps meadow blades slender with a soft bow and tapered tips", () => {
  const point = new Vector3();
  const opposite = new Vector3();
  for (const seed of [73, 281, 991]) {
    for (let species = 0; species < 3; species++) {
      const geometry = grassClump(seed, species);
      const position = geometry.getAttribute("position");
      for (let blade = 0; blade < 14; blade++) {
        const base = blade * 12;
        const width = point
          .fromBufferAttribute(position, base)
          .distanceTo(opposite.fromBufferAttribute(position, base + 1));
        const tipWidth = point
          .fromBufferAttribute(position, base + 10)
          .distanceTo(opposite.fromBufferAttribute(position, base + 11));
        const firstRise = position.getY(base + 2) - position.getY(base);
        const tipRise = position.getY(base + 10) - position.getY(base + 8);
        expect(width / position.getY(base + 10)).toBeLessThan(0.035);
        expect(tipWidth / width).toBeLessThanOrEqual(0.03);
        expect(tipRise / firstRise).toBeLessThan(0.8);
      }
      geometry.dispose();
    }
  }
});

// PRD-870: the meadow's fallback flowers drew as poppy colonies, a salmon carpet with 27 times the
// Fab meadow's flower coverage.
it("grows the meadow's fallback flowers as single small heads under the poppy colony's", () => {
  const cell = { u0: 0.5, v0: 0, u1: 1, v1: 0.5 };
  const poppy = poppyCluster(73, cell);
  const bloom = poppyCluster(73, cell, WILDFLOWER);
  expect(bloom.petals.index?.count ?? 0).toBeLessThanOrEqual(
    (poppy.petals.index?.count ?? 0) / POPPY.stems,
  );
  bloom.stems.computeBoundingBox();
  poppy.stems.computeBoundingBox();
  expect(bloom.stems.boundingBox?.max.y ?? 1).toBeLessThan(POPPY.height[0]);
  expect(WILDFLOWER.disc).toBeLessThan(POPPY.disc);
  for (const geometry of [poppy.petals, poppy.stems, bloom.petals, bloom.stems]) geometry.dispose();
});

// PRD-870: the procedural spruce held its crown to a fifth of its height, so a stand was a wall of
// cards hiding every trunk; the Fab stand shows trunks to about two fifths.
it("raises a stand spruce's crown off its trunk and keeps a sapling's low", () => {
  const lowest = (bare?: number) => {
    const [tree] = spruceVariants(1, 11, bare);
    if (!tree) throw new Error("no spruce variant");
    tree.crown.computeBoundingBox();
    const share = (tree.crown.boundingBox?.min.y ?? 0) / tree.height;
    tree.crown.dispose();
    tree.trunk.dispose();
    return share;
  };
  expect(lowest(SPRUCE.standBareTrunk)).toBeGreaterThan(0.24);
  expect(lowest()).toBeLessThan(0.22);
});
