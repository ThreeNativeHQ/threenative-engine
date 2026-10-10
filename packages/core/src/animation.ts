import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type Object3D,
  Vector3,
  type VectorKeyframeTrack,
} from "three";
import { clipTrackBindings } from "./clip-audit.js";
import { type ISharedStride, type RigPreparation, uniformYawScale } from "./rig-preparation.js";

export interface IAnimationPlayerOptions {
  readonly clips: readonly AnimationClip[];
  readonly root: Object3D;
  readonly requiredClips?: readonly string[] | Readonly<Record<string, string>>;
  /**
   * Shared preparation for clones of one source rig. Set by `SkeletalMesh3D`; a standalone
   * player leaves it undefined and keeps the per-instance binding audit and stride sample.
   */
  readonly preparation?: RigPreparation;
  /**
   * Match a travelling clip's playback rate to the ground the body actually covers.
   *
   * On by default, because a model whose feet do not agree with its motion is the single most
   * common thing wrong with a character in a game built here, and every game solves it the same
   * way. Set `false` to keep the authored rate; the measurement below stays live either way and
   * says that it was overridden. The convention re-times locomotion only: a `"once"` clip — a
   * death, a flinch — always plays at its authored rate.
   */
  readonly strideSync?: boolean;
  /**
   * The object whose travel counts as ground covered. Defaults to `root`.
   *
   * Name the body a game moves when the rig is a child of it, which is the usual shape: the clip
   * writes the model's own root track, so measuring the same object the mixer writes would read
   * the clip's motion back as if it were the body's.
   */
  readonly strideRoot?: Object3D;
}

/**
 * What the feet are doing against what the body is doing.
 *
 * Reported whether or not the convention is applied: turning a convention off must not turn its
 * measurement off, or a game that opted out has no way to know what it cost.
 */
export interface IStrideReport {
  /** Metres of ground the current clip carries per clip-second, at rate 1. Zero if it travels none. */
  readonly clipGroundSpeed: number;
  /** Metres per second the root has actually covered, smoothed over the last update. */
  readonly groundSpeed: number;
  /** The playback rate those two imply, clamped to `limits`. */
  readonly rate: number;
  /** True when that rate is being applied to the action. */
  readonly synced: boolean;
  /** True when a rate was measured and deliberately not applied. */
  readonly overridden: boolean;
  /**
   * True when the clip carries no root motion and its stride was read off the feet instead.
   *
   * `synced: false, overridden: false` is what an idle reports, so without this a game whose walk
   * cycle is silently going unmatched cannot tell itself apart from one with nothing to match. An
   * in-place clip that also yields no foot plant reports `inPlace: true` with a zero
   * `clipGroundSpeed`, which names the asset as the thing to fix.
   */
  readonly inPlace: boolean;
}

/**
 * The band a measured rate is held inside.
 *
 * A rig with one walk cycle cannot honestly represent a sprint or a crawl. Above the ceiling the
 * clip reads as a cartoon; at zero it freezes mid-stride while the body drifts, which is worse
 * than a slow cycle. Both ends are a property of the clip set, so both are the game's to move.
 */
const STRIDE_RATE_MIN = 0.15;
const STRIDE_RATE_MAX = 3;
/** Below this the body is standing, and a measured rate would be noise. */
const STRIDE_SPEED_FLOOR = 1e-4;
/** A clip carrying less ground than this per second is not locomotion. */
const CLIP_GROUND_FLOOR = 1e-3;
/** Poses taken across one cycle when reading an in-place clip's stride off its feet. */
const PLANT_SAMPLES = 64;
/** A contact bone is one that reaches this near the lowest point the rig visits. */
const CONTACT_BAND = 0.15;
/** Of a contact bone's own vertical arc, the bottom slice counts as planted. */
const PLANT_BAND = 0.3;

/** What one clip's own locomotion measured out at, cached per clip name. */
interface IClipStride {
  /** Metres of ground the clip carries per clip-second at rate 1. */
  readonly groundSpeed: number;
  /** True when no root track travelled and the number came from the feet — or from nothing. */
  readonly inPlace: boolean;
}

/**
 * The ground a clip's root track carries, per clip-second, in the track's own units.
 *
 * **Net** displacement, not distance walked. Summing every step's magnitude is what made a
 * swinging thigh outscore a still root: a limb that ends the cycle where it began has covered no
 * ground however far it waved, while a travelling root ends the cycle somewhere else — that is
 * what root motion *is*. Measured in `sandbox/wildwood`: `ANIM_DeerStag_Walk` scored 0.1287 under
 * the old sum (from `STAG_-R-Thigh`) and scores 0 under this one, which is the truth.
 */
