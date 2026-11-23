// Guide-strand solver transliterated from frostbitten-hair-webgpu
// (src/passes/simulation/hairSimIntegrationPass.wgsl.ts and shaderImpl/*.wgsl.ts):
// Verlet integration, then per iteration the length, global-shape, local-shape and collision
// constraints. Changes from upstream: Unreal's root-to-tip stretch projection ends each substep; world space with the roots and rest shape carried by a bone,
// SI units, capsules in place of the sphere and SDF colliders, no density/velocity grid (so no
// friction or volume preservation), Unreal groom air drag and WindField3D in place of the wind gusts.
//
// The MIT License (MIT)
//
// Copyright (c) 2024 Marcin Matuszczyk
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
// OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { type Matrix4, Object3D, Vector3, Vector4 } from "three";
import {
  Fn,
  If,
  abs,
  dot,
  float,
  instanceIndex,
  instancedArray,
  int,
  length,
  max,
  mix,
  normalize,
  saturate,
  uniform,
  uniformArray,
  vec3,
  vec4,
  workgroupArray,
  workgroupBarrier,
} from "three/tsl";
import type { ComputeNode, Node, StorageBufferNode, UniformArrayNode } from "three/webgpu";
import type { IComputeDriven } from "./compute-driven.js";
import { GPUReadback, type IGPUReadbackSample } from "./gpu-readback.js";
import type { IRendererLike } from "./renderer.js";
import {
  type ISoftBodyCapsule,
  SINGLE_DISPATCH_MAX,
  countLoop,
  workgroupVec3,
} from "./softbody-skinned.js";
import { compactClothVec3Readback } from "./softbody.js";
import { windAt } from "./wind-field.js";

/** Up to this many colliders (unrolled at constant indices). */
const MAX_COLLIDERS = 8;
const EPSILON = 1e-7;
// Unreal groom drag (UE 5.8.3: Engine/Plugins/Runtime/HairStrands/Shaders/Private/
// NiagaraStrandsExternalForce.ush:17-58) in SI: air at 20 °C.
const AIR_DENSITY = 1.225;
const AIR_VISCOSITY = 1.8e-5;

/** Options for `HairStrands3D`. Every value is a named override. */
export interface IHairStrands3DOptions {
  /** Points per guide, root first; `guides.length / 3` must divide by it. */
  readonly pointsPerStrand: number;
  /** The bone the roots and the rest shape follow, usually the head. */
  readonly bone: Object3D;
  /** Fixed step in seconds. Default 1/60, the loop's step. */
  readonly timeStep?: number;
  /** Substeps per step. Unreal groom default 5 (`GroomAssetPhysics.cpp:13`). */
  readonly substeps?: number;
  /** Constraint iterations per substep. Unreal groom default 5 (`GroomAssetPhysics.cpp:14`). */
  readonly iterations?: number;
  /** World gravity. Default (0, -9.81, 0). */
  readonly gravity?: Vector3;
  /** Air drag scale. Unreal groom default 0.1 (`GroomAssetPhysics.h:322`). */
  readonly airDrag?: number;
  /** Wind in m/s. Omitted: the sum of the scene's `WindField3D` velocities, read every step. */
  readonly wind?: Vector3;
  /** Strand thickness for mass and drag, metres. Unreal default 0.01 cm (`GroomAssetPhysics.cpp:74`). */
  readonly thickness?: number;
  /** Strand density, kg/m³. Unreal default 1 g/cm³ (`GroomAssetPhysics.cpp:72`). */
  readonly density?: number;
  /** Length constraint stiffness. frostbitten default 1. */
  readonly lengthStiffness?: number;
  /** Pull toward the rest shape, strongest at the root. frostbitten default 0.2. */
  readonly globalStiffness?: number;
  /** Fraction of the strand held fully by the global shape. frostbitten default 0.1. */
  readonly globalExtent?: number;
  /** Fraction after the extent over which the global shape fades out. frostbitten default 0.75. */
  readonly globalFade?: number;
  /** Bend toward the rest curvature. frostbitten default 0.3. */
  readonly localStiffness?: number;
  /** Collision push-out stiffness. frostbitten default 1. */
  readonly collisionStiffness?: number;
  /** Capsules the strands stay out of; `measureBodyCapsules` gives the skin's. */
  readonly colliders?: readonly ISoftBodyCapsule[];
  /** Clearance beyond each collider radius, metres. Default 0.005. */
  readonly colliderThickness?: number;
  /** A root move in one step past this resets the strands to the rest shape. Unreal default 50 cm. */
  readonly teleportDistance?: number;
  /** Throttled GPU position readback for proofs; zero (default) disables it. */
  readonly readbackEveryFrames?: number;
  /** Copies of the GPU state kept in flight for `takeSamples()`; default 1, the gameplay path. */
  readonly readbackInFlight?: number;
}

