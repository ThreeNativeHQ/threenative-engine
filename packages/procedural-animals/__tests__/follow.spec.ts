import { FixedStepLoop, createAfterPhysicsPhase } from "../../core/src/loop.js";
import type { ICtx } from "../../core/src/scene.js";
import "../../physics/src/web.js";
import { BufferGeometry, DataTexture, Group, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { wolfMotion } from "../../../examples/procedural-animals/src/render/wolf-motion.js";
import { CharacterBody3D } from "../../physics/src/CharacterBody3D.js";
import { CollisionShape3D } from "../../physics/src/CollisionShape3D.js";
import { RigidBody3D } from "../../physics/src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../../physics/src/plugin.js";
import { bakeWolf } from "../src/build.js";
import { createAnimalActor } from "../src/follow.js";
import { parseAnimalBake } from "../src/format.js";
import { encodeFixture } from "./fixture.js";

const material = () => new MeshBasicMaterial();
describe("Rapier accepted state → follow → pinned wolf pose", () => {
  it("uses completed blocked/stopped/teleported states through the actual fixed-step phase", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const plugin = rapier({ gravity: { x: 0, y: 0, z: 0 } });
    const ctx = { physics: undefined } as unknown as ICtx<Record<string, unknown>, IPhysicsContext>;
    await plugin.setup?.(ctx);
    const floor = new RigidBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.box(20, 0.2, 20),
      position: { x: 0, y: -0.1, z: 0 },
      type: "fixed",
      collisionLayer: 1,
    });
    const wall = new RigidBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.box(0.25, 2, 4),
      position: { x: 2, y: 0, z: 0 },
      type: "fixed",
      collisionLayer: 4,
    });
    const root = new Group();
    root.position.y = 0.5;
    const body = new CharacterBody3D({
      object: root,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      gravity: 0,
      collisionLayer: 2,
      collisionMask: 5,
    });
    const ground = (x: number, z: number) => {
      const hit = ctx.physics.directSpaceState.intersectRay({
        from: { x, y: 10, z },
        to: { x, y: -10, z },
        collisionMask: 1,
      });
      if (!hit) throw new Error("missing Rapier course ground");
      return hit.position.y;
    };
    expect(ground(0, 0)).toBeCloseTo(0, 6);
    const animal = createAnimalActor(bake, { motion: wolfMotion, material, ground });
    const previous = root.position.clone();
    const acceptedVelocity = new Vector3();
    const phase = createAfterPhysicsPhase();
    let observations = 0;
    let requested = 3;
    const unregister = phase.register((dt) => {
      acceptedVelocity.copy(root.position).sub(previous).divideScalar(dt);
      animal.follow(
        { position: root.position, velocity: acceptedVelocity, heading: Math.PI / 2 },
        dt,
      );
      expect(animal.object.position.distanceTo(root.position)).toBeLessThan(1e-7);
      expect(animal.object.rotation.y).toBeCloseTo(Math.PI / 2, 7);
      previous.copy(root.position);
      observations++;
    });
    const loop = new FixedStepLoop({
      requestFrame: () => 0,
      cancelFrame: () => undefined,
      onUpdate: (dt) => {
        body.velocity.set(requested, 0, 0);
        body.moveAndSlide(dt);
        plugin.update?.(ctx, dt);
      },
      onAfterPhysics: phase.run,
    });
    loop.start(0);
    try {
      loop.advance(120);
      expect(root.position.x).toBeGreaterThan(1);
      expect(root.position.x).toBeLessThan(1.6);
      expect(acceptedVelocity.length()).toBeLessThan(1e-4);
      requested = 0;
      const stopped = root.position.clone();
      loop.advance(60);
      expect(root.position.distanceTo(stopped)).toBeLessThan(1e-7);
      const pending = animal.play("sit");
      const destination = new Vector3(-3, 2, 1);
      body.teleport(destination);
      previous.copy(destination);
      animal.teleport({ position: root.position, velocity: new Vector3(), heading: Math.PI / 2 });
      expect(await pending).toBe("interrupted");
      loop.advance(2);
      expect(animal.object.position.distanceTo(destination)).toBeLessThan(1e-7);
      expect(animal.pose.data.every(Number.isFinite)).toBe(true);
      animal.paused = true;
      const paused = animal.pose.data.slice();
      requested = 1;
      loop.advance(2);
      expect(animal.pose.data).toEqual(paused);
      animal.paused = false;
      loop.advance(2);
      expect(animal.pose.data).not.toEqual(paused);
      expect(observations).toBe(186);
    } finally {
      loop.stop();
      unregister();
      animal.dispose();
      body.dispose();
      wall.dispose();
      floor.dispose();
      plugin.dispose?.(ctx);
    }
  }, 30_000);

  it("rejects transformed parents, isolates shared bake instances, and releases 50 lifetimes once", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const original = bake.pos.slice();
    const parent = new Group();
    parent.position.x = 1;
    const factory = vi.fn(material);
    expect(() =>
      createAnimalActor(bake, { motion: wolfMotion, material: factory, ground: () => 0, parent }),
    ).toThrow("TN_ANIMAL_PARENT_TRANSFORM");
    expect(factory).not.toHaveBeenCalled();
    let disposedGeometry = 0;
    let disposedMaterial = 0;
    let disposedTexture = 0;
    const textureDispose = vi.spyOn(DataTexture.prototype, "dispose");
    try {
      for (let cycle = 0; cycle < 50; cycle++) {
        const first = createAnimalActor(bake, { motion: wolfMotion, material, ground: () => 0 });
        const second = createAnimalActor(bake, { motion: wolfMotion, material, ground: () => 0 });
        first.mesh.geometry.addEventListener("dispose", () => disposedGeometry++);
        first.mesh.material.addEventListener("dispose", () => disposedMaterial++);
        const texture = first.pose.texture;
        texture.addEventListener("dispose", () => disposedTexture++);
        first.follow(
          { position: new Vector3(1, 0, 0), velocity: new Vector3(1, 0, 0), heading: 1 },
          1 / 60,
        );
        expect(first.pose.data).not.toBe(second.pose.data);
        expect(first.pose.data).not.toEqual(second.pose.data);
        const pending = first.play("stand");
        let resolved = 0;
        void pending.then(() => resolved++);
        first.dispose();
        first.dispose();
        expect(await pending).toBe("disposed");
        await Promise.resolve();
        expect(resolved).toBe(1);
        expect(first.object.children).toHaveLength(0);
        second.dispose();
      }
      expect(disposedGeometry).toBe(50);
      expect(disposedMaterial).toBe(50);
      expect(disposedTexture).toBe(50);
      expect(textureDispose).toHaveBeenCalledTimes(100);
      expect(bake.pos).toEqual(original);
    } finally {
      textureDispose.mockRestore();
    }
  }, 60_000);
});

