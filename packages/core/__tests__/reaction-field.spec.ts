import { describe, expect, it } from "vitest";
import { ReactionField } from "../src/spells/reaction-field.js";

describe("ReactionField", () => {
  it("splats heat at a point, saturates at 1 and leaves the rest of the patch clean", () => {
    const field = new ReactionField({ resolution: 32, size: 32 });
    expect(field.empty).toBe(true);
    expect(field.splat({ heat: 1, radius: 2, x: 0, z: 0 })).toBe(true);

    expect(field.empty).toBe(false);
    const centre = field.sample("heat", 0, 0);
    expect(centre).toBeGreaterThan(0.5);
    expect(field.sample("heat", 15, 15)).toBe(0);

    // Two fireballs on one cell burn hotter but never past the top of the range.
    field.splat({ heat: 1, radius: 2, x: 0, z: 0 });
    expect(field.sample("heat", 0, 0)).toBeLessThanOrEqual(1);
  });

  it("keeps channels independent, so ice on a burning floor is both hot and frosted", () => {
    const field = new ReactionField({ resolution: 32, size: 32 });
    field.splat({ char: 1, heat: 1, radius: 3, x: 0, z: 0 });
    field.splat({ frost: 1, wet: 0.5, radius: 3, x: 0, z: 0 });
    expect(field.sample("heat", 0, 0)).toBeGreaterThan(0.5);
    expect(field.sample("char", 0, 0)).toBeGreaterThan(0.5);
    expect(field.sample("frost", 0, 0)).toBeGreaterThan(0.5);
    expect(field.sample("wet", 0, 0)).toBeGreaterThan(0.2);
    expect(field.strongest(0, 0)).toBeDefined();
  });

  it("decays each channel on its own half-life and forgets the patch when it is clean", () => {
    const field = new ReactionField({
      halfLife: { char: 1000, heat: 1 },
      resolution: 32,
      size: 32,
    });
    field.splat({ char: 1, heat: 1, radius: 2, x: 0, z: 0 });
    const heatBefore = field.sample("heat", 0, 0);
    const charBefore = field.sample("char", 0, 0);
    field.update(1);
    const heatAfter = field.sample("heat", 0, 0);
    const charAfter = field.sample("char", 0, 0);
    // One half-life halves heat and barely touches char.
    expect(heatAfter).toBeLessThan(heatBefore);
    expect(heatAfter / heatBefore).toBeLessThan(0.6);
    expect(charAfter / charBefore).toBeGreaterThan(0.99);
  });

  it("forgets the patch once every channel has decayed to nothing", () => {
    const quick = new ReactionField({
      halfLife: { char: 0.05, crack: 0.05, frost: 0.05, glow: 0.05, heat: 0.05, wet: 0.05 },
      resolution: 32,
      size: 32,
    });
    quick.splat({ char: 1, heat: 1, radius: 2, x: 0, z: 0 });
    expect(quick.empty).toBe(false);
    for (let step = 0; step < 40; step++) quick.update(0.5);
    expect(quick.empty).toBe(true);
  });

  it("reports the changed rectangle so a material uploads a strip, not the grid", () => {
    const field = new ReactionField({ resolution: 64, size: 64 });
    expect(field.consumeDirty()).toBeUndefined();
    field.splat({ heat: 1, radius: 1, x: -20, z: -20 });
    const dirty = field.consumeDirty();
    expect(dirty).toBeDefined();
    expect(dirty?.width).toBeLessThan(64);
    expect(dirty?.height).toBeLessThan(64);
    // The rectangle covers the corner the splat landed in.
    expect(dirty?.x).toBeLessThanOrEqual(32);
    expect(dirty?.z).toBeLessThanOrEqual(32);
    expect(field.consumeDirty()).toBeUndefined();
  });

  it("ignores a splat outside the patch and changes no cell", () => {
    const field = new ReactionField({ resolution: 32, size: 32 });
    expect(field.splat({ heat: 1, radius: 2, x: 500, z: 0 })).toBe(false);
    expect(field.empty).toBe(true);
    expect(field.sample("heat", 0, 0)).toBe(0);
  });

  it("moves with the action and reports every cell after a recenter", () => {
    const field = new ReactionField({ resolution: 32, size: 32 });
    field.splat({ heat: 1, radius: 2, x: 0, z: 0 });
    field.consumeDirty();
    field.recenter(4, 0);
    expect(field.centerX).toBeCloseTo(4, 6);
    const dirty = field.consumeDirty();
    expect(dirty).toEqual({ height: 32, width: 32, x: 0, z: 0 });
  });

  it("clears whole and stops decaying once every channel is zero", () => {
    const field = new ReactionField({ resolution: 32, size: 32 });
    field.splat({ heat: 1, radius: 4, x: 0, z: 0 });
    const version = field.version;
    field.clear();
    expect(field.empty).toBe(true);
    expect(field.version).toBeGreaterThan(version);
    // The clear itself is one full-patch upload; once it has been taken, time changes nothing.
    expect(field.consumeDirty()).toEqual({ height: 32, width: 32, x: 0, z: 0 });
    field.update(1);
    expect(field.consumeDirty()).toBeUndefined();
  });

  it("marks a stripe along the impact direction, not a disc", () => {
    const field = new ReactionField({ resolution: 64, size: 64 });
    field.splat({ angle: 0, heat: 1, pattern: "streak", radius: 2, x: 0, z: 0 });
    // Stretched along x, so a point 4 m out on the x axis is hotter than 4 m out on z.
    expect(field.sample("heat", 4, 0)).toBeGreaterThan(field.sample("heat", 0, 4));
  });

  it("rejects a splat that is not a real mark", () => {
    const field = new ReactionField({ resolution: 32, size: 32 });
    expect(() => field.splat({ heat: 1, radius: 0, x: 0, z: 0 })).toThrow(RangeError);
    expect(() => field.splat({ heat: 1, radius: 1, x: Number.NaN, z: 0 })).toThrow(TypeError);
  });
});
