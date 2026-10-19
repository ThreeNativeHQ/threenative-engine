import type { ICtx } from "@threenative/core";
import { CharacterBody3D, type IPhysicsContext } from "@threenative/physics";
import { type IAnimalBake, createAnimalActor } from "@threenative/procedural-animals";
import { Group, Vector3 } from "three";
import { releaseAll } from "./cleanup.js";
import { animalMaterial } from "./render/animal-material.js";
import { wolfMotion } from "./render/wolf-motion.js";
import { wolfCollision } from "./wolf-collision.js";

type Animal = ReturnType<typeof createAnimalActor>;
interface IWolf {
  readonly root: Group;
  readonly body: CharacterBody3D;
  readonly animal: Animal;
  readonly previous: Vector3;
  readonly velocity: Vector3;
  pausedPose?: Float32Array;
}
function listenerCount(resource: object): number {
  const listeners: unknown = Reflect.get(resource, "_listeners");
  if (listeners === undefined) return 0; // Three EventDispatcher creates this lazily.
  if (typeof listeners !== "object" || listeners === null)
    throw new Error("TN_ANIMAL_LIFECYCLE_LISTENERS_UNAVAILABLE");
  let count = 0;
  for (const [type, values] of Object.entries(listeners)) {
    if (!Array.isArray(values) || values.some((value: unknown) => typeof value !== "function"))
      throw new Error("TN_ANIMAL_LIFECYCLE_LISTENERS_UNAVAILABLE");
    const has: unknown = Reflect.get(resource, "hasEventListener");
    if (
      typeof has !== "function" ||
      values.some((value: unknown) => Reflect.apply(has, resource, [type, value]) !== true)
    )
      throw new Error("TN_ANIMAL_LIFECYCLE_LISTENERS_UNAVAILABLE");
    count += values.length;
  }
  return count;
}