function check(name: string, value: number, min: number, max = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`HairStrands3D.${name} must be in [${min}, ${max}]; received ${value}.`);
  return value;
}

/**
 * Simulate hair guide strands on the GPU: hair cards or strands that swing with the head, hang
 * under gravity, keep their styled shape near the root and stay out of the head and body.
 *
 * The kernel is frostbitten-hair-webgpu's guide solver (MIT): Verlet, then the length,
 * global-shape, local-shape and collision constraints per iteration. Defaults are Unreal's groom
 * solver (5 substeps, 5 iterations, air drag 0.1) and frostbitten's stiffnesses. Roots and the rest
 * shape ride on `bone`. Positions stay on the GPU: cards or ribbons read {@link positions} in their
 * position node. Add it to the scene root; it simulates in world space.
 *
 * @situation long hair moves with the head
 * @situation hair cards follow the head
 * @situation simulate hair guide strands on the GPU
 * @situation braid or fringe of hair cards that swings
 * @constraint WebGPU compute; one thread per point with each strand in workgroup memory (at most 256 points per workgroup), the whole step in one dispatch, at most 8 colliders; world space at the scene root
 * @override substeps, iterations, airDrag, wind, globalStiffness, localStiffness, colliders, teleportDistance
 * @example
 * import { HairStrands3D, measureBodyCapsules } from "@threenative/core";
 * const hair = new HairStrands3D(guidePositions, { pointsPerStrand: 16, bone: head, colliders });
 * scene.add(hair);
 * material.positionNode = hair.positions.element(guidePointIndex);
 */
export class HairStrands3D extends Object3D implements IComputeDriven {
  readonly processCadence = "fixed" as const;
  readonly warmupNodes: readonly ComputeNode[];
  /** World positions, strand-major, root first. Cards read this in their position node. */
  readonly positions: StorageBufferNode<"vec3">;
  readonly pointsPerStrand: number;
  readonly strandCount: number;
  /** Whole strands per workgroup; one thread solves one point, so a group is `strandsPerGroup * pointsPerStrand` threads. */
  readonly strandsPerGroup: number;
  /** Threads per workgroup, at most 256. */
  readonly workgroupSize: number;
  /** Rest segment lengths, strand-major; the last slot of each strand is 0. */
  readonly restLengths: Float32Array;
  /** Wind in m/s, read every step. Holds the scene's `WindField3D` sum unless `wind` was given. */
  readonly wind: Vector3;
  readonly #bone: Object3D;
  readonly #substeps: number;
  readonly #iterations: number;
  readonly #colliders: readonly ISoftBodyCapsule[];
  readonly #windFromScene: boolean;
  readonly #teleport: number;
  readonly #frames: { prev: Matrix4; now: Matrix4 };
  readonly #frameUniforms: { prev: { value: Matrix4 }; now: { value: Matrix4 } };
  readonly #windUniform: { value: Vector3 };
  readonly #capsuleRows: UniformArrayNode<"vec4">;
  readonly #step: ComputeNode;
  readonly #reset: ComputeNode;
  readonly #readback: GPUReadback | undefined;
  #renderer: IRendererLike | undefined;
  #started = false;
  #resets = 0;
  #steps = 0;
  #released = false;

