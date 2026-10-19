import { Scene, afterPhysics } from "@threenative/core";
import type { ICtx, SceneFrame } from "@threenative/core";
import { CharacterBody3D } from "@threenative/physics";
import type { IPhysicsContext } from "@threenative/physics";
import { createAnimalActor, loadAnimalBake } from "@threenative/procedural-animals";
import type { IAnimalBake } from "@threenative/procedural-animals";
import { BoxGeometry, Group, Mesh, PerspectiveCamera, Vector3 } from "three";
import { releaseAll } from "./cleanup.js";
import { performanceOrigin, performanceVelocity } from "./performance-path.js";
import { QualificationClock } from "./qualification-clock.js";
import { animalMaterial } from "./render/animal-material.js";
import { course, slopedFloorGround } from "./render/course.js";
import { AnimalGPUProbe } from "./render/gpu-probe.js";
import { performanceCamera } from "./render/performance-camera.js";
import { qualificationCamera } from "./render/qualification-camera.js";
import { wolfMotion } from "./render/wolf-motion.js";
import { wolfCollision } from "./wolf-collision.js";

export type AnimalMode = "qualification" | "crowd" | "high" | "baseline";

export interface IAnimalsState extends Record<string, unknown> {
  loaded: boolean;
  wolves: number;
  elapsed: number;
  rootError: number;
  vertices: number;
  bones: number;
  phase: string;
  mode: AnimalMode;
  gpuCases: number;
  gpuPositionError: number | null;
  gpuNormalError: number | null;
  visibleCaptured: boolean;
  visibleMainDraws: number;
  visibleShadowDraws: number;
  offFrustumCaptured: boolean;
  offFrustumMainDraws: number;
}
type AnimalsCtx = ICtx<IAnimalsState, IPhysicsContext>;

