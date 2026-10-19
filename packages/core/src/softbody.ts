import { type BufferGeometry, Matrix4, Mesh, Vector3, Vector4 } from "three";
import {
  Fn,
  If,
  Loop,
  exp,
  instanceIndex,
  instancedArray,
  length,
  uniform,
  uniformArray,
  vec3,
  vertexIndex,
} from "three/tsl";
import type {
  ComputeNode,
  Node,
  NodeMaterial,
  StorageBufferNode,
  UniformArrayNode,
} from "three/webgpu";
import type { IComputeDriven } from "./compute-driven.js";
import { GPUReadback, type IGPUReadbackSample } from "./gpu-readback.js";
import type { IRendererLike } from "./renderer.js";
import {
  type IClothReferenceOptions,
  type IClothTopology,
  type IClothTopologyOptions,
  buildClothTopology,
  simulateClothReference,
} from "./softbody-topology.js";

export type { IClothReferenceOptions, IClothTopology, IClothTopologyOptions };
export { buildClothTopology, simulateClothReference };

/** Packed collision input supplied by an optional dependency such as `@threenative/physics`. */
export interface ISoftBodyCollision {
  readonly capacity: number;
  writeBoxes(target: Float32Array, worldToLocal: Matrix4): number;
}

export interface ISoftBody3DOptions extends IClothTopologyOptions {
  /** Spring acceleration per metre of stretch. Required; the game owns the cloth response. */
  readonly stiffness: number;
  /** Exponential velocity decay per second. Required; zero disables damping. */
  readonly damping: number;
  /** Local-space acceleration in metres per second squared. */
  readonly gravity: readonly [number, number, number];
  /** Local-space wind acceleration in metres per second squared. */
  readonly wind: readonly [number, number, number];
  /** Existing physics bodies translated by the physics package; omitted when cloth has no world collision. */
  readonly collision?: ISoftBodyCollision;
  /** Framework fixed-step duration. Defaults to the engine convention of 1/60 second. */
  readonly timeStep?: number;
  /** Throttled GPU position readback for gameplay/proof; zero disables it. */
  readonly readbackEveryFrames?: number;
}

interface IClothBuffers {
  readonly adjacency: StorageBufferNode<"vec2">;
  readonly initial: StorageBufferNode<"vec3">;
  readonly metadata: StorageBufferNode<"uvec2">;
  readonly originalToUnique: StorageBufferNode<"uint">;
  readonly positionsA: StorageBufferNode<"vec3">;
  readonly positionsB: StorageBufferNode<"vec3">;
  readonly velocitiesA: StorageBufferNode<"vec3">;
  readonly velocitiesB: StorageBufferNode<"vec3">;
}

interface IClothCollisionState {
  readonly bounds: UniformArrayNode<"vec4">;
  readonly count: Node<"uint"> & { value: number };
  readonly packed: Float32Array;
  readonly source: ISoftBodyCollision;
  readonly worldToLocal: Matrix4;
}

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new Error(`SoftBody3D.${name} must be finite.`);
  return value;
}

function positive(name: string, value: number): number {
  finite(name, value);
  if (value <= 0) throw new Error(`SoftBody3D.${name} must be greater than zero.`);
  return value;
}

function nonNegative(name: string, value: number): number {
  finite(name, value);
  if (value < 0) throw new Error(`SoftBody3D.${name} must be non-negative.`);
  return value;
}

function vector(name: string, value: readonly [number, number, number]): Vector3 {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error(`SoftBody3D.${name} must contain three numbers.`);
  return new Vector3(
    finite(`${name}.x`, value[0]),
    finite(`${name}.y`, value[1]),
    finite(`${name}.z`, value[2]),
  );
}

function nodeMaterial(mesh: Mesh): NodeMaterial {
  if (
    Array.isArray(mesh.material) ||
    (mesh.material as { readonly isNodeMaterial?: boolean }).isNodeMaterial !== true
  )
    throw new Error("SoftBody3D mesh must use one game-owned Three.js node material.");
  return mesh.material.clone() as NodeMaterial;
}