function clipRootMotionSpeed(clip: AnimationClip): number {
  let best = 0;
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue;
    const values = (track as VectorKeyframeTrack).values;
    if (values.length < 6) continue;
    const dx = (values[values.length - 3] ?? 0) - (values[0] ?? 0);
    const dz = (values[values.length - 1] ?? 0) - (values[2] ?? 0);
    best = Math.max(best, Math.hypot(dx, dz) / clip.duration);
  }
  return best;
}

/**
 * The ground an in-place clip was authored for, read off the feet, in world metres per clip-second.
 *
 * A planted foot sweeps backward relative to the body at exactly the speed the body is meant to be
 * travelling — that is what "planted" means — so the stance phase of a cycle states the clip's
 * speed even though nothing in it translates. Contact bones are found by where they go rather than
 * by what they are called: whatever reaches the bottom of the rig's arc is a foot, in any rig and
 * any language. The median over stance frames rejects the toe-off and heel-strike ends of the
 * sweep, and the median over feet rejects a limb that never plants.
 *
 * The rig is driven and then restored to the transforms it arrived with, once per clip.
 */
function footPlantSpeed(root: Object3D, clip: AnimationClip): number {
  const objects: Object3D[] = [];
  root.traverse((object) => objects.push(object));
  const restore = objects.map((object) => ({
    object,
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
  }));

  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  const paths = objects.map(() => [] as { x: number; y: number; z: number }[]);
  const step = clip.duration / PLANT_SAMPLES;
  try {
    for (let frame = 0; frame <= PLANT_SAMPLES; frame += 1) {
      mixer.setTime(frame * step);
      root.updateMatrixWorld(true);
      for (let index = 0; index < objects.length; index += 1) {
        // The frame's updateMatrixWorld already holds every bone; getWorldPosition re-walks ancestors.
        scratchWorld.setFromMatrixPosition((objects[index] as Object3D).matrixWorld);
        (paths[index] as { x: number; y: number; z: number }[]).push({
          x: scratchWorld.x,
          y: scratchWorld.y,
          z: scratchWorld.z,
        });
      }
    }
  } finally {
    action.stop();
    mixer.uncacheClip(clip);
    for (const entry of restore) {
      entry.object.position.copy(entry.position);
      entry.object.quaternion.copy(entry.quaternion);
      entry.object.scale.copy(entry.scale);
    }
    root.updateMatrixWorld(true);
  }

  const rootPath = paths[0];
  if (rootPath === undefined) return 0;
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const path of paths)
    for (const point of path) {
      lowest = Math.min(lowest, point.y);
      highest = Math.max(highest, point.y);
    }
  const height = highest - lowest;
  if (!(height > 0)) return 0;

  const speeds: number[] = [];
  for (const path of paths) {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const point of path) {
      low = Math.min(low, point.y);
      high = Math.max(high, point.y);
    }
    // A contact bone visits the floor and lifts off it again. One that never descends is not a
    // foot, and one that never rises is a stationary prop rather than a cycling limb.
    if (low > lowest + height * CONTACT_BAND) continue;
    const arc = high - low;
    if (!(arc > height * CLIP_GROUND_FLOOR)) continue;
    const planted = low + arc * PLANT_BAND;
    const rates: number[] = [];
    for (let frame = 1; frame < path.length; frame += 1) {
      const previous = path[frame - 1] as { x: number; y: number; z: number };
      const current = path[frame] as { x: number; y: number; z: number };
      if (current.y > planted || previous.y > planted) continue;
      const anchor = rootPath[frame] as { x: number; y: number; z: number };
      const before = rootPath[frame - 1] as { x: number; y: number; z: number };
      const dx = current.x - anchor.x - (previous.x - before.x);
      const dz = current.z - anchor.z - (previous.z - before.z);
      rates.push(Math.hypot(dx, dz) / step);
    }
    if (rates.length < 4) continue;
    rates.sort((first, second) => first - second);
    speeds.push(rates[Math.floor(rates.length / 2)] as number);
  }
  if (speeds.length === 0) return 0;
  speeds.sort((first, second) => first - second);
  return speeds[Math.floor(speeds.length / 2)] as number;
}