export class Animals extends Scene<IAnimalsState, IPhysicsContext> {
  static override readonly initialState: IAnimalsState = {
    loaded: false,
    wolves: 0,
    elapsed: 0,
    rootError: 0,
    vertices: 0,
    bones: 0,
    phase: "loading",
    mode: "qualification",
    gpuCases: 0,
    gpuPositionError: null,
    gpuNormalError: null,
    visibleCaptured: false,
    visibleMainDraws: -1,
    visibleShadowDraws: -1,
    offFrustumCaptured: false,
    offFrustumMainDraws: -1,
  };
  readonly #mode: AnimalMode;
  constructor(mode: AnimalMode = "qualification") {
    super();
    this.#mode = mode;
  }
  #bake: IAnimalBake | undefined;
  #abort = new AbortController();
  #cleanup: (() => void)[] = [];
  override async load(ctx: AnimalsCtx): Promise<void> {
    this.#abort = new AbortController();
    if (this.#mode === "baseline") return;
    this.#bake = await loadAnimalBake(
      ctx.assets,
      this.#mode === "high" ? "wolf-high.animal" : "wolf-crowd.animal",
      {
        signal: this.#abort.signal,
      },
    );
  }
  override enter(ctx: AnimalsCtx): SceneFrame<IAnimalsState, IPhysicsContext> {
    try {
      return this.#enter(ctx);
    } catch (error) {
      try {
        this.exit();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "TN_ANIMAL_ENTER_FAILED");
      }
      throw error;
    }
  }
  #enter(ctx: AnimalsCtx): SceneFrame<IAnimalsState, IPhysicsContext> {
    const bake = this.#bake;
    if (!bake && this.#mode !== "baseline") throw new Error("TN_ANIMAL_MISSING_BAKE");
    this.#cleanup.push(course(ctx));
    const performanceMode = this.#mode !== "qualification";
    if (performanceMode) performanceCamera(ctx.camera);
    const groundRay = (x: number, z: number) => {
      const hit = ctx.physics.directSpaceState.intersectRay({
        from: { x, y: 50, z },
        to: { x, y: -50, z },
        collisionMask: 1,
      });
      if (!hit) throw new Error("TN_ANIMAL_GROUND_MISSING");
      return hit.position.y;
    };
    let floor: Mesh<BoxGeometry> | undefined;
    ctx.scene.traverse((object) => {
      if (
        object.name === "sloped-floor" &&
        object instanceof Mesh &&
        object.geometry instanceof BoxGeometry
      )
        floor = object as Mesh<BoxGeometry>;
    });
    const ground = floor ? slopedFloorGround(floor, groundRay) : groundRay;
    const collision = bake ? wolfCollision(bake) : undefined;
    const count = this.#mode === "baseline" ? 0 : this.#mode === "high" ? 1 : 32;
    const actors = Array.from({ length: count }, (_, index) => {
      if (!bake || !collision) throw new Error("TN_ANIMAL_MISSING_BAKE");
      const root = new Group();
      root.name = `wolf-body-${index}`;
      root.position.set(
        ((index % 8) - 3.5) * 1.45,
        collision.startHeight,
        index === 0 ? -8 : Math.floor(index / 8) * 2 - 3,
      );
      if (performanceMode) {
        root.position.copy(performanceOrigin(index, count, collision.radius));
        root.position.y = collision.startHeight + ground(root.position.x, root.position.z);
      }
      const origin = root.position.clone();
      this.#cleanup.push(() => root.removeFromParent());
      ctx.add(root);
      const body = new CharacterBody3D({
        object: root,
        physics: ctx.physics,
        shape: collision.shape(),
        collisionLayer: 2,
        collisionMask: 5,
      });
      this.#cleanup.push(() => body.dispose());
      const animal = createAnimalActor(bake, {
        material: animalMaterial,
        motion: wolfMotion,
        ground,
        visualOriginOffset: collision.visualOriginOffset,
      });
      this.#cleanup.push(() => animal.dispose());
      animal.object.name = `wolf-${index}`;
      animal.mesh.name = `wolf-surface-${index}`;
      animal.mesh.castShadow = animal.mesh.receiveShadow = true;
      ctx.add(animal.object);
      this.#cleanup.push(() => ctx.entities.remove(`wolf-${index}`));
      ctx.entities.add(`wolf-${index}`, { body, mesh: animal.object });
      return {
        root,
        body,
        animal,
        origin,
        previous: root.position.clone(),
        velocity: new Vector3(),
      };
    });
    const probe = this.#mode === "qualification" && bake ? new AnimalGPUProbe(bake) : undefined;
    if (probe) {
      this.#cleanup.push(() => probe.detach());
      ctx.add(probe);
    }
    let elapsed = 0;
    const clock = this.#mode === "qualification" ? new QualificationClock() : undefined;
    let probeArmed = false;
    let teleported = false;
    let posture = 0;
    const cameraTarget = new Vector3();
    let rootError = 0;
    this.#cleanup.push(
      afterPhysics(ctx, (dt) => {
        for (const { root, animal, previous, velocity } of actors) {
          velocity.copy(root.position).sub(previous).divideScalar(dt);
          animal.follow({ position: root.position, velocity, heading: root.rotation.y }, dt);
          previous.copy(root.position);
          rootError = Math.max(rootError, animal.object.position.distanceTo(root.position));
        }
        const first = actors[0];
        if (clock && collision && first && elapsed >= 1.5 && ctx.state.getState().visibleCaptured) {
          if (!(ctx.camera instanceof PerspectiveCamera))
            throw new Error("TN_ANIMAL_CAMERA_REQUIRED");
          first.animal.object.localToWorld(cameraTarget.copy(collision.cameraCenter));
          qualificationCamera(ctx.camera, cameraTarget, clock.outside);
        }
        if (probe && probeArmed && ctx.startup.phase === "ready") {
          const label =
            elapsed >= 0.5 && elapsed < 3
              ? "walk"
              : elapsed >= 3.5 && elapsed < 6
                ? "turn"
                : elapsed >= 6.2 && elapsed < 7
                  ? "trot"
                  : elapsed >= 10 && elapsed < 12
                    ? "stop"
                    : elapsed >= 13 && elapsed < 14
                      ? "teleport"
                      : elapsed >= 14.25 && elapsed < 15
                        ? "pause"
                        : elapsed >= 17.5 && elapsed < 19
                          ? "sit"
                          : elapsed >= 20.5 && elapsed < 22
                            ? "lie"
                            : elapsed >= 23.5 && elapsed < 25.5
                              ? "stand"
                              : undefined;
          const actor =
            label === "walk" || label === "turn" || label === "trot" ? actors[1] : actors[0];
          if (label && actor) probe.queue(label, actor.animal.pose.data);
        }
        const gpu = probe?.report;
        ctx.state.set({
          loaded: true,
          wolves: actors.length,
          elapsed,
          rootError,
          vertices: bake?.nV ?? 0,
          bones: bake?.bones.length ?? 0,
          mode: this.#mode,
          gpuCases: gpu?.cases ?? 0,
          gpuPositionError: gpu && gpu.cases > 0 ? gpu.positionError : null,
          gpuNormalError: gpu && gpu.cases > 0 ? gpu.normalError : null,
          phase: clock?.outside
            ? "off-frustum"
            : elapsed < 3
              ? "walk-wall"
              : elapsed < 6
                ? "turn"
                : elapsed < 9
                  ? "walk"
                  : "stop",
        });
      }),
    );
    return (_frameCtx, dt) => {
      const ready = ctx.startup.phase === "ready";
      if (ready && ctx.input.justPressed("probe")) probeArmed = true;
      if (clock) {
        clock.advance(
          dt,
          ready,
          ctx.input.justPressed("advance"),
          ctx.input.justPressed("outside"),
        );
        elapsed = clock.elapsed;
      } else if (ready) elapsed += dt;
      const held = clock?.held === true;
      for (const actor of actors) {
        if (performanceMode) {
          if (!collision) throw new Error("TN_ANIMAL_MISSING_BAKE");
          const desired = performanceVelocity(
            actor.root.position,
            actor.origin,
            elapsed,
            collision.radius,
            actor.velocity,
          );
          actor.body.velocity.set(
            ready ? desired.x : 0,
            actor.body.velocity.y,
            ready ? desired.z : 0,
          );
          actor.root.rotation.y = Math.atan2(desired.x, desired.z);
          actor.body.moveAndSlide(dt);
          continue;
        }
        const turning = elapsed >= 3 && elapsed < 6;
        actor.root.rotation.y = turning ? Math.PI / 2 : Math.PI;
        actor.body.velocity.set(
          ready && !held && turning ? 1.5 : 0,
          actor.body.velocity.y,
          ready && !held && elapsed < 9 && !turning ? (elapsed >= 6 ? -3 : -1.5) : 0,
        );
        actor.body.moveAndSlide(dt);
      }
      const first = actors[0];
      if (performanceMode || !first) return;
      if (elapsed >= 12 && !teleported) {
        teleported = true;
        const position = new Vector3(0, ground(0, -4) - (collision?.visualOriginOffset.y ?? 0), -4);
        first.body.teleport(position);
        first.previous.copy(position);
        first.animal.teleport({
          position,
          velocity: new Vector3(),
          heading: first.root.rotation.y,
        });
      }
      for (const { animal } of actors) animal.paused = held;
      first.animal.paused = held || (elapsed >= 14 && elapsed < 15);
      if (elapsed >= 16 && posture === 0) {
        posture = 1;
        void first.animal.play("sit");
      }
      if (elapsed >= 19 && posture === 1) {
        posture = 2;
        void first.animal.play("lie");
      }
      if (elapsed >= 22 && posture === 2) {
        posture = 3;
        void first.animal.play("stand");
      }
    };
  }
  override exit(): void {
    releaseAll([() => this.#abort.abort(), ...this.#cleanup.splice(0).reverse()]);
  }
}
