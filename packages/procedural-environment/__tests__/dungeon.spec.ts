import { Box3, Mesh, PointLight, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createStylizedAsset, stylizedAssets } from "../src/stylized.js";

const reference = {
  Walls: [
    "wall",
    "corner",
    "tee",
    "cross",
    "archway",
    "door-frame",
    "barred-window",
    "collapsed-wall",
  ],
  "Floors and stairs": [
    "floor",
    "cracked-floor",
    "mossy-floor",
    "grate",
    "stairs",
    "corner-stairs",
    "ramp",
    "platform",
  ],
  Structure: ["pillar", "broken-column", "large-arch", "ruined-arch", "vault", "beam"],
  Props: [
    "crate",
    "barrel",
    "sack",
    "locked-chest",
    "open-chest",
    "cage",
    "table",
    "bench",
    "shelves",
    "weapon-rack",
    "weapon-stand",
    "banner",
    "wall-torch",
    "brazier",
    "hanging-lamp",
    "candles",
    "rubble",
    "bones",
  ],
  Features: [
    "portcullis",
    "lever",
    "spike-trap",
    "pressure-plate",
    "wooden-bridge",
    "stone-bridge",
    "statue",
    "altar",
    "sarcophagus",
  ],
};

describe("dungeon kit", () => {
  it("lists and builds each reference piece in all three themes", () => {
    const rows = stylizedAssets().filter((asset) => asset.kind === "dungeon");
    for (const [category, ids] of Object.entries(reference)) {
      expect(rows.filter((row) => row.category === category).map((row) => row.id)).toEqual(
        ids.map((id) => `dungeon-${id}`),
      );
      for (const id of ids) {
        for (let variant = 0; variant < 3; variant++) {
          const asset = createStylizedAsset(`dungeon-${id}`, { variant, seed: 17 });
          expect(new Box3().setFromObject(asset.group).isEmpty(), id).toBe(false);
        }
      }
    }
    expect(rows.filter((row) => row.category === "Scenes").map((row) => row.id)).toEqual([
      "dungeon-courtyard",
      "dungeon-assembly",
    ]);
  });

  it("joins on a 4 metre grid and leaves a walkable opening in the arch", () => {
    const wall = createStylizedAsset("dungeon-wall").group;
    const size = new Box3().setFromObject(wall).getSize(new Vector3());
    expect(size.x).toBeCloseTo(4);
    const floor = new Box3().setFromObject(createStylizedAsset("dungeon-floor").group);
    expect(floor.max.x).toBeCloseTo(2);
    expect(floor.max.y).toBeCloseTo(0);
    expect(floor.max.z).toBeCloseTo(2);
    const arch = createStylizedAsset("dungeon-archway").group;
    arch.updateMatrixWorld(true);
    const cast = new Raycaster(new Vector3(0, 1.65, 1), new Vector3(0, 0, -1));
    expect(cast.intersectObject(arch, true)).toHaveLength(0);
    cast.ray.origin.set(1.75, 1.65, 1);
    expect(cast.intersectObject(arch, true).length).toBeGreaterThan(0);
  });

  it("is deterministic by seed and builds the assembled views with actual module instances", () => {
    const positions = (seed: number) => {
      const meshes = createStylizedAsset("dungeon-wall", { seed }).group.children as Mesh[];
      return Array.from(meshes[0]?.geometry.getAttribute("position").array ?? []);
    };
    expect(positions(3)).toEqual(positions(3));
    expect(positions(3)).not.toEqual(positions(4));

    for (const id of ["dungeon-courtyard", "dungeon-assembly"]) {
      for (let variant = 0; variant < 3; variant++) {
        const { group, env, view } = createStylizedAsset(id, { variant });
        expect(
          group.children.filter(({ name }) => name.startsWith("dungeon-")).length,
        ).toBeGreaterThan(30);
        expect(view?.target.length).toBe(3);
        expect(env?.hemi.intensity).toBeGreaterThan(0);
      }
    }
  });
  it("carries independently animated flames and light with every fire fixture", () => {
    for (const id of ["wall-torch", "brazier", "hanging-lamp", "candles", "altar"]) {
      const { animated, group, update } = createStylizedAsset(`dungeon-${id}`);
      const light = group.children.find((part) => part instanceof PointLight);
      expect(animated, id).toBe(true);
      expect(light?.intensity, id).toBeGreaterThan(0);
      expect(update, id).toBeTypeOf("function");
      const profile = group.children
        .filter((part) => part instanceof Mesh)
        .map((mesh) => mesh.geometry.getAttribute("dungeonFlame"))
        .find(Boolean);
      expect(profile, id).toBeDefined();
      expect(
        profile &&
          Array.from({ length: profile.count }, (_, i) => profile.getY(i)).some((sway) => sway > 0),
        id,
      ).toBe(true);
      update?.(0);
      const first = light?.intensity;
      update?.(0.43);
      expect(light?.intensity, id).not.toBeCloseTo(first ?? 0);
    }
  });
});
