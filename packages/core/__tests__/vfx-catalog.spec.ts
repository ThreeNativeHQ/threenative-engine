import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import { RibbonField } from "../src/vfx/index.js";

describe("the engine VFX catalog", () => {
  it("exposes and constructs every gallery effect, including the portal ribbon layer", () => {
    const { VFX_PRESETS, createVfxPreset, PARTICLE_KINDS } = core;
    expect(PARTICLE_KINDS.length).toBeGreaterThan(0);
    expect(new Set(VFX_PRESETS.map((preset) => preset.id)).size).toBe(46);
    for (const preset of VFX_PRESETS) {
      const effect = createVfxPreset(preset.id);
      expect(effect.objects.length, preset.id).toBeGreaterThan(0);
      if (preset.id === "godot-portal-vortex") {
        expect(effect.objects.some((object) => object instanceof RibbonField)).toBe(true);
      }
      expect(() => effect.replay()).not.toThrow();
      effect.dispose();
    }
  });

  it("validates controls and applies scale to every layer", () => {
    expect(() => core.createVfxPreset("unknown")).toThrow(/Unknown VFX preset/);
    expect(() => core.createVfxPreset("fire", { intensity: -1 })).toThrow(/intensity/);
    const effect = core.createVfxPreset("godot-portal-vortex", {
      scale: 2,
      intensity: 1.5,
      tint: "#445566",
    });
    expect(effect.objects.map(({ scale }) => scale.toArray())).toEqual([
      [2, 2, 2],
      [2, 2, 2],
    ]);
    effect.dispose();
  });
});
