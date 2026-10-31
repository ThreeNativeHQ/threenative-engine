import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { BoxGeometry, Group, Mesh, Vector3 } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { FixedStepLoop } from "../../core/src/loop.js";
import { roundedBox } from "../../create-threenative/templates/starter/src/render/shapes.js";
import { CharacterBody3D } from "../src/CharacterBody3D.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

const plugins: Array<ReturnType<typeof rapier>> = [];

async function setup(gravity = { x: 0, y: 0, z: 0 }) {
  await RAPIER.init();
  const plugin = rapier({ gravity });
  const ctx = { physics: undefined } as unknown as ICtx<Record<string, unknown>, IPhysicsContext>;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return { ctx, plugin };
}

function fixedBody(
  ctx: IPhysicsContext,
  geometry: BoxGeometry,
  x: number,
  y: number,
  rotation = 0,
) {
  const mesh = new Mesh(geometry);
  mesh.position.set(x, y, 0);
  mesh.rotation.z = rotation;
  return new RigidBody3D({
    object: mesh,
    physics: ctx,
    shape: CollisionShape3D.fromMesh(mesh),
    type: "fixed",
  });
}

afterEach(() => {
  for (const plugin of plugins.splice(0))
    plugin.dispose?.({} as ICtx<Record<string, unknown>, IPhysicsContext>);
});

