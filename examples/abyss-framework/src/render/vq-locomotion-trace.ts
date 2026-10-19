import { SkeletalMesh3D } from "@threenative/core";
import { type AnimationClip, Bone, Group, type Object3D, Quaternion, Vector3 } from "three";
import {
  FIRST_PERSON_BODY_LOCOMOTION,
  type ILocomotionSettings,
  KAYKIT_DIRECTIONAL,
  THIRD_PERSON_LOCOMOTION,
  createLocomotionDriver,
} from "./locomotion-driver.js";

/**
 * The one scripted speed trace, in metres per second, and how many fixed ticks each speed holds:
 * idle, walk, jog, sprint, back down, then reversals a player actually makes. No direction is ever
 * supplied, because this game authored no directional clips; the driver throws if one is asked for.
 */
const SCRIPT: readonly (readonly [speed: number, ticks: number])[] = [
  [0, 30],
  [1.6, 24],
  [3.4, 24],
  [5.6, 24],
  [2.4, 18],
  [1.2, 18],
  [0, 24],
  [5.6, 2],
  [0, 2],
  [5.6, 2],
  [0, 2],
  [3.4, 1],
  [0, 1],
  [1.6, 1],
  [0, 1],
];
/** The same trace twice: a returning rig has to reach the same settled pose, not a fresh one. */
const PASSES = 2;
/** Idle ticks after the last speed before the actions are released, so the settle is measured. */
const SETTLE_TICKS = 24;
const STEP = 1 / 60;
/** Two clips share a pose's verdict when their weights agree this closely, weights being in [0, 1]. */
const DOMAIN_TIE = 1e-6;

/**
 * The one scripted direction trace, on the authored pose vocabulary: x is right, y is forward. Each
 * axis pose is held long enough for a 0.2 s weight ramp to finish, so the recorded dominant clip is
 * the pose's own clip and not a blend still on its way there.
 */
const KAYKIT_POSES = {
  back: [0, -1],
  diagBackLeft: [-0.5, -0.5],
  diagForwardRight: [0.5, 0.5],
  diagLeftForward: [-0.5, 0.5],
  diagRightBack: [0.5, -0.5],
  forward: [0, 1],
  idle: [0, 0],
  left: [-1, 0],
  right: [1, 0],
} as const;

/** Ticks one sweep leg spends crossing a quadrant. Slow enough to watch the feet change direction. */
const SWEEP_TICKS = 6;

interface IDirectionStep {
  readonly pose: string;
  readonly ticks: number;
  /** Undefined plays the pose's own authored point; only the sweep interpolates. */
  readonly direction?: readonly [number, number];
}

/**
 * forward -> right -> back -> left -> forward walked slowly, then reversals a player really makes:
 * a whole direction replaced in one tick, twice over.
 */
function slowSweep(): readonly IDirectionStep[] {
  const legs = ["forward", "right", "back", "left", "forward"] as const;
  const steps: IDirectionStep[] = [];
  for (let leg = 0; leg + 1 < legs.length; leg++) {
    const from = KAYKIT_POSES[legs[leg] ?? "idle"];
    const to = KAYKIT_POSES[legs[leg + 1] ?? "idle"];
    for (let tick = 1; tick <= SWEEP_TICKS; tick++) {
      const along = tick / SWEEP_TICKS;
      steps.push({
        direction: [from[0] + (to[0] - from[0]) * along, from[1] + (to[1] - from[1]) * along],
        pose: `sweep${leg + 1}`,
        ticks: 1,
      });
    }
  }
  return steps;
}

/** 174 fixed ticks per pass, exactly SCRIPT's length, so every consumer of this fixture ends together. */
const DIRECTION_SCRIPT: readonly IDirectionStep[] = [
  { pose: "idle", ticks: 20 },
  { pose: "forward", ticks: 16 },
  { pose: "diagForwardRight", ticks: 14 },
  { pose: "right", ticks: 16 },
  { pose: "diagRightBack", ticks: 14 },
  { pose: "back", ticks: 16 },
  { pose: "diagBackLeft", ticks: 14 },
  { pose: "left", ticks: 16 },
  { pose: "diagLeftForward", ticks: 14 },
  ...slowSweep(),
  { pose: "right", ticks: 1 },
  { pose: "left", ticks: 1 },
  { pose: "forward", ticks: 1 },
  { pose: "back", ticks: 1 },
  { pose: "idle", ticks: 6 },
];