  constructor(guides: Float32Array, options: IHairStrands3DOptions) {
    super();
    this.name = "HairStrands3D";
    const n = check("pointsPerStrand", options.pointsPerStrand, 4, 64);
    if (!Number.isInteger(n)) throw new Error("HairStrands3D.pointsPerStrand must be an integer.");
    if (guides.length === 0 || guides.length % (n * 3) !== 0)
      throw new Error(
        `HairStrands3D guides hold ${guides.length} floats; expected a positive multiple of ${n * 3}.`,
      );
    for (const value of guides)
      if (!Number.isFinite(value)) throw new Error("HairStrands3D guides must be finite.");
    if (options.bone?.isObject3D !== true)
      throw new Error("HairStrands3D.bone must be an Object3D.");
    const timeStep = check("timeStep", options.timeStep ?? 1 / 60, 1e-4, 1);
    const substeps = check("substeps", options.substeps ?? 5, 1, 16);
    const iterations = check("iterations", options.iterations ?? 5, 1, 32);
    const airDrag = check("airDrag", options.airDrag ?? 0.1, 0);
    const strandThickness = check("thickness", options.thickness ?? 1e-4, 1e-6);
    const density = check("density", options.density ?? 1000, 1);
    const lengthK = check("lengthStiffness", options.lengthStiffness ?? 1, 0, 1);
    const globalK = check("globalStiffness", options.globalStiffness ?? 0.2, 0, 1);
    const extent = check("globalExtent", options.globalExtent ?? 0.1, 0, 1);
    const fade = check("globalFade", options.globalFade ?? 0.75, 1e-3, 1);
    const localK = check("localStiffness", options.localStiffness ?? 0.3, 0, 1);
    const collisionK = check("collisionStiffness", options.collisionStiffness ?? 1, 0, 1);
    const colliderThickness = check("colliderThickness", options.colliderThickness ?? 0.005, 0);
    this.#teleport = check("teleportDistance", options.teleportDistance ?? 0.5, 0);
    const colliders = options.colliders ?? [];
    if (colliders.length > MAX_COLLIDERS)
      throw new Error(
        `HairStrands3D.colliders holds ${colliders.length}; at most ${MAX_COLLIDERS}.`,
      );
    for (const capsule of colliders) check("colliders[].radius", capsule.radius, 1e-4);
    const gravity = options.gravity ?? new Vector3(0, -9.81, 0);
    this.#bone = options.bone;
    this.#substeps = substeps;
    this.#iterations = iterations;
    this.#colliders = colliders;
    this.#windFromScene = options.wind === undefined;
    this.wind = (options.wind ?? new Vector3()).clone();
    this.pointsPerStrand = n;
    const pointCount = guides.length / 3;
    this.strandCount = pointCount / n;

    // Rest shape in the bone's frame, and rest segment lengths in world metres.
    this.#bone.updateWorldMatrix(true, false);
    const boneWorld = this.#bone.matrixWorld.clone();
    const toBone = boneWorld.clone().invert();
    const rest = new Float32Array(pointCount * 4);
    const point = new Vector3();
    for (let i = 0; i < pointCount; i++) {
      point.fromArray(guides, i * 3).applyMatrix4(toBone);
      rest.set([point.x, point.y, point.z, i % n === 0 ? 0 : 1], i * 4);
    }
    this.restLengths = new Float32Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      if (i % n === n - 1) continue;
      const length = Math.hypot(
        (guides[i * 3 + 3] as number) - (guides[i * 3] as number),
        (guides[i * 3 + 4] as number) - (guides[i * 3 + 1] as number),
        (guides[i * 3 + 5] as number) - (guides[i * 3 + 2] as number),
      );
      if (length < 1e-5) throw new Error(`HairStrands3D guide segment ${i} has zero length.`);
      this.restLengths[i] = length;
    }