export interface IAnimationPlayOptions {
  readonly fade?: number;
  /**
   * `"loop"` (default) repeats; `"once"` plays through and holds the last frame. A `"once"` clip
   * also keeps its authored rate — stride sync re-times locomotion, not events.
   */
  readonly mode?: "loop" | "once";
}

type AnimationMode = "loop" | "once";

export class AnimationPlayer {
  readonly mixer: AnimationMixer;
  readonly root: Object3D;
  #actions = new Map<string, AnimationAction>();
  #current: string | undefined;
  #mode: AnimationMode = "loop";
  #advancedFrames = 0;
  #finished = false;
  #fadeOut: { action: AnimationAction; from: number }[] = [];
  #fadeElapsed = 0;
  #fadeDuration = 0;
  #fadeInFrom = 0;
  #clips = new Map<string, AnimationClip>();
  #clipGroundSpeed = new Map<string, IClipStride>();
  /** Weights `playWeighted` is heading towards. Undefined whenever single-clip `play` owns the rig. */
  #blendTargets: Map<string, number> | undefined;
  #blendDuration = 0;
  #blendElapsed = 0;
  #blendStarts = new Map<string, number>();
  #preparation: RigPreparation | undefined;
  #strideSync: boolean;
  #strideRoot: Object3D;
  #lastRootPosition = new Vector3();
  #hasLastRootPosition = false;
  // The last update's numbers, kept as scalars so a frame that never reads `.stride` builds no
  // report. A read materializes a fresh snapshot, so a retained report never changes under it.
  #strideGroundSpeed = 0;
  #strideRate = 1;
  #strideSynced = false;
  #strideOverridden = false;
  #strideInPlace = false;
  readonly #onFinished = ({ action }: { action: AnimationAction }) => {
    if (action === this.#actions.get(this.#current ?? "")) this.#finished = true;
  };

