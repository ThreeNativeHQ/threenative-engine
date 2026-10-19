import { createAnimalActor, parseAnimalBake } from "@threenative/procedural-animals";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { wolfMotion } from "../../../examples/procedural-animals/src/render/wolf-motion.js";
import { wolfCollision } from "../../../examples/procedural-animals/src/wolf-collision.js";
import { createAfterPhysicsPhase } from "../../core/src/loop.js";
import type { ICtx } from "../../core/src/scene.js";
import "../../physics/src/web.js";
import { CharacterBody3D } from "../../physics/src/CharacterBody3D.js";
import { CollisionShape3D } from "../../physics/src/CollisionShape3D.js";
import { RigidBody3D } from "../../physics/src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../../physics/src/plugin.js";
import { bakeWolf } from "../src/build.js";
import { deformReference } from "./oracle.js";

let bake: ReturnType<typeof parseAnimalBake>;
beforeAll(async () => {
  bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
});
const material = () => new MeshBasicMaterial();
async function wallClearance(historical = false) {
  const collision = wolfCollision(bake);
  const height = historical ? 0.37 : -collision.visualOriginOffset.y;
  const plugin = rapier({ gravity: { x: 0, y: -9.81, z: 0 } });
  const ctx = {} as ICtx<Record<string, unknown>, IPhysicsContext>;
  await plugin.setup?.(ctx);
  const floor = new Mesh(new BoxGeometry(40, 0.5, 40));
  floor.position.set(0, -0.25, -2);
  floor.rotation.z = Math.atan(0.1);
  const floorBody = new RigidBody3D({
    object: floor,
    physics: ctx.physics,
    shape: CollisionShape3D.fromMesh(floor),
    type: "fixed",
    collisionLayer: 1,
  });
  const wall = new RigidBody3D({
    physics: ctx.physics,
    shape: CollisionShape3D.box(24, 3, 0.5),
    position: { x: 0, y: 1.3, z: -10 },
    type: "fixed",
    collisionLayer: 4,
  });
  const ground = (x: number, z: number) => {
    const hit = ctx.physics.directSpaceState.intersectRay({
      from: { x, y: 50, z },
      to: { x, y: -50, z },
      collisionMask: 1,
    });
    if (!hit) throw new Error("missing actual slope");
    return hit.position.y;
  };
  const root = new Group();
  root.position.set(-5.075, height + 1, -8);
  root.rotation.y = Math.PI;
  const body = new CharacterBody3D({
    object: root,
    physics: ctx.physics,
    shape: historical ? CollisionShape3D.capsule(0.12, 0.25) : collision.shape(),
    collisionLayer: 2,
    collisionMask: 5,
  });
  const animal = createAnimalActor(bake, {
    material,
    motion: wolfMotion,
    ground,
    visualOriginOffset: new Vector3(0, -height, 0),
  });
  const phase = createAfterPhysicsPhase();
  const previous = root.position.clone();
  const accepted = new Vector3();
  const remove = phase.register((dt) => {
    accepted.copy(root.position).sub(previous).divideScalar(dt);
    animal.follow({ position: root.position, velocity: accepted, heading: root.rotation.y }, dt);
    previous.copy(root.position);
  });
  try {
    let blockedStart = 0;
    for (let tick = 0; tick < 480; tick++) {
      if (tick === 360) blockedStart = root.position.z;
      body.velocity.set(0, body.velocity.y, -1.5);
      body.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
      phase.run(1 / 60);
    }
    const blockedDisplacement = Math.abs(root.position.z - blockedStart);
    const requestedZ = body.velocity.z;
    for (let tick = 0; tick < 120; tick++) {
      body.velocity.set(0, body.velocity.y, 0);
      body.moveAndSlide(1 / 60);
      plugin.update?.(ctx, 1 / 60);
      phase.run(1 / 60);
    }
    animal.object.updateWorldMatrix(true, true);
    let minZ = Number.POSITIVE_INFINITY;
    let minimumSurfaceFloorGap = Number.POSITIVE_INFINITY;
    for (let v = 0; v < bake.nV; v++) {
      const point = deformReference(bake, animal.pose.data, v).position.applyMatrix4(
        animal.object.matrixWorld,
      );
      minZ = Math.min(minZ, point.z);
      minimumSurfaceFloorGap = Math.min(minimumSurfaceFloorGap, point.y - ground(point.x, point.z));
    }
    return {
      clearance: minZ - -9.75,
      acceptedZ: accepted.z,
      requestedZ,
      blockedDisplacement,
      rootError: animal.object.position.distanceTo(root.position),
      minimumSurfaceFloorGap,
      radius: collision.radius,
      grounded: body.grounded,
    };
  } finally {
    remove();
    animal.dispose();
    body.dispose();
    wall.dispose();
    floorBody.dispose();
    floor.geometry.dispose();
    (floor.material as MeshBasicMaterial).dispose();
    plugin.dispose?.(ctx);
  }
}