function storageBuffers(topology: IClothTopology): IClothBuffers {
  const zeroVelocities = new Float32Array(topology.positions.length);
  const metadata = new Uint32Array(topology.pinned.length * 2);
  for (let vertex = 0; vertex < topology.pinned.length; vertex += 1) {
    metadata[vertex * 2] = topology.pinned[vertex] ?? 0;
    metadata[vertex * 2 + 1] = topology.neighborCounts[vertex] ?? 0;
  }
  const adjacency = new Float32Array(topology.neighbors.length * 2);
  for (let slot = 0; slot < topology.neighbors.length; slot += 1) {
    adjacency[slot * 2] = topology.neighbors[slot] ?? 0;
    adjacency[slot * 2 + 1] = topology.neighborRestLengths[slot] ?? 0;
  }
  return {
    adjacency: instancedArray(adjacency, "vec2"),
    initial: instancedArray(new Float32Array(topology.positions), "vec3"),
    metadata: instancedArray(metadata, "uvec2"),
    originalToUnique: instancedArray(topology.originalToUnique, "uint"),
    positionsA: instancedArray(new Float32Array(topology.positions), "vec3"),
    positionsB: instancedArray(new Float32Array(topology.positions), "vec3"),
    velocitiesA: instancedArray(zeroVelocities, "vec3"),
    velocitiesB: instancedArray(new Float32Array(zeroVelocities), "vec3"),
  };
}

/** @internal WGSL arrays align vec3 elements to 16 bytes even though the CPU attribute is packed. */
export function compactClothVec3Readback(data: Float32Array, vertices: number): Float32Array {
  if (data.length === vertices * 3) return new Float32Array(data);
  if (data.length !== vertices * 4)
    throw new Error(
      `SoftBody3D position readback expected ${vertices * 3} packed or ${vertices * 4} padded floats, received ${data.length}.`,
    );
  const compact = new Float32Array(vertices * 3);
  for (let vertex = 0; vertex < vertices; vertex += 1)
    compact.set(data.subarray(vertex * 4, vertex * 4 + 3), vertex * 3);
  return compact;
}