describe("failed lifecycle cleanup controls", () => {
  const inert = () => ({
    input: { speed: 0, target: null, heading: 0, follow: null },
    update: () => undefined,
    reset: () => undefined,
    play: () => new Promise<"done">(() => undefined),
    dispose: () => {
      throw new Error("game-motion-dispose-failed");
    },
  });
  it("rejects a non-finite parent before game factories run", () => {
    const parent = new Group();
    parent.matrixAutoUpdate = false;
    parent.matrix.elements[0] = Number.NaN;
    const factory = vi.fn(material);
    expect(() =>
      createAnimalActor(parseAnimalBake(encodeFixture()), {
        motion: inert,
        material: factory,
        ground: () => 0,
        parent,
      }),
    ).toThrow("TN_ANIMAL_PARENT_TRANSFORM");
    expect(factory).not.toHaveBeenCalled();
  });
  it("still releases all owned resources when game motion disposal throws", () => {
    const animal = createAnimalActor(parseAnimalBake(encodeFixture()), {
      motion: inert,
      material,
      ground: () => 0,
    });
    const geometry = vi.spyOn(animal.mesh.geometry, "dispose");
    const mat = vi.spyOn(animal.mesh.material, "dispose");
    const texture = vi.spyOn(animal.pose.texture, "dispose");
    expect(() => animal.dispose()).toThrow("game-motion-dispose-failed");
    expect(geometry).toHaveBeenCalledOnce();
    expect(mat).toHaveBeenCalledOnce();
    expect(texture).toHaveBeenCalledOnce();
    expect(animal.object.children).toHaveLength(0);
    animal.dispose();
    expect(geometry).toHaveBeenCalledOnce();
  });
  it("keeps mutable geometry edits private and rejects altered bake arrays before construction", () => {
    const bake = parseAnimalBake(encodeFixture());
    const options = {
      motion: () => ({ ...inert(), dispose: () => undefined }),
      material,
      ground: () => 0,
    };
    const first = createAnimalActor(bake, options);
    const second = createAnimalActor(bake, options);
    first.mesh.geometry.translate(5, 0, 0);
    expect(bake.pos[0]).toBe(0);
    expect(second.mesh.geometry.getAttribute("position").getX(0)).toBe(0);
    first.dispose();
    second.dispose();
    bake.skinIndex[0] = 42;
    const factory = vi.fn(material);
    expect(() => createAnimalActor(bake, { ...options, material: factory })).toThrow(
      "TN_ANIMAL_BONE_INDEX",
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it("retains the named material error and cleans allocations for an invalid factory return", () => {
    const geometry = vi.spyOn(BufferGeometry.prototype, "dispose");
    const texture = vi.spyOn(DataTexture.prototype, "dispose");
    try {
      expect(() =>
        createAnimalActor(parseAnimalBake(encodeFixture()), {
          motion: inert,
          material: (() => ({})) as unknown as typeof material,
          ground: () => 0,
        }),
      ).toThrow("TN_ANIMAL_MATERIAL");
      expect(geometry).toHaveBeenCalledOnce();
      expect(texture).toHaveBeenCalledOnce();
    } finally {
      geometry.mockRestore();
      texture.mockRestore();
    }
  });
});

describe("construction and teleport exception ownership", () => {
  const makeMotion = () => ({
    input: { speed: 0, target: null, heading: 0, follow: null },
    update: () => undefined,
    reset: () => undefined,
    play: () => new Promise<"done">(() => undefined),
    dispose: vi.fn(),
  });
  it("cleans every allocation when a parent childadded listener throws", () => {
    const parent = new Group();
    parent.addEventListener("childadded", () => {
      throw new Error("parent-listener-failed");
    });
    const motion = makeMotion();
    const mat = material();
    const matDispose = vi.spyOn(mat, "dispose");
    const geometry = vi.spyOn(BufferGeometry.prototype, "dispose");
    const texture = vi.spyOn(DataTexture.prototype, "dispose");
    try {
      expect(() =>
        createAnimalActor(parseAnimalBake(encodeFixture()), {
          motion: () => motion,
          material: () => mat,
          ground: () => 0,
          parent,
        }),
      ).toThrow("parent-listener-failed");
      expect(parent.children).toHaveLength(0);
      expect(motion.dispose).toHaveBeenCalledOnce();
      expect(matDispose).toHaveBeenCalledOnce();
      expect(geometry).toHaveBeenCalledOnce();
      expect(texture).toHaveBeenCalledOnce();
    } finally {
      geometry.mockRestore();
      texture.mockRestore();
    }
  });
  it("leaves the valid accepted root and pose intact when destination ground is missing", () => {
    const motion = makeMotion();
    let missing = false;
    const actor = createAnimalActor(parseAnimalBake(encodeFixture()), {
      motion: () => motion,
      material,
      ground: () => (missing ? Number.NaN : 0),
    });
    actor.follow({ position: new Vector3(1, 0, 1), velocity: new Vector3(), heading: 0 }, 1 / 60);
    const previous = actor.object.position.clone();
    const pose = actor.pose.data.slice();
    missing = true;
    expect(() =>
      actor.teleport({ position: new Vector3(9, 2, 9), velocity: new Vector3(), heading: 1 }),
    ).toThrow("TN_ANIMAL_GROUND");
    expect(actor.object.position).toEqual(previous);
    expect(actor.pose.data).toEqual(pose);
    expect(motion.dispose).not.toHaveBeenCalled();
    missing = false;
    actor.dispose();
  });
  it("disposes a failed replacement without retiring the old motion twice", () => {
    const old = makeMotion();
    let calls = 0;
    const actor = createAnimalActor(parseAnimalBake(encodeFixture()), {
      motion: () => {
        if (++calls === 2) throw new Error("replacement-failed");
        return old;
      },
      material,
      ground: () => 0,
    });
    const geometry = vi.spyOn(actor.mesh.geometry, "dispose");
    expect(() =>
      actor.teleport({ position: new Vector3(), velocity: new Vector3(), heading: 0 }),
    ).toThrow("replacement-failed");
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(geometry).toHaveBeenCalledOnce();
    expect(() =>
      actor.follow({ position: new Vector3(), velocity: new Vector3(), heading: 0 }, 1 / 60),
    ).toThrow("TN_ANIMAL_DISPOSED");
    actor.dispose();
    expect(old.dispose).toHaveBeenCalledOnce();
  });
});

it("resolves actual sit/lie/stand transitions once when their motion completes", async () => {
  const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
  const actor = createAnimalActor(bake, { motion: wolfMotion, material, ground: () => 0 });
  const state = { position: new Vector3(), velocity: new Vector3(), heading: 0 };
  try {
    for (const action of ["sit", "lie", "stand"] as const) {
      const pending = actor.play(action);
      let resolutions = 0;
      void pending.then(() => resolutions++);
      for (let tick = 0; tick < 600; tick++) actor.follow(state, 1 / 60);
      expect(await pending).toBe("done");
      await Promise.resolve();
      expect(resolutions).toBe(1);
      for (let tick = 0; tick < 60; tick++) actor.follow(state, 1 / 60);
      await Promise.resolve();
      expect(resolutions).toBe(1);
    }
  } finally {
    actor.dispose();
  }
}, 30_000);
