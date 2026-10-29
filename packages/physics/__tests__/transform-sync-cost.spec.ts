import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { Object3D, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index.js";
import { CharacterBody3D } from "../src/CharacterBody3D.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { PHYSICS_TRANSFORM_STRIDE } from "../src/index.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;
const plugins: Array<ReturnType<typeof rapier>> = [];

async function setup(): Promise<{ ctx: PhysicsCtx; plugin: ReturnType<typeof rapier> }> {
  await RAPIER.init();
  const plugin = rapier({ gravity: { x: 0, y: 0, z: 0 } });
  const ctx = { physics: undefined } as unknown as PhysicsCtx;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return { ctx, plugin };
}

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose?.({} as PhysicsCtx);
});

function record(
  id: number,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number, number],
): Float32Array {
  const values = new Float32Array(PHYSICS_TRANSFORM_STRIDE);
  values[0] = id;
  values[1] = position[0];
  values[2] = position[1];
  values[3] = position[2];
  values[4] = rotation[0];
  values[5] = rotation[1];
  values[6] = rotation[2];
  values[7] = rotation[3];
  return values;
}

function pair(ctx: IPhysicsContext) {
  const characterObject = new Object3D();
  characterObject.position.set(0, 0, 0);
  const character = new CharacterBody3D({
    object: characterObject,
    physics: ctx,
    shape: CollisionShape3D.capsule(0.6, 0.3),
  });
  const bodyObject = new Object3D();
  bodyObject.position.set(10, 0, 0);
  const body = new RigidBody3D({
    object: bodyObject,
    physics: ctx,
    shape: CollisionShape3D.box(1, 1, 1),
  });
  return { body, bodyObject, character, characterObject };
}

