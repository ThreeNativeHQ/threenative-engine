/*!
 * Selectively adapted from GGEZ packages/anim-core/src/root-motion.ts
 * (translation difference, quaternion yaw) at
 * 45ed541cb163ef98694467758f60d5533373ac60. Adds explicit root binding,
 * continuous loop intervals, yaw unwrapping and validated Three transforms.
 * MIT License
 * Copyright (c) 2026 @alightinastorm (x.com/alightinastorm)
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  type AnimationClip,
  type Bone,
  type Interpolant,
  InterpolateLinear,
  type KeyframeTrack,
  Matrix4,
  NumberKeyframeTrack,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { animationFinite } from "./animation-blend.js";
import { canonicalAnimationClip } from "./animation-layers.js";
import { uniformYawScale } from "./rig-preparation.js";

export interface IAnimationRootMotionOptions {
  readonly bone: string;
  /** Existing character-body object. Its parent must be identity in this first slice. */
  readonly body: Object3D;
}

export interface IAnimationMotionDelta {
  readonly translation: Pick<Vector3, "x" | "y" | "z">;
  readonly yaw: number;
}

interface IRootSample {
  readonly duration: number;
  readonly position: Interpolant | undefined;
  readonly yaw: Interpolant | undefined;
  readonly cycle: Vector3;
  readonly cycleYaw: number;
  readonly start: Vector3;
  readonly startYaw: number;
}

interface ITrackInterpolant extends KeyframeTrack {
  createInterpolant(result: Float32Array): Interpolant;
}

function interpolant(track: KeyframeTrack, width: number): Interpolant {
  if (track.getInterpolation() !== InterpolateLinear)
    throw new Error(`AnimationComposer: root track '${track.name}' requires linear interpolation.`);
  return (track as ITrackInterpolant).createInterpolant(new Float32Array(width));
}

function wrappedYaw(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function rotateYaw(vector: Vector3, angle: number): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = vector.x;
  vector.x = c * x + s * vector.z;
  vector.z = -s * x + c * vector.z;
  return vector;
}

export function animationYaw(q: Quaternion): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

/** Borrowed output and interpolants are allocated once, then sampled over the fixed interval. */
export class AnimationRootMotion {
  readonly node: Object3D;
  readonly body: Object3D;
  readonly proposal = { translation: new Vector3(), yaw: 0 };
  #samples: readonly IRootSample[];
  readonly #rotation = new Quaternion();
  readonly #identity = new Matrix4();
  readonly #local = new Vector3();
  readonly #first = new Vector3();
  readonly #last = new Vector3();
  readonly #cycle = new Vector3();
  #bufferBytes = 0;
  #buffers = 0;

