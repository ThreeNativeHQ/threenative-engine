import { type ICtx, Scene, type SceneFrame, SoftBody3D, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  rapier,
  softBodyCollision,
} from "@threenative/physics";
import { type BufferGeometry, Mesh } from "three";
import {
  createClothWall,
  createFlagGeometry,
  createFlagMaterial,
  createFlagStage,
} from "./render/flag.js";

interface IClothState extends Record<string, unknown> {
  attachments: number;
  collisionHeld: number;
  gusts: number;
  gustDisplacement: number;
  outcome: "lost" | "playing" | "won";
  releases: number;
  reloads: number;
  softBodySteps: number;
}

const WIN_DISPLACEMENT = 0.34;
const GUST_TICKS = 30;
const WALL_NEAR_Z = 0.35;
const lifetime = { attachments: 0, releases: 0, reloads: 0 };

function pinnedLeftEdge(geometry: BufferGeometry): number[] {
  const positions = geometry.getAttribute("position");
  if (positions === undefined) throw new Error("PRD243_FLAG_POSITIONS_MISSING");
  const pinned: number[] = [];
  for (let vertex = 0; vertex < positions.count; vertex += 1)
    if (Math.abs(positions.getX(vertex)) < 1e-6) pinned.push(vertex);
  if (pinned.length === 0) throw new Error("PRD243_FLAG_PINNED_EDGE_MISSING");
  return pinned;
}

function gustDisplacement(after: Float32Array): number {
  if (after.length === 0) throw new Error("PRD243_FLAG_READBACK_EMPTY");
  if (after.length % 3 !== 0)
    throw new Error(`PRD243_FLAG_READBACK_INVALID_LENGTH length=${after.length}`);
  let maximum = 0;
  for (let index = 0; index < after.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const current = after[index + axis];
      if (!Number.isFinite(current))
        throw new Error(
          `PRD243_FLAG_NONFINITE_SAMPLE index=${index + axis} after=${current} length=${after.length}`,
        );
    }
    // This authored flag is planar at z=0, so local z is its game-specific deformation measure.
    const z = after[index + 2];
    if (z === undefined) throw new Error(`PRD243_FLAG_READBACK_MISSING_Z index=${index}`);
    maximum = Math.max(maximum, Math.abs(z));
  }
  return maximum;
}

class ClothScene extends Scene<IClothState, IPhysicsContext> {
  static override readonly initialState: IClothState = {
    attachments: 0,
    collisionHeld: 0,
    gusts: 0,
    gustDisplacement: 0,
    outcome: "playing",
    releases: 0,
    reloads: 0,
    softBodySteps: 0,
  };

  #geometry: BufferGeometry | undefined;

  override load(): void {
    this.#geometry = createFlagGeometry();
  }

  override enter(
    ctx: ICtx<IClothState, IPhysicsContext>,
  ): SceneFrame<IClothState, IPhysicsContext> {
    const geometry = this.#geometry;
    if (geometry === undefined) throw new Error("PRD243_FLAG_NOT_LOADED");
    ctx.camera.position.set(4.7, 2.3, 7.8);
    ctx.camera.lookAt(0.65, 0.2, 0);
    ctx.add(createFlagStage(ctx.scene));
    const wallObject = ctx.add(createClothWall());
    const wall = new RigidBody3D({
      object: wallObject,
      physics: ctx.physics,
      shape: CollisionShape3D.box(4.4, 3.2, 0.2),
      type: "fixed",
    });

    const authoredMesh = new Mesh(geometry, createFlagMaterial());
    const cloth = new SoftBody3D(authoredMesh, {
      damping: 1.8,
      collision: softBodyCollision(wall),
      gravity: [0, 0, 0],
      pinned: pinnedLeftEdge(geometry),
      readbackEveryFrames: 2,
      stiffness: 42,
      wind: [0, 0, 0],
    });
    cloth.name = "flag";
    cloth.position.set(-1, -0.65, 0);
    cloth.addEventListener("removed", () => {
      if (cloth.released) lifetime.releases += 1;
    });
    ctx.add(cloth);
    lifetime.attachments += 1;

    let gustStartStep: number | undefined;
    let gusts = 0;
    let maximum = 0;
    let collisionHeld = 0;
    let outcome: IClothState["outcome"] = "playing";
    return (frameCtx) => {
      if (frameCtx.input.justPressed("reload")) {
        lifetime.reloads += 1;
        void frameCtx.goto("cloth");
        return;
      }
      if (frameCtx.input.justPressed("gust")) {
        gustStartStep = cloth.steps;
        cloth.wind.set(3.5, 1.2, 8);
        gusts += 1;
      }
      if (gustStartStep !== undefined && cloth.steps - gustStartStep >= GUST_TICKS)
        cloth.wind.set(0, 0, 0);
      const sample = cloth.sample;
      if (sample !== undefined && gustStartStep !== undefined)
        maximum = Math.max(maximum, gustDisplacement(sample.data));
      const sampleStep = sample === undefined ? undefined : cloth.steps - sample.staleFrames;
      const adjudicationSample =
        sampleStep !== undefined &&
        gustStartStep !== undefined &&
        sampleStep - gustStartStep >= GUST_TICKS;
      if (adjudicationSample && sample !== undefined && outcome === "playing") {
        let maximumZ = Number.NEGATIVE_INFINITY;
        for (let index = 2; index < sample.data.length; index += 3)
          maximumZ = Math.max(maximumZ, sample.data[index] as number);
        collisionHeld = maximumZ <= WALL_NEAR_Z + 0.01 ? 1 : 0;
        outcome = maximum >= WIN_DISPLACEMENT && collisionHeld === 1 ? "won" : "lost";
      }
      frameCtx.state.set({
        attachments: lifetime.attachments,
        collisionHeld,
        gusts,
        gustDisplacement: maximum,
        outcome,
        releases: lifetime.releases,
        reloads: lifetime.reloads,
        softBodySteps: cloth.steps,
      });
      if (outcome !== "playing") frameCtx.state.flush();
    };
  }

  override exit(): void {
    this.#geometry?.dispose();
    this.#geometry = undefined;
  }
}

const game = defineGame<IClothState, IPhysicsContext>({
  input: { gust: { keys: ["Space"] }, reload: { keys: ["KeyR"] } },
  plugins: [rapier({ gravity: { x: 0, y: 0, z: 0 } }), playtest()],
  renderer: { preferWebGPU: true },
  scenes: { cloth: ClothScene },
  start: "cloth",
  step: 1 / 60,
});

export default game;
