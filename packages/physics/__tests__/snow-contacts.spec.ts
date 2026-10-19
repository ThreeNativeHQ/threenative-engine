import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { Heightfield, SnowField } from "@threenative/core/world";
import { Object3D } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";
import {
  type ISnowPhysicsBinding,
  attachSnowPhysics,
  boxFootprint,
  capsuleFootprint,
} from "../src/snow.js";

/**
 * These runs drive real Rapier. Nothing here mocks the solver: the acceptance is that a solved
 * contact, read back from the narrow phase, is what deforms the snow, and that the deformed
 * surface is what the next step collides against.
 */
const FIXED_STEP = 1 / 60;
const SNOW_DEPTH = 0.28;
const BALL_RADIUS = 0.25;
const BALL_MASS = 10;
const SETTLE_TOLERANCE = 0.02;

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

const plugins: Array<ReturnType<typeof rapier>> = [];
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const plugin of plugins.splice(0)) plugin.dispose?.({} as PhysicsCtx);
});

async function world(): Promise<PhysicsCtx> {
  await RAPIER.init();
  const plugin = rapier({ gravity: { x: 0, y: -9.81, z: 0 } });
  const ctx = { physics: undefined } as unknown as PhysicsCtx;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return ctx;
}

function snowField(
  options: { depth?: number; originX?: number; slopeX?: number; slopeZ?: number } = {},
): SnowField {
  const field = Heightfield.fromSampler({
    columns: 129,
    depth: 6,
    origin: { x: options.originX ?? 0, z: 0 },
    rows: 129,
    sampleHeight: (x, z) => x * (options.slopeX ?? 0) + z * (options.slopeZ ?? 0),
    width: 6,
  });
  return new SnowField({ depth: options.depth ?? SNOW_DEPTH, field });
}

async function scene(options: Parameters<typeof snowField>[0] = {}) {
  const ctx = await world();
  const snow = snowField(options);
  const binding = attachSnowPhysics({ physics: ctx.physics, snow });
  disposers.push(() => binding.dispose());
  return { binding, ctx, snow };
}

function ball(physics: IPhysicsContext, x: number, y: number, z: number): RigidBody3D {
  const object = new Object3D();
  object.position.set(x, y, z);
  return new RigidBody3D({
    mass: BALL_MASS,
    object,
    physics,
    shape: CollisionShape3D.sphere(BALL_RADIUS),
  });
}

function run(
  ctx: PhysicsCtx,
  bindings: ISnowPhysicsBinding | readonly ISnowPhysicsBinding[],
  steps: number,
  onStep?: (index: number) => void,
): void {
  const list = Array.isArray(bindings) ? bindings : [bindings];
  for (let index = 0; index < steps; index += 1) {
    ctx.physics.simulation.step(FIXED_STEP);
    for (const binding of list as readonly ISnowPhysicsBinding[]) binding.step(FIXED_STEP);
    onStep?.(index);
  }
}

function solved(ctx: PhysicsCtx, body: RigidBody3D) {
  const transform = ctx.physics.simulation.readBodyTransform?.(body.body.id);
  if (transform === undefined) throw new Error("the solver reported no transform for the body");
  return transform;
}

function sleeping(ctx: PhysicsCtx, body: RigidBody3D): boolean {
  const buffer = new Float32Array(64);
  const count = ctx.physics.simulation.readBodySleepStates(buffer);
  for (let index = 0; index < count; index += 1)
    if (buffer[index * 2] === body.body.id) return buffer[index * 2 + 1] === 1;
  return false;
}

/** Angle between two unit quaternions, in radians. */
function turned(a: { x: number; y: number; z: number; w: number }, b: typeof a): number {
  const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
  return 2 * Math.acos(dot);
}

