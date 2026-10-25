import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type AnimationMixerEventMap,
  type Box3,
  type BufferGeometry,
  type EventListener,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  type Object3D,
  Vector3,
  type VectorKeyframeTrack,
} from "three";
import {
  type IAnimationPacketState,
  animationPacketField,
  animationPacketMethodsPristine,
  animationPacketReaders,
  animationPacketTime,
  animationPacketTimeReaders,
} from "./animation-packet-state.js";
import { clipTrackBindings } from "./clip-audit.js";
import {
  type IAnimationRateState,
  animationRateStates,
  trackAnimationRate,
} from "./render-camera-cull.js";
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
  /**
   * Evaluate by measured screen size by default; a positive integer names a frame interval.
   * Public mixer listeners/speed overrides stay full-rate; action speed interpolations do until settled.
   */
  readonly updateRate?: "auto" | number;
  /**
   * Let the skinned batch evaluate a held, distant rig's pose on the GPU from keyframes and time.
   * Off by default: each vertex re-evaluates the pose in the main and shadow passes, which cost
   * 2.7 / 10.3 / 13.8 ms of GPU time at 32 / 128 / 256 rigs on Intel gen-12lp (PRD-570). Held rigs
   * otherwise keep their last CPU pose until their next evaluation.
   */
  readonly gpuPose?: boolean;
}