function clothPass(options: {
  readonly name: string;
  readonly vertexCount: number;
  readonly maxNeighbors: number;
  readonly sourcePositions: StorageBufferNode<"vec3">;
  readonly sourceVelocities: StorageBufferNode<"vec3">;
  readonly targetPositions: StorageBufferNode<"vec3">;
  readonly targetVelocities: StorageBufferNode<"vec3">;
  readonly buffers: IClothBuffers;
  readonly forces: UniformArrayNode<"vec4">;
  readonly stiffness: Node<"float">;
  readonly damping: Node<"float">;
  readonly halfStep: Node<"float">;
  readonly collision?: Pick<IClothCollisionState, "bounds" | "count"> & {
    readonly capacity: number;
  };
}): ComputeNode {
  const pass = Fn(() => {
    const position = options.sourcePositions.element(instanceIndex);
    const force = vec3(0).toVar();
    const metadata = options.buffers.metadata.element(instanceIndex);
    const neighborCount = metadata.y;
    Loop({ type: "uint", start: 0, end: options.maxNeighbors }, ({ i }) => {
      If(i.lessThan(neighborCount), () => {
        const slot = instanceIndex.mul(options.maxNeighbors).add(i);
        const adjacency = options.buffers.adjacency.element(slot);
        const neighbor = adjacency.x.toUint();
        const delta = options.sourcePositions.element(neighbor).sub(position);
        const distance = length(delta);
        If(distance.greaterThan(1e-6), () => {
          const stretch = distance.sub(adjacency.y);
          force.addAssign(delta.mul(stretch.div(distance)).mul(options.stiffness));
        });
      });
    });
    const velocity = options.sourceVelocities
      .element(instanceIndex)
      .add(
        force
          .add(options.forces.element(0).xyz)
          .add(options.forces.element(1).xyz)
          .mul(options.halfStep),
      )
      .mul(exp(options.damping.mul(options.halfStep).negate()))
      .toVar();
    const nextPosition = position.add(velocity.mul(options.halfStep)).toVar();
    const collision = options.collision;
    if (collision !== undefined) {
      Loop({ type: "uint", start: 0, end: collision.capacity }, ({ i }) => {
        If(i.lessThan(collision.count), () => {
          const center = collision.bounds.element(i.mul(2)).xyz;
          const halfExtents = collision.bounds.element(i.mul(2).add(1)).xyz;
          const currentRelative = position.sub(center);
          const relative = nextPosition.sub(center);
          const withinX = relative.x.abs().lessThanEqual(halfExtents.x);
          const withinY = relative.y.abs().lessThanEqual(halfExtents.y);
          const withinZ = relative.z.abs().lessThanEqual(halfExtents.z);
          const crossedNegativeX = currentRelative.x
            .lessThanEqual(halfExtents.x.negate())
            .and(relative.x.greaterThanEqual(halfExtents.x.negate()))
            .and(withinY)
            .and(withinZ);
          const crossedPositiveX = currentRelative.x
            .greaterThanEqual(halfExtents.x)
            .and(relative.x.lessThanEqual(halfExtents.x))
            .and(withinY)
            .and(withinZ);
          const crossedNegativeY = currentRelative.y
            .lessThanEqual(halfExtents.y.negate())
            .and(relative.y.greaterThanEqual(halfExtents.y.negate()))
            .and(withinX)
            .and(withinZ);
          const crossedPositiveY = currentRelative.y
            .greaterThanEqual(halfExtents.y)
            .and(relative.y.lessThanEqual(halfExtents.y))
            .and(withinX)
            .and(withinZ);
          const crossedNegativeZ = currentRelative.z
            .lessThanEqual(halfExtents.z.negate())
            .and(relative.z.greaterThanEqual(halfExtents.z.negate()))
            .and(withinX)
            .and(withinY);
          const crossedPositiveZ = currentRelative.z
            .greaterThanEqual(halfExtents.z)
            .and(relative.z.lessThanEqual(halfExtents.z))
            .and(withinX)
            .and(withinY);
          If(crossedNegativeX, () => {
            nextPosition.x.assign(center.x.sub(halfExtents.x));
            velocity.x.assign(0);
          })
            .ElseIf(crossedPositiveX, () => {
              nextPosition.x.assign(center.x.add(halfExtents.x));
              velocity.x.assign(0);
            })
            .ElseIf(crossedNegativeY, () => {
              nextPosition.y.assign(center.y.sub(halfExtents.y));
              velocity.y.assign(0);
            })
            .ElseIf(crossedPositiveY, () => {
              nextPosition.y.assign(center.y.add(halfExtents.y));
              velocity.y.assign(0);
            })
            .ElseIf(crossedNegativeZ, () => {
              nextPosition.z.assign(center.z.sub(halfExtents.z));
              velocity.z.assign(0);
            })
            .ElseIf(crossedPositiveZ, () => {
              nextPosition.z.assign(center.z.add(halfExtents.z));
              velocity.z.assign(0);
            })
            .ElseIf(relative.abs().lessThanEqual(halfExtents).all(), () => {
              const faceDistance = halfExtents.sub(relative.abs());
              If(
                faceDistance.x
                  .lessThanEqual(faceDistance.y)
                  .and(faceDistance.x.lessThanEqual(faceDistance.z)),
                () => {
                  nextPosition.x.assign(
                    center.x.add(halfExtents.x.mul(relative.x.greaterThanEqual(0).select(1, -1))),
                  );
                  velocity.x.assign(0);
                },
              )
                .ElseIf(faceDistance.y.lessThanEqual(faceDistance.z), () => {
                  nextPosition.y.assign(
                    center.y.add(halfExtents.y.mul(relative.y.greaterThanEqual(0).select(1, -1))),
                  );
                  velocity.y.assign(0);
                })
                .Else(() => {
                  nextPosition.z.assign(
                    center.z.add(halfExtents.z.mul(relative.z.greaterThanEqual(0).select(1, -1))),
                  );
                  velocity.z.assign(0);
                });
            });
        });
      });
    }
    If(metadata.x.greaterThan(0), () => {
      options.targetPositions
        .element(instanceIndex)
        .assign(options.buffers.initial.element(instanceIndex));
      options.targetVelocities.element(instanceIndex).assign(vec3(0));
    }).Else(() => {
      options.targetPositions.element(instanceIndex).assign(nextPosition);
      options.targetVelocities.element(instanceIndex).assign(velocity);
    });
  })().compute(options.vertexCount);
  pass.setName(options.name);
  return pass;
}

