import {
  type AnimationAction,
  type AnimationClip,
  LoopOnce,
  LoopRepeat,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { animationFinite } from "./animation-blend.js";
import { type IAnimationLayer, prepareAnimationLayers } from "./animation-layers.js";
import {
  AnimationRootMotion,
  type IAnimationMotionDelta,
  type IAnimationRootMotionOptions,
} from "./animation-root-motion.js";
import { AnimationPlayer } from "./animation.js";

export interface IAnimationComposerOptions {
  readonly root: Object3D;
  /**
   * Copied into owned pose snapshots at construction. Constant stock quaternion tracks use
   * equivalent discrete sampling there; reauthor source keys before constructing a new composer.
   */
  readonly clips: readonly AnimationClip[];
  readonly samples: readonly string[];
  readonly layers?: readonly IAnimationLayer[];
  readonly rootMotion?: IAnimationRootMotionOptions;
}

interface IComposerAction {
  readonly action: AnimationAction;
  readonly masked: boolean;
}

interface IComposerSample {
  readonly duration: number;
  readonly actions: readonly IComposerAction[];
}

interface IComposerLayer {
  readonly options: IAnimationLayer;
  readonly action: AnimationAction;
  weight: number;
}

/**
 * One bounded Three player/mixer. Game-owned intent supplies normalized sample weights;
 * every base action samples one normalized phase, while layered events retain authored time.
 */
export class AnimationComposer {
  readonly #player: AnimationPlayer;
  #samples: readonly IComposerSample[];
  #layers: readonly IComposerLayer[];
  #weights: Float64Array;
  #targets: Float64Array;
  #starts: Float64Array;
  #rootMotion: AnimationRootMotion | undefined;
  readonly #before = new Vector3();
  readonly #beforeRotation = new Quaternion();
  readonly #accepted = new Vector3();
  readonly #expectedRotation = new Quaternion();
  readonly #observedRotation = new Quaternion();
  readonly #up = new Vector3(0, 1, 0);
  readonly #proposal = { translation: new Vector3(), yaw: 0 };
  #acceptedYaw = 0;
  #pending = false;
  #tickDt = 0;
  #clock = 0;
  #speed = 1;
  #duration = 0;
  #elapsed = 0;
  #disposed = false;
  #clipBuffers = 0;
  #clipBufferBytes = 0;
  paused = false;

  constructor(options: IAnimationComposerOptions) {
    const sources = options.samples.map((name) => {
      const source = options.clips.find((clip) => clip.name === name);
      if (source === undefined) throw new Error(`AnimationComposer: missing clip '${name}'.`);
      return source;
    });
    this.#rootMotion =
      options.rootMotion === undefined
        ? undefined
        : new AnimationRootMotion(options.root, sources, options.rootMotion);
    const prepared = prepareAnimationLayers(
      options.root,
      options.clips,
      options.samples,
      options.layers ?? [],
      this.#rootMotion?.node,
    );
    const buffers = new Set<ArrayBufferView>();
    for (const clip of prepared.clips)
      for (const track of clip.tracks) {
        if (ArrayBuffer.isView(track.times)) buffers.add(track.times);
        if (ArrayBuffer.isView(track.values)) buffers.add(track.values);
      }
    this.#clipBuffers = buffers.size;
    for (const values of buffers) this.#clipBufferBytes += values.byteLength;
    this.#player = new AnimationPlayer({
      root: options.root,
      clips: prepared.clips,
      strideSync: false,
    });
    this.#samples = prepared.samples.map((sample) => ({
      duration: sample.duration,
      actions: sample.clips.map((clip) => ({
        action: this.mixer.clipAction(clip).setEffectiveTimeScale(0).setEffectiveWeight(0).play(),
        masked: clip.name.endsWith(":masked"),
      })),
    }));
    this.#layers = prepared.layers.map((layer) => ({
      options: layer.options,
      action: this.mixer.clipAction(layer.clip),
      weight: 0,
    }));
    this.#weights = new Float64Array(options.samples.length);
    this.#targets = new Float64Array(options.samples.length);
    this.#starts = new Float64Array(options.samples.length);
    this.#weights[0] = 1;
    this.#targets[0] = 1;
  }

  get mixer() {
    return this.#player.mixer;
  }
  get root() {
    return this.#player.root;
  }
  get phase(): number {
    return this.#clock % 1;
  }
  get speed(): number {
    return this.#speed;
  }
  set speed(value: number) {
    if (animationFinite(value, "speed") < 0)
      throw new Error("AnimationComposer: speed must be nonnegative.");
    this.#speed = value;
  }
  get weights(): readonly number[] {
    return Array.from(this.#weights);
  }
  get sampleTimes(): readonly number[] {
    return this.#samples.map((sample) => (sample.actions[0] as IComposerAction).action.time);
  }
  get resources() {
    return {
      actions: this.mixer.stats.actions.total,
      bindings: this.mixer.stats.bindings.total,
      scratchBytes: this.#weights.byteLength + this.#targets.byteLength + this.#starts.byteLength,
      clipBuffers: this.#clipBuffers,
      clipBufferBytes: this.#clipBufferBytes,
      rootBuffers: this.#rootMotion?.buffers ?? 0,
      rootBufferBytes: this.#rootMotion?.bufferBytes ?? 0,
    };
  }
  /** Snapshots remain honest while blocked: phase advances at authored speed, never re-timed by the wall. */
  get motion() {
    return {
      authority: this.#rootMotion === undefined ? "phase" : "rootMotion",
      requested: this.#proposal.translation.clone(),
      requestedYaw: this.#proposal.yaw,
      accepted: this.#accepted.clone(),
      acceptedYaw: this.#acceptedYaw,
      blocked: this.blocked,
    } as const;
  }

  get blocked(): boolean {
    return (
      this.#proposal.translation.distanceToSquared(this.#accepted) > 1e-10 ||
      Math.abs(this.#proposal.yaw - this.#acceptedYaw) > 1e-5
    );
  }

  setWeights(weights: ArrayLike<number>, transition = 0): void {
    this.#live();
    if (weights.length !== this.#weights.length)
      throw new Error("AnimationComposer: weight count differs from samples.");
    if (animationFinite(transition, "transition") < 0)
      throw new Error("AnimationComposer: transition must be nonnegative.");
    let sum = 0;
    for (let i = 0; i < weights.length; i += 1) {
      const weight = animationFinite(weights[i] as number, `weight[${i}]`);
      if (weight < 0) throw new Error("AnimationComposer: weights must be nonnegative.");
      sum += weight;
    }
    if (!(sum > 0) || !Number.isFinite(sum))
      throw new Error("AnimationComposer: weights must have a finite positive sum.");
    let same = transition === this.#duration;
    for (let i = 0; i < weights.length; i += 1)
      if (this.#targets[i] !== (weights[i] as number) / sum) same = false;
    if (same) return;
    this.#starts.set(this.#weights);
    for (let i = 0; i < weights.length; i += 1) this.#targets[i] = (weights[i] as number) / sum;
    this.#duration = transition;
    this.#elapsed = 0;
    if (transition === 0) this.#weights.set(this.#targets);
  }

  setLayerWeight(name: string, weight: number): void {
    this.#live();
    if (animationFinite(weight, `'${name}' weight`) < 0 || weight > 1)
      throw new Error(`AnimationComposer: '${name}' weight must be in [0,1].`);
    const layer = this.#layers.find((layer) => layer.options.name === name);
    if (layer === undefined) throw new Error(`AnimationComposer: unknown layer '${name}'.`);
    if (weight > 0 && layer.weight === 0) {
      layer.action
        .reset()
        .setLoop(
          layer.options.once === true ? LoopOnce : LoopRepeat,
          layer.options.once === true ? 1 : Number.POSITIVE_INFINITY,
        )
        .play();
      layer.action.clampWhenFinished = layer.options.once === true;
    }
    layer.weight = weight;
    layer.action.setEffectiveWeight(weight);
    if (weight === 0) layer.action.stop();
  }

  /** Explicit replay; repeated weight requests do not re-fire a completed one-shot. */
  restartLayer(name: string): void {
    this.#live();
    const layer = this.#layers.find((layer) => layer.options.name === name);
    if (layer === undefined) throw new Error(`AnimationComposer: unknown layer '${name}'.`);
    layer.action.reset().setEffectiveWeight(layer.weight);
    if (layer.weight > 0) layer.action.play();
  }

  update(dt: number): void {
    if (this.#rootMotion !== undefined)
      throw new Error(
        "AnimationComposer: root motion requires advance, Rapier movement, then finish with accepted motion.",
      );
    this.advance(dt);
    this.finish();
  }

  /** Borrowed proposal: queue it once with CharacterBody3D.move, then finish after physics. */
  advance(dt: number): { readonly translation: Vector3; readonly yaw: number } {
    this.#live();
    if (this.#pending)
      throw new Error("AnimationComposer: finish the previous fixed tick before advance.");
    if (animationFinite(dt, "dt") < 0)
      throw new Error("AnimationComposer: dt must be nonnegative.");
    this.#rootMotion?.validateSpace();
    if (this.#rootMotion !== undefined) {
      const position = this.#rootMotion.body.position;
      this.#before.set(
        animationFinite(position.x, "body.x"),
        animationFinite(position.y, "body.y"),
        animationFinite(position.z, "body.z"),
      );
    }
    const elapsed = this.paused ? 0 : dt;
    this.#elapsed = Math.min(this.#duration, this.#elapsed + elapsed);
    const progress = this.#duration > 0 ? this.#elapsed / this.#duration : 1;
    let frequency = 0;
    for (let i = 0; i < this.#samples.length; i += 1) {
      this.#weights[i] =
        (this.#starts[i] as number) +
        ((this.#targets[i] as number) - (this.#starts[i] as number)) * progress;
      frequency += (this.#weights[i] as number) / (this.#samples[i] as IComposerSample).duration;
    }
    const previous = this.#clock;
    this.#clock = animationFinite(this.#clock + elapsed * this.#speed * frequency, "phase clock");
    const rounded = Math.round(this.#clock);
    if (Math.abs(this.#clock - rounded) < 1e-12) this.#clock = rounded;
    this.#proposal.translation.set(0, 0, 0);
    this.#proposal.yaw = 0;
    if (this.#rootMotion !== undefined) {
      this.#beforeRotation.copy(this.#rootMotion.body.quaternion);
      const proposal = this.#rootMotion.sample(previous, this.#clock, this.#weights);
      this.#proposal.translation.copy(proposal.translation);
      this.#proposal.yaw = proposal.yaw;
    }
    this.#pending = true;
    this.#tickDt = elapsed;
    return this.#proposal;
  }

  /** Final authored pose precedes the game's existing IK. This method never writes the body. */
  finish(accepted?: IAnimationMotionDelta): void {
    this.#live();
    if (!this.#pending) throw new Error("AnimationComposer: advance must precede finish.");
    if (this.#rootMotion !== undefined) {
      if (accepted === undefined)
        throw new Error("AnimationComposer: finish requires accepted Rapier motion.");
      const body = this.#rootMotion.body;
      this.#accepted.set(
        animationFinite(accepted.translation.x, "accepted.x"),
        animationFinite(accepted.translation.y, "accepted.y"),
        animationFinite(accepted.translation.z, "accepted.z"),
      );
      this.#expectedRotation
        .setFromAxisAngle(this.#up, animationFinite(accepted.yaw, "accepted.yaw"))
        .premultiply(this.#beforeRotation)
        .normalize();
      const norm = body.quaternion.lengthSq();
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-5)
        throw new Error(
          "AnimationComposer: observed character body quaternion must be normalized.",
        );
      // Float32 physics round-off is a scale of a quaternion, not a different rotation.
      this.#observedRotation.copy(body.quaternion).normalize();
      if (
        Math.abs(
          animationFinite(body.position.x, "observed body.x") - this.#before.x - this.#accepted.x,
        ) > 1e-5 ||
        Math.abs(
          animationFinite(body.position.y, "observed body.y") - this.#before.y - this.#accepted.y,
        ) > 1e-5 ||
        Math.abs(
          animationFinite(body.position.z, "observed body.z") - this.#before.z - this.#accepted.z,
        ) > 1e-5 ||
        this.#expectedRotation.angleTo(this.#observedRotation) > 1e-5
      )
        throw new Error(
          "AnimationComposer: accepted motion differs from the observed character body.",
        );
      this.#acceptedYaw = accepted.yaw;
    } else {
      this.#accepted.set(0, 0, 0);
      this.#acceptedYaw = 0;
    }
    const overrideWeight =
      this.#layers.find((layer) => layer.options.mode === "override")?.weight ?? 0;
    for (let i = 0; i < this.#samples.length; i += 1) {
      const sample = this.#samples[i] as IComposerSample;
      for (const { action, masked } of sample.actions) {
        action.time = this.phase * sample.duration;
        action.setEffectiveWeight((this.#weights[i] as number) * (masked ? 1 - overrideWeight : 1));
      }
    }
    this.mixer.update(this.#tickDt);
    this.#pending = false;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#player.dispose();
    this.#rootMotion?.dispose();
    this.#rootMotion = undefined;
    this.#samples = [];
    this.#layers = [];
    this.#weights = new Float64Array(0);
    this.#targets = new Float64Array(0);
    this.#starts = new Float64Array(0);
    this.#clipBuffers = 0;
    this.#clipBufferBytes = 0;
  }

  #live(): void {
    if (this.#disposed) throw new Error("AnimationComposer cannot be used after dispose.");
  }
}
