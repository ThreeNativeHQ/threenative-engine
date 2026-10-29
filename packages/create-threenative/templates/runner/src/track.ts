import { InstancedBatch } from "@threenative/core";
import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import {
  type BufferGeometry,
  Group,
  Matrix4,
  type MeshStandardMaterial,
  type Object3D,
} from "three";
import { OBSTACLE_LAYER, type RunnerPhysics } from "./physics.js";
import {
  LANE_WIDTH,
  OBSTACLE_SIZE,
  ground,
  obstacleShape,
  trackRails,
  trackSlab,
} from "./render/shapes.js";

export const CHUNK_LENGTH = 24;
/** How many chunks exist at once. The track is infinite; this many meshes are not. */
export const RESIDENT_CHUNKS = 6;
/** Slots per chunk. Fixed, because an `InstancedMesh` cannot grow after it is built. */
export const MAX_OBSTACLES = 4;
export const LANE_X = [-LANE_WIDTH, 0, LANE_WIDTH] as const;
/** No obstacles this close to the start, so the first seconds teach the controls. */
const GRACE_METRES = 34;
/** Where an unused slot goes: scaled to nothing at the chunk's centre, so it keeps the bounds tight. */
const PARKED = new Matrix4().makeScale(0, 0, 0);

export interface IChunkContext {
  readonly physics: RunnerPhysics;
  add(object: Object3D): Object3D;
  random(): number;
}

/**
 * One recycled slice of track.
 *
 * The road, the rails, the obstacle geometry and the obstacle material are built once and then
 * moved. `InstancedBatch` places `MAX_OBSTACLES` slots at construction and `build()` hands back
 * the `InstancedMesh`; a recycle rewrites that mesh's matrices and parks the slots it does not
 * need. An earlier version built a fresh batch per recycle and only `remove()`d the old mesh,
 * which in Three.js frees no GPU memory at all — every obstacle-bearing recycle leaked a
 * geometry, a material and an instance buffer, forever, on exactly the ten-minute run the
 * comment used to boast about.
 *
 * **The obstacle bodies are the exception, and are not recycled.** `RigidBody3D` has no
 * reposition API for a fixed body, so each recycle disposes the chunk's bodies and creates new
 * ones. They are disposed, so nothing leaks — but the claim is "the render side allocates
 * nothing", not "nothing allocates".
 */
export class Chunk {
  readonly group = new Group();
  readonly #bodies: RigidBody3D[] = [];
  readonly #obstacles: ReturnType<InstancedBatch["build"]>;
  readonly #matrix = new Matrix4();
  /** This stretch's obstacles: lane x and the run distance at their centre. */
  readonly obstacles: { x: number; distance: number }[] = [];
  #start = 0;

  constructor(
    ctx: IChunkContext,
    index: number,
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
  ) {
    this.group.name = `chunk-${index}`;
    this.group.add(trackRails(CHUNK_LENGTH), trackSlab(CHUNK_LENGTH));
    const batch = new InstancedBatch({ geometry, material });
    for (let slot = 0; slot < MAX_OBSTACLES; slot += 1) batch.place({ position: [0, -1000, 0] });
    this.#obstacles = batch.build({ castShadow: true, name: "obstacles", parent: this.group });
    ctx.add(this.group);
  }

  get start(): number {
    return this.#start;
  }

  /** Places the chunk at `start` metres and rewrites its obstacles for that stretch of track. */
  build(ctx: IChunkContext, start: number): void {
    this.#start = start;
    this.group.position.z = -(start + CHUNK_LENGTH / 2);
    for (const body of this.#bodies) body.dispose();
    this.#bodies.length = 0;
    this.obstacles.length = 0;

    let placed = 0;
    if (start >= GRACE_METRES) {
      for (let slot = 0; slot < MAX_OBSTACLES; slot += 1) {
        // Never all three lanes: a run that cannot be survived is a bug, not a difficulty curve.
        const blocked = Math.floor(ctx.random() * 3);
        if (ctx.random() < 0.35) continue;
        const laneX = LANE_X[blocked] ?? 0;
        const localZ = (slot + 0.5) * (CHUNK_LENGTH / MAX_OBSTACLES) - CHUNK_LENGTH / 2;
        this.#obstacles?.setMatrixAt(
          placed,
          this.#matrix.identity().setPosition(laneX, OBSTACLE_SIZE.height / 2, localZ),
        );
        placed += 1;
        this.obstacles.push({ x: laneX, distance: -(this.group.position.z + localZ) });
        this.#bodies.push(
          new RigidBody3D({
            collisionLayer: OBSTACLE_LAYER,
            collisionMask: 0,
            entity: `obstacle.${this.group.name}.${slot}`,
            physics: ctx.physics,
            position: {
              x: laneX,
              y: OBSTACLE_SIZE.height / 2,
              z: this.group.position.z + localZ,
            },
            shape: CollisionShape3D.box(
              OBSTACLE_SIZE.width,
              OBSTACLE_SIZE.height,
              OBSTACLE_SIZE.depth,
            ),
            type: "fixed",
          }),
        );
      }
    }
    for (let slot = placed; slot < MAX_OBSTACLES; slot += 1) {
      this.#obstacles?.setMatrixAt(slot, PARKED);
    }
    if (this.#obstacles !== undefined) {
      this.#obstacles.instanceMatrix.needsUpdate = true;
      // Three.js culls an InstancedMesh by the bounds it last computed. Those were taken around the
      // parked slots, so without this every rewritten obstacle was culled: unseen, still solid.
      this.#obstacles.computeBoundingSphere();
    }
  }

  dispose(): void {
    for (const body of this.#bodies) body.dispose();
    this.#bodies.length = 0;
    this.group.removeFromParent();
  }
}

/**
 * The track, as a ring of chunks.
 *
 * `advance` moves the chunk that has fallen behind the runner to the front of the queue and
 * rewrites it. The obstacle geometry and material are created here, once, and shared by every
 * chunk: they are the same box and the same surface every time, and building them per chunk was
 * both an allocation and — with no `dispose` — a leak.
 *
 * The ground the track runs over is added here too, under the whole stream, so the horizon reads
 * as ground meeting sky rather than a road over a void.
 */
export class Track {
  readonly chunks: Chunk[] = [];
  readonly #geometry: BufferGeometry;
  readonly #material: MeshStandardMaterial;
  #built = 0;

  constructor(ctx: IChunkContext) {
    ctx.add(ground());
    const shape = obstacleShape();
    this.#geometry = shape.geometry;
    this.#material = shape.material;
    for (let index = 0; index < RESIDENT_CHUNKS; index += 1) {
      const chunk = new Chunk(ctx, index, this.#geometry, this.#material);
      chunk.build(ctx, index * CHUNK_LENGTH);
      this.chunks.push(chunk);
      this.#built += 1;
    }
  }

  get built(): number {
    return this.#built;
  }

  advance(ctx: IChunkContext, distance: number): void {
    for (const chunk of this.chunks) {
      if (chunk.start + CHUNK_LENGTH > distance - CHUNK_LENGTH) continue;
      const furthest = Math.max(...this.chunks.map((other) => other.start));
      chunk.build(ctx, furthest + CHUNK_LENGTH);
      this.#built += 1;
    }
  }

  dispose(): void {
    for (const chunk of this.chunks) chunk.dispose();
    this.chunks.length = 0;
    this.#geometry.dispose();
    this.#material.dispose();
  }
}
