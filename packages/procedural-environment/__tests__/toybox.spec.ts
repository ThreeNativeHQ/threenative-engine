import { Box3, Mesh, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createStylizedAsset, stylizedAssets, toyboxPush } from "../src/stylized.js";
import { toyboxPushers } from "../src/toybox/materials.js";
import { spikeRise, springStretch } from "../src/toybox/parts.js";

const rows = stylizedAssets().filter((row) => row.kind === "toybox");
const ids = new Set(rows.map((row) => row.id));

describe("toybox kit", () => {
  it("lists modules and scenes in three themes; every module stands on the ground", () => {
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.every((row) => row.variants === 3)).toBe(true);
    for (const { id } of rows.filter((row) => row.category !== "Scenes"))
      for (const variant of [0, 1, 2]) {
        const box = new Box3().setFromObject(createStylizedAsset(id, { seed: 3, variant }).group);
        expect(box.isEmpty(), id).toBe(false);
        expect(box.min.y, id).toBeGreaterThan(-0.25);
        expect(box.max.y, id).toBeLessThan(5);
      }
  });

  it("snaps terrain and platforms to the 2 m grid so neighbours meet edge to edge", () => {
    const solid = (id: string) => {
      const box = new Box3();
      createStylizedAsset(id).group.traverse((node) => {
        if (node instanceof Mesh && !node.name.endsWith(":grass")) box.expandByObject(node);
      });
      return box;
    };
    // rock slabs bulge up to 7 cm mid-face, and the ruin block's carved panels stand 11 cm proud;
    // both fade back to the grid plane at the block's edges, so neighbours still meet
    for (const [id, top, wide = 2.16] of [
      ["toybox-grass-block", 1],
      ["toybox-grass-block-tall", 2],
      ["toybox-cliff-block", 2],
      ["toybox-tech-panel", 0.5],
      ["toybox-plastic-slab", 0.5],
      ["toybox-wood-deck", 1],
      ["toybox-stone-platform", 1],
      ["toybox-ruin-block", 2, 2.24],
    ] as const) {
      const box = solid(id);
      expect(box.max.x - box.min.x, id).toBeGreaterThan(1.98);
      expect(box.max.x - box.min.x, id).toBeLessThan(wide);
      expect(box.max.z - box.min.z, id).toBeLessThan(wide);
      expect(Math.abs(box.max.y - top), id).toBeLessThan(0.1);
    }
  });

  it("animates its moving parts: coins spin, the bounce pad jumps, platforms bob", () => {
    expect(springStretch(5)).toBeCloseTo(1, 1);
    expect(springStretch(0.3)).toBeLessThan(0.7);
    expect(springStretch(0.65)).toBeGreaterThan(1.2);
    expect(spikeRise(0.5)).toBe(0);
    expect(spikeRise(2)).toBe(1);
    for (const id of [
      "toybox-coin",
      "toybox-bounce-pad",
      "toybox-hover-platform",
      "toybox-cannon",
      "toybox-spinner",
      "toybox-spike-trap",
      "toybox-slider-platform",
      "toybox-stone-float",
    ]) {
      const asset = createStylizedAsset(id);
      expect(asset.update, id).toBeTypeOf("function");
      expect(asset.animated, id).toBe(true);
      const pose = () => {
        const out: number[] = [];
        asset.group.traverse((node) => {
          if (node.userData.animate)
            out.push(
              ...node.position.toArray(),
              node.rotation.x,
              node.rotation.y,
              node.rotation.z,
              ...node.scale.toArray(),
            );
        });
        return out as number[];
      };
      // sample across a 3 s cycle: the spike trap rests for half of it
      const poses = [0.1, 0.5, 1.2, 1.9, 2.6].map((t) => {
        asset.update?.(t);
        return JSON.stringify(pose());
      });
      expect(new Set(poses).size, id).toBeGreaterThan(1);
    }
    for (const id of [
      "toybox-puff-tree",
      "toybox-grass-block",
      "toybox-waterfall",
      "toybox-hanging-vines",
      "toybox-spiky-plant",
    ])
      expect(createStylizedAsset(id).animated, id).toBe(true);
  });

  it("lets a game push grass and leaves aside, and rejects a fifth pusher", () => {
    toyboxPush(1, 2, 0.5, -3, 0.8);
    expect(toyboxPushers[1]?.toArray()).toEqual([2, 0.5, -3, 0.8]);
    expect(() => toyboxPush(4, 0, 0, 0, 1)).toThrow(/outside 0..3/);
  });

  it("assembles each scene only from kit modules, with lighting, a camera and a backdrop", () => {
    for (const id of ["toybox-garden", "toybox-course", "toybox-cove"])
      for (const variant of [0, 1, 2]) {
        const scene = createStylizedAsset(id, { seed: 2, variant });
        expect(scene.group.children.length, id).toBeGreaterThan(40);
        for (const child of scene.group.children)
          expect(ids.has(child.name), child.name).toBe(true);
        expect(scene.env?.hemi.intensity).toBeGreaterThan(0);
        expect(scene.view?.target).toHaveLength(3);
        expect(scene.backdrop).toMatch(/toybox_backdrop-(garden|frost|sand)\.webp$/);
      }
    expect(() => createStylizedAsset("toybox-garden", { variant: 3 })).toThrow(/theme/);
    expect(() => createStylizedAsset("toybox-nope")).toThrow(/Unknown toybox asset/);
  });

  it("is deterministic by seed", () => {
    const first = (seed: number) =>
      [
        ...((
          createStylizedAsset("toybox-grass-block", { seed }).group.children[0] as Mesh
        ).geometry.getAttribute("position").array as Float32Array),
      ].slice(0, 300);
    expect(first(4)).toEqual(first(4));
    expect(first(4)).not.toEqual(first(5));
    const size = new Box3()
      .setFromObject(createStylizedAsset("toybox-floating-island").group)
      .getSize(new Vector3());
    expect(size.x).toBeGreaterThan(7.5);
  });
});
