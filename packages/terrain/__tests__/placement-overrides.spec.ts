import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Mask,
  Terrain,
  applyPlacementOverrides,
  bakeTerrain,
  validatePlacementOverrides,
} from "@threenative/terrain";
import { TerrainEditorDocument } from "@threenative/terrain/editor/server";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const transform = {
  position: [12, 8, -4],
  quaternion: [0, 0, 0, 1],
  scale: [2, 0.5, 1.5],
  grounding: false,
};
function fixture() {
  const terrain = new Terrain({ size: 64, resolution: 17, seed: 73 }).scatter({
    id: "trees",
    count: 40,
    minDistance: 0,
    avoidWater: false,
  });
  const path = join(makeTempDirSync("placement-overrides-"), "world.json");
  writeFileSync(path, JSON.stringify({ version: 1, recipe: terrain.toJSON() }));
  return { terrain, path, document: new TerrainEditorDocument(path) };
}
describe("persistent placement overrides", () => {
  it("rejects non-record inputs, inherited coordinates and sparse vectors", () => {
    for (const value of [new Date(0), new Map(), new Set(), Object.create({ tree: transform })])
      expect(() => validatePlacementOverrides(value)).toThrow();
    const inherited = Object.create({ ...transform, position: [Number.POSITIVE_INFINITY, 0, 0] });
    expect(() => validatePlacementOverrides({ tree: inherited })).toThrow();
    for (const field of ["position", "quaternion", "scale"])
      expect(() =>
        validatePlacementOverrides({
          tree: { ...transform, [field]: new Array(field === "quaternion" ? 4 : 3) },
        }),
      ).toThrow();
    expect(validatePlacementOverrides(Object.create(null))).toEqual({});
  });
  it("accepts and reloads finite nonuniform transforms without replacing the recipe", () => {
    const { terrain, path, document } = fixture();
    const before = document.snapshot();
    const key = terrain.evaluate().instances[0]?.id as string;
    const accepted = document.commit({
      baseRevision: before.revision,
      document: { ...before.document, placementOverrides: { [key]: transform } },
    });
    expect(accepted.document.recipe).toEqual(before.document.recipe);
    expect(accepted.document.placementOverrides?.[key]).toEqual(transform);
    expect(new TerrainEditorDocument(path).snapshot()).toEqual(accepted);
    expect(JSON.parse(readFileSync(path, "utf8")).placementOverrides[key]).toEqual(transform);
  });
  it("rejects malformed transforms atomically and defaults grounding on", () => {
    const { terrain, path, document } = fixture();
    const before = document.snapshot();
    const disk = readFileSync(path, "utf8");
    const key = terrain.evaluate().instances[0]?.id as string;
    for (const invalid of [
      { ...transform, scale: [1, 0, 1] },
      { ...transform, scale: [1, -1, 1] },
      { ...transform, quaternion: [0, 0, 0, 0] },
      { ...transform, quaternion: [0, 0, 0, 2] },
      { ...transform, position: [Number.NaN, 0, 0] },
      { ...transform, position: [0, 0] },
      { ...transform, grounding: "off" },
      { ...transform, grounding: null },
      { ...transform, extra: 1 },
    ]) {
      expect(() =>
        document.commit({
          baseRevision: before.revision,
          document: { ...before.document, placementOverrides: { [key]: invalid } },
        }),
      ).toThrow();
      expect(document.snapshot()).toEqual(before);
      expect(readFileSync(path, "utf8")).toBe(disk);
    }
    const { grounding: _, ...grounded } = transform;
    const accepted = document.commit({
      baseRevision: before.revision,
      document: { ...before.document, placementOverrides: { [key]: grounded } },
    });
    expect(accepted.document.placementOverrides?.[key]?.grounding).toBe(true);
  });
  it("keeps matched keys through rejection-order changes and reports retained unmatched edits", () => {
    const { terrain } = fixture();
    const before = terrain.evaluate();
    const item = before.instances.find((placement) => placement.position[0] > 0);
    if (!item) throw new Error("Fixture requires a positive-X candidate");
    const overrides = { [item.id]: transform };
    const resolved = applyPlacementOverrides(before, overrides);
    expect(resolved.instances.find((placement) => placement.id === item.id)?.transform).toEqual(
      transform,
    );
    expect(before.instances.every((placement) => !placement.transform)).toBe(true);
    expect(
      bakeTerrain(resolved).instances.find((placement) => placement.id === item.id)?.transform,
    ).toEqual(transform);
    terrain.update("trees", { mask: Mask.rectangle([16, 0], [32, 64], 0, 0) });
    const filtered = applyPlacementOverrides(terrain.evaluate(), overrides);
    expect(filtered.instances.find((placement) => placement.id === item.id)?.transform).toEqual(
      transform,
    );
    terrain.update("trees", { mask: Mask.none() });
    const unmatched = applyPlacementOverrides(terrain.evaluate(), overrides);
    expect(unmatched.instances).toHaveLength(0);
    expect(unmatched.diagnostics).toContain(`Unmatched placement override '${item.id}'`);
    expect(overrides[item.id]).toEqual(transform);
    const restored = applyPlacementOverrides(resolved, {});
    expect(restored.instances.every((placement) => !placement.transform)).toBe(true);
    expect(
      applyPlacementOverrides(unmatched, {}).diagnostics.some((message) =>
        message.startsWith("Unmatched placement override '"),
      ),
    ).toBe(false);
  });
});