describe("sphere on deformable snow under real physics", () => {
  it("does not stamp while airborne, then settles on the surface it made", async () => {
    const { binding, ctx, snow } = await scene();
    const body = ball(ctx.physics, 0, 1.6, 0);
    binding.add(body);

    run(ctx, binding, 15, () => expect(binding.loadOf(body)).toBe(0));
    expect(solved(ctx, body).position.y).toBeGreaterThan(SNOW_DEPTH + BALL_RADIUS + 0.3);
    expect(snow.steps).toBe(0);
    expect(snow.activeCells).toBe(0);

    let pressed = 0;
    run(ctx, binding, 285, () => {
      pressed += binding.supported;
    });
    const rest = solved(ctx, body).position;
    expect(pressed).toBeGreaterThan(0);
    expect(snow.sample(0, 0).indent).toBeGreaterThan(0.02);
    // The sphere's underside and the surface it made agree within the acceptance tolerance.
    expect(Math.abs(rest.y - BALL_RADIUS - snow.heightAt(rest.x, rest.z))).toBeLessThan(
      SETTLE_TOLERANCE,
    );
    // The load came from the solver and roughly carries the sphere's weight.
    run(ctx, binding, 1);
    const observed = binding.observe();
    expect(observed.loadProvenance).toBe("solver-impulse-per-step");
    expect(binding.loadOf(body)).toBe(observed.load);
    if (observed.supported > 0) {
      expect(observed.load).toBeGreaterThan(BALL_MASS * 9.81 * 0.5);
      expect(observed.load).toBeLessThan(BALL_MASS * 9.81 * 2);
    }
  });

  it("rolls a pushed sphere through a connected circular track", async () => {
    const { binding, ctx, snow } = await scene();
    const body = ball(ctx.physics, 0, 0.6, -2);
    binding.add(body);
    run(ctx, binding, 90);
    expect(snow.sample(0, -2).indent).toBeGreaterThan(0.01);

    body.applyImpulse({ x: 0, y: 0, z: 8 });
    let previous = solved(ctx, body).rotation;
    let rotation = 0;
    run(ctx, binding, 180, () => {
      const current = solved(ctx, body).rotation;
      rotation += turned(previous, { ...current });
      previous = { ...current };
    });
    const end = solved(ctx, body).position;
    const travelled = end.z + 2;
    expect(travelled).toBeGreaterThan(1);
    expect(Math.abs(end.x)).toBeLessThan(0.05);
    // The solver rolled it: the turn it made matches the distance over its radius.
    expect(rotation).toBeGreaterThan((travelled / BALL_RADIUS) * 0.8);
    expect(rotation).toBeLessThan((travelled / BALL_RADIUS) * 1.2);

    // Every sample along the path is pressed: the track is connected, not a row of holes.
    for (let index = 0; index <= 40; index += 1) {
      const z = -2 + (index / 40) * travelled;
      expect(snow.sample(0, z).indent).toBeGreaterThan(0.005);
    }
    // And it is circular: pressed under the centre line, untouched beyond the radius.
    expect(snow.sample(BALL_RADIUS * 0.5, -1).indent).toBeGreaterThan(0.002);
    expect(snow.sample(BALL_RADIUS * 1.6, -1).indent).toBeLessThan(0.0005);
  });

  it("presses with the vertical part of a contact, so a sideways shove does not dig a pit", async () => {
    const { binding, ctx, snow } = await scene();
    const body = ball(ctx.physics, 0, 0.6, 0);
    binding.add(body);
    run(ctx, binding, 120);
    const resting = snow.sample(0, 0).indent;
    // A hard horizontal shove drives the ball into the wall of its own crater for a step or two.
    body.applyImpulse({ x: 0, y: 0, z: 18 });
    let deepest = 0;
    run(ctx, binding, 6, () => {
      for (let z = -0.3; z <= 0.6; z += 0.05) deepest = Math.max(deepest, snow.sample(0, z).indent);
    });
    expect(deepest).toBeLessThan(resting + 0.01);
  });

  it("keeps the collider on the canonical surface with at most one step of lag", async () => {
    const { binding, ctx, snow } = await scene();
    const body = ball(ctx.physics, 0.3, 0.8, 0.2);
    binding.add(body);
    run(ctx, binding, 120, () => {
      // Solve, consume contacts once, deform, then the collider matches before the next step.
      expect(binding.surfaceVersion).toBe(snow.version);
      expect(binding.observe().colliderError).toBeLessThanOrEqual(0.001);
    });

    // A game-side reset lands between steps; the next consumed step installs it.
    snow.reset();
    expect(binding.observe().colliderError).toBeGreaterThan(0.001);
    run(ctx, binding, 1);
    expect(binding.observe().colliderError).toBeLessThanOrEqual(0.001);

    // Triangle interiors of the collider agree with the canonical surface.
    run(ctx, binding, 120);
    let worst = 0;
    for (let index = 0; index < 60; index += 1) {
      const x = 0.3 + Math.cos(index) * 0.37 * ((index % 7) / 7);
      const z = 0.2 + Math.sin(index * 1.3) * 0.37 * ((index % 5) / 5);
      const hit = ctx.physics.simulation.intersectRay({
        collisionMask: 0xffff,
        from: { x, y: 3, z },
        to: { x, y: -1, z },
      });
      if (hit === undefined || hit.body.id !== binding.surface.id) continue;
      worst = Math.max(worst, Math.abs(3 - hit.distance - snow.heightAt(x, z)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("wakes a resting sphere when the snow beneath it changes depth", async () => {
    const { binding, ctx, snow } = await scene({ depth: 0.4 });
    const body = ball(ctx.physics, 0, 0.8, 0);
    binding.add(body);
    let slept = false;
    run(ctx, binding, 900, () => {
      slept ||= sleeping(ctx, body);
    });
    expect(slept).toBe(true);
    snow.setDepth(0.1);
    run(ctx, binding, 180);
    const rest = solved(ctx, body).position;
    expect(Math.abs(rest.y - BALL_RADIUS - snow.heightAt(rest.x, rest.z))).toBeLessThan(
      SETTLE_TOLERANCE,
    );
  });

  it("integrates the same under 30, 60 and 120 Hz presentation", async () => {
    const indents: number[] = [];
    for (const hz of [30, 60, 120]) {
      const { binding, ctx, snow } = await scene();
      binding.deposition = 0.002;
      binding.wind = 0.4;
      const body = ball(ctx.physics, 0, 0.7, 0);
      binding.add(body);
      // A fixed-step accumulator fed by frames of the presentation rate.
      let accumulator = 0;
      for (let frame = 0; frame < 3 * hz; frame += 1) {
        accumulator += 1 / hz;
        while (accumulator >= FIXED_STEP - 1e-9) {
          ctx.physics.simulation.step(FIXED_STEP);
          binding.step(FIXED_STEP);
          accumulator -= FIXED_STEP;
        }
      }
      indents.push(snow.sample(0, 0).indent);
    }
    expect(indents[0]).toBeGreaterThan(0.01);
    expect(Math.max(...indents) - Math.min(...indents)).toBeLessThanOrEqual(0.001);
  });
});

describe("box and capsule contacts", () => {
  it("presses a box's resting face and a fallen capsule's trough", async () => {
    const { binding, ctx, snow } = await scene();
    const boxObject = new Object3D();
    boxObject.position.set(-1.5, 1, 0);
    // Turned a quarter around y, so a print aligned to the body proves orientation is used.
    boxObject.rotation.y = Math.PI / 2;
    const box = new RigidBody3D({
      mass: 60,
      object: boxObject,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1.0, 0.4, 0.5),
    });
    const capsuleObject = new Object3D();
    capsuleObject.position.set(1.5, 1, 0);
    // Laid on its side so its spine runs along z, as a fallen body's does.
    capsuleObject.rotation.x = Math.PI / 2;
    const capsule = new RigidBody3D({
      mass: 60,
      object: capsuleObject,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.5, 0.2),
    });
    binding.add(box);
    binding.add(capsule);
    run(ctx, binding, 400);

    // The box's 1.0 m side now runs along z and its 0.5 m side along x.
    expect(snow.sample(-1.5, 0).indent).toBeGreaterThan(0.01);
    expect(snow.sample(-1.5, 0.4).indent).toBeGreaterThan(0.01);
    expect(snow.sample(-1.5 + 0.4, 0).indent).toBeLessThan(0.002);
    expect(snow.sample(-1.5, 0.75).indent).toBeLessThan(0.002);

    // The capsule's trough runs along its spine: both ends pressed, the flanks not.
    expect(snow.sample(1.5, 0).indent).toBeGreaterThan(0.01);
    expect(snow.sample(1.5, -0.5).indent).toBeGreaterThan(0.01);
    expect(snow.sample(1.5, 0.5).indent).toBeGreaterThan(0.01);
    expect(snow.sample(1.5 + 0.4, 0).indent).toBeLessThan(0.002);

    // Both still rest on the surface they made.
    expect(solved(ctx, box).position.y - 0.2 - snow.heightAt(-1.5, 0)).toBeLessThan(0.03);
    expect(solved(ctx, capsule).position.y - 0.2 - snow.heightAt(1.5, 0)).toBeLessThan(0.03);
  });

  it("presses an upright capsule as a disc, not a trough", async () => {
    const { binding, ctx, snow } = await scene();
    const object = new Object3D();
    object.position.set(0, 1.2, 0);
    const capsule = new RigidBody3D({
      mass: 60,
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.5, 0.2),
    });
    binding.add(capsule);
    run(ctx, binding, 20);
    // Within the first contacts it is still upright: a round print, no trough along any axis.
    run(ctx, binding, 10);
    expect(snow.steps).toBeGreaterThan(0);
    expect(snow.sample(0, 0).indent).toBeGreaterThan(0.005);
    expect(snow.sample(0, 0.45).indent).toBeLessThan(0.001);
    expect(snow.sample(0.45, 0).indent).toBeLessThan(0.001);
  });

  it("orients the surface collider on the field's own axes and scale", async () => {
    for (const slope of [
      { slopeX: 0.15, slopeZ: 0 },
      { slopeX: 0, slopeZ: 0.15 },
    ]) {
      const { binding, ctx, snow } = await scene(slope);
      // Placed up the slope: a transposed or mis-scaled collider would put it at the wrong height.
      const object = new Object3D();
      object.position.set(slope.slopeX > 0 ? 1.8 : 0, 2, slope.slopeZ > 0 ? 1.8 : 0);
      const high = new RigidBody3D({
        mass: 20,
        object,
        physics: ctx.physics,
        shape: CollisionShape3D.box(0.4, 0.4, 0.4),
      });
      binding.add(high);
      run(ctx, binding, 240);
      const position = solved(ctx, high).position;
      // A box resting on a 0.15 slope: centre stands half its height over the surface, tilted.
      const expected = snow.heightAt(position.x, position.z) + 0.2 / Math.cos(Math.atan(0.15));
      expect(Math.abs(position.y - expected)).toBeLessThan(0.03);
      // It stayed far enough up the slope that a transposed collider would be > 0.09 m off.
      expect(slope.slopeX > 0 ? position.x : position.z).toBeGreaterThan(0.6);
    }
  });
});

describe("snow binding lifecycle", () => {
  it("survives recovery and a field reset without a stale collider or fall-through", async () => {
    const { binding, ctx, snow } = await scene();
    binding.deposition = 0.002;
    binding.wind = 0.5;
    const body = ball(ctx.physics, 0, 0.6, 0);
    binding.add(body);
    run(ctx, binding, 300);
    const surface = binding.surface;
    expect(snow.activeCells).toBeGreaterThan(0);

    run(ctx, binding, 600);
    expect(binding.surface).toBe(surface);
    expect(binding.surfaceVersion).toBe(snow.version);

    snow.reset();
    run(ctx, binding, 240);
    expect(binding.surface).toBe(surface);
    const rest = solved(ctx, body).position;
    expect(Math.abs(rest.y - BALL_RADIUS - snow.heightAt(rest.x, rest.z))).toBeLessThan(
      SETTLE_TOLERANCE,
    );
  });

  it("routes contacts only to the field a body touches when two share a world", async () => {
    const ctx = await world();
    const west = snowField({ originX: -4 });
    const east = snowField({ originX: 4 });
    const westBinding = attachSnowPhysics({ physics: ctx.physics, snow: west });
    const eastBinding = attachSnowPhysics({ physics: ctx.physics, snow: east });
    disposers.push(
      () => westBinding.dispose(),
      () => eastBinding.dispose(),
    );
    const body = ball(ctx.physics, -4, 0.8, 0);
    westBinding.add(body);
    eastBinding.add(body);
    run(ctx, [westBinding, eastBinding], 240);
    expect(west.sample(-4, 0).indent).toBeGreaterThan(0.01);
    expect(east.steps).toBe(0);
    expect(east.activeCells).toBe(0);
    expect(eastBinding.contacts).toBe(0);
  });

  it("ignores bodies resting on scenery and stops watching a removed body", async () => {
    const { binding, ctx, snow } = await scene();
    new RigidBody3D({
      physics: ctx.physics,
      position: { x: 1, y: 0.6, z: 0 },
      shape: CollisionShape3D.box(1, 0.2, 1),
      type: "fixed",
    });
    const onPlatform = ball(ctx.physics, 1, 1.2, 0);
    binding.add(onPlatform);
    run(ctx, binding, 120);
    expect(snow.steps).toBe(0);

    const onSnow = ball(ctx.physics, -1, 0.6, 0);
    binding.add(onSnow);
    run(ctx, binding, 60);
    const steps = snow.steps;
    expect(steps).toBeGreaterThan(0);
    binding.remove(onSnow);
    run(ctx, binding, 60);
    expect(snow.steps).toBe(steps);
  });

  it("refuses a shape it cannot profile and names the ones it can", async () => {
    const { binding, ctx } = await scene();
    const mesh = new RigidBody3D({
      mass: 5,
      object: new Object3D(),
      physics: ctx.physics,
      shape: CollisionShape3D.heightfield(3, 3, new Float32Array(9), { x: 1, y: 1, z: 1 }),
    });
    expect(() => binding.add(mesh)).toThrow(/supported shapes are sphere, box, capsule/);
    expect(() => binding.add(mesh, boxFootprint(0.5, 0.5))).not.toThrow();
    expect(() => binding.add(mesh, capsuleFootprint(0.4, 0.15))).not.toThrow();
  });

  it("rejects malformed tuning and steps, and disposes idempotently", async () => {
    const { binding, ctx, snow } = await scene();
    expect(() => binding.step(0)).toThrow(/delta time/);
    expect(() => binding.step(Number.NaN)).toThrow(/delta time/);
    expect(() => attachSnowPhysics({ loadScale: Number.NaN, physics: ctx.physics, snow })).toThrow(
      /loadScale/,
    );
    binding.wind = Number.POSITIVE_INFINITY;
    expect(() => binding.step(FIXED_STEP)).toThrow(/wind/);
    expect(() => capsuleFootprint(0.4, 0)).toThrow(/radius/);
    expect(() => boxFootprint(-1, 1)).toThrow(/halfWidth/);
    binding.dispose();
    expect(() => binding.dispose()).not.toThrow();
    expect(() => binding.step(FIXED_STEP)).not.toThrow();
  });
});