describe("bulk transform sync cost", () => {
  it("does not set an unchanged quaternion on a bulk update", async () => {
    const { ctx, plugin } = await setup();
    const { body, bodyObject, character, characterObject } = pair(ctx.physics);
    plugin.update?.(ctx, 1 / 60);

    const characterSet = vi.spyOn(characterObject.quaternion, "set");
    const bodySet = vi.spyOn(bodyObject.quaternion, "set");
    const characterQuaternion = characterObject.quaternion.toArray();
    const bodyQuaternion = bodyObject.quaternion.toArray();
    const characterEuler = characterObject.rotation.toArray();
    const bodyEuler = bodyObject.rotation.toArray();

    for (let tick = 0; tick < 10; tick += 1) plugin.update?.(ctx, 1 / 60);

    expect(characterSet).not.toHaveBeenCalled();
    expect(bodySet).not.toHaveBeenCalled();
    expect(characterObject.quaternion.toArray()).toEqual(characterQuaternion);
    expect(bodyObject.quaternion.toArray()).toEqual(bodyQuaternion);
    expect(characterObject.rotation.toArray()).toEqual(characterEuler);
    expect(bodyObject.rotation.toArray()).toEqual(bodyEuler);

    character.dispose();
    body.dispose();
  });

  it("sets a changed bulk rotation once and corrects external edits", async () => {
    const { ctx, plugin } = await setup();
    const { body, bodyObject, character, characterObject } = pair(ctx.physics);
    plugin.update?.(ctx, 1 / 60);

    const characterSet = vi.spyOn(characterObject.quaternion, "set");
    const characterRecord = record(character.body.id, [1, 2, 3], [0.5, 0.5, 0.5, 0.5]);
    character.applyTransform(characterRecord, 0);
    expect(characterSet).toHaveBeenCalledTimes(1);
    expect(characterObject.position.toArray()).toEqual([1, 2, 3]);
    expect(characterObject.quaternion.toArray()).toEqual([0.5, 0.5, 0.5, 0.5]);
    character.applyTransform(characterRecord, 0);
    expect(characterSet).toHaveBeenCalledTimes(1);

    characterObject.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    character.applyTransform(characterRecord, 0);
    expect(characterSet).toHaveBeenCalledTimes(2);
    expect(characterObject.quaternion.toArray()).toEqual([0.5, 0.5, 0.5, 0.5]);

    const bodySet = vi.spyOn(bodyObject.quaternion, "set");
    const bodyRecord = record(body.body.id, [4, 5, 6], [0.5, 0.5, 0.5, 0.5]);
    body.applyTransform(bodyRecord, 0);
    expect(bodySet).toHaveBeenCalledTimes(1);
    expect(bodyObject.position.toArray()).toEqual([4, 5, 6]);
    expect(bodyObject.quaternion.toArray()).toEqual([0.5, 0.5, 0.5, 0.5]);
    body.applyTransform(bodyRecord, 0);
    expect(bodySet).toHaveBeenCalledTimes(1);

    bodyObject.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    body.applyTransform(bodyRecord, 0);
    expect(bodySet).toHaveBeenCalledTimes(2);
    expect(bodyObject.quaternion.toArray()).toEqual([0.5, 0.5, 0.5, 0.5]);

    character.dispose();
    body.dispose();
  });

  it("treats a signed-zero component as a rotation change", async () => {
    const { ctx } = await setup();
    const object = new Object3D();
    const body = new RigidBody3D({
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 1, 1),
    });
    const set = vi.spyOn(object.quaternion, "set");

    const negativeZero = record(body.body.id, [0, 0, 0], [-0, 0, 0, 1]);
    body.applyTransform(negativeZero, 0);
    expect(set).toHaveBeenCalledTimes(1);
    expect(Object.is(object.quaternion.x, -0)).toBe(true);

    body.applyTransform(negativeZero, 0);
    expect(set).toHaveBeenCalledTimes(1);

    body.applyTransform(record(body.body.id, [0, 0, 0], [0, 0, 0, 1]), 0);
    expect(set).toHaveBeenCalledTimes(2);
    expect(Object.is(object.quaternion.x, 0)).toBe(true);

    body.dispose();
  });

  it("leaves an unchanged manual sync alone and still corrects external edits", async () => {
    const { ctx, plugin } = await setup();
    const { body, bodyObject, character, characterObject } = pair(ctx.physics);
    plugin.update?.(ctx, 1 / 60);

    const characterSet = vi.spyOn(characterObject.quaternion, "set");
    const bodySet = vi.spyOn(bodyObject.quaternion, "set");
    character.syncFromPhysics();
    body.syncFromPhysics();
    expect(characterSet).not.toHaveBeenCalled();
    expect(bodySet).not.toHaveBeenCalled();

    characterObject.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    bodyObject.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    character.syncFromPhysics();
    body.syncFromPhysics();
    expect(characterSet).toHaveBeenCalledTimes(1);
    expect(bodySet).toHaveBeenCalledTimes(1);
    expect(characterObject.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(bodyObject.quaternion.toArray()).toEqual([0, 0, 0, 1]);

    (body.body.raw as RAPIER.RigidBody).setRotation({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 }, true);
    body.syncFromPhysics();
    expect(bodySet).toHaveBeenCalledTimes(2);
    expect(bodyObject.quaternion.toArray()).toEqual([0.5, 0.5, 0.5, 0.5]);

    character.dispose();
    body.dispose();
  });

  it("still grounds a character whose rotation does not change", async () => {
    const { ctx, plugin } = await setup();
    const floorObject = new Object3D();
    const floor = new RigidBody3D({
      object: floorObject,
      physics: ctx.physics,
      shape: CollisionShape3D.box(20, 0.5, 20),
      type: "fixed",
    });
    const characterObject = new Object3D();
    characterObject.position.set(0, 2, 0);
    const character = new CharacterBody3D({
      object: characterObject,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.6, 0.3),
    });
    for (let tick = 0; tick < 120; tick += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    expect(character.grounded).toBe(true);

    const settledY = characterObject.position.y;
    const set = vi.spyOn(characterObject.quaternion, "set");
    for (let tick = 0; tick < 5; tick += 1) {
      character.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
    }
    expect(set).not.toHaveBeenCalled();
    expect(character.grounded).toBe(true);
    expect(character.groundNormal.y).toBeCloseTo(1, 5);
    expect(characterObject.position.y).toBeCloseTo(settledY, 5);

    character.dispose();
    floor.dispose();
  });

  it("keeps kinematic displacement bookkeeping when rotation is skipped", async () => {
    const { ctx, plugin } = await setup();
    const object = new Object3D();
    const body = new RigidBody3D({
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 1, 1),
      type: "kinematic",
    });
    plugin.update?.(ctx, 1 / 60);

    const set = vi.spyOn(object.quaternion, "set");
    object.position.x = 3;
    expect(body.kinematicMotion().x).toBeCloseTo(3, 5);

    plugin.update?.(ctx, 1 / 60);
    expect(object.position.x).toBeCloseTo(3, 5);
    expect(body.kinematicMotion().x).toBe(0);
    expect(set).not.toHaveBeenCalled();

    body.dispose();
  });

  it("rejects malformed bulk values before it can skip a rotation", async () => {
    const { ctx } = await setup();
    const { body, bodyObject, character, characterObject } = pair(ctx.physics);
    const malformed = record(body.body.id, [1, 2, 3], [0, 0, 0, 1]);
    malformed[6] = Number.NaN;

    expect(() => character.applyTransform(malformed, 0)).toThrow(
      "IPhysicsSimulation returned a malformed transform.",
    );
    expect(() => body.applyTransform(malformed, 0)).toThrow(
      "IPhysicsSimulation returned a malformed transform.",
    );
    expect(characterObject.position.toArray()).toEqual([0, 0, 0]);
    expect(characterObject.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(bodyObject.position.toArray()).toEqual([10, 0, 0]);
    expect(bodyObject.quaternion.toArray()).toEqual([0, 0, 0, 1]);

    character.dispose();
    body.dispose();
  });
});