describe("measured wolf wall clearance", () => {
  it("keeps the DQS surface outside the real wall after accepted Rapier motion stops", async () => {
    const result = await wallClearance();
    console.info("TN_ANIMAL_WALL_ORACLE", JSON.stringify(result));
    expect(result.requestedZ).toBe(-1.5);
    expect(result.blockedDisplacement).toBeLessThan((Math.abs(result.requestedZ) * 2) / 100);
    expect(Math.abs(result.acceptedZ)).toBeLessThanOrEqual(1e-4);
    expect(result.rootError).toBeLessThanOrEqual(1e-4);
    expect(result.grounded).toBe(true);
    expect(result.clearance).toBeGreaterThanOrEqual(-1e-4);
  });
  it("reproduces clipping with the historical capsule even though its accepted root stops", async () => {
    const result = await wallClearance(true);
    expect(Math.abs(result.acceptedZ)).toBeLessThanOrEqual(1e-4);
    expect(result.rootError).toBeLessThanOrEqual(1e-4);
    expect(result.clearance).toBeLessThan(-0.1);
  });
  it.each(["crowd", "high"] as const)(
    "covers the actual %s gait/action DQS horizontal envelope",
    async (tier) => {
      const selected = tier === "crowd" ? bake : parseAnimalBake(await bakeWolf({ seed: 7, tier }));
      const collision = wolfCollision(selected);
      const animal = createAnimalActor(selected, {
        material,
        motion: wolfMotion,
        ground: (x) => x * 0.1,
        visualOriginOffset: collision.visualOriginOffset,
      });
      const position = new Vector3(0, -collision.visualOriginOffset.y, 0);
      const velocity = new Vector3();
      let maximum = 0;
      let samples = 0;
      try {
        for (const phase of ["stand", "walk", "trot", "turn", "stop", "sit", "lie", "reset"]) {
          if (phase === "sit" || phase === "lie") void animal.play(phase);
          if (phase === "reset") {
            position.set(2, 3, -2);
            animal.teleport({ position, velocity, heading: Math.PI / 2 });
          }
          velocity.set(
            phase === "turn" ? 1.5 : 0,
            0,
            phase === "walk" ? 1.2 : phase === "trot" ? 3 : 0,
          );
          for (let tick = 0; tick < 120; tick++) {
            position.addScaledVector(velocity, 1 / 60);
            animal.follow(
              { position, velocity, heading: phase === "turn" ? Math.PI / 2 : 0 },
              1 / 60,
            );
            if (tick % 30 !== 29) continue;
            for (let v = 0; v < selected.nV; v++) {
              const point = deformReference(selected, animal.pose.data, v).position;
              maximum = Math.max(maximum, Math.hypot(point.x, point.z));
              samples++;
            }
          }
        }
        console.info(
          "TN_ANIMAL_COLLISION_CORPUS",
          JSON.stringify({ tier, radius: collision.radius, maximumXZ: maximum, samples }),
        );
        expect(samples).toBe(selected.nV * 32);
        expect(maximum).toBeLessThanOrEqual(collision.radius);
      } finally {
        animal.dispose();
      }
    },
  );
});