  constructor(
    root: Object3D,
    sources: readonly AnimationClip[],
    options: IAnimationRootMotionOptions,
  ) {
    if (root === options.body)
      throw new Error("AnimationComposer: use a separate rig root below the character body.");
    const matches: Object3D[] = [];
    root.traverse((node) => {
      if (node.name === options.bone) matches.push(node);
    });
    if (matches.length !== 1)
      throw new Error(
        `AnimationComposer: root-motion bone '${options.bone}' is missing or ambiguous.`,
      );
    this.node = matches[0] as Object3D;
    this.body = options.body;
    if ((this.node.parent as Bone | null)?.isBone === true)
      throw new Error(
        "AnimationComposer: root-motion bone must be the skeleton root, with no animated bone ancestor.",
      );
    let ancestor: Object3D | null = root.parent;
    while (ancestor !== null && ancestor !== this.body) ancestor = ancestor.parent;
    if (ancestor === null)
      throw new Error(
        "AnimationComposer: rig root must be a strict descendant of the character body.",
      );
    const ancestors = new Set<string>();
    for (let node = this.node.parent; node !== null; node = node.parent) ancestors.add(node.uuid);
    this.validateSpace();
    this.#samples = sources.map((source) => {
      const clip = canonicalAnimationClip(root, source);
      if (
        clip.tracks.some((track) => ancestors.has(track.name.slice(0, track.name.lastIndexOf("."))))
      )
        throw new Error(
          "AnimationComposer: root-motion ancestors and character body must not have animation tracks.",
        );
      const translation = clip.tracks.find((track) => track.name === `${this.node.uuid}.position`);
      const rotation = clip.tracks.find((track) => track.name === `${this.node.uuid}.quaternion`);
      if (translation === undefined && rotation === undefined)
        throw new Error(
          `AnimationComposer: '${clip.name}' has no named root-motion track for '${options.bone}'.`,
        );
      const position = translation === undefined ? undefined : interpolant(translation, 3);
      let yaw: Interpolant | undefined;
      if (rotation !== undefined) {
        if (rotation.getInterpolation() !== InterpolateLinear)
          throw new Error(
            `AnimationComposer: root track '${rotation.name}' requires linear interpolation.`,
          );
        const values: number[] = [];
        let previous = 0;
        for (let i = 0; i < rotation.values.length; i += 4) {
          this.#rotation.fromArray(rotation.values, i);
          if (Math.abs(this.#rotation.x) + Math.abs(this.#rotation.z) > 1e-5)
            throw new Error(
              `AnimationComposer: '${rotation.name}' root rotation must be yaw-only.`,
            );
          const angle = animationYaw(this.#rotation);
          previous = values.length === 0 ? angle : previous + wrappedYaw(angle - previous);
          values.push(previous);
        }
        yaw = interpolant(new NumberKeyframeTrack(rotation.name, rotation.times, values), 1);
      }
      const cycle = new Vector3();
      const start = new Vector3();
      if (position !== undefined) {
        start.fromArray(position.evaluate(0));
        cycle.fromArray(position.evaluate(clip.duration)).sub(start);
      }
      const startYaw = yaw?.evaluate(0)[0] ?? 0;
      const cycleYaw = (yaw?.evaluate(clip.duration)[0] ?? 0) - startYaw;
      return { duration: clip.duration, position, yaw, cycle, cycleYaw, start, startYaw };
    });
    const buffers = new Set<ArrayBufferView>();
    for (const sample of this.#samples)
      for (const item of [sample.position, sample.yaw]) {
        if (item === undefined) continue;
        for (const values of [item.parameterPositions, item.sampleValues, item.resultBuffer]) {
          if (ArrayBuffer.isView(values)) buffers.add(values);
        }
      }
    this.#buffers = buffers.size;
    for (const values of buffers) this.#bufferBytes += values.byteLength;
  }

  get buffers() {
    return this.#buffers;
  }
  get bufferBytes() {
    return this.#bufferBytes;
  }

  validateSpace(): void {
    if (this.body.parent !== null) {
      this.body.parent.updateWorldMatrix(true, false);
      if (!this.body.parent.matrixWorld.equals(this.#identity))
        throw new Error(
          "AnimationComposer: character-body parent must be identity; parent transforms are unsupported.",
        );
    }
    const parent = this.node.parent ?? this.node;
    parent.updateWorldMatrix(true, false);
    if (uniformYawScale(parent.matrixWorld) === undefined)
      throw new Error(
        "AnimationComposer: root motion requires positive uniform scale and yaw-only parents; nonuniform/tilted/mirrored transforms are unsupported.",
      );
  }

  sample(previous: number, next: number, weights: ArrayLike<number>): typeof this.proposal {
    if (previous < 0 || next < previous || !Number.isSafeInteger(Math.floor(next)))
      throw new Error(
        "AnimationComposer: root phase interval exceeds the supported finite clock range.",
      );
    this.proposal.translation.set(0, 0, 0);
    this.proposal.yaw = 0;
    const loops = Math.floor(next) - Math.floor(previous);
    const firstYaw = this.#pose(previous % 1, weights, this.#first);
    const lastYaw = this.#pose(next % 1, weights, this.#last);
    this.#cycle.set(0, 0, 0);
    let cycleYaw = 0;
    for (let i = 0; i < this.#samples.length; i += 1) {
      const weight = weights[i] as number;
      if (weight === 0) continue;
      const sample = this.#samples[i] as IRootSample;
      this.#cycle.addScaledVector(sample.cycle, weight);
      cycleYaw += weight * sample.cycleYaw;
    }
    if (loops === 0) {
      rotateYaw(this.proposal.translation.copy(this.#last).sub(this.#first), -firstYaw);
    } else {
      rotateYaw(this.proposal.translation.copy(this.#cycle).sub(this.#first), -firstYaw);
      const full = loops - 1;
      const turn = wrappedYaw(cycleYaw);
      const denominator = Math.sin(turn / 2);
      const factor = denominator === 0 ? full : Math.sin((full * turn) / 2) / denominator;
      this.#local.copy(this.#cycle);
      this.#local.x *= factor;
      this.#local.z *= factor;
      this.#local.y *= full;
      rotateYaw(this.#local, cycleYaw - firstYaw + ((full - 1) * turn) / 2);
      this.proposal.translation.add(this.#local);
      rotateYaw(this.#last, loops * cycleYaw - firstYaw);
      this.proposal.translation.add(this.#last);
    }
    this.proposal.yaw = lastYaw - firstYaw + loops * cycleYaw;
    const parent = this.node.parent ?? this.node;
    parent.getWorldQuaternion(this.#rotation);
    const scale = uniformYawScale(parent.matrixWorld) as number;
    this.proposal.translation.multiplyScalar(scale).applyQuaternion(this.#rotation);
    animationFinite(this.proposal.translation.x, "root delta.x");
    animationFinite(this.proposal.translation.y, "root delta.y");
    animationFinite(this.proposal.translation.z, "root delta.z");
    animationFinite(this.proposal.yaw, "root delta.yaw");
    return this.proposal;
  }

  #pose(phase: number, weights: ArrayLike<number>, position: Vector3): number {
    position.set(0, 0, 0);
    let yaw = 0;
    for (let i = 0; i < this.#samples.length; i += 1) {
      const weight = weights[i] as number;
      if (weight === 0) continue;
      const sample = this.#samples[i] as IRootSample;
      const time = phase * sample.duration;
      if (sample.position !== undefined) {
        this.#local.fromArray(sample.position.evaluate(time)).sub(sample.start);
        position.addScaledVector(this.#local, weight);
      }
      yaw += weight * ((sample.yaw?.evaluate(time)[0] ?? 0) - sample.startYaw);
    }
    return yaw;
  }

  dispose(): void {
    this.#samples = [];
    this.#buffers = 0;
    this.#bufferBytes = 0;
  }
}
