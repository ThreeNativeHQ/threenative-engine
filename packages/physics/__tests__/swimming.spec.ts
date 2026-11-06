import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { BoxGeometry, Group, Mesh } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { CharacterBody3D, type ICharacterBody3DOptions } from "../src/CharacterBody3D.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

// The strata player's capsule: 0.5 m half height + 0.35 m radius, 1.7 m tall.
const HALF = 0.85;
const plugins: Array<ReturnType<typeof rapier>> = [];

async function world(floorTop: number) {
  await RAPIER.init();
  const plugin = rapier({ gravity: { x: 0, y: 0, z: 0 } });
  const ctx = { physics: undefined } as unknown as ICtx<Record<string, unknown>, IPhysicsContext>;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  const floor = new Mesh(new BoxGeometry(200, 1, 200));
  floor.position.set(0, floorTop - 0.5, 0);
  new RigidBody3D({
    object: floor,
    physics: ctx.physics,
    shape: CollisionShape3D.fromMesh(floor),
    type: "fixed",
  });
  const object = new Group();
  const swimmer = (
    y: number,
    water: (x: number, z: number) => number | undefined,
    {
      current,
      buoyancy,
    }: {
      current?: ICharacterBody3DOptions["waterCurrent"];
      buoyancy?: ICharacterBody3DOptions["buoyancy"];
    } = {},
  ) => {
    object.position.set(0, y, 0);
    return new CharacterBody3D({
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.5, 0.35),
      snapToGround: 0.4,
      water,
      waterCurrent: current,
      buoyancy,
    });
  };
  const run = (body: CharacterBody3D, seconds: number, vx = 0) => {
    for (let tick = 0; tick < seconds * 60; tick += 1) {
      body.velocity.x = vx;
      body.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
  };
  return { object, run, swimmer };
}

afterEach(() => {
  for (const plugin of plugins.splice(0))
    plugin.dispose?.({} as ICtx<Record<string, unknown>, IPhysicsContext>);
});

describe("CharacterBody3D in water", () => {
  it("floats in deep water at the immersion its buoyancy holds, off the bed", async () => {
    // Surface at 0, bed 5 m down: a walker would sink to the bed and stand there.
    const { object, run, swimmer } = await world(-5);
    const body = swimmer(-0.3, () => 0);
    run(body, 4);
    expect(body.swimming).toBe(true);
    expect(body.grounded).toBe(false);
    expect(body.waterSurface).toBe(0);
    // Unreal floats a swimmer where Buoyancy * ImmersionDepth = 1.
    expect(body.immersionDepth).toBeCloseTo(1 / body.buoyancy, 1);
    expect(object.position.y).toBeGreaterThan(-HALF);
    expect(object.position.y).toBeLessThan(0);
    expect(Math.abs(body.velocity.y)).toBeLessThan(0.15);
  });

  it("swims at maxSwimSpeed, slower than it walks", async () => {
    const { object, run, swimmer } = await world(-5);
    const body = swimmer(-0.2, () => 0);
    run(body, 1, 6);
    expect(body.swimming).toBe(true);
    expect(body.maxSwimSpeed).toBe(3);
    expect(body.velocity.x).toBeLessThanOrEqual(3);
    expect(object.position.x).toBeGreaterThan(2.7);
    expect(object.position.x).toBeLessThan(3.1);
  });

  it("wades in shallow water: it stays on the bed, slowed, and does not swim", async () => {
    // 0.4 m of water over the floor: knee deep on a 1.7 m body.
    const { object, run, swimmer } = await world(0);
    const body = swimmer(HALF + 0.05, () => 0.4);
    run(body, 1, 9);
    expect(body.swimming).toBe(false);
    expect(body.grounded).toBe(true);
    expect(body.immersionDepth).toBeCloseTo(0.4 / (2 * HALF), 1);
    expect(body.velocity.x).toBeLessThan(9);
    expect(body.velocity.x).toBeGreaterThan(body.maxSwimSpeed);
    expect(object.position.x).toBeGreaterThan(5);
  });

  it("is carried downstream by a river current at the water's own speed", async () => {
    const { object, run, swimmer } = await world(-5);
    // The default buoyancy floats the body with its centre under, so the water carries it at the
    // current's full 0.9 m/s, as Unreal settles a floating body at the river's speed.
    const body = swimmer(-1, () => 0, { current: () => ({ x: 0.9, z: 0 }) });
    run(body, 2);
    expect(body.swimming).toBe(true);
    expect(body.currentVelocity.x).toBeCloseTo(0.9, 2);
    expect(object.position.x).toBeGreaterThan(1.8 * 0.85);
    expect(object.position.x).toBeLessThan(1.8 * 1.15);
    body.waterCurrent = () => ({ x: Number.NaN, z: 0 });
    expect(() => body.moveAndSlide(1 / 60)).toThrow(/waterCurrent/);
  });

  it("stands still on land with the same current", async () => {
    const { object, run, swimmer } = await world(0);
    const body = swimmer(HALF + 0.05, () => undefined, { current: () => ({ x: 0.9, z: 0 }) });
    run(body, 2);
    expect(body.swimming).toBe(false);
    expect(body.currentVelocity).toEqual({ x: 0, z: 0 });
    expect(Math.abs(object.position.x)).toBeLessThan(0.01);
  });

  it("drifts slower wading than swimming in the same current", async () => {
    // Knee-deep water over the bed: the feet hold the bed, so a wader drifts at (2 * depth)^2 of the
    // current a swimmer is carried at whole.
    const wade = await world(0);
    const wader = wade.swimmer(HALF + 0.05, () => 0.5, { current: () => ({ x: 0.9, z: 0 }) });
    // Fluid friction settles a body into the bed slowly; measure the drift from where it comes to rest.
    wade.run(wader, 3);
    const depth = wader.immersionDepth;
    const start = wade.object.position.x;
    expect(wader.swimming).toBe(false);
    expect(depth).toBeGreaterThan(0.2);
    expect(depth).toBeLessThan(0.4);
    wade.run(wader, 2);
    const drift = wade.object.position.x - start;
    // 0.9 m/s for 2 s, times the wader's share, within the 15% a slide against the bed costs.
    const share = (2 * depth) ** 2;
    expect(drift / 1.8).toBeGreaterThan(share * 0.85);
    expect(drift / 1.8).toBeLessThan(share * 1.15);
    const swim = await world(-5);
    const body = swim.swimmer(-1, () => 0, { current: () => ({ x: 0.9, z: 0 }) });
    swim.run(body, 2);
    expect(drift).toBeLessThan(swim.object.position.x * 0.6);
  });

  it("walks out where the query reports no water, and rejects a malformed surface", async () => {
    const { run, swimmer } = await world(-5);
    const body = swimmer(-0.2, (x) => (x < 1 ? 0 : undefined));
    run(body, 2, 3);
    expect(body.swimming).toBe(false);
    expect(body.immersionDepth).toBe(0);
    expect(body.waterSurface).toBeUndefined();
    body.water = () => Number.NaN;
    expect(() => body.moveAndSlide(1 / 60)).toThrow(/water/);
  });
});