  constructor(options: IAnimationPlayerOptions) {
    const owner = new.target.name || "AnimationPlayer";
    this.root = options.root;
    this.mixer = new AnimationMixer(options.root);
    this.#preparation = options.preparation;
    this.#strideSync = options.strideSync ?? true;
    this.#strideRoot = options.strideRoot ?? options.root;
    for (const clip of options.clips) {
      if (this.#actions.has(clip.name))
        // Two clip sources on one rig is the normal way to assemble a character's vocabulary, and
        // stock libraries all ship a bind pose under the same name. Failing closed is right — a
        // silently dropped clip is a pose bug nobody thinks to look for — but the message says
        // what to do about it, because every game that loads two `.glb` files hits this.
        throw new Error(
          `Duplicate animation clip '${clip.name}'. Two clip sources define it; keep one per name before constructing the player.`,
        );
      const action = this.mixer.clipAction(clip);
      if (action === null)
        throw new Error(`Animation clip '${clip.name}' could not create an action.`);
      this.#actions.set(clip.name, action);
      this.#clips.set(clip.name, clip);
    }
    for (const name of requiredClipNames(options.requiredClips)) {
      const clip = this.#clips.get(name);
      if (clip === undefined)
        throw new Error(
          `${owner}: missing required clip '${name}'. Available clips: ${options.clips.map((item) => `'${item.name}'`).join(", ") || "(none)"}.`,
        );
      let bound = this.#preparation?.boundCount(options.root, clip);
      if (bound === undefined) {
        bound = clipTrackBindings(options.root, clip).bound;
        this.#preparation?.rememberBound(options.root, clip, bound);
      }
      if (bound === 0)
        throw new Error(
          `${owner}: clip '${name}' binds 0 tracks to '${options.root.name || options.root.type}'.`,
        );
    }
    this.mixer.addEventListener("finished", this.#onFinished);
  }

  get current(): string | undefined {
    return this.#current;
  }

  get advancedFrames(): number {
    return this.#advancedFrames;
  }

  /** True when a `"once"` clip has reached its end and is holding. */
  get finished(): boolean {
    return this.#finished;
  }

  /**
   * What the feet are doing against what the body is doing, as of the last `update`.
   *
   * Live whether or not the convention is applied. A game that set `strideSync: false` reads
   * `overridden: true` here next to the rate it declined, which is the only way an override can
   * be honest about what it turned off.
   */
  get stride(): IStrideReport {
    const name = this.#current;
    const measured = name === undefined ? undefined : this.#measureOf(name);
    // A fresh snapshot each read: what the last update stored, with the clip's own ground speed
    // derived so it is answerable the moment it is played, before any frame has advanced.
    return {
      clipGroundSpeed: measured?.groundSpeed ?? 0,
      groundSpeed: this.#strideGroundSpeed,
      inPlace: measured?.inPlace ?? this.#strideInPlace,
      overridden: this.#strideOverridden,
      rate: this.#strideRate,
      synced: this.#strideSynced,
    };
  }

  /** The clip behind a name, for a game that wants the action or the raw `AnimationClip`. */
  clip(name: string): AnimationClip {
    const clip = this.#clips.get(name);
    if (clip === undefined) throw new Error(`Unknown animation clip '${name}'.`);
    return clip;
  }

  /**
   * How much ground a clip carries per clip-second, in the world's metres.
   *
   * Horizontal only: a jump's vertical arc is not stride. Measured once per clip and cached,
   * because it is a property of the asset and cannot change between frames.
   *
   * Root motion first, feet second. Most game locomotion is authored **in place** — every ActorX
   * and Unreal export, every Mixamo "in place" clip, every stock animal pack — and a convention
   * that only works on the travelling minority is a convention that does not work.
   */
  #measureOf(name: string): IClipStride {
    const cached = this.#clipGroundSpeed.get(name);
    if (cached !== undefined) return cached;
    const clip = this.#clips.get(name);
    let measured: IClipStride = { groundSpeed: 0, inPlace: true };
    if (clip !== undefined && clip.duration > 0) {
      const shared = this.#sharedStride(clip);
      if (shared !== undefined) {
        measured = {
          groundSpeed: shared.groundSpeed * this.#trackScale(),
          inPlace: shared.inPlace,
        };
      } else {
        const rootMotion = clipRootMotionSpeed(clip);
        measured =
          rootMotion >= CLIP_GROUND_FLOOR
            ? { groundSpeed: rootMotion * this.#trackScale(), inPlace: false }
            : {
                groundSpeed: footPlantSpeed(this.mixer.getRoot() as Object3D, clip),
                inPlace: true,
              };
        this.#rememberSharedStride(clip, measured);
      }
    }
    this.#clipGroundSpeed.set(name, measured);
    return measured;
  }

  /**
   * A stride already measured for an equivalent clone, rescaled into this clone's world.
   *
   * Only a yaw-only, uniformly scaled rig is eligible: the sampled value normalizes for scale and
   * translation, so a tilted, mirrored or non-uniformly scaled instance keeps its own sample.
   */
  #sharedStride(clip: AnimationClip): ISharedStride | undefined {
    if (this.#preparation === undefined) return undefined;
    if (this.#uniformWorldScale() === undefined) return undefined;
    return this.#preparation.stride(this.mixer.getRoot() as Object3D, clip);
  }

  #rememberSharedStride(clip: AnimationClip, measured: IClipStride): void {
    if (this.#preparation === undefined) return;
    const scale = this.#uniformWorldScale();
    if (scale === undefined) return;
    this.#preparation.rememberStride(this.mixer.getRoot() as Object3D, clip, {
      groundSpeed: measured.groundSpeed / scale,
      inPlace: measured.inPlace,
    });
  }

  #uniformWorldScale(): number | undefined {
    const root = this.mixer.getRoot() as Object3D;
    const owner = root.parent ?? root;
    owner.updateWorldMatrix(true, false);
    return uniformYawScale(owner.matrixWorld);
  }