/** A fresh 32-actor generation; Rapier writes roots and its completed phase writes every pose. */
export function createLifecycleGeneration(
  ctx: Pick<
    ICtx<Record<string, unknown>, IPhysicsContext>,
    "add" | "physics" | "entities" | "afterPhysics"
  >,
  bake: IAnimalBake,
  cycle: number,
) {
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 50)
    throw new Error("TN_ANIMAL_LIFECYCLE_GENERATION");
  const collision = wolfCollision(bake);
  const wolves: IWolf[] = [];
  const resources: object[] = [];
  const cleanup: (() => void)[] = [];
  let live = true;
  let paused = false;
  let registered = false;
  let disposals = 0;
  let pendingActions = 0;
  let disposedActions = 0;
  let actions = Promise.resolve();
  const ground = (x: number, z: number) => {
    const hit = ctx.physics.directSpaceState.intersectRay({
      from: { x, y: 50, z },
      to: { x, y: -50, z },
      collisionMask: 1,
    });
    if (!hit) throw new Error("TN_ANIMAL_LIFECYCLE_GROUND_MISSING");
    return hit.position.y;
  };
  const dispose = () => {
    if (!live) return;
    live = false;
    releaseAll([
      () => {
        if (wolves.length !== 32) return;
        const requests: Promise<void>[] = [];
        try {
          releaseAll(
            wolves.map(({ animal }) => () => {
              const action = animal.play("lie");
              pendingActions++;
              requests.push(
                action
                  .then((result) => {
                    if (result !== "disposed")
                      throw new Error(`TN_ANIMAL_LIFECYCLE_ACTION_RESULT: ${result}`);
                    disposedActions++;
                  })
                  .finally(() => {
                    pendingActions--;
                  }),
              );
            }),
          );
        } finally {
          actions = Promise.all(requests).then(() => undefined);
          // Error cleanup/scene exit may not await settled(); its original failure stays observable.
          void actions.catch(() => undefined);
        }
      },
      ...cleanup.splice(0).reverse(),
    ]);
  };
  try {
    for (let index = 0; index < 32; index++) {
      const root = new Group();
      root.name = `wolf-body-${cycle}-${index}`;
      root.position.set(
        ((index % 8) - 3.5) * 1.45,
        collision.startHeight,
        Math.floor(index / 8) * 2 - 3,
      );
      ctx.add(root);
      cleanup.push(() => root.removeFromParent());
      const body = new CharacterBody3D({
        object: root,
        physics: ctx.physics,
        shape: collision.shape(),
        collisionLayer: 2,
        collisionMask: 5,
      });
      cleanup.push(() => body.dispose());
      const animal = createAnimalActor(bake, {
        material: animalMaterial,
        motion: wolfMotion,
        ground,
        visualOriginOffset: collision.visualOriginOffset,
      });
      cleanup.push(() => animal.dispose());
      for (const resource of [animal.mesh.geometry, animal.mesh.material, animal.pose.texture]) {
        const observedDispose = () => {
          disposals++;
          resource.removeEventListener("dispose", observedDispose);
        };
        resource.addEventListener("dispose", observedDispose);
        resources.push(resource);
      }
      animal.mesh.name = `wolf-surface-${cycle}-${index}`;
      animal.mesh.castShadow = animal.mesh.receiveShadow = true;
      animal.object.name = `wolf-${cycle}-${index}`;
      ctx.add(animal.object);
      const id = animal.object.name;
      ctx.entities.add(id, { body, mesh: animal.object });
      cleanup.push(() => ctx.entities.remove(id));
      wolves.push({ root, body, animal, previous: root.position.clone(), velocity: new Vector3() });
    }
    const remove = ctx.afterPhysics((dt) => {
      if (!live) throw new Error("TN_ANIMAL_LIFECYCLE_STALE_CALLBACK");
      for (const wolf of wolves) {
        wolf.velocity.copy(wolf.root.position).sub(wolf.previous).divideScalar(dt);
        wolf.animal.follow(
          { position: wolf.root.position, velocity: wolf.velocity, heading: wolf.root.rotation.y },
          dt,
        );
        wolf.previous.copy(wolf.root.position);
      }
    });
    registered = true;
    cleanup.push(() => {
      remove();
      registered = false;
    });
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "TN_ANIMAL_LIFECYCLE_ACQUIRE_FAILED");
    }
    throw error;
  }
  return {
    update(dt: number) {
      if (!live) throw new Error("TN_ANIMAL_LIFECYCLE_DISPOSED_UPDATE");
      for (const { body } of wolves) {
        body.velocity.set(paused ? 0 : 0.3, body.velocity.y, 0);
        body.moveAndSlide(dt);
      }
    },
    teleportAndPause() {
      paused = true;
      for (const wolf of wolves) {
        const position = wolf.root.position.clone();
        position.z += 0.125;
        position.y = ground(position.x, position.z) - collision.visualOriginOffset.y;
        wolf.body.teleport(position);
        wolf.previous.copy(position);
        wolf.animal.teleport({ position, velocity: new Vector3(), heading: wolf.root.rotation.y });
        wolf.animal.paused = true;
        wolf.pausedPose = wolf.animal.pose.data.slice();
      }
    },
    resume() {
      paused = false;
      for (const { animal } of wolves) animal.paused = false;
    },
    dispose,
    settled() {
      if (live) return Promise.reject(new Error("TN_ANIMAL_LIFECYCLE_NOT_DISPOSED"));
      return actions;
    },
    ownership() {
      return {
        actors: wolves.filter(({ animal }) => animal.object.children.includes(animal.mesh)).length,
        attached: wolves.reduce(
          (count, { root, animal }) =>
            count +
            Number(root.parent !== null) +
            Number(animal.object.parent !== null) +
            Number(animal.mesh.parent !== null),
          0,
        ),
        listeners: resources.reduce((count, resource) => count + listenerCount(resource), 0),
        callbacks: Number(registered),
        pendingActions,
        disposedActions,
        disposals,
        poseChanged: wolves.some(
          ({ pausedPose, animal }) =>
            pausedPose !== undefined &&
            animal.pose.data.some((value, index) => value !== pausedPose[index]),
        ),
      };
    },
  };
}
