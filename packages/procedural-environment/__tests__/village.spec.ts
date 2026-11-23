import { Box3, Mesh, PointLight, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createStylizedAsset, stylizedAssets } from "../src/stylized.js";

const rows = stylizedAssets().filter((row) => row.kind === "village");

describe("village kit", () => {
  it("lists every piece in three themes and builds each one standing on the ground", () => {
    expect(rows.map((row) => row.category)).toContain("Buildings");
    expect(rows.every((row) => row.variants === 3)).toBe(true);
    for (const { id } of rows.filter((row) => row.category !== "Scenes")) {
      for (const variant of [0, 1, 2]) {
        const { group } = createStylizedAsset(id, { seed: 3, variant });
        const box = new Box3().setFromObject(group);
        expect(box.isEmpty(), id).toBe(false);
        expect(box.min.y, id).toBeGreaterThan(-0.2);
        expect(box.max.y, id).toBeLessThan(15);
      }
    }
  });

  it("gives buildings real scale and the windmill sails clear of the ground", () => {
    const size = (id: string) =>
      new Box3().setFromObject(createStylizedAsset(id).group).getSize(new Vector3());
    expect(size("village-cottage").y).toBeGreaterThan(4);
    expect(size("village-tavern").x).toBeGreaterThan(8);
    const mill = new Box3().setFromObject(createStylizedAsset("village-windmill").group);
    expect(mill.max.y).toBeGreaterThan(10);
  });

  it("leaves the enterable house, inn and shop open: a doorway to walk through and furniture inside", () => {
    const ray = (id: string, from: Vector3, to: Vector3) => {
      const { group } = createStylizedAsset(id);
      group.updateMatrixWorld(true);
      const cast = new Raycaster(from, to.clone().sub(from).normalize(), 0, from.distanceTo(to));
      return cast.intersectObject(group, true).filter((hit) => hit.object instanceof Mesh);
    };
    // the bar top in the inn, the counter top in the shop, the wardrobe in the house
    for (const [id, depth, x, z] of [
      ["village-home", 2.6, -2.68, 1.65],
      ["village-inn", 3.5, -2.3, -1.65],
      ["village-shop", 3, -0.4, -1.45],
    ] as const) {
      // a player walking in through the front door at chest height meets nothing until the room
      expect(
        ray(id, new Vector3(0, 1.5, depth + 2), new Vector3(0, 1.5, depth - 0.8)),
        id,
      ).toHaveLength(0);
      // looking down into the cutaway from above hits floor-standing furniture, not just floor
      const hits = ray(`${id}-cutaway`, new Vector3(x, 8, z), new Vector3(x, 0, z));
      expect(hits[0]?.point.y ?? 0, id).toBeGreaterThan(1.2);
      // the roofed version covers that same room
      expect(
        ray(id, new Vector3(x, 12, z), new Vector3(x, 0, z))[0]?.point.y ?? 0,
        id,
      ).toBeGreaterThan(3);
    }
  });

  it("is deterministic by seed and lights its fire pieces", () => {
    const first = (seed: number) =>
      [
        ...((
          createStylizedAsset("village-cottage", { seed }).group.children[0] as Mesh
        ).geometry.getAttribute("position").array as Float32Array),
      ].slice(0, 300);
    expect(first(4)).toEqual(first(4));
    for (const id of ["village-forge", "village-lamp-post", "village-campfire"]) {
      const asset = createStylizedAsset(id);
      const lights: PointLight[] = [];
      asset.group.traverse((node) => node instanceof PointLight && lights.push(node));
      expect(lights.length, id).toBeGreaterThan(0);
      expect(asset.update, id).toBeTypeOf("function");
    }
  });

  it("assembles the village green with lighting and a camera in every theme", () => {
    for (const id of ["village-green", "village-town"])
      for (const variant of [0, 1, 2]) {
        const scene = createStylizedAsset(id, { seed: 2, variant });
        expect(scene.group.children.length, id).toBeGreaterThan(80);
        expect(scene.env?.hemi.intensity).toBeGreaterThan(0);
        expect(scene.view?.target).toHaveLength(3);
      }
    // some houses in each scene are the walk-in versions
    const names = (id: string) => {
      const found = new Set<string>();
      createStylizedAsset(id).group.traverse((o) => found.add(o.name.split(":")[0] ?? ""));
      return found;
    };
    expect(names("village-green").has("village-home")).toBe(true);
    const town = names("village-town");
    for (const id of ["village-home", "village-inn", "village-shop"])
      expect(town.has(id), id).toBe(true);
    expect(() => createStylizedAsset("village-green", { variant: 3 })).toThrow(/theme/);
    expect(() => createStylizedAsset("village-nope")).toThrow(/Unknown village asset/);
  });
});