    const restBuffer = instancedArray(rest, "vec4");
    const lengthBuffer = instancedArray(this.restLengths, "float");
    const prev = instancedArray(new Float32Array(guides), "vec3");
    const now = instancedArray(new Float32Array(guides), "vec3");
    this.positions = now;
    this.#frames = { prev: boneWorld.clone(), now: boneWorld.clone() };
    const framePrev = uniform(this.#frames.prev);
    const frameNow = uniform(this.#frames.now);
    this.#frameUniforms = { prev: framePrev, now: frameNow };
    const windUniform = uniform(this.wind.clone());
    this.#windUniform = windUniform;
    // Collider rows: c * 4 + [prevA (radius in w), prevB, nowA, nowB].
    this.#capsuleRows = uniformArray(
      Array.from({ length: Math.max(1, colliders.length) * 4 }, () => new Vector4()),
      "vec4",
    );
    const capsuleRows = this.#capsuleRows;
    const h = timeStep / substeps;
    const nodeMass = density * Math.PI * (strandThickness / 2) ** 2;

    // The rest point carried by the bone, blended across the step like the roots.
    const target = (r: Node<"vec4">, at: Node<"float">): Node<"vec3"> =>
      mix(framePrev.mul(r).xyz, frameNow.mul(r).xyz, at);

    // One thread per point, a strand's points in workgroup memory, as Unreal's groom solver lays it out
    // (UE 5.8.3: Engine/Plugins/Runtime/HairStrands/Shaders/Private/NiagaraDataInterfaceHairStrandsTemplate.ush:131,
    // 177, 263-291: a node is a thread, its strand-local index is the group thread id modulo the strand size, and
    // GroupMemoryBarrier separates the steps). A group holds whole strands, and the whole frame (every substep)
    // is one dispatch. Constraints that touch neighbours run in colours (even then odd segments) or read then
    // write behind a barrier; the root-to-tip projection is a chain, so each strand's root thread walks it.
    const strandsPerGroup = Math.floor(SINGLE_DISPATCH_MAX / n);
    const groupSize = strandsPerGroup * n;
    this.strandsPerGroup = strandsPerGroup;
    this.workgroupSize = groupSize;
    const groups = Math.ceil(this.strandCount / strandsPerGroup);
    const globalStep = globalK / iterations;
    const localStep = localK / iterations;
    const step = Fn(() => {
      const gid = int(instanceIndex);
      // Per-thread values the loops reuse sit in registers: a bare expression node is re-evaluated at each use.
      const live = gid.lessThan(pointCount).toVar();
      const local = int(float(gid).mod(groupSize)).toVar();
      const i = int(float(local).mod(n)).toVar();
      const parity = float(i).mod(2);
      const evenSegment = live
        .and(i.lessThan(n - 1))
        .and(parity.lessThan(0.5))
        .toVar();
      const oddSegment = live
        .and(i.lessThan(n - 1))
        .and(parity.greaterThan(0.5))
        .toVar();
      const hasParent = live.and(i.greaterThan(0)).toVar();
      const hasShape = live.and(i.lessThanEqual(n - 4)).toVar();
      const isRoot = i.equal(0).toVar();
      const rootShare = isRoot.select(0, 1).toVar();
      // Global shape: pull toward the rest shape, full over the extent, fading after it.
      const pull = float(1)
        .sub(
          saturate(
            float(i)
              .div(n - 1)
              .sub(extent)
              .div(fade),
          ),
        )
        .mul(globalStep)
        .toVar();
      // This point's share of the triangles a = i (first corner), i - 1 (middle) and i - 2 (last).
      const second = i.greaterThanEqual(2).toVar();
      const middleShare = i
        .equal(1)
        .select(-2, -4 / 3)
        .toVar();
      const lastShare = second.select(i.equal(2).select(1, 2 / 3), 0).toVar();
      const lastCorner = second.select(local.sub(2), local).toVar();
      const isTail = i.greaterThanEqual(n - 3).toVar();
      const shared = workgroupVec3(groupSize);
      const targets = workgroupVec3(groupSize);
      const shape = workgroupVec3(groupSize);
      const lengths = workgroupArray("float", groupSize) as unknown as StorageBufferNode<"float">;
      const earlier = vec3(0).toVar();
      // What a thread reads from storage is read once: the loops below touch registers and workgroup memory.
      const rest = vec4(0, 0, 0, 1).toVar();
      const segmentAfter = float(1).toVar();
      const segmentBefore = float(1).toVar();
      If(live, () => {
        shared.element(local).assign(now.element(gid));
        earlier.assign(prev.element(gid));
        rest.assign(vec4(restBuffer.element(gid).xyz, 1));
        segmentAfter.assign(lengthBuffer.element(gid));
        If(i.greaterThan(0), () => {
          segmentBefore.assign(lengthBuffer.element(gid.sub(1)));
        });
      });
      lengths.element(local).assign(segmentAfter);
      workgroupBarrier();
      countLoop("s", substeps, (s) => {
        const at = float(s).add(1).div(substeps);
        const atBefore = float(s).div(substeps);
        // Verlet integration (upstream `verletIntegration` with no grid displacement); the root is not
        // movable and follows the bone. A point reads its parent's old position before anyone moves.
        const lastOld = vec3(0).toVar();
        If(hasParent, () => {
          lastOld.assign(shared.element(local.sub(1)));
        });
        workgroupBarrier();
        If(live, () => {
          targets.element(local).assign(target(rest, at));
          If(isRoot, () => {
            earlier.assign(target(rest, atBefore));
            shared.element(local).assign(target(rest, at));
          }).Else(() => {
            const pNow = shared.element(local).toVar();
            const disp = pNow.sub(earlier).toVar();
            // Unreal air drag on a node of this segment's length.
            const segment = segmentBefore;
            const deltaV = disp.div(h).sub(windUniform).toVar();
            const speed = length(deltaV);
            const tangent = pNow.sub(lastOld).toVar();
            const tangentLength = length(tangent);
            const aligned = speed
              .greaterThan(1e-6)
              .select(abs(dot(tangent, deltaV)).div(max(tangentLength.mul(speed), EPSILON)), 0);
            const diameter = mix(float(strandThickness), tangentLength, aligned);
            const area = diameter.mul(strandThickness);
            const coeff = float(3 * Math.PI * AIR_VISCOSITY * airDrag)
              .mul(diameter)
              .add(
                float(0.5 * AIR_DENSITY * airDrag)
                  .mul(area)
                  .mul(speed),
              );
            const accel = vec3(gravity.x, gravity.y, gravity.z).sub(
              deltaV.mul(coeff.div(segment.mul(nodeMass))),
            );
            earlier.assign(pNow);
            shared.element(local).assign(pNow.add(disp).add(accel.mul(h * h)));
          });
        });
        workgroupBarrier();

        countLoop("k", iterations, () => {
          // Stretch/length constraint ([Bender15] 5.1), even segments then odd: a colour's segments share no
          // point, so each applies its whole correction in place.
          for (const colour of [evenSegment, oddSegment]) {
            If(colour, () => {
              const p0 = shared.element(local).toVar();
              const p1 = shared.element(local.add(1)).toVar();
              const t = p1.sub(p0);
              const correction = float(1).sub(segmentAfter.div(max(length(t), EPSILON)));
              const delta = t.mul(correction.mul(lengthK).div(rootShare.add(1 + EPSILON)));
              shared.element(local).assign(p0.add(delta.mul(rootShare)));
              shared.element(local.add(1)).assign(p1.sub(delta));
            });
            workgroupBarrier();
          }
          // Local shape (triangle bending toward the rest curvature) reads the triangle a = i, then the
          // gather below applies each triangle's three corrections. The parent's position is read now for
          // the tangent match, before any point moves.
          const parent = vec3(0).toVar();
          If(hasParent, () => {
            parent.assign(shared.element(local.sub(1)));
          });
          shape.element(local).assign(vec3(0));
          If(hasShape, () => {
            const r0 = targets.element(local);
            const r1 = targets.element(local.add(1));
            const r2 = targets.element(local.add(2));
            const h0 = length(r0.add(r1).add(r2).div(3).sub(r1));
            const p0 = shared.element(local);
            const p1 = shared.element(local.add(1));
            const p2 = shared.element(local.add(2));
            const hVec = p1.sub(p0.add(p1).add(p2).div(3)).toVar();
            shape
              .element(local)
              .assign(hVec.mul(float(1).sub(h0.div(max(length(hVec), EPSILON)))).mul(localStep));
          });
          workgroupBarrier();
          If(hasParent, () => {
            const p = shared.element(local).toVar();
            p.addAssign(targets.element(local).sub(p).mul(pull));
            p.addAssign(shape.element(local).mul(2 / 3));
            p.addAssign(shape.element(local.sub(1)).mul(middleShare));
            p.addAssign(shape.element(lastCorner).mul(lastShare));
            // The last points match the rest tangent.
            If(isTail, () => {
              const tangentRest = targets.element(local).sub(targets.element(local.sub(1)));
              p.addAssign(parent.add(tangentRest).sub(p).mul(localStep));
            });
            // Collisions (upstream sphere, as capsules), root skipped. A projection, as Unreal's groom static
            // collision (UE 5.8.3: Engine/Plugins/Runtime/HairStrands/Shaders/Private/
            // NiagaraStaticCollisionConstraint.ush:16-20 takes the full penetration when IsProjection).
            for (let c = 0; c < colliders.length; c++) {
              const aRow = mix(capsuleRows.element(c * 4), capsuleRows.element(c * 4 + 2), at);
              const b = mix(capsuleRows.element(c * 4 + 1), capsuleRows.element(c * 4 + 3), at).xyz;
              const ab = b.sub(aRow.xyz);
              const s = saturate(dot(p.sub(aRow.xyz), ab).div(max(dot(ab, ab), EPSILON)));
              const v = p.sub(aRow.xyz.add(ab.mul(s))).toVar();
              const inside = aRow.w.add(colliderThickness).sub(length(v));
              If(inside.greaterThan(0), () => {
                p.addAssign(normalize(v).mul(inside.mul(collisionK)));
              });
            }
            shared.element(local).assign(p);
          });
          workgroupBarrier();
        });
        // Unreal's stretch projection after the solve (UE 5.8.3: Engine/Plugins/Runtime/HairStrands/
        // Shaders/Private/NiagaraHookeSpringMaterial.ush:28-53,93-118): root to tip, only the child
        // moves, so every segment leaves the substep at its rest length. The root's thread walks the chain.
        If(live.and(isRoot), () => {
          countLoop(
            "j",
            n - 1,
            (j) => {
              const index = local.add(j);
              const parentPoint = shared.element(index);
              const edge = shared.element(index.add(1)).sub(parentPoint);
              shared
                .element(index.add(1))
                .assign(
                  parentPoint.add(edge.mul(lengths.element(index).div(max(length(edge), EPSILON)))),
                );
            },
            "int",
          );
        });
        workgroupBarrier();
      });
      If(live, () => {
        now.element(gid).assign(shared.element(local));
        prev.element(gid).assign(earlier);
      });
    })().compute(groups * groupSize, [groupSize]);
    step.setName("hair.strands.step");
    this.#step = step;

    const reset = Fn(() => {
      const index = int(instanceIndex);
      const p = target(vec4(restBuffer.element(index).xyz, 1), float(1));
      prev.element(index).assign(p);
      now.element(index).assign(p);
    })().compute(pointCount);
    reset.setName("hair.strands.reset");
    this.#reset = reset;
    this.warmupNodes = [step, reset];

    const every = options.readbackEveryFrames ?? 0;
    if (!Number.isInteger(every) || every < 0)
      throw new Error("HairStrands3D.readbackEveryFrames must be a non-negative integer.");
    this.#readback =
      every > 0
        ? new GPUReadback({
            attribute: now.value,
            everyFrames: every,
            maxInFlight: options.readbackInFlight ?? 1,
          })
        : undefined;
    this.addEventListener("removed", this.#onRemoved);
  }

  /** The last landed world positions (packed xyz) and their age, when `readbackEveryFrames` is on. */
  get sample(): IGPUReadbackSample | undefined {
    const sample = this.#readback?.sample;
    if (sample === undefined) return undefined;
    return {
      data: compactClothVec3Readback(sample.data, this.restLengths.length),
      staleFrames: sample.staleFrames,
    };
  }

  /**
   * Every landed world position sample since the last call, oldest first, for a probe that must
   * see each step. Empty without `readbackEveryFrames`.
   */
  takeSamples(): IGPUReadbackSample[] {
    const samples = this.#readback?.take();
    if (samples === undefined) return [];
    return samples.map((sample) => ({
      data: compactClothVec3Readback(sample.data, this.restLengths.length),
      staleFrames: sample.staleFrames,
    }));
  }

  get released(): boolean {
    return this.#released;
  }

  /** Snap the strands to the rest shape on the bone's current pose at the next step. */
  reset(): void {
    this.#started = false;
  }

  debug(): Record<string, number | boolean> {
    return {
      strands: this.strandCount,
      strandsPerGroup: this.strandsPerGroup,
      workgroupSize: this.workgroupSize,
      pointsPerStrand: this.pointsPerStrand,
      substeps: this.#substeps,
      iterations: this.#iterations,
      colliders: this.#colliders.length,
      steps: this.#steps,
      resets: this.#resets,
      windFromScene: this.#windFromScene,
    };
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("HairStrands3D cannot be attached after release.");
    if (renderer.kind !== "webgpu") throw new Error("HairStrands3D requires the WebGPU renderer.");
    this.#renderer = renderer;
  }

  process(renderer = this.#renderer): void {
    if (this.#released) return;
    if (renderer === undefined) throw new Error("HairStrands3D is not attached to a renderer.");
    if (this.parent !== null && (this.parent as { isScene?: boolean }).isScene !== true)
      throw new Error("HairStrands3D simulates in world space; add it to the scene root.");
    this.#bone.updateWorldMatrix(true, false);
    const frames = this.#frames;
    frames.prev.copy(frames.now);
    frames.now.copy(this.#bone.matrixWorld);
    const moved = Math.hypot(
      (frames.now.elements[12] as number) - (frames.prev.elements[12] as number),
      (frames.now.elements[13] as number) - (frames.prev.elements[13] as number),
      (frames.now.elements[14] as number) - (frames.prev.elements[14] as number),
    );
    const capsules = this.#capsuleRows.array as Vector4[];
    const a = new Vector3();
    const b = new Vector3();
    this.#colliders.forEach((capsule, c) => {
      capsule.bone.updateWorldMatrix(true, false);
      a.copy(capsule.start ?? new Vector3()).applyMatrix4(capsule.bone.matrixWorld);
      b.copy(capsule.end).applyMatrix4(capsule.bone.matrixWorld);
      (capsules[c * 4] as Vector4).copy(capsules[c * 4 + 2] as Vector4);
      (capsules[c * 4 + 1] as Vector4).copy(capsules[c * 4 + 3] as Vector4);
      (capsules[c * 4 + 2] as Vector4).set(a.x, a.y, a.z, capsule.radius);
      (capsules[c * 4 + 3] as Vector4).set(b.x, b.y, b.z, 0);
      if (!this.#started) {
        (capsules[c * 4] as Vector4).copy(capsules[c * 4 + 2] as Vector4);
        (capsules[c * 4 + 1] as Vector4).copy(capsules[c * 4 + 3] as Vector4);
      }
    });
    if (this.#windFromScene) windAt(this.parent, this.wind);
    this.#windUniform.value.copy(this.wind);
    this.#frameUniforms.prev.value.copy(frames.prev);
    this.#frameUniforms.now.value.copy(frames.now);
    if (!this.#started || moved > this.#teleport) {
      // Unreal's teleport rule: past the distance, the groom restarts from its rest pose.
      this.#frameUniforms.prev.value.copy(frames.now);
      renderer.compute(this.#reset);
      this.#resets += 1;
      this.#started = true;
    }
    renderer.compute(this.#step);
    this.#steps += 1;
    this.#readback?.request(renderer);
  }

  detach(): void {
    if (this.#released) return;
    this.removeEventListener("removed", this.#onRemoved);
    this.#renderer = undefined;
    for (const node of this.warmupNodes) node.dispose();
    this.#readback?.dispose();
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();
}