  /**
   * What one unit of a root track is worth in world metres.
   *
   * A clip's translation values are in the animated node's **parent** space, while the ground the
   * body covers is measured in world metres. `normaliseToMetres` — the framework's own convention
   * for sizing an import — all but guarantees the two differ, and a half-scale rig compared
   * without this reads its own stride at twice the speed. The foot-plant path below needs no such
   * conversion: it reads world positions, which already carry every ancestor's scale.
   */
  #trackScale(): number {
    const root = this.mixer.getRoot() as Object3D;
    (root.parent ?? root).getWorldScale(scratchScale);
    return (Math.abs(scratchScale.x) + Math.abs(scratchScale.z)) / 2;
  }

  /**
   * Hold the current clip's playback rate against the ground the body just covered.
   *
   * Called after `mixer.update`, from the root's world position, so it reads the movement a game
   * already applied this frame rather than asking the game to report it. A game that drives the
   * same object from the clip's own root motion has the two ends of this loop joined and should
   * turn the convention off; that is what the option is for.
   */
  #syncStride(dt: number): void {
    const name = this.#current;
    const action = name === undefined ? undefined : this.#actions.get(name);
    this.#strideRoot.getWorldPosition(scratchWorld);
    const previous = this.#lastRootPosition;
    const moved = this.#hasLastRootPosition
      ? Math.hypot(scratchWorld.x - previous.x, scratchWorld.z - previous.z)
      : 0;
    this.#lastRootPosition.copy(scratchWorld);
    this.#hasLastRootPosition = true;
    if (name === undefined || action === undefined || dt <= 0) return;
    const measured = this.#measureOf(name);
    const clipGroundSpeed = measured.groundSpeed;
    const groundSpeed = moved / dt;
    // A dominant idle must not leave a contributing walk at its authored speed.
    if (this.#blendTargets !== undefined && this.#strideSync && this.#mode === "loop")
      this.#syncBlendParticipants(groundSpeed);
    if (clipGroundSpeed < CLIP_GROUND_FLOOR) {
      // Not locomotion. An idle, a reload or a death is authored at the rate it is authored at,
      // and warping it by how fast the body happens to be sliding is a bug, not a convention.
      if (action.getEffectiveTimeScale() !== 1) action.setEffectiveTimeScale(1);
      this.#strideGroundSpeed = groundSpeed;
      this.#strideRate = 1;
      this.#strideSynced = false;
      this.#strideOverridden = false;
      this.#strideInPlace = measured.inPlace;
      return;
    }
    const wanted =
      groundSpeed < STRIDE_SPEED_FLOOR ? STRIDE_RATE_MIN : groundSpeed / clipGroundSpeed;
    const rate = Math.min(STRIDE_RATE_MAX, Math.max(STRIDE_RATE_MIN, wanted));
    // A `"once"` clip is an event — a death, a flinch, a reload — and plays at the rate the
    // event happens at, however still the body stands: its own root motion is the movement, so
    // re-timing it against a stationary body only slows the event down. A travelling death clip
    // clamped to the rate floor held a corpse upright through its whole death in the sandbox.
    const applies = this.#strideSync && this.#mode === "loop";
    if (applies) action.setEffectiveTimeScale(rate);
    this.#strideGroundSpeed = groundSpeed;
    this.#strideRate = rate;
    this.#strideSynced = applies;
    this.#strideOverridden = !this.#strideSync;
    this.#strideInPlace = measured.inPlace;
  }

  /**
   * Hold every contributing locomotion clip of a blend against the ground the body covered.
   *
   * One body covers one ground speed, and each clip carries its own distance per clip-second, so
   * each participant gets the rate its own stride implies. Without this the minority clip of a
   * blend slides: it plays at its authored rate against a body moving at another clip's speed.
   */
  #syncBlendParticipants(groundSpeed: number): void {
    for (const [name, action] of this.#actions) {
      if (!action.isScheduled() || action.getEffectiveWeight() <= 0) continue;
      const ground = this.#measureOf(name).groundSpeed;
      if (ground < CLIP_GROUND_FLOOR) continue;
      const wanted = groundSpeed < STRIDE_SPEED_FLOOR ? STRIDE_RATE_MIN : groundSpeed / ground;
      action.setEffectiveTimeScale(Math.min(STRIDE_RATE_MAX, Math.max(STRIDE_RATE_MIN, wanted)));
    }
  }

  #playAction(action: AnimationAction, mode: AnimationMode, weight: number): void {
    const once = mode === "once";
    action
      .reset()
      .setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Number.POSITIVE_INFINITY)
      .setEffectiveWeight(weight)
      .play();
    action.clampWhenFinished = once;
  }

  #replayCurrent(action: AnimationAction, mode: AnimationMode): void {
    for (const entry of this.#fadeOut) entry.action.stop();
    this.#fadeOut = [];
    for (const other of this.#actions.values()) {
      if (other !== action) other.setEffectiveWeight(0).stop();
    }
    this.#playAction(action, mode, 1);
    this.#mode = mode;
    this.#finished = false;
    this.#advancedFrames = 0;
  }

  #playCurrent(action: AnimationAction, requestedMode: AnimationMode | undefined): void {
    const mode = requestedMode ?? "loop";
    if (!this.#finished && mode === this.#mode) return;
    this.#replayCurrent(action, mode);
  }

  #playNext(name: string, next: AnimationAction, options: IAnimationPlayOptions): void {
    const fade = Math.max(0, options.fade ?? 0);
    const once = options.mode === "once";
    const from = fade > 0 && next.isScheduled() ? next.getEffectiveWeight() : 0;
    // A loop that is still visible keeps its gait; explicit one-shots and mode changes replay.
    const time = from > 0 && !once && next.loop === LoopRepeat ? next.time : 0;

    // Every clip still contributing ramps out together, from the weight it currently holds.
    //
    // This used to hard-stop anything that was not `previous` and force `previous` to weight 1.
    // Interrupting a blend therefore dropped the older clip's contribution in a single frame
    // and snapped the outgoing clip up to full — a visible pop, and one that appeared only when
    // transitions came faster than the fade, which is exactly when a character is reacting.
    const outgoing: { action: AnimationAction; from: number }[] = [];
    for (const action of this.#actions.values()) {
      if (action === next) continue;
      const weight = action.getEffectiveWeight();
      if (action.isScheduled() && weight > 0) outgoing.push({ action, from: weight });
      else action.setEffectiveWeight(0).stop();
    }

    this.#playAction(next, once ? "once" : "loop", fade > 0 && outgoing.length > 0 ? from : 1);
    next.time = time;
    if (outgoing.length === 0 || fade === 0) {
      for (const entry of outgoing) entry.action.setEffectiveWeight(0).stop();
      this.#fadeOut = [];
    } else {
      for (const entry of outgoing) entry.action.play();
      this.#fadeOut = outgoing;
      this.#fadeElapsed = 0;
      this.#fadeDuration = fade;
      this.#fadeInFrom = from;
    }
    this.#current = name;
    this.#mode = once ? "once" : "loop";
    this.#finished = false;
    this.#advancedFrames = 0;
  }

  play(name: string, options: IAnimationPlayOptions = {}): void {
    const next = this.#actions.get(name);
    if (next === undefined) throw new Error(`Unknown animation clip '${name}'.`);
    // One owner at a time. A single-clip request takes the rig back from a weighted blend, exactly
    // as it took it back from a crossfade.
    const weighted = this.#blendTargets !== undefined;
    this.#blendTargets = undefined;
    this.#blendDuration = 0;
    this.#blendStarts.clear();
    if (this.#current === name) {
      if (weighted) {
        const time = next.time;
        const keepPhase = this.#mode === "loop" && options.mode !== "once";
        this.#playNext(name, next, options);
        if (keepPhase) next.time = time;
      } else this.#playCurrent(next, options.mode);
      return;
    }
    this.#playNext(name, next, options);
  }

  /**
   * Play several clips at once, at weights the game computed — the plumbing half of a locomotion
   * blend space. The samples, the thresholds and the interpolation domain stay the game's: this
   * takes the answer (`{ clip, weight }[]`) and owns what happens to the actions.
   *
   * What it guarantees, because every blend space needs the same four things:
   *
   * - **One mixer, one updater, one action per clip.** Nothing here creates an `AnimationMixer`.
   * - **A still-contributing clip keeps its phase.** Returning to a walk mid-cycle does not
   *   restart it — the same convention `play` follows.
   * - **An entering clip joins the gait.** Its normalized time is set to the dominant
   *   contributor's, so a walk→run change does not cross the feet mid-stride. Pass
   *   `phaseSync: false` for authored cycles that are deliberately out of phase with each other.
   * - **Weights stay finite, non-negative and summing to 1.** Malformed input throws rather than
   *   producing a pose nobody can explain.
   *
   * `transition` is the bounded authored transition: weights move linearly towards the request
   * over that many seconds, so a large instantaneous intent change cannot pop the pose, and `0`
   * snaps them on the call. A clip that drops out of the request fades to zero and is then
   * stopped, so repeated blends release their actions.
   *
   * Entries are played as loops. Events — a hit, a death, a reload — are `play`'s job.
   */
  playWeighted(
    entries: readonly { readonly clip: string; readonly weight: number }[],
    options: { readonly transition?: number; readonly phaseSync?: boolean } = {},
  ): void {
    const transition = options.transition ?? 0;
    if (!Number.isFinite(transition) || transition < 0)
      throw new Error("AnimationPlayer.playWeighted requires a finite non-negative transition.");
    const targets = blendTargets(this.#actions, entries);
    const phaseSync = options.phaseSync ?? true;
    // Per-frame evaluators may repeat their answer; retain the original fade deadline.
    if (
      this.#blendTargets !== undefined &&
      this.#blendDuration === transition &&
      this.#blendTargets.size === targets.size &&
      [...targets].every(([name, weight]) => this.#blendTargets?.get(name) === weight)
    )
      return;
    // Any crossfade in flight stops owning the rig; its outgoing actions join the blend ramp below
    // as participants with a target of zero, so they leave the same bounded way they arrived.
    this.#fadeOut = [];
    const phase = this.#dominantPhase();
    let current = "";
    let heaviest = -1;
    for (const [name, action] of this.#actions) {
      const target = targets.get(name);
      if (target === undefined) continue;
      if (target > heaviest) {
        heaviest = target;
        current = name;
      }
      this.#startBlendParticipant(action, phase, phaseSync);
    }

    this.#blendStarts.clear();
    let initialWeight = 0;
    for (const [name, action] of this.#actions) {
      if (!action.isScheduled()) continue;
      const weight = action.getEffectiveWeight();
      this.#blendStarts.set(name, weight);
      initialWeight += weight;
    }
    this.#blendTargets = targets;
    // With no contributing pose there is nothing to fade from: start at the requested blend.
    this.#blendDuration = initialWeight > 0 ? transition : 0;
    this.#blendElapsed = 0;
    this.#current = current;
    this.#mode = "loop";
    this.#finished = false;
    this.#advancedFrames = 0;
    // A zero transition is the caller's request for these weights right now, not on the next
    // frame; a positive one leaves them where the previous request left them and ramps from there.
    this.#advanceBlend(0);
  }

  /**
   * The normalized gait phase an entering clip joins: the dominant contributor's own.
   *
   * A returning action is deliberately left alone — its phase is the continuity the reversal
   * repair exists to protect, and re-deriving it here would restart a walk the player is watching.
   */
  #dominantPhase(): number {
    let phase = 0;
    let dominant = 0;
    for (const action of this.#actions.values()) {
      if (!action.isScheduled()) continue;
      const weight = action.getEffectiveWeight();
      if (weight > dominant) {
        dominant = weight;
        const duration = action.getClip().duration;
        phase = duration > 0 ? action.time / duration : 0;
      }
    }
    return phase;
  }

  #startBlendParticipant(action: AnimationAction, phase: number, phaseSync: boolean): void {
    const weight = action.isScheduled() ? action.getEffectiveWeight() : 0;
    const returning = action.isScheduled() && action.loop === LoopRepeat && !action.paused;
    if (!returning) action.reset();
    action.setLoop(LoopRepeat, Number.POSITIVE_INFINITY).setEffectiveWeight(weight);
    action.clampWhenFinished = false;
    action.play();
    if (returning) return;
    const duration = action.getClip().duration;
    action.time = phaseSync && duration > 0 ? phase * duration : 0;
  }

  /**
   * Move every contributing action one step towards its requested weight.
   *
   * `dt` is the frame's own time, so the ramp is linear in real time whatever the frame rate is.
   */
  #advanceBlend(dt: number): void {
    const targets = this.#blendTargets;
    if (targets === undefined) return;
    this.#blendElapsed = Math.min(this.#blendDuration, this.#blendElapsed + dt);
    const progress = this.#blendDuration > 0 ? this.#blendElapsed / this.#blendDuration : 1;
    let total = 0;
    for (const [name, action] of this.#actions) {
      if (!action.isScheduled()) continue;
      const target = targets.get(name) ?? 0;
      const from = this.#blendStarts.get(name) ?? 0;
      const next = progress === 1 ? target : from + (target - from) * progress;
      action.setEffectiveWeight(next);
      total += next;
    }
    this.#settleBlend(targets, total);
  }

  /**
   * Release every action the request no longer includes, then restore the sum-to-one invariant.
   *
   * The renormalization is what keeps the sum at 1 while a blend swaps one clip for another: the
   * arriving clip grows from zero at the same rate the departing one shrinks, so without it the
   * rig under-weights toward the bind pose for the length of the transition.
   */
  #settleBlend(targets: ReadonlyMap<string, number>, total: number): void {
    const scale = total > 0 && total !== 1 ? 1 / total : 1;
    for (const [name, action] of this.#actions) {
      if (!action.isScheduled()) continue;
      if ((targets.get(name) ?? 0) === 0 && action.getEffectiveWeight() === 0) action.stop();
      else if (scale !== 1) action.setEffectiveWeight(action.getEffectiveWeight() * scale);
    }
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error("AnimationPlayer.update requires a finite non-negative dt.");
    // Read before mixer.update(): the "finished" listener fires inside it for a completing
    // once-clip, and that final frame still counts as advancement.
    const wasFinished = this.#finished;
    const before = this.mixer.time;
    this.mixer.update(dt);
    if (this.#fadeOut.length > 0) {
      this.#fadeElapsed = Math.min(this.#fadeDuration, this.#fadeElapsed + dt);
      const linear = this.#fadeDuration === 0 ? 1 : this.#fadeElapsed / this.#fadeDuration;
      // Smoothstep rather than linear. A linear weight ramp changes the pose's velocity
      // instantly at both ends, which reads as a corner on the character even when the fade
      // duration is right.
      const progress = linear * linear * (3 - 2 * linear);
      for (const entry of this.#fadeOut) {
        entry.action.setEffectiveWeight(entry.from * (1 - progress));
      }
      this.#actions
        .get(this.#current ?? "")
        ?.setEffectiveWeight(this.#fadeInFrom + (1 - this.#fadeInFrom) * progress);
      if (linear >= 1) {
        for (const entry of this.#fadeOut) entry.action.setEffectiveWeight(0).stop();
        this.#fadeOut = [];
      }
    }
    // three advances mixer.time unconditionally, finished or not: past a held last frame the
    // pose is frozen, so counting there would report idle frames as animation progress.
    if (this.#current !== undefined && !wasFinished && this.mixer.time !== before)
      this.#advancedFrames += 1;
    this.#advanceBlend(dt);
    this.#syncStride(dt);
  }

  stop(): void {
    this.mixer.stopAllAction();
    this.#current = undefined;
    this.#mode = "loop";
    this.#finished = false;
    this.#advancedFrames = 0;
    this.#fadeOut = [];
    this.#blendTargets = undefined;
    this.#blendDuration = 0;
    this.#blendElapsed = 0;
    this.#blendStarts.clear();
    this.#resetStride();
  }

  #resetStride(): void {
    this.#hasLastRootPosition = false;
    this.#strideGroundSpeed = 0;
    this.#strideRate = 1;
    this.#strideSynced = false;
    this.#strideOverridden = false;
    this.#strideInPlace = false;
  }

  dispose(): void {
    this.stop();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.mixer.removeEventListener("finished", this.#onFinished);
    this.#actions.clear();
    this.#clips.clear();
    this.#clipGroundSpeed.clear();
    this.#preparation = undefined;
  }
}

/** Reused so a per-frame stride read costs no allocation. See PRD-189. */
const scratchWorld = new Vector3();
const scratchScale = new Vector3();

/**
 * Validate one weighted request into normalized, non-zero target weights.
 *
 * Fail closed on everything malformed — an unknown clip, a non-finite or negative weight, a clip
 * listed twice, a request with nothing in it — because a blend that silently drops a sample reads
 * as a rig problem long after the request that caused it. Zero weights are dropped rather than
 * rejected: an evaluation over a grid naturally reports every cell it did not pick, and those
 * clips simply leave the blend. The remaining weights are scaled to sum to 1, so the engine holds
 * the invariant the caller does not have to.
 */
function blendTargets(
  actions: ReadonlyMap<string, AnimationAction>,
  entries: readonly { readonly clip: string; readonly weight: number }[],
): Map<string, number> {
  if (entries.length === 0)
    throw new Error("AnimationPlayer.playWeighted requires at least one clip.");
  const targets = new Map<string, number>();
  const seen = new Set<string>();
  let largest = 0;
  for (const entry of entries) {
    if (!actions.has(entry.clip)) throw new Error(`Unknown animation clip '${entry.clip}'.`);
    if (!Number.isFinite(entry.weight) || entry.weight < 0)
      throw new Error(
        `AnimationPlayer.playWeighted: '${entry.clip}' has weight ${entry.weight}; weights must be finite and non-negative.`,
      );
    if (seen.has(entry.clip))
      throw new Error(
        `AnimationPlayer.playWeighted: '${entry.clip}' is listed twice; give each clip one weight.`,
      );
    seen.add(entry.clip);
    if (entry.weight === 0) continue;
    targets.set(entry.clip, entry.weight);
    largest = Math.max(largest, entry.weight);
  }
  if (!(largest > 0))
    throw new Error("AnimationPlayer.playWeighted requires at least one clip above weight zero.");
  let total = 0;
  for (const weight of targets.values()) total += weight / largest;
  for (const [name, weight] of targets) targets.set(name, weight / largest / total);
  return targets;
}

function requiredClipNames(value: IAnimationPlayerOptions["requiredClips"]): readonly string[] {
  if (value === undefined) return [];
  const names = Array.isArray(value) ? value : Object.values(value);
  if (!names.every((name): name is string => typeof name === "string" && name.length > 0))
    throw new Error("AnimationPlayer: requiredClips must contain non-empty strings.");
  return names;
}