/** The direction trace expanded to one entry per fixed tick, twice. */
function directionTrace() {
  const poses: string[] = [];
  const points: (readonly [number, number])[] = [];
  const perPass = DIRECTION_SCRIPT.reduce((total, step) => total + step.ticks, 0);
  for (let pass = 0; pass < PASSES; pass++)
    for (const step of DIRECTION_SCRIPT)
      for (let tick = 0; tick < step.ticks; tick++) {
        const pose = step.pose as keyof typeof KAYKIT_POSES;
        poses.push(step.pose);
        points.push(step.direction ?? KAYKIT_POSES[pose]);
      }
  return { perPass, points, poses };
}
/** Bones whose local pose must not jump between two adjacent ticks. */
const SAMPLED_BONES = [
  "spine_03",
  "clavicle_l",
  "upperarm_l",
  "lowerarm_l",
  "hand_l",
  "clavicle_r",
  "upperarm_r",
  "lowerarm_r",
  "hand_r",
  "thigh_l",
  "calf_l",
  "foot_l",
  "thigh_r",
  "calf_r",
  "foot_r",
] as const;
/** The same job on Rig_Medium. Its pack names the sides with a dot, which the loader sanitizes away. */
const KAYKIT_BONES = [
  "spine",
  "chest",
  "head",
  "upperarml",
  "lowerarml",
  "wristl",
  "upperarmr",
  "lowerarmr",
  "wristr",
  "upperlegl",
  "lowerlegl",
  "footl",
  "toesl",
  "upperlegr",
  "lowerlegr",
  "footr",
  "toesr",
] as const;

/** One parsed glTF file: the scene it carries and the clips its author put in it. */
interface IKayKitFile {
  readonly animations: readonly AnimationClip[];
  readonly scene: Object3D;
}

/** Which of a rig's own bones this fixture measures. Named by the game, not inferred. */
interface IRigBones {
  readonly head: string;
  readonly sampled: readonly string[];
}

const MANNEQUIN_BONES: IRigBones = { head: "Head", sampled: SAMPLED_BONES };
const KAYKIT_RIG_BONES: IRigBones = { head: "head", sampled: KAYKIT_BONES };

/** Every clip these settings can ask the player for: speed samples first, then the direction's. */
function clipsOf(settings: ILocomotionSettings): readonly string[] {
  const names = settings.speedSamples.map(({ clip }) => clip);
  for (const { clip } of settings.direction?.samples ?? [])
    if (!names.includes(clip)) names.push(clip);
  return names;
}

/** What one direction pose actually resolved to, once its own weight ramp had time to finish. */
interface IPoseVerdict {
  /** Every clip tied for that weight, in the same `+` vocabulary the per-tick report uses. */
  clips: string;
  weight: number;
}

/** Everything one consumer publishes every tick, in the shape the playtest reads. */
interface ILocomotionReport {
  activeActions: number;
  clips: string;
  disposed: boolean;
  maxActiveActions: number;
  maxPhaseGap: number;
  maxPoseMetres: number;
  maxPoseRadians: number;
  maxWeightError: number;
  phase: number[];
  /** Per authored pose, the dominant clip and the weight it reached. Empty on a speed-only rig. */
  poses: Record<string, IPoseVerdict>;
  releasedActions: number;
  settledActions: number;
  settledClips: string;
  weights: number[];
}