/**
 * Simulate an ordinary game-authored triangle mesh as cloth on the existing fixed-step GPU lane.
 *
 * The mesh supplies every visible choice. This class welds exporter duplicates, owns spring and
 * position buffers, and replaces only the cloned material's position node. It adds no material,
 * colour, texture, wind, stiffness, damping, or pinning default.
 *
 * @situation make a flag, cape, or curtain move as cloth
 * @situation simulate a deforming surface while keeping one edge pinned
 * @situation simulate cloth sails blowing in the wind
 * @situation make cloth sails billow in wind on a ship
 * @constraint the mesh must use one Three.js node material and contain complete triangles
 * @constraint pinned, stiffness, damping, gravity, and wind are required game-owned inputs
 * @constraint Pixel 8 steady upper bound for the shipped 45-vertex pennant with readback every two frames: whole-starter update p95 4.66 ms, render p95 3.56 ms, and GPU timer 0.05 ms across three 300-frame final-rung windows at 552x248 with 4x MSAA; these whole-scene numbers are not isolated solver cost
 * @override timeStep follows the engine 1/60-second convention unless the game overrides it
 * @override readbackEveryFrames enables an explicitly stale CPU position sample; zero disables it
 * @example const flag = new SoftBody3D(flagMesh, { pinned: topEdge, stiffness: 35, damping: 1.8, gravity: [0, -9.81, 0], wind: [1.5, 0, 0.4] });
 */
export class SoftBody3D extends Mesh<BufferGeometry, NodeMaterial> implements IComputeDriven {
  readonly processCadence = "fixed" as const;
  readonly warmupNodes: readonly ComputeNode[];
  readonly stiffness: number;
  readonly damping: number;
  readonly timeStep: number;
  readonly gravity: Vector3;
  readonly wind: Vector3;
  readonly uniqueVertexCount: number;
  readonly springCount: number;
  readonly #buffers: IClothBuffers;
  readonly #forces: UniformArrayNode<"vec4">;
  readonly #collision: IClothCollisionState | undefined;
  readonly #readback: GPUReadback | undefined;
  readonly #ownedMaterial: NodeMaterial;
  #renderer: IRendererLike | undefined;
  #released = false;
  #steps = 0;