export interface IAnimationUpdateRateReport {
  readonly rate: number;
  readonly overridden: boolean;
  readonly evaluated: boolean;
  /** Frames between CPU bone refreshes: `rate`, or longer while the GPU evaluates the pose. */
  readonly boneRate: number;
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
/** Packet-state reads that reuse the last full validation of the action and mixer internals. */
const PACKET_REVALIDATE_READS = 256;
/**
 * While the GPU evaluates a rig's pose, the CPU bones refresh every this many scheduled
 * evaluations. The drawn pose stays exact every frame; only bone readers see the longer interval.
 */
const GPU_POSE_BONE_REFRESH = 4;
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
 * The box a mesh's contact point is read from, or undefined for the object's own origin.
 *
 * A procedural boot or sole has its origin wherever the author put the geometry, usually the
 * middle. On a leg that swings from the hip the origin sweeps a smaller circle than the sole does,
 * so reading it reports a stride shorter than the ground the sole covers, and the clip plays too
 * fast. A skinned mesh keeps its bind-pose box under a static matrix, so its bones carry the
 * motion and it stays on the origin path.
 */
function contactBox(object: Object3D): Box3 | undefined {
  const mesh = object as Object3D & { geometry?: BufferGeometry; isSkinnedMesh?: boolean };
  if (mesh.geometry === undefined || mesh.isSkinnedMesh === true) return undefined;
  if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (box === null || box.isEmpty()) return undefined;
  const finite = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  return finite.every(Number.isFinite) ? box : undefined;
}

/**
 * Where an object meets the floor: its lowest world-space geometry point, with the horizontal
 * position taken at the middle of the four lowest corners of its box (the sole, however it tilts).
 * An object without geometry is its origin.
 */
function contactPoint(matrix: Matrix4, box: Box3 | undefined, target: Vector3): Vector3 {
  if (box === undefined) return target.setFromMatrixPosition(matrix);
  // Plain arithmetic over one read of the matrix and the box, Vector3.applyMatrix4's own formula:
  // on the owned engine each vector call crosses into the engine, and 8 corners per mesh per sample
  // held Lantern Vale's first walk and first run for 43 ms each.
  const [e0, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12, e13, e14, e15] = matrix.elements;
  const { x: minX, y: minY, z: minZ } = box.min;
  const { x: maxX, y: maxY, z: maxZ } = box.max;
  for (let index = 0; index < 8; index += 1) {
    const x = index & 1 ? maxX : minX;
    const y = index & 2 ? maxY : minY;
    const z = index & 4 ? maxZ : minZ;
    const w = 1 / (e3 * x + e7 * y + e11 * z + e15);
    cornerX[index] = (e0 * x + e4 * y + e8 * z + e12) * w;
    cornerY[index] = (e1 * x + e5 * y + e9 * z + e13) * w;
    cornerZ[index] = (e2 * x + e6 * y + e10 * z + e14) * w;
    cornerOrder[index] = index;
  }
  cornerOrder.sort((first, second) => (cornerY[first] as number) - (cornerY[second] as number));
  let x = 0;
  let z = 0;
  for (let index = 0; index < 4; index += 1) {
    const corner = cornerOrder[index] as number;
    x += cornerX[corner] as number;
    z += cornerZ[corner] as number;
  }
  return target.set(x / 4, cornerY[cornerOrder[0] as number] as number, z / 4);
}

/**
 * The ground an in-place clip was authored for, read off the feet, in world metres per clip-second.
 *
 * A planted foot sweeps backward relative to the body at exactly the speed the body is meant to be
 * travelling — that is what "planted" means — so the stance phase of a cycle states the clip's
 * speed even though nothing in it translates. Contact bones are found by where they go rather than
 * by what they are called: whatever reaches the bottom of the rig's arc is a foot, in any rig and
 * any language. A mesh counts at its lowest geometry point, not its origin (`contactPoint`). The median over stance frames rejects the toe-off and heel-strike ends of the
 * sweep, and the median over feet rejects a limb that never plants.
 *
 * The rig is driven and then restored to the transforms it arrived with, once per clip.
 */
function footPlantSpeed(root: Object3D, clip: AnimationClip): number {
  const objects: Object3D[] = [];
  root.traverse((object) => objects.push(object));
  const boxes = objects.map(contactBox);

  // The root belongs to the game, which turns it with `rotation.y +=`. A quaternion restore
  // rewrites `rotation` as the equivalent Euler, so a yaw of PI comes back as (PI, 0, PI) and the
  // next increment turns the figure the mirrored way. Bones keep the exact quaternion: a round trip
  // through Euler would lose precision on every joint.
  const rootRotation = root.rotation.clone();

  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  const paths = objects.map(() => [] as { x: number; y: number; z: number }[]);
  const step = clip.duration / PLANT_SAMPLES;
  // The mixer animates only the rig, so its ancestors need one refresh, not one per sample.
  root.parent?.updateWorldMatrix(true, false);
  try {
    for (let frame = 0; frame <= PLANT_SAMPLES; frame += 1) {
      mixer.setTime(frame * step);
      root.updateMatrixWorld(true);
      for (let index = 0; index < objects.length; index += 1) {
        // The frame's updateMatrixWorld already holds every bone; getWorldPosition re-walks ancestors.
        const object = objects[index] as Object3D & {
          __tnCopyMatrixWorld?: (target: Matrix4) => void;
        };
        let matrix = object.matrixWorld;
        if (object.__tnCopyMatrixWorld !== undefined) {
          object.__tnCopyMatrixWorld(scratchMatrixWorld);
          matrix = scratchMatrixWorld;
        }
        contactPoint(matrix, boxes[index], scratchWorld);
        (paths[index] as { x: number; y: number; z: number }[]).push({
          x: scratchWorld.x,
          y: scratchWorld.y,
          z: scratchWorld.z,
        });
      }
    }
  } finally {
    // Stopping restores every animated binding saved by this isolated mixer when it played.
    action.stop();
    mixer.uncacheClip(clip);
    root.rotation.copy(rootRotation);
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
let nextAnimationOffset = 0;
const ANIMATION_RATE_STATE_KEY = "threenative.animationRateState";

type LoopListener = EventListener<AnimationMixerEventMap["loop"], "loop", LoopAwareAnimationMixer>;
type FinishedListener = EventListener<
  AnimationMixerEventMap["finished"],
  "finished",
  LoopAwareAnimationMixer
>;
type BeforeFirstLoopListener = (duringUpdate: boolean) => void;

class LoopAwareAnimationMixer extends AnimationMixer<AnimationMixerEventMap> {
  readonly #loopListeners = new Set<LoopListener>();
  readonly #finishedListeners = new Set<FinishedListener>();
  readonly #beforeFirstLoopListener: BeforeFirstLoopListener;
  #updateDepth = 0;

  constructor(
    root: Object3D,
    beforeFirstLoopListener: BeforeFirstLoopListener,
    internalFinishedListener: FinishedListener,
  ) {
    super(root);
    this.#beforeFirstLoopListener = beforeFirstLoopListener;
    super.addEventListener("finished", internalFinishedListener);
  }

  get hasPublicListeners(): boolean {
    return this.#loopListeners.size > 0 || this.#finishedListeners.size > 0;
  }

  override addEventListener(type: "loop", listener: LoopListener): void;
  override addEventListener(type: "finished", listener: FinishedListener): void;
  override addEventListener(
    type: "loop" | "finished",
    listener: LoopListener | FinishedListener,
  ): void {
    if (type === "loop") {
      const loopListener = listener as LoopListener;
      if (!this.hasEventListener(type, loopListener)) {
        if (!this.hasPublicListeners) {
          const duringUpdate = this.#updateDepth > 0;
          this.#beforeFirstLoopListener(duringUpdate);
        }
        this.#loopListeners.add(loopListener);
      }
      super.addEventListener(type, loopListener);
      return;
    }
    const finishedListener = listener as FinishedListener;
    if (!this.hasEventListener(type, finishedListener)) {
      if (!this.hasPublicListeners) this.#beforeFirstLoopListener(this.#updateDepth > 0);
      this.#finishedListeners.add(finishedListener);
    }
    super.addEventListener(type, finishedListener);
  }

  override removeEventListener(type: "loop", listener: LoopListener): void;
  override removeEventListener(type: "finished", listener: FinishedListener): void;
  override removeEventListener(
    type: "loop" | "finished",
    listener: LoopListener | FinishedListener,
  ): void {
    if (type === "loop") {
      const loopListener = listener as LoopListener;
      const wasRegistered = this.hasEventListener(type, loopListener);
      super.removeEventListener(type, loopListener);
      if (wasRegistered) this.#loopListeners.delete(loopListener);
      return;
    }
    const finishedListener = listener as FinishedListener;
    super.removeEventListener(type, finishedListener);
    this.#finishedListeners.delete(finishedListener);
  }

  override update(deltaTime: number): AnimationMixer {
    this.#updateDepth += 1;
    try {
      return super.update(deltaTime);
    } finally {
      this.#updateDepth -= 1;
    }
  }
}

export class AnimationPlayer {
  readonly #packetReader = () => this.#readPacketState();
  readonly #packetTimeReader = () => this.#trustedPacketTime();
  /** The action and clip the last full packet validation accepted, reused for a bounded number of reads. */
  #packetTrust: { action: AnimationAction; clip: AnimationClip; left: number } | undefined;
  readonly mixer: AnimationMixer;
  readonly root: Object3D;
  readonly #rateState: IAnimationRateState = {
    rate: 1,
    effectiveRate: 1,
    frame: 0,
    source: undefined,
    evaluated: true,
    evaluation: 0,
    syncBones: () => this.#flushPending(),
  };
  readonly #staggerOffset = nextAnimationOffset++;
  #updateRate: "auto" | number = "auto";
  #updateFrame = 0;
  #skippedFrames = 0;
  #pendingDt = 0;
  readonly #pendingActionTimes = new Map<AnimationAction, number>();
  readonly #evaluationScales = new Map<AnimationAction, number>();
  readonly #evaluationPaused = new Set<AnimationAction>();
  readonly #timeScaleInterpolations = new Set<AnimationAction>();
  #evaluating = false;
  #evaluated = false;
  #actions = new Map<string, AnimationAction>();
  #current: string | undefined;
  #mode: AnimationMode = "loop";
  #advancedFrames = 0;
  #finished = false;
  #posed = false;
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
  /**
   * The clip whose last stride measurement could not change any time scale: it is not locomotion,
   * or the game declined stride sync. While it is still playing, a held tick only banks its `dt`
   * and the next evaluation measures the whole interval, so a held rig pays no world-matrix walk.
   */
  #strideReportOnlyFor: string | undefined;
  #strideDtDebt = 0;
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
    this.updateRate = options.updateRate ?? "auto";
    this.#rateState.gpuPoseEnabled = options.gpuPose === true;
    this.mixer = new LoopAwareAnimationMixer(
      options.root,
      (duringUpdate) => {
        if (!duringUpdate) this.#flushPending();
      },
      this.#onFinished,
    );
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
      this.#observeTimeScaleInterpolation(action);
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
    animationPacketReaders.set(this.root, this.#packetReader);
    animationPacketTimeReaders.set(this.root, this.#packetTimeReader);
    trackAnimationRate(this.root, this.#rateState);
    this.root.userData[ANIMATION_RATE_STATE_KEY] = this.#rateState;
  }

  get updateRate(): "auto" | number {
    return this.#updateRate;
  }

  set updateRate(value: "auto" | number) {
    if (value !== "auto" && (!Number.isSafeInteger(value) || value < 1))
      throw new Error("AnimationPlayer.updateRate requires 'auto' or a positive safe integer.");
    this.#updateRate = value;
  }

  get updateRateReport(): IAnimationUpdateRateReport {
    return {
      rate: this.#effectiveUpdateRate(),
      overridden: this.#updateRate !== "auto",
      evaluated: this.#evaluated,
      boneRate: this.#boneRate(this.#effectiveUpdateRate()),
    };
  }

  /** An explicit `updateRate` keeps the CPU pose on that interval; auto lets the GPU pose stretch it. */
  #boneRate(rate: number): number {
    return this.#updateRate === "auto" && rate > 1 && this.#rateState.gpuPose === true
      ? rate * GPU_POSE_BONE_REFRESH
      : rate;
  }

  #effectiveUpdateRate(): number {
    // Public mixer speed overrides and observed events retain ordinary Three.js tick semantics.
    if (this.mixer.timeScale !== 1) return 1;
    // Event deadlines and changing blend weights remain exactly on the gameplay tick.
    if (
      this.#mode === "once" ||
      this.#fadeOut.length > 0 ||
      this.#blendElapsed < this.#blendDuration
    )
      return 1;
    if (this.mixer instanceof LoopAwareAnimationMixer && this.mixer.hasPublicListeners) return 1;
    if (this.#timeScaleInterpolations.size > 0) return 1;
    if (this.#updateRate !== "auto") return this.#updateRate;
    const state = this.#rateState;
    if (state.source === undefined) return 1;
    return state.frame === state.source.animationFrame ? state.rate : 8;
  }

  #observeTimeScaleInterpolation(action: AnimationAction): void {
    const warp = action.warp.bind(action);
    const stopWarping = action.stopWarping.bind(action);
    const crossFadeFrom = action.crossFadeFrom.bind(action);
    action.warp = (startTimeScale, endTimeScale, duration) => {
      if (!this.#evaluating) this.#flushPending();
      this.#timeScaleInterpolations.add(action);
      return warp(startTimeScale, endTimeScale, duration);
    };
    action.crossFadeFrom = (fadeOutAction, duration, warp) => {
      if (!this.#evaluating) this.#flushPending();
      return crossFadeFrom(fadeOutAction, duration, warp);
    };
    action.stopWarping = () => {
      const result = stopWarping();
      this.#timeScaleInterpolations.delete(action);
      return result;
    };
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
    const owner = (root.parent ?? root) as Object3D & {
      __tnCopyMatrixWorld?: (target: Matrix4) => void;
    };
    owner.updateWorldMatrix(true, false);
    if (owner.__tnCopyMatrixWorld !== undefined) {
      // Native copies into owned storage so this read cannot escape the live transform alias.
      owner.__tnCopyMatrixWorld(scratchMatrixWorld);
      return uniformYawScale(scratchMatrixWorld);
    }
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
      if (
        this.#strideSynced &&
        !this.#timeScaleInterpolations.has(action) &&
        action.getEffectiveTimeScale() === this.#strideRate
      )
        action.setEffectiveTimeScale(1);
      this.#strideGroundSpeed = groundSpeed;
      this.#strideRate = 1;
      this.#strideSynced = false;
      this.#strideOverridden = false;
      this.#strideInPlace = measured.inPlace;
      this.#strideReportOnlyFor = this.#blendTargets === undefined ? name : undefined;
      return;
    }
    const wanted =
      groundSpeed < STRIDE_SPEED_FLOOR ? STRIDE_RATE_MIN : groundSpeed / clipGroundSpeed;
    const rate = Math.min(STRIDE_RATE_MAX, Math.max(STRIDE_RATE_MIN, wanted));
    // A `"once"` clip is an event — a death, a flinch, a reload — and plays at the rate the
    // event happens at, however still the body stands: its own root motion is the movement, so
    // re-timing it against a stationary body only slows the event down. A travelling death clip
    // clamped to the rate floor held a corpse upright through its whole death in the sandbox.
    const applies =
      this.#strideSync && this.#mode === "loop" && !this.#timeScaleInterpolations.has(action);
    if (applies) action.setEffectiveTimeScale(rate);
    this.#strideGroundSpeed = groundSpeed;
    this.#strideRate = rate;
    this.#strideSynced = applies;
    this.#strideOverridden = !this.#strideSync;
    this.#strideInPlace = measured.inPlace;
    this.#strideReportOnlyFor = !applies && this.#blendTargets === undefined ? name : undefined;
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
      if (ground < CLIP_GROUND_FLOOR || this.#timeScaleInterpolations.has(action)) continue;
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
    this.#start(name, options);
    this.#poseAtStart();
  }

  /**
   * Whether a clip has posed the skeleton. False until the first `play` or `playWeighted`, so a
   * rig that never plays a clip stays observably in its bind pose.
   */
  get posed(): boolean {
    return this.#posed;
  }

  /**
   * Pose the skeleton from the clip that just started, before any `update`. `play` only schedules
   * an action, and three applies a pose only inside `mixer.update`, so a character added to the
   * scene on the frame it starts would otherwise render once in its bind pose (a T-pose) and snap
   * to its clip on the next tick. A zero step applies the pose and advances nothing.
   */
  #poseAtStart(): void {
    if (this.#posed) return;
    this.mixer.update(0);
    this.#posed = true;
  }

  #start(name: string, options: IAnimationPlayOptions): void {
    const next = this.#actions.get(name);
    if (next === undefined) throw new Error(`Unknown animation clip '${name}'.`);
    if (this.#current !== name || this.#finished || (options.mode ?? "loop") !== this.#mode)
      this.#flushPending();
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
    this.#flushPending();
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
    this.#poseAtStart();
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

  /** `force` evaluates accumulated time now, even outside this player's stagger slot. */
  update(dt: number, force = false): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error("AnimationPlayer.update requires a finite non-negative dt.");
    if (this.mixer.timeScale !== 1) this.#flushPending();
    const elapsed = dt * this.mixer.timeScale;
    this.#pendingDt += elapsed;
    for (const action of this.#actions.values()) {
      if (!action.isScheduled()) continue;
      const time = action.paused ? 0 : action.timeScale * elapsed;
      this.#pendingActionTimes.set(action, (this.#pendingActionTimes.get(action) ?? 0) + time);
    }
    const rate = this.#effectiveUpdateRate();
    this.#rateState.effectiveRate = force ? 1 : rate;
    this.#updateFrame += 1;
    this.#skippedFrames += 1;
    this.#rateState.evaluated = false;
    const boneRate = this.#boneRate(rate);
    this.#evaluated =
      force ||
      (this.#updateFrame + this.#staggerOffset) % boneRate === 0 ||
      this.#skippedFrames >= boneRate;
    if (this.#evaluated) this.#evaluate(dt);
    // Measure the body's movement on every tick, including skipped pose evaluations. A held tick of
    // a clip whose measurement only reports banks its dt: the average speed over the interval is
    // the same number, measured once.
    if (
      !this.#evaluated &&
      this.#strideReportOnlyFor !== undefined &&
      this.#strideReportOnlyFor === this.#current &&
      this.#blendTargets === undefined &&
      dt > 0
    ) {
      this.#strideDtDebt += dt;
      return;
    }
    if (dt > 0) {
      const interval = dt + this.#strideDtDebt;
      this.#strideDtDebt = 0;
      this.#syncStride(interval);
    } else this.#syncStride(dt);
  }

  /**
   * The playhead a trusted packet reads, as a bare number: the same checks as the trusted branch
   * of `#readPacketState` without building a state object. Undefined sends the caller to the full
   * read, which also renews the trust.
   */
  #trustedPacketTime(): number | undefined {
    const trust = this.#packetTrust;
    if (
      trust === undefined ||
      trust.left <= 0 ||
      this.#evaluating ||
      this.#actions.size !== 1 ||
      this.#mode !== "loop" ||
      this.#finished ||
      this.#fadeOut.length !== 0 ||
      this.#blendTargets !== undefined ||
      this.#timeScaleInterpolations.size !== 0
    )
      return undefined;
    const name = this.#current ?? "";
    const action = this.#actions.get(name);
    if (action !== trust.action || this.#clips.get(name) !== trust.clip) return undefined;
    trust.left -= 1;
    return animationPacketTime(
      action.time,
      this.#pendingActionTimes.get(action) ?? 0,
      trust.clip.duration,
    );
  }

  #readPacketState(): IAnimationPacketState | undefined {
    if (
      this.#evaluating ||
      this.#actions.size !== 1 ||
      this.#mode !== "loop" ||
      this.#finished ||
      this.#fadeOut.length !== 0 ||
      this.#blendTargets !== undefined ||
      this.#timeScaleInterpolations.size !== 0
    )
      return undefined;
    const action = this.#actions.get(this.#current ?? "");
    const clip = this.#clips.get(this.#current ?? "");
    const trust = this.#packetTrust;
    if (trust !== undefined && trust.left > 0 && action === trust.action && clip === trust.clip) {
      trust.left -= 1;
      // Between full validations only the playhead is read: plain data fields, no author code.
      const time = animationPacketTime(
        action.time,
        this.#pendingActionTimes.get(action) ?? 0,
        clip.duration,
      );
      if (time === undefined) return undefined;
      return Object.freeze({
        root: this.root,
        mixer: this.mixer,
        action,
        clip,
        time,
        evaluated: this.#rateState.evaluated,
        evaluation: this.#rateState.evaluation,
      });
    }
    this.#packetTrust = undefined;
    if (
      action === undefined ||
      clip === undefined ||
      !animationPacketMethodsPristine(action, this.mixer)
    )
      return undefined;
    const field = animationPacketField;
    const duration = field(clip, "duration");
    const held = field(action, "time");
    const index = field(action, "_cacheIndex");
    const active = field(this.mixer, "_nActiveActions");
    const actions = field(this.mixer, "_actions");
    if (
      field(action, "_mixer") !== this.mixer ||
      field(action, "_clip") !== clip ||
      field(this.mixer, "_root") !== this.root ||
      field(this.mixer, "timeScale") !== 1 ||
      field(action, "loop") !== LoopRepeat ||
      field(action, "repetitions") !== Number.POSITIVE_INFINITY ||
      field(action, "clampWhenFinished") !== false ||
      field(action, "paused") !== false ||
      field(action, "enabled") !== true ||
      field(action, "weight") !== 1 ||
      field(action, "_effectiveWeight") !== 1 ||
      field(action, "timeScale") !== 1 ||
      field(action, "_effectiveTimeScale") !== 1 ||
      field(action, "_startTime") !== null ||
      field(action, "_weightInterpolant") !== null ||
      field(action, "_timeScaleInterpolant") !== null ||
      active !== 1 ||
      typeof index !== "number" ||
      index !== 0 ||
      !Array.isArray(actions) ||
      field(actions, String(index)) !== action ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      typeof held !== "number" ||
      !Number.isFinite(held) ||
      held < 0 ||
      held > duration
    )
      return undefined;
    const time = animationPacketTime(held, this.#pendingActionTimes.get(action) ?? 0, duration);
    if (time === undefined) return undefined;
    this.#packetTrust = { action, clip, left: PACKET_REVALIDATE_READS };
    return Object.freeze({
      root: this.root,
      mixer: this.mixer,
      action,
      clip,
      time,
      evaluated: this.#rateState.evaluated,
      evaluation: this.#rateState.evaluation,
    });
  }

  #flushPending(): void {
    if (this.#pendingDt !== 0) this.#evaluate(this.#pendingDt);
  }

  #evaluate(dt: number): void {
    // Read before mixer.update(): the "finished" listener fires inside it for a completing
    // once-clip, and that final frame still counts as advancement.
    const wasFinished = this.#finished;
    const before = this.mixer.time;
    const elapsed = this.#pendingDt;
    const mixerScale = this.mixer.timeScale;
    const direct =
      this.#skippedFrames === 1 &&
      elapsed === dt * mixerScale &&
      (mixerScale !== 1 ||
        (this.mixer instanceof LoopAwareAnimationMixer && this.mixer.hasPublicListeners));
    if (!direct) {
      this.mixer.timeScale = 1;
      for (const [action, pending] of this.#pendingActionTimes) {
        const wasPaused = action.paused;
        if (wasPaused && pending !== 0) {
          this.#evaluationPaused.add(action);
          action.paused = false;
        }
        let time = pending;
        let seamAdjusted = false;
        const duration = action.getClip().duration;
        if (action.loop === LoopRepeat && duration > 0) {
          const end = action.time + time;
          const seam = Math.round(end / duration) * duration;
          // Grouped addition must not hold the last pose when rate 1 already crossed a loop seam.
          if (Math.abs(end - seam) <= Number.EPSILON * 16 * Math.max(duration, Math.abs(end))) {
            time = seam - action.time;
            seamAdjusted = true;
          }
        }
        // Integrate changing stride rates; the last tick's rate must not own earlier skipped time.
        if (elapsed !== 0) {
          const scale = time / elapsed;
          const equalToActionScale =
            Math.abs(scale - action.timeScale) <=
            Number.EPSILON * 16 * Math.max(1, Math.abs(scale), Math.abs(action.timeScale));
          const warpActive = !wasPaused && action.getEffectiveTimeScale() !== action.timeScale;
          if (!warpActive && (seamAdjusted || !equalToActionScale)) {
            this.#evaluationScales.set(action, action.timeScale);
            action.setEffectiveTimeScale(scale);
          }
        }
      }
    }
    this.#evaluating = true;
    try {
      this.mixer.update(direct ? dt : elapsed);
    } finally {
      this.#evaluating = false;
      if (!direct) this.mixer.timeScale = mixerScale;
      for (const action of this.#evaluationPaused) action.paused = true;
      this.#evaluationPaused.clear();
      for (const [action, scale] of this.#evaluationScales) action.setEffectiveTimeScale(scale);
      this.#evaluationScales.clear();
      this.#pendingDt = 0;
      this.#pendingActionTimes.clear();
      this.#skippedFrames = 0;
    }
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
    this.#rateState.evaluation += 1;
    this.#rateState.evaluated = true;
  }

  stop(): void {
    this.#pendingDt = 0;
    this.#pendingActionTimes.clear();
    this.#skippedFrames = 0;
    this.#evaluated = false;
    this.mixer.stopAllAction();
    this.#rateState.evaluation += 1;
    this.#current = undefined;
    this.#mode = "loop";
    this.#finished = false;
    this.#advancedFrames = 0;
    this.#fadeOut = [];
    this.#blendTargets = undefined;
    this.#blendDuration = 0;
    this.#blendElapsed = 0;
    this.#blendStarts.clear();
    this.#timeScaleInterpolations.clear();
    this.#resetStride();
  }

  #resetStride(): void {
    this.#hasLastRootPosition = false;
    this.#strideReportOnlyFor = undefined;
    this.#strideDtDebt = 0;
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
    if (animationPacketReaders.get(this.root) === this.#packetReader)
      animationPacketReaders.delete(this.root);
    if (animationPacketTimeReaders.get(this.root) === this.#packetTimeReader)
      animationPacketTimeReaders.delete(this.root);
    if (animationRateStates.get(this.root) === this.#rateState)
      animationRateStates.delete(this.root);
    if (this.root.userData[ANIMATION_RATE_STATE_KEY] === this.#rateState)
      delete this.root.userData[ANIMATION_RATE_STATE_KEY];
  }
}

/** Reused so a per-frame stride read costs no allocation. See PRD-189. */
const scratchWorld = new Vector3();
const scratchScale = new Vector3();
const scratchMatrixWorld = new Matrix4();
const cornerX = new Float64Array(8);
const cornerY = new Float64Array(8);
const cornerZ = new Float64Array(8);
const cornerOrder = [0, 1, 2, 3, 4, 5, 6, 7];

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