describe("CharacterBody3D", () => {
  it("falls beside a trimesh box while moving into its vertical face", async () => {
    const { ctx, plugin } = await setup();
    const wall = new Mesh(new BoxGeometry(3, 10, 2.6));
    wall.position.set(1.5, -5, 0);
    const body = new RigidBody3D({
      object: wall,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(wall, "trimesh"),
      type: "fixed",
    });
    const mesh = new Group();
    mesh.position.set(-0.32, -1, 0);
    const character = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.6, 0.3),
    });
    for (let tick = 0; tick < 60; tick += 1) {
      character.velocity.x = 2;
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
      expect(character.grounded, `tick ${tick}`).toBe(false);
    }
    expect(mesh.position.y).toBeLessThan(-2);
    character.dispose();
    body.dispose();
  });

  it("falls beside the starter's rounded island wall instead of reading it as ground", async () => {
    const { ctx, plugin } = await setup();
    // The template's `roundedBox` bevels with a 3x3 face grid. Pressed into its side, a capsule
    // used to report `grounded` and sink at 0.16 m/s along a wall, never reaching the kill plane.
    const wall = new Mesh(roundedBox(3, 5.4, 2.6, 0.1).clone().translate(7.9, -3.3, 0));
    const body = new RigidBody3D({
      object: wall,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(wall, "trimesh"),
      type: "fixed",
    });
    const mesh = new Group();
    mesh.position.set(6, -0.2, 0);
    const character = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.6, 0.3),
    });
    for (let tick = 0; tick < 90; tick += 1) {
      character.velocity.x = 1.5;
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    expect(character.grounded).toBe(false);
    expect(mesh.position.y).toBeLessThan(-3);
    character.dispose();
    body.dispose();
  });

  it("should accumulate gravity into velocity when airborne", async () => {
    const { ctx, plugin } = await setup();
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.y = 4;
    const character = new CharacterBody3D({
      gravity: -9.81,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });

    for (let step = 0; step < 10; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }

    expect(character.velocity.y).toBeLessThan(0);
    character.dispose();
  });

  it("should keep physics fixed-step during a 500ms render stall", async () => {
    const { ctx, plugin } = await setup({ x: 0, y: -9.81, z: 0 });
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.y = 4;
    const character = new CharacterBody3D({
      gravity: -9.81,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });
    const physicsSteps: number[] = [];
    const loop = new FixedStepLoop({
      onUpdate: (dt) => {
        physicsSteps.push(dt);
        character.moveAndSlide(dt);
        plugin.update?.(ctx, dt);
      },
    });

    loop.stepFrame(0);
    loop.stepFrame(500);

    expect(physicsSteps).toHaveLength(3); // a stall adds at most 1/20 s (core loop maxPhysicsDeltaTime)
    expect(physicsSteps.every((dt) => dt === 1 / 60)).toBe(true);
    expect(mesh.position.y).toBeGreaterThan(3.9);
    character.dispose();
  });

  it("should zero downward velocity when grounded", async () => {
    const { ctx, plugin } = await setup();
    const floor = fixedBody(ctx.physics, new BoxGeometry(10, 0.2, 4), 0, -0.1);
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(0, 0.5, 0);
    const character = new CharacterBody3D({
      gravity: -9.81,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });

    for (let step = 0; step < 30; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }

    expect(character.grounded).toBe(true);
    expect(character.velocity.y).toBe(0);
    expect(character.groundBody).toBe(floor.body);
    expect(character.groundNormal.x).toBeCloseTo(0, 5);
    expect(character.groundNormal.y).toBeCloseTo(1, 5);
    expect(character.groundNormal.z).toBeCloseTo(0, 2);
    expect(character.slopeAngle).toBeLessThan(0.01);
    character.dispose();
    floor.dispose();
  });

  it("stays grounded on a floor while it presses into a vertical wall", async () => {
    const { ctx, plugin } = await setup();
    const floorMesh = new Mesh(new BoxGeometry(10, 0.2, 4));
    floorMesh.position.set(0, -0.1, 0);
    const floor = new RigidBody3D({
      object: floorMesh,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(floorMesh, "trimesh"),
      type: "fixed",
    });
    // Kinematic, like a push block: a box whose west face stands at x = 0.5.
    const blockMesh = new Mesh(new BoxGeometry(1, 1, 1));
    blockMesh.position.set(1, 0.5, 0);
    const block = new RigidBody3D({
      object: blockMesh,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(blockMesh),
      type: "kinematic",
    });
    const mesh = new Group();
    mesh.position.set(0, 0.86, 0.36);
    const character = new CharacterBody3D({
      autostep: { maxHeight: 0.3, minWidth: 0.2 },
      gravity: -20,
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.55, 0.3),
      snapToGround: 0.3,
    });
    for (let step = 0; step < 30; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    for (let tick = 0; tick < 100; tick += 1) {
      character.velocity.x = 2.5;
      // The block slides one metre away and stops, the way a pushed block does.
      if (tick >= 20 && tick < 70) blockMesh.position.x += 1 / 50;
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
      if (tick >= 20) expect(character.grounded, `tick ${tick}`).toBe(true);
    }
    expect(mesh.position.x).toBeGreaterThan(0.15);
    expect(mesh.position.y).toBeLessThan(0.9);
    character.dispose();
    block.dispose();
    floor.dispose();
  });

  it("should carry a grounded rider with a moving kinematic platform", async () => {
    const { ctx, plugin } = await setup();
    const platformMesh = new Mesh(new BoxGeometry(4, 0.2, 4));
    platformMesh.position.y = -0.1;
    const platform = new RigidBody3D({
      object: platformMesh,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(platformMesh),
      type: "kinematic",
    });
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(0, 0.5, 0);
    const character = new CharacterBody3D({
      gravity: -9.81,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });

    for (let step = 0; step < 120; step += 1) {
      platformMesh.position.x += 0.02;
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }

    expect(character.grounded).toBe(true);
    expect(character.groundBody).toBe(platform.body);
    expect(mesh.position.x).toBeGreaterThan(1.5);
    character.dispose();
    platform.dispose();
  });

  it("should apply the motion reported by its ground collider", async () => {
    const { ctx, plugin } = await setup();
    fixedBody(ctx.physics, new BoxGeometry(10, 0.2, 4), 0, -0.1);
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(0, 0.5, 0);
    const character = new CharacterBody3D({
      gravity: -9.81,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });

    for (let step = 0; step < 30; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    ctx.physics.kinematicMotion = () => ({ x: 1.5, y: 0, z: 0 });
    character.moveAndSlide(1 / 60);
    plugin.update?.(ctx, 1 / 60);

    expect(character.grounded).toBe(true);
    expect(mesh.position.x).toBeGreaterThan(1.4);
    character.dispose();
  });

  it("should not carry a rider that is not grounded on the platform", async () => {
    const { ctx, plugin } = await setup();
    const platformMesh = new Mesh(new BoxGeometry(4, 0.2, 4));
    platformMesh.position.y = -0.1;
    const platform = new RigidBody3D({
      object: platformMesh,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(platformMesh),
      type: "kinematic",
    });
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(0, 0.5, 0);
    const character = new CharacterBody3D({
      gravity: -9.81,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });

    for (let step = 0; step < 30; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    character.velocity.y = 5;
    platformMesh.position.x += 1;
    character.moveAndSlide(1 / 60);
    plugin.update?.(ctx, 1 / 60);

    expect(mesh.position.x).toBeLessThan(0.2);
    character.dispose();
    platform.dispose();
  });

  it("should climb a 0.3-unit step without stopping", async () => {
    const { ctx, plugin } = await setup();
    fixedBody(ctx.physics, new BoxGeometry(10, 0.2, 4), 0, -0.1);
    fixedBody(ctx.physics, new BoxGeometry(0.6, 0.3, 4), 1, 0.15);
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(-2, 0.5, 0);
    const character = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });

    for (let step = 0; step < 120; step++) {
      character.move({ x: 2 / 60, y: 0, z: 0 });
      plugin.update?.(ctx, 1 / 60);
    }

    expect(mesh.position.x).toBeGreaterThan(1.25);
    expect(mesh.position.y).toBeGreaterThan(0.7);
    character.dispose();
  });

  it("should not climb a 60-degree slope", async () => {
    const { ctx, plugin } = await setup();
    fixedBody(ctx.physics, new BoxGeometry(10, 0.2, 4), 0, -0.1);
    fixedBody(ctx.physics, new BoxGeometry(3, 0.2, 4), 0, 0.9, Math.PI / 3);
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(-2, 0.5, 0);
    const character = new CharacterBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });

    for (let step = 0; step < 120; step++) {
      character.move({ x: 2 / 60, y: 0, z: 0 });
      plugin.update?.(ctx, 1 / 60);
    }

    expect(mesh.position.x).toBeLessThan(0);
    character.dispose();
  });

  it("should expose the normal and angle of a walkable slope", async () => {
    const { ctx, plugin } = await setup();
    const slope = fixedBody(ctx.physics, new BoxGeometry(8, 0.2, 4), 0, 0, Math.PI / 6);
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(0, 2, 0);
    const character = new CharacterBody3D({
      gravity: -9.81,
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
    });

    for (let step = 0; step < 120; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }

    expect(character.grounded).toBe(true);
    expect(character.groundBody).toBe(slope.body);
    expect(character.groundNormal.y).toBeLessThan(0.99);
    expect(character.groundNormal.y).toBeGreaterThan(0.8);
    expect(character.slopeAngle).toBeGreaterThan(0.1);
    expect(character.slopeAngle).toBeLessThan(Math.PI / 4);
    character.dispose();
    slope.dispose();
  });

  it("should ignore colliders outside its collision mask while moving", async () => {
    const { ctx, plugin } = await setup();
    const wallMesh = new Mesh(new BoxGeometry(0.6, 2, 4));
    const wall = new RigidBody3D({
      collisionLayer: 4,
      object: wallMesh,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(wallMesh),
      type: "fixed",
    });
    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.x = -2;
    const character = new CharacterBody3D({
      collisionLayer: 1,
      collisionMask: 0xfffb,
      gravity: 0,
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
    });

    for (let step = 0; step < 120; step += 1) {
      character.move({ x: 2 / 60, y: 0, z: 0 });
      plugin.update?.(ctx, 1 / 60);
    }

    expect(mesh.position.x).toBeGreaterThan(1.5);
    character.dispose();
    wall.dispose();
  });

  it("should clear the filter predicate after step() and land on a one-way platform", async () => {
    const { ctx, plugin } = await setup();
    fixedBody(ctx.physics, new BoxGeometry(10, 0.2, 4), 0, -0.1);
    const platformMesh = new Mesh(new BoxGeometry(4, 0.2, 4));
    platformMesh.position.y = 2;
    const platform = new RigidBody3D({
      collisionLayer: 2,
      object: platformMesh,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(platformMesh),
      type: "fixed",
    });

    const mesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    mesh.position.set(0, 0.5, 0);
    const character = new CharacterBody3D({
      gravity: -9.81,
      oneWayLayers: 2,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: mesh,
    });
    character.velocity.y = 8;

    for (let step = 0; step < 120; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }

    expect(character.grounded).toBe(true);
    expect(mesh.position.y).toBeGreaterThan(2.3);
    character.dispose();
    platform.dispose();
  });

  it("should drive a Group as a character body", async () => {
    const { ctx, plugin } = await setup();
    const object = new Group();
    const left = new Mesh(new BoxGeometry(0.4, 0.4, 0.4));
    const right = new Mesh(new BoxGeometry(0.4, 0.4, 0.4));
    left.position.x = -0.6;
    right.position.x = 0.6;
    object.add(left, right);
    const character = new CharacterBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object,
    });

    character.move({ x: 1, y: 0, z: 0 });
    plugin.update?.(ctx, 1 / 60);

    const leftWorld = left.getWorldPosition(new Vector3());
    const rightWorld = right.getWorldPosition(new Vector3());
    expect(object.position.x).toBeCloseTo(1, 4);
    expect(leftWorld.x).toBeCloseTo(object.position.x - 0.6, 4);
    expect(rightWorld.x).toBeCloseTo(object.position.x + 0.6, 4);
    character.dispose();
  });

  it("should preserve script-controlled rotation through a physics tick", async () => {
    const { ctx, plugin } = await setup();
    const object = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    const character = new CharacterBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object,
    });

    object.rotation.y = Math.PI / 2;
    character.move({ x: 1, y: 0, z: 0 });
    plugin.update?.(ctx, 1 / 60);

    expect(object.rotation.y).toBeCloseTo(Math.PI / 2, 4);
    expect((character.body.raw as RAPIER.RigidBody).rotation().y).toBeCloseTo(
      Math.sin(Math.PI / 4),
      4,
    );
    character.dispose();
  });

  it("should keep CollisionShape3D.fromMesh taking a Mesh", () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    expect(() => CollisionShape3D.fromMesh(mesh)).not.toThrow();
  });

  // A primitive collider is centred on the body, so geometry whose bounds are not centred on its
  // own origin (translated or merged in place) used to get a displaced collider silently — it
  // floated a 1.8 m figure 0.4 m above the floor it stood on. Refuse by name instead.
  it("should refuse a primitive collider for off-centre geometry, naming the fix", () => {
    const offCentre = new Mesh(new BoxGeometry(1, 1, 1).translate(3, 0.5, 0));
    expect(() => CollisionShape3D.fromMesh(offCentre)).toThrow(/TN_COLLISION_SHAPE_OFF_CENTRE/u);
    expect(() => CollisionShape3D.fromMesh(offCentre, "trimesh")).not.toThrow();
  });

  // The centre check is in metres, so scale each axis by its own factor before comparing it with
  // the scaled dimensions. A 0.001 unit offset under scale 100 is 0.1 m of collider drift — a
  // tenth of the 1 m body — and must be refused; a 1 unit offset under scale 1e-6 is one
  // micrometre and must not be. Both passed unscaled, in opposite directions.
  it("should measure the off-centre offset in scaled metres", () => {
    const tenthOfTheBody = new Mesh(new BoxGeometry(0.01, 0.01, 0.01).translate(0.001, 0, 0));
    tenthOfTheBody.scale.setScalar(100);
    expect(() => CollisionShape3D.fromMesh(tenthOfTheBody)).toThrow(
      /TN_COLLISION_SHAPE_OFF_CENTRE/u,
    );

    const micrometre = new Mesh(new BoxGeometry(1, 1, 1).translate(1, 0, 0));
    micrometre.scale.setScalar(0.000001);
    expect(() => CollisionShape3D.fromMesh(micrometre)).not.toThrow();
  });

  // Anisotropic: each axis carries its own factor, so a wide flat body is judged on the axis that
  // actually moved, and a figure stretched only upward is still caught.
  it("should scale each off-centre axis by its own factor, not the largest", () => {
    const flat = new Mesh(new BoxGeometry(1, 1, 1).translate(0, 0, 0.5));
    flat.scale.set(100, 100, 0.0001);
    expect(() => CollisionShape3D.fromMesh(flat)).not.toThrow();

    const stretchedUpward = new Mesh(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    stretchedUpward.scale.set(0.0001, 100, 0.0001);
    expect(() => CollisionShape3D.fromMesh(stretchedUpward)).toThrow(
      /TN_COLLISION_SHAPE_OFF_CENTRE/u,
    );
  });

  it("should place the body and zero its velocity when teleported", async () => {
    const { ctx } = await setup();
    const object = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    const character = new CharacterBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object,
    });
    character.velocity.set(4, -3, 2);
    character.grounded = true;

    character.teleport({ x: 3, y: 4, z: 5 });

    expect(object.position.toArray()).toEqual([3, 4, 5]);
    expect(character.velocity.lengthSq()).toBe(0);
    expect(character.grounded).toBe(false);
    expect(character.groundBody).toBeUndefined();
    expect(character.groundNormal.toArray()).toEqual([0, 1, 0]);
    expect(character.slopeAngle).toBe(0);
    character.dispose();
  });

  // Both of these pin a documented contract a build got wrong on screen rather than in a
  // stack trace: a positive gravity flew the character upward, and a rig parented straight
  // onto the body floated half a capsule above the floor. See the round 9 friction ledger,
  // docs/verification/sweep-platformer-2026-08-16.md.
  it("should treat gravity as a signed velocity component, not a strength", async () => {
    const { ctx, plugin } = await setup();
    const falling = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    falling.position.y = 8;
    const rising = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    rising.position.y = 8;
    const down = new CharacterBody3D({
      gravity: -24,
      object: falling,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
    });
    const up = new CharacterBody3D({
      gravity: 24,
      object: rising,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
    });

    for (let step = 0; step < 20; step += 1) {
      down.moveAndSlide(1 / 60);
      up.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }

    expect(falling.position.y).toBeLessThan(8);
    expect(rising.position.y).toBeGreaterThan(8);
    down.dispose();
    up.dispose();
  });

  it("should rest a capsule body's origin halfHeight + radius above the floor", async () => {
    const { ctx, plugin } = await setup();
    const halfHeight = 0.26;
    const radius = 0.28;
    fixedBody(ctx.physics, new BoxGeometry(10, 0.2, 10), 0, -0.1);
    const object = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    object.position.set(0, 3, 0);
    const character = new CharacterBody3D({
      gravity: -24,
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(halfHeight, radius),
    });

    for (let step = 0; step < 120; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }

    expect(character.grounded).toBe(true);
    // The origin is the capsule's centre, so a rig standing on its own origin needs a
    // -(halfHeight + radius) offset or it floats by exactly this gap.
    expect(object.position.y).toBeGreaterThan(halfHeight + radius);
    expect(object.position.y).toBeLessThan(halfHeight + radius + 0.05);
    character.dispose();
  });

  it("should throw when teleported after dispose", async () => {
    const { ctx } = await setup();
    const character = new CharacterBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: new Mesh(new BoxGeometry(0.6, 1, 0.6)),
    });
    character.dispose();

    expect(() => character.teleport({ x: 0, y: 0, z: 0 })).toThrow(
      "CharacterBody3D.teleport cannot be used after dispose.",
    );
  });

  it("climbs a 25-degree slope uphill and downhill with snapToGround, gaining height for 120 steps without freeze", async () => {
    const { ctx, plugin } = await setup();
    const slopeAngle = (25 * Math.PI) / 180;
    const slope = fixedBody(ctx.physics, new BoxGeometry(30, 0.2, 8), 0, 0, slopeAngle);
    const object = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    object.position.set(0, 2, 0);
    const character = new CharacterBody3D({
      gravity: -9.81,
      maxFallSpeed: 30,
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      snapToGround: 0.5,
    });

    for (let step = 0; step < 120; step += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    expect(character.grounded).toBe(true);
    const initialX = object.position.x;

    const startUphillY = object.position.y;
    for (let step = 0; step < 120; step += 1) {
      character.velocity.x = 2;
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    expect(character.grounded).toBe(true);
    expect(object.position.x).toBeGreaterThan(initialX + 1.5);
    expect(object.position.y).toBeGreaterThan(startUphillY + 0.5);

    const peakY = object.position.y;
    for (let step = 0; step < 120; step += 1) {
      character.velocity.x = -2;
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    expect(character.grounded).toBe(true);
    expect(object.position.y).toBeLessThan(peakY - 0.5);

    character.dispose();
    slope.dispose();
  });

  it("clamps falling velocity to maxFallSpeed during moveAndSlide", async () => {
    const { ctx } = await setup();
    const object = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    const character = new CharacterBody3D({
      gravity: -50,
      maxFallSpeed: 15,
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
    });

    for (let step = 0; step < 60; step += 1) {
      character.moveAndSlide(1 / 60);
    }
    expect(character.velocity.y).toBe(-15);
    character.dispose();
  });
});
