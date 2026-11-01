import { Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { SpellWorld } from "../src/spells/spell-world.js";

describe("SpellWorld", () => {
  it("owns the floor the game supplied and never assumes y = 0", () => {
    const world = new SpellWorld({ groundAt: (x, z) => x + z, scene: new Scene() });
    expect(world.floorAt(2, 3)).toBe(5);
    expect(new SpellWorld({ scene: new Scene() }).floorAt(2, 3)).toBe(0);
  });

  it("creates its lights once, at zero intensity, and hands them out", () => {
    const scene = new Scene();
    const world = new SpellWorld({ lightCount: 2, scene });
    expect(world.lights.lights).toHaveLength(2);
    expect(scene.children).toHaveLength(2);
    for (const light of world.lights.lights) expect(light.intensity).toBe(0);

    const lit = world.lights.flash({
      color: world.lights.lights[0]?.color ?? undefined,
      intensity: 10,
      range: 8,
      seconds: 0.5,
      x: 0,
      y: 1,
      z: 2,
    } as never);
    expect(lit?.intensity).toBe(10);
    // The scene's light count did not change with the cast.
    expect(scene.children).toHaveLength(2);
    expect(world.lights.active).toBe(true);
  });

  it("fades a flash to nothing and re-uses the same light", () => {
    const world = new SpellWorld({ lightCount: 1, scene: new Scene() });
    const color = world.lights.lights[0]?.color;
    const light = world.lights.flash({
      color,
      intensity: 10,
      range: 8,
      seconds: 1,
      x: 0,
      y: 0,
      z: 0,
    }) as { intensity: number } | undefined;
    expect(light).toBeDefined();
    world.update(0.5);
    expect(world.lights.lights[0]?.intensity).toBeCloseTo(5, 5);
    world.update(0.5);
    expect(world.lights.lights[0]?.intensity).toBe(0);
    expect(world.lights.active).toBe(false);
  });

  it("allows at most three flashes a second with reduced flashes on", () => {
    const world = new SpellWorld({ reducedFlashes: true, scene: new Scene() });
    expect(world.flash()).toBe(true);
    expect(world.flash()).toBe(true);
    expect(world.flash()).toBe(true);
    // WCAG 2.3.1: a fourth flash inside the same second is refused, not dimmed.
    expect(world.flash()).toBe(false);
    expect(world.suppressedFlashes).toBe(1);

    world.update(1.1);
    expect(world.flash()).toBe(true);
  });

  it("shows every flash when reduced flashes is off", () => {
    const world = new SpellWorld({ scene: new Scene() });
    for (let index = 0; index < 20; index++) expect(world.flash()).toBe(true);
    expect(world.suppressedFlashes).toBe(0);
  });

  it("advances the surface field and the shake on the same delta", () => {
    const world = new SpellWorld({ scene: new Scene() });
    expect(world.reaction).toBeDefined();
    world.reaction?.splat({ heat: 1, radius: 2, x: 0, z: 0 });
    expect(world.reaction?.empty).toBe(false);
    world.update(0.1);
    expect(world.time).toBeCloseTo(0.1, 6);
    world.clear();
    expect(world.reaction?.empty).toBe(true);
    expect(world.lights.active).toBe(false);
  });

  it("skips the surface field and the shake when the game asked for neither", () => {
    const world = new SpellWorld({ reaction: false, scene: new Scene(), shake: false });
    expect(world.reaction).toBeUndefined();
    expect(world.shake).toBeUndefined();
    world.update(0.1);
  });

  it("reports the cast slots so a spell can key its own state by slot", () => {
    expect(new SpellWorld({ castSlots: 4, scene: new Scene() }).castSlots).toBe(4);
    expect(new SpellWorld({ scene: new Scene() }).castSlots).toBe(16);
  });

  it("starts a cast at its focus point", () => {
    const world = new SpellWorld({ scene: new Scene() });
    world.focus.set(1, 2, 3);
    expect(world.focus).toBeInstanceOf(Vector3);
    expect(world.focus.toArray()).toEqual([1, 2, 3]);
  });
});