/** One real game consumer: its authored settings, its own rig, its own driver, one mixer. */
function createRig(
  settings: ILocomotionSettings,
  model: { readonly scene: Object3D; readonly animations: readonly AnimationClip[] },
  rigBones: IRigBones = MANNEQUIN_BONES,
) {
  const group = new Group();
  const clips = clipsOf(settings);
  const player = new SkeletalMesh3D({
    source: model.scene,
    clips: model.animations,
    requiredClips: clips,
    strideSync: false,
  });
  group.add(player.root);
  const bones = new Map<string, Bone>();
  player.root.traverse((node) => {
    if (node instanceof Bone) bones.set(node.name, node);
  });
  const sampled = rigBones.sampled.map((name) => {
    const bone = bones.get(name);
    if (bone === undefined)
      throw new Error(`Locomotion requires the bone '${name}' to sample on this rig.`);
    return bone;
  });
  const head = bones.get(rigBones.head);
  if (head === undefined)
    throw new Error(`Locomotion requires a '${rigBones.head}' bone to measure eye height from.`);
  const actions = clips.map((name) => player.mixer.clipAction(player.clip(name)));
  const durations = actions.map((action) => action.getClip().duration);
  const driver = createLocomotionDriver(settings, player);
  // Every buffer below is allocated once. The per-tick path only writes into them.
  const weights = clips.map(() => 0);
  const phase = clips.map(() => 0);
  const live = clips.map(() => false);
  const wasLive = clips.map(() => false);
  const previous = sampled.map(() => ({ position: new Vector3(), rotation: new Quaternion() }));
  const normalized = new Quaternion();
  const world = new Vector3();
  /** Ticks the settings' own ramp needs, and the tie two clips must share to count as one verdict. */
  const rampTicks = Math.ceil((settings.transitionSeconds ?? 0) / STEP);
  let heldFor = 0;
  let lastPose: string | undefined;
  const report: ILocomotionReport = {
    activeActions: 0,
    clips: "",
    disposed: false,
    maxActiveActions: 0,
    maxPhaseGap: 0,
    maxPoseMetres: 0,
    maxPoseRadians: 0,
    maxWeightError: 0,
    phase,
    poses: {},
    releasedActions: -1,
    settledActions: -1,
    settledClips: "",
    weights,
  };
  let sampledOnce = false;
  return {
    dispose(): void {
      report.settledActions = player.mixer.stats.actions.inUse;
      report.settledClips = report.clips;
      player.dispose();
      report.disposed = true;
      report.releasedActions = player.mixer.stats.actions.total;
    },
    group,
    head,
    report,
    /** One fixed tick: the driver owns the weights, the player owns the actions. */
    tick(speed: number, direction?: readonly [number, number], pose?: string): void {
      driver.update(speed, direction);
      // Request-time sampling, exactly like the reversal trace: the phase join is measured before a
      // tick of playback moves two clips of different lengths apart, which is gait, not a jump.
      let total = 0;
      let dominant = 0;
      let dominantWeight = 0;
      let selected = "";
      for (const [index, action] of actions.entries()) {
        const scheduled = action.isScheduled();
        const weight = scheduled ? action.getEffectiveWeight() : 0;
        if (!Number.isFinite(weight) || weight < 0)
          throw new Error("Locomotion produced a weight that is not finite and non-negative.");
        const duration = durations[index] ?? 0;
        live[index] = scheduled;
        weights[index] = weight;
        phase[index] = duration > 0 ? action.time / duration : 0;
        total += weight;
        if (weight > 0 && clips[index] !== undefined)
          selected = selected.length === 0 ? clips[index] : `${selected}+${clips[index]}`;
        if (weight > dominantWeight) {
          dominant = index;
          dominantWeight = weight;
        }
      }
      report.clips = selected;
      report.activeActions = player.mixer.stats.actions.inUse;
      report.maxActiveActions = Math.max(report.maxActiveActions, report.activeActions);
      report.maxWeightError = Math.max(report.maxWeightError, Math.abs(total - 1));
      // A pose is only judged once it has been held for the whole ramp the settings asked for:
      // before that the mixer still carries the previous direction, and a verdict taken then would
      // name the clip the rig is leaving rather than the one it arrived at. A pose held for less
      // than its own ramp - a sweep leg or a one-tick reversal - is measured as motion, not judged.
      heldFor = pose === lastPose ? heldFor + 1 : 0;
      lastPose = pose;
      if (pose !== undefined && heldFor >= rampTicks && dominantWeight > 0) {
        const carried = clips
          .filter((_, index) => Math.abs((weights[index] ?? 0) - dominantWeight) <= DOMAIN_TIE)
          .join("+");
        const held = report.poses[pose];
        if (held === undefined || dominantWeight > held.weight)
          report.poses[pose] = { clips: carried, weight: dominantWeight };
      }
      // An entering clip joins the dominant contributor's phase when sync is on and starts at its
      // own when it is off; a returning one keeps the phase it already had, so it is not measured.
      for (const [index, scheduled] of live.entries()) {
        if (!scheduled || wasLive[index]) continue;
        const own = phase[index];
        const joined = phase[dominant];
        if (own === undefined || joined === undefined)
          throw new Error("Locomotion lost a phase sample.");
        report.maxPhaseGap = Math.max(report.maxPhaseGap, Math.abs(own - joined));
      }
      player.update(STEP);
      for (const [index, bone] of sampled.entries()) {
        const before = previous[index];
        if (before === undefined) throw new Error("Locomotion lost a sampled bone.");
        // glTF float32 quaternions are only near unit length, so compare normalized copies and
        // never touch the played bone.
        normalized.copy(bone.quaternion).normalize();
        bone.getWorldPosition(world);
        if (sampledOnce) {
          report.maxPoseRadians = Math.max(
            report.maxPoseRadians,
            normalized.angleTo(before.rotation),
          );
          report.maxPoseMetres = Math.max(report.maxPoseMetres, world.distanceTo(before.position));
        }
        before.rotation.copy(normalized);
        before.position.copy(world);
      }
      sampledOnce = true;
      for (const [index, scheduled] of live.entries()) wasLive[index] = scheduled;
    },
  };
}