  constructor(mesh: Mesh, options: ISoftBody3DOptions) {
    const topology = buildClothTopology(mesh.geometry, options);
    const gravity = vector("gravity", options.gravity);
    const wind = vector("wind", options.wind);
    const material = nodeMaterial(mesh);
    const buffers = storageBuffers(topology);
    const forces: UniformArrayNode<"vec4"> = uniformArray(
      [new Vector4(gravity.x, gravity.y, gravity.z, 0), new Vector4(wind.x, wind.y, wind.z, 0)],
      "vec4",
    );
    const collision = options.collision;
    if (
      collision !== undefined &&
      (!Number.isInteger(collision.capacity) || collision.capacity <= 0)
    )
      throw new Error("SoftBody3D collision capacity must be a positive integer.");
    const collisionState: IClothCollisionState | undefined =
      collision === undefined
        ? undefined
        : {
            bounds: uniformArray(
              Array.from({ length: collision.capacity * 2 }, () => new Vector4()),
              "vec4",
            ),
            count: uniform(0, "uint"),
            packed: new Float32Array(collision.capacity * 8),
            source: collision,
            worldToLocal: new Matrix4(),
          };
    material.positionNode = buffers.positionsA.element(
      buffers.originalToUnique.element(vertexIndex),
    );
    super(mesh.geometry, material);
    this.#ownedMaterial = material;
    this.#buffers = buffers;
    this.#forces = forces;
    this.#collision = collisionState;
    this.stiffness = positive("stiffness", options.stiffness);
    this.damping = nonNegative("damping", options.damping);
    this.timeStep = positive("timeStep", options.timeStep ?? 1 / 60);
    this.gravity = gravity;
    this.wind = wind;
    const readbackEveryFrames = options.readbackEveryFrames ?? 0;
    if (!Number.isInteger(readbackEveryFrames) || readbackEveryFrames < 0)
      throw new Error("SoftBody3D.readbackEveryFrames must be a non-negative integer.");
    this.uniqueVertexCount = topology.positions.length / 3;
    this.springCount = topology.springs.length / 2;
    const stiffness = uniform(this.stiffness);
    const damping = uniform(this.damping);
    const halfStep = uniform(this.timeStep / 2);
    const common = {
      buffers,
      ...(collisionState === undefined
        ? {}
        : {
            collision: {
              bounds: collisionState.bounds,
              capacity: collisionState.source.capacity,
              count: collisionState.count,
            },
          }),
      damping,
      forces,
      halfStep,
      maxNeighbors: topology.maxNeighbors,
      stiffness,
      vertexCount: this.uniqueVertexCount,
    };
    const passAtoB = clothPass({
      ...common,
      name: "softbody.a-to-b",
      sourcePositions: buffers.positionsA,
      sourceVelocities: buffers.velocitiesA,
      targetPositions: buffers.positionsB,
      targetVelocities: buffers.velocitiesB,
    });
    const passBtoA = clothPass({
      ...common,
      name: "softbody.b-to-a",
      sourcePositions: buffers.positionsB,
      sourceVelocities: buffers.velocitiesB,
      targetPositions: buffers.positionsA,
      targetVelocities: buffers.velocitiesA,
    });
    this.warmupNodes = [passAtoB, passBtoA];
    this.#readback =
      readbackEveryFrames > 0
        ? new GPUReadback({
            attribute: buffers.positionsA.value,
            everyFrames: readbackEveryFrames,
          })
        : undefined;
    this.frustumCulled = false;
    this.addEventListener("removed", this.#onRemoved);
  }

  get released(): boolean {
    return this.#released;
  }

  get steps(): number {
    return this.#steps;
  }

  /** Latest asynchronous GPU positions and their age, when readback was requested. */
  get sample(): IGPUReadbackSample | undefined {
    const sample = this.#readback?.sample;
    if (sample === undefined) return undefined;
    return {
      data: compactClothVec3Readback(sample.data, this.uniqueVertexCount),
      staleFrames: sample.staleFrames,
    };
  }

  debug(): Record<string, unknown> {
    return {
      released: this.#released,
      softBodySteps: this.#steps,
      springCount: this.springCount,
      uniqueVertexCount: this.uniqueVertexCount,
      readbackPending: this.#readback?.pending,
      readbackStats: this.#readback?.stats,
      sampleStaleFrames: this.#readback?.staleFrames,
    };
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("SoftBody3D cannot be attached after release.");
    if (renderer.kind !== "webgpu") throw new Error("SoftBody3D requires the WebGPU renderer.");
    this.#renderer = renderer;
  }

  process(renderer = this.#renderer): void {
    if (this.#released) return;
    if (renderer === undefined) throw new Error("SoftBody3D is not attached to a renderer.");
    (this.#forces.array[0] as Vector4).set(this.gravity.x, this.gravity.y, this.gravity.z, 0);
    (this.#forces.array[1] as Vector4).set(this.wind.x, this.wind.y, this.wind.z, 0);
    const collision = this.#collision;
    if (collision !== undefined) {
      this.updateWorldMatrix(true, false);
      collision.worldToLocal.copy(this.matrixWorld).invert();
      const count = collision.source.writeBoxes(collision.packed, collision.worldToLocal);
      if (!Number.isInteger(count) || count < 0 || count > collision.source.capacity)
        throw new Error(
          `SoftBody3D collision source returned ${count}; expected 0..${collision.source.capacity}.`,
        );
      collision.count.value = count;
      for (let index = 0; index < collision.source.capacity * 2; index += 1) {
        const offset = index * 4;
        (collision.bounds.array[index] as Vector4).set(
          collision.packed[offset] as number,
          collision.packed[offset + 1] as number,
          collision.packed[offset + 2] as number,
          collision.packed[offset + 3] as number,
        );
      }
    }
    for (const node of this.warmupNodes) renderer.compute(node);
    this.#steps += 1;
    this.#readback?.request(renderer);
  }

  detach(): void {
    if (this.#released) return;
    this.removeEventListener("removed", this.#onRemoved);
    this.#renderer = undefined;
    for (const node of this.warmupNodes) node.dispose();
    for (const buffer of Object.values(this.#buffers)) buffer.value.dispose();
    this.#readback?.dispose();
    this.#ownedMaterial.dispose();
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();
}
