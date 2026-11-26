import { describe, expect, it } from "vitest";
import { createHealingAura, createRain } from "../src/vfx/index.js";
import { coneTangent, layerAmount, overrideLayer } from "../src/vfx/particles.js";
import * as presets from "../src/vfx/presets.js";

type Recipe = (position: presets.ArchiveVec3) => presets.ArchiveLayer[];
const recipes = Object.entries(presets).filter(
  (entry): entry is [string, Recipe] =>
    entry[0].endsWith("Layers") && typeof entry[1] === "function",
);

describe("@threenative/core/vfx presets", () => {
  it("ships all 46 donor recipes", () => {
    expect(recipes).toHaveLength(46);
  });

  it("gives every cone a spread axis that is not parallel to its direction", () => {
    for (const [name, recipe] of recipes) {
      for (const layer of recipe([0, 0, 0])) {
        const { direction, mode, angle } = layer.velocity;
        if (mode !== "cone" || angle === undefined || angle <= 0) continue;
        const d = direction ?? [0, 1, 0];
        const length = Math.hypot(d[0], d[1], d[2]);
        const t = coneTangent(d);
        const cross = Math.hypot(
          (d[1] * t[2] - d[2] * t[1]) / length,
          (d[2] * t[0] - d[0] * t[2]) / length,
          (d[0] * t[1] - d[1] * t[0]) / length,
        );
        expect(cross, `${name} ${layer.id}`).toBeGreaterThan(0.1);
      }
    }
  });

  it("defaults every layer to the donor capacity", () => {
    const donor = presets.healingAuraLayers([0, 0, 0]).map((layer) => layer.capacity);
    expect(createHealingAura().map((layer) => layer.amount)).toEqual(donor);
  });

  it("takes amount as a count or as a function of the donor capacity", () => {
    expect(createRain({ amount: 64 }).map((layer) => layer.amount)).toEqual([64]);
    const capacity = presets.rainLayers([0, 0, 0])[0]?.capacity ?? 0;
    expect(createRain({ amount: (donor) => donor / 4 })[0]?.amount).toBe(capacity / 4);
    const layer = presets.rainLayers([0, 0, 0])[0];
    if (layer === undefined) throw new Error("rain has no layer");
    expect(() => layerAmount(layer, 0)).toThrow(/positive integer/u);
    expect(() => layerAmount(layer, 2.5)).toThrow(/positive integer/u);
  });

  it("multiplies colour, size and lifetime into the donor data and leaves it alone by default", () => {
    const layer = presets.healingAuraLayers([0, 0, 0])[0];
    if (layer === undefined) throw new Error("healing aura has no layer");
    expect(overrideLayer(layer, {})).toEqual(layer);

    const tinted = overrideLayer(layer, { color: 0xff0000, size: 2, lifetime: 3 });
    expect(tinted.color).toEqual([layer.color[0], 0, 0, layer.color[3]]);
    for (const [at, rgb] of tinted.colorCurve ?? []) {
      const source = layer.colorCurve?.find(([sourceAt]) => sourceAt === at)?.[1];
      expect(rgb[0]).toBe(source?.[0]);
      expect(rgb[1]).toBe(0);
      expect(rgb[2]).toBe(0);
    }
    expect(tinted.size).toBe(layer.size * 2);
    expect(tinted.lifetime).toEqual([layer.lifetime[0] * 3, layer.lifetime[1] * 3]);
    expect(() => overrideLayer(layer, { size: 0 })).toThrow(/positive/u);
    expect(() => overrideLayer(layer, { lifetime: -1 })).toThrow(/positive/u);
  });
});