/** One Rig_Medium from the three unmodified KayKit files: the first carries the scene, and a clip is
 *  taken by the exact name the settings play. Nothing is retargeted or relabelled, and a name the
 *  player would be handed twice is a failure instead of a silent overwrite. */
function mergeKayKit(files: readonly IKayKitFile[]) {
  const [first] = files;
  if (first === undefined) throw new Error("KayKit locomotion needs at least its rig file.");
  const required = clipsOf(KAYKIT_DIRECTIONAL);
  const animations = files.flatMap((file) =>
    file.animations.filter((clip) => required.includes(clip.name)),
  );
  for (const clip of required)
    if (animations.filter((candidate) => candidate.name === clip).length !== 1)
      throw new Error(`KayKit locomotion needs exactly one authored '${clip}' clip to play.`);
  return { animations, scene: first.scene };
}

/** Three real rigs: two on the CC0 mannequin driven by speed, one on the CC0 KayKit rig by direction. */
export function createLocomotionTrace(model: IKayKitFile, kayKitFiles: readonly IKayKitFile[]) {
  const third = createRig(THIRD_PERSON_LOCOMOTION, model);
  const first = createRig(FIRST_PERSON_BODY_LOCOMOTION, model);
  const kaykit = createRig(KAYKIT_DIRECTIONAL, mergeKayKit(kayKitFiles), KAYKIT_RIG_BONES);
  const script: number[] = [];
  for (let pass = 0; pass < PASSES; pass++)
    for (const [speed, ticks] of SCRIPT)
      for (let tick = 0; tick < ticks; tick++) script.push(speed);
  const perPass = script.length / PASSES;
  const direction = directionTrace();
  // The two consumers are one fixture: they have to end on the same tick, or the trace reports a
  // pass count and a settled rig that never happened.
  if (direction.perPass !== perPass)
    throw new Error("The speed trace and the direction trace must be the same length per pass.");
  const observation = {
    complete: false,
    first: first.report,
    kaykit: kaykit.report,
    passes: 0,
    released: false,
    settled: false,
    third: third.report,
    tick: 0,
  };
  let settled = 0;
  return {
    first,
    kaykit,
    observation,
    third,
    /** Advance the shared trace by one fixed tick for every consumer. */
    step(): void {
      const speed = script[observation.tick];
      const point = direction.points[observation.tick];
      const pose = direction.poses[observation.tick];
      observation.tick += 1;
      if (speed === undefined) {
        if (settled < SETTLE_TICKS) {
          settled += 1;
          observation.settled = true;
          third.tick(0);
          first.tick(0);
          // The idle is the direction domain's own centre, so the settle is speed 0 either way.
          kaykit.tick(0);
          return;
        }
        if (!observation.released) {
          observation.released = true;
          third.dispose();
          first.dispose();
          kaykit.dispose();
          observation.complete = true;
        }
        return;
      }
      third.tick(speed);
      first.tick(speed);
      kaykit.tick(speed, point, pose);
      observation.passes = Math.min(PASSES, Math.floor(observation.tick / perPass));
    },
  };
}
