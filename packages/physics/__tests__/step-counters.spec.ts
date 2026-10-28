import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { Object3D } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;
type CostHost = {
  __THREENATIVE_ENGINE_COST__?: unknown;
  __tnEngineCost?: Record<string, number>;
};

const plugins: Array<ReturnType<typeof rapier>> = [];
let savedKnob: unknown;

async function setup(): Promise<{ ctx: PhysicsCtx; plugin: ReturnType<typeof rapier> }> {
  await RAPIER.init();
  const plugin = rapier({ gravity: { x: 0, y: -9.81, z: 0 } });
  const ctx = { physics: undefined } as unknown as PhysicsCtx;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return { ctx, plugin };
}

/** A floor to land on, `walls` fixed bodies, and `crates` dynamic ones above it. */
function scene(ctx: PhysicsCtx, walls: number, crates: number): RigidBody3D[] {
  new RigidBody3D({
    physics: ctx.physics,
    position: { x: 0, y: -1, z: 0 },
    shape: CollisionShape3D.box(40, 1, 40),
    type: "fixed",
  });
  for (let index = 0; index < walls; index += 1) {
    new RigidBody3D({
      physics: ctx.physics,
      position: { x: index * 3, y: 0.5, z: 4 },
      shape: CollisionShape3D.box(1, 1, 1),
      type: "fixed",
    });
  }
  return Array.from({ length: crates }, (_, index) => {
    const object = new Object3D();
    object.position.set(index, 2, 0);
    return new RigidBody3D({
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.box(0.5, 0.5, 0.5),
    });
  });
}

function totals(): Record<string, number> {
  return { ...(globalThis as CostHost).__tnEngineCost };
}

function delta(before: Record<string, number>, name: string): number {
  return (totals()[name] ?? 0) - (before[name] ?? 0);
}

beforeEach(() => {
  savedKnob = (globalThis as CostHost).__THREENATIVE_ENGINE_COST__;
  (globalThis as CostHost).__THREENATIVE_ENGINE_COST__ = true;
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose?.({} as PhysicsCtx);
  (globalThis as CostHost).__THREENATIVE_ENGINE_COST__ = savedKnob;
});

// The profiler traced physics at 3.4-6.6 ms a frame on a loaded host against 2.1 ms on a quiet one,
// inside one unnamed Rapier function, with two candidate causes: more substeps per slow frame
// (fixed-step catch-up) or more awake bodies (shattered breakables). Neither is countable from the
// trace, and the loop already reports substeps, so these rows hold the two missing readings: the
// bodies the solver was handed, and the step's own cost.
describe("physics step counters", () => {
  it("counts the bodies and awake dynamics a step is handed, and the step's own microseconds", async () => {
    const { ctx, plugin } = await setup();
    scene(ctx, 3, 2);
    plugin.update?.(ctx, 1 / 60);
    const before = totals();
    plugin.update?.(ctx, 1 / 60);
    plugin.update?.(ctx, 1 / 60);
    // One floor, three walls, two falling crates: six bodies, one collider each, four of them fixed.
    expect(delta(before, "physicsBodies")).toBe(12);
    expect(delta(before, "physicsColliders")).toBe(12);
    expect(delta(before, "physicsDynamicBodies")).toBe(4);
    expect(delta(before, "physicsAwakeBodies")).toBe(4);
    const stepUs = delta(before, "physicsStepUs");
    expect(stepUs).toBeGreaterThan(0);
    expect(Number.isInteger(stepUs)).toBe(true);
  });

  it("stops counting a body that fell asleep and counts it again once an impulse wakes it", async () => {
    const { ctx, plugin } = await setup();
    const [crate] = scene(ctx, 0, 1);
    // Five seconds is well past Rapier's half-second sleep threshold for a crate at rest.
    for (let tick = 0; tick < 300; tick += 1) plugin.update?.(ctx, 1 / 60);
    const settled = totals();
    plugin.update?.(ctx, 1 / 60);
    expect(delta(settled, "physicsAwakeBodies")).toBe(0);
    expect(delta(settled, "physicsDynamicBodies")).toBe(1);
    expect(crate).toBeDefined();
    crate?.applyImpulse({ x: 0, y: 4, z: 0 });
    const woken = totals();
    plugin.update?.(ctx, 1 / 60);
    expect(delta(woken, "physicsAwakeBodies")).toBe(1);
  });

  it("counts nothing at all when no playtest asked for engine costs", async () => {
    const { ctx, plugin } = await setup();
    scene(ctx, 2, 1);
    plugin.update?.(ctx, 1 / 60);
    (globalThis as CostHost).__THREENATIVE_ENGINE_COST__ = undefined;
    const before = totals();
    for (let tick = 0; tick < 5; tick += 1) plugin.update?.(ctx, 1 / 60);
    // The crossing counters stay always-on; the per-step ones must not be paid for unasked.
    expect(delta(before, "physicsStepUs")).toBe(0);
    expect(delta(before, "physicsAwakeBodies")).toBe(0);
    expect(delta(before, "physicsBodies")).toBe(0);
    expect(delta(before, "physicsColliders")).toBe(0);
    expect(delta(before, "physicsDynamicBodies")).toBe(0);
  });
});
