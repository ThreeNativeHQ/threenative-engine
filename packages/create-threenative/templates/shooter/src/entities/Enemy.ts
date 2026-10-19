import {
  GroundSnap,
  type ICtx,
  type IStrideReport,
  SkeletalMesh3D,
  attachToBone,
  boneContact,
  measureThreePose,
  normaliseToMetres,
} from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import {
  type AnimationClip,
  Box3,
  BoxGeometry,
  Color,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { scale } from "../render/scale.js";
import type { TownCollider } from "../render/town.js";
import type { GameState } from "../state.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

/** One solid box in the world: nav, grounding and hit tests all read these. */
export type BoxCollider = TownCollider;

export type EnemyPhase = "patrol" | "suspicious" | "engage" | "search" | "return" | "dead";

const MAX_HEALTH = 36;
const WALK_SPEED = 2.4;
/**
 * Chase pace, in metres per second.
 *
 * It was 3.6, bounded to 2.75 by a rig that had no run cycle: the only locomotion clip was a
 * walk, so a 3.6 m/s chase drove its playback rate to 2.75 against a ceiling of 3 — a walk cycle
 * on fast-forward, which is the "moving faster than he is animated" read. The engine's stride
 * convention now holds `Rifle_Walk` against the ground, so the pace is bounded by the soldier.
 */
const CHASE_SPEED = 3.4;
const HEAR_RANGE = 26;
const VIEW_RANGE = 30;
const VIEW_HALF_ANGLE = MathUtils.degToRad(46);
const ENGAGE_RANGE = 13;
const BURST_ROUNDS = 3;
const BURST_SPACING = 0.11;
const BURST_COOLDOWN = 3.2;
const ROUND_DAMAGE = 9;
const RESPAWN_SECONDS = 4.5;
const AGENT_RADIUS = 0.48;
const NAV_CELL = 0.7;
const NAV_MIN = -16;
const NAV_MAX = 16;
const NAV_REPLAN_SECONDS = 0.4;
/** Seconds between first sighting and the first round, so the player is not shot on sight. */
const REACTION_SECONDS = 0.45;
const SPAWN_GRACE_SECONDS = 2.5;
/**
 * Animation blending, tuned by eye rather than by what typechecks.
 *
 * `LOCOMOTION_FADE` at 0.05 s is three frames, which pops; a quarter second reads as weight
 * shifting between feet. `LOCOMOTION_HOLD` stops the rig re-deciding every frame when crouch
 * state sits on a threshold, and `STILL_BEFORE_IDLE` stops one blocked step reading as a stop.
 */
const LOCOMOTION_FADE = 0.26;
const LOCOMOTION_HOLD_SECONDS = 0.3;
const STILL_BEFORE_IDLE_SECONDS = 0.16;
/**
 * Ground speed below which the rate is meaningless and a footstep is not a footstep.
 *
 * The playback rate itself is the engine's business: `SkeletalMesh3D` holds the clip against
 * the ground the body actually covered, off the root's own world motion, so a game never has to
 * measure a stride and re-time an action itself. This floor only decides when the squad has
 * stopped so far that the question is meaningless.
 */
const MOVING_SPEED_FLOOR = 0.3;
/**
 * Ground speed `Rifle_Crouch_Walk` carries at rate 1, in metres per second, measured off this
 * asset's own feet. It is the slowest locomotion clip the game has, so it is the one whose
 * playback rate the engine's stride convention has to push hardest when a body changes gait.
 */
const CROUCH_PACE = 0.81;

/**
 * How a body gets up to walking pace and back down again, in metres per second squared.
 *
 * Travel used to be `speed * dt` with no ramp at all. Traced over 359 frames of patrol, the
 * soldier was either standing at exactly 0 or travelling at exactly 2.400 m/s, and the change
 * between the two happened inside one frame. That single step is most of what reads as a
 * machine: nothing with legs reaches full pace instantly, and nothing with legs stops dead.
 * 6.5 m/s² is about 0.37 s to walking pace, which is roughly two steps.
 */
const WALK_ACCEL = 6.5;
const WALK_DECEL = 9;
/**
 * Steering and facing, in radians per second and radians per second squared.
 *
 * The old turn was `MathUtils.clamp(delta, -dt * 7, dt * 7)`: a bang-bang servo that sat at
 * exactly zero angular velocity, saturated at the cap for two or three frames at a waypoint,
 * and stopped dead. The same 359-frame trace held the heading bit-exactly constant on 343
 * frames and ran at 5–10 rad/s on the other 16. Carrying angular velocity and accelerating it
 * toward what the error asks for gives a turn that starts, peaks and settles.
 *
 * Travel direction is steered as well as facing, so a corner is a curve through the waypoint
 * rather than a vertex — the A* grid is 0.7 m, and turning hard at every grid point is what
 * made the route read as faceted. `#segmentClear` already keeps the corridor wide enough for
 * the body, and cornering sheds speed, so the curve stays inside what the search cleared.
 *
 * Steering is deliberately quicker than facing. `enemy-reaches-walkway` is the constraint: the
 * soldier has about eight seconds to cover twenty-five metres, and the first tuning — steering
 * at 3.1 rad/s with cornering cutting to a third of pace — cost roughly a metre and a half per
 * ninety-degree corner and he arrived too late, twice, against a baseline that passed twice.
 * At 4.6 rad/s a right-angle takes about a third of a second, which is what a walking person
 * takes, and the visible easing is all still there: peak turn rate stays under half of the old
 * clamp's, and the turn still spins up and settles instead of switching on and off.
 */
const STEER_RATE_MAX = 4.6;
const STEER_ACCEL = 26;
const STEER_SETTLE = 0.11;
const FACE_RATE_MAX = 4.4;
const FACE_ACCEL = 26;
const FACE_SETTLE = 0.12;
/**
 * Pace below which a coast is over, in metres per second.
 *
 * Two centimetres a second is under a millimetre a frame: past this the body is standing, and
 * carrying the remainder only keeps the walk clip alive on a soldier who has stopped.
 */
const COAST_FLOOR = 0.02;
/** Heading error, in radians, at which cornering has taken all the speed off it can. */
const CORNER_FULL = 2.2;
/** Slowest a corner may be taken, as a fraction of the requested speed. */
const CORNER_FLOOR = 0.55;
/** Metres from the end of the route over which he eases off instead of stopping on the mark. */
const ARRIVE_DISTANCE = 1.6;
const ARRIVE_FLOOR = 0.3;
/**
 * How far a soldier's facing may deviate from where his feet are going, in radians.
 *
 * `#engage` aimed the body at the player and then `#step` immediately overwrote that with the
 * travel heading, so a flanking soldier turned his back and jogged. Facing the player outright
 * is not the answer either: this rig has no strafe cycle, so a body moving sideways under a
 * forward walk clip moonwalks. 0.75 rad is as far as the feet can be wrong before that shows.
 */
const AIM_LEAD_MAX = 0.75;
/** Reactions and deaths are sharp events, but three frames is still a pop. */
const REACTION_FADE = 0.12;
const DEATH_FADE = 0.14;
const FIRE_FADE = 0.1;

/**
 * The clips this rig plays, by the name the AI states them under.
 *
 * `SkeletalMesh3D` is given the whole list as `requiredClips`, so a template shipped against an
 * asset that lost one of them throws at load with the missing name rather than quietly playing
 * nothing. Every name is a real clip on `assets/mannequin-combat.glb`; the pack also carries
 * `Sprint_Loop`, `Jump_*`, `Roll` and the pistol aim variants, which this game has no state for.
 */
export const ENEMY_CLIPS = [
  "Rifle_Idle",
  "Rifle_Walk",
  "Rifle_Crouch_To_Idle",
  "Rifle_Crouch_Walk",
  "Rifle_Shoot",
  "Rifle_Hit",
  "Death01",
] as const;

/**
 * Rifle rotation in `hand_r` space, degrees XYZ, per rifle clip: the barrel points at `hand_l`
 * and the sights at the sky. Measured off the retargeted clips
 * (hand_l in the hand_r frame, twelve samples a clip; the spread never exceeds 6 cm, so one
 * rotation per clip holds the whole cycle). Clips not listed keep the last hold.
 */
const RIFLE_HOLD: Readonly<Record<string, readonly [number, number, number]>> = {
  Rifle_Idle: [-80.1, -13.4, -148.4],
  Rifle_Walk: [-80.2, -21.4, -158.1],
  Rifle_Crouch_Walk: [-72.2, -17.9, -161.2],
  Rifle_Crouch_To_Idle: [-72.6, -16.3, -147.6],
  Rifle_Shoot: [-83.4, -20.1, -170],
  Rifle_Hit: [-70.4, -27.7, -113.4],
};

/**
 * The tint every soldier wears, in the template's own dark grey.
 *
 * The mannequin ships near-white, and the player's first-person hands are white gloves at the
 * bottom of the same frame. Two white figures in one image, one of which the player is looking
 * through and one of which he is shooting, is the readability problem the whole crate-blue /
 * orange-plate palette is built to avoid.
 */
const ENEMY_TINT = 0x4a4f57;

const ROUTE: readonly Vector3[] = [
  new Vector3(-4.5, 0, -9.5),
  new Vector3(-11.5, 0, -13.0),
  new Vector3(-1.0, 0, -15.0),
  new Vector3(4.5, 0, -11.0),
  new Vector3(11.6, 0, -8.6),
  new Vector3(1.5, 0, -6.5),
  new Vector3(-6.0, 0, -4.5),
];
const ROUTE_START = ROUTE[0] ?? new Vector3();

/**
 * Uniform world scale of an object, read straight off its world matrix.
 *
 * `Object3D.getWorldScale` decomposes the whole matrix and allocates a `Vector3`; the length of
 * the first basis column is the same number for the uniform scales this rig uses, and this runs
 * per soldier per frame.
 */
/**
 * Where a soldier's frame goes, accumulated across the squad.
 *
 * A section timer inside the per-soldier update, because "enemies cost 13 ms" is not something
 * anyone can act on. Peaks are per frame and reset by `beginSquadFrame`, so what comes out is
 * the worst single frame each stage has ever cost across all five soldiers together.
 */
/**
 * Shortest gap between two grid searches for one soldier when only the goal has drifted.
 *
 * `NAV_REPLAN_SECONDS` (0.4) is the gap for a route that has become obstructed. Reusing it for
 * goal drift is too coarse to navigate with: `enemy-reaches-walkway` caught a soldier failing to
 * work his way under the deck because he could not re-plan often enough to follow the target
 * around it. A tenth of a second still turns a per-frame search into one every six frames, which
 * is where nearly all of the saving was.
 *
 * Settled at 0.15 s, about nine frames. The scenario's flakiness turned out to be a stale sight
 * answer rather than a stale route — see `#canSee` — so this can be rationed properly: a route
 * re-aimed six times a second still tracks a running player, and the search stops being a
 * per-frame cost.
 */
const GOAL_REPLAN_SECONDS = 0.15;
/** Blocked-cell bitmaps per collider set, so the squad pays for the nav grid once. */
const NAV_GRIDS = new WeakMap<object, Map<string, Uint8Array>>();

// Scratch for the per-frame sight test; five soldiers × three vectors × 60 Hz is real garbage.
const scratchGoal = new Vector3();
const scratchTo = new Vector3();
const scratchFacing = new Vector3();
const scratchFlat = new Vector3();

/** Shortest signed rotation from one yaw to another, in radians. */
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/**
 * A yaw that carries its own angular velocity, so a turn eases in as well as out.
 *
 * Clamping the per-frame step — what `#turn` did — gives a body that is either not turning at
 * all or turning at exactly its maximum. There is no third state, and both edges are a step
 * change in angular velocity. Accelerating the rate toward `delta / settle` instead means the
 * turn spins up over a few frames, tops out at `maxRate`, and eases onto the target. Never
 * stepping past the remaining delta keeps it from ringing on a small correction.
 */
class EasedYaw {
  value: number;
  #rate = 0;
  readonly #maxRate: number;
  readonly #accel: number;
  readonly #settle: number;

  constructor(maxRate: number, accel: number, settle: number, value = 0) {
    this.#maxRate = maxRate;
    this.#accel = accel;
    this.#settle = settle;
    this.value = value;
  }

  /** Jump to a yaw with no turn at all: a respawn, or a body placed by a scenario. */
  set(value: number): void {
    this.value = value;
    this.#rate = 0;
  }

  /** `scale` trims the ceiling for a slower turn — looking around rather than reorienting. */
  step(target: number, dt: number, scale = 1): number {
    const delta = angleDelta(this.value, target);
    const ceiling = this.#maxRate * scale;
    const wanted = MathUtils.clamp(delta / this.#settle, -ceiling, ceiling);
    this.#rate += MathUtils.clamp(wanted - this.#rate, -this.#accel * dt, this.#accel * dt);
    const magnitude = Math.abs(delta);
    this.value += MathUtils.clamp(this.#rate * dt, -magnitude, magnitude);
    return this.value;
  }

  /** Drive the yaw directly — a scanning sweep — while keeping `rate` honest for the carriage. */
  spin(radiansPerSecond: number, dt: number): number {
    this.#rate = radiansPerSecond;
    this.value += radiansPerSecond * dt;
    return this.value;
  }
}

/**
 * The rifle every soldier carries, built from five boxes.
 *
 * ## Why it is written rather than downloaded
 *
 * The old rig carried a rigged AK-47 with retargeted Mixamo clips, which meant a second skinned
 * asset per soldier, a `Grip_Bone` to align against, a magazine bone to read a muzzle from, and
 * a 90-line pose table translating one weapon's animation into another's. The mannequin has no
 * weapon socket and no rifle clips, so all of that was solving a problem the template no longer
 * has — and shipping ~1 MB of AK geometry into every scaffolded project to do it.
 *
 * Five boxes read as a rifle at the distances a soldier is ever seen from, cost twelve triangles,
 * and normalise to `scale.rifleLength` like any other prop. The grip is the holder's own origin,
 * so the right hand lands on it by construction and there is nothing to align afterwards.
 *
 * ## Layout, in metres, along the barrel (+z is the muzzle)
 *
 *   receiver   0.42 long, centred at z 0.06   the body and the sight line
 *   barrel     0.30 long, centred at z 0.40   thin, forward
 *   magazine   0.14 long, below at z 0.02      the tell that reads as "rifle" from the front
 *   stock      0.24 long, behind at z -0.26    what puts the shoulder line in the right place
 *   grip       0.10 long, below at z -0.04     the block the fist closes around
 *
 * ## The hold
 *
 * `hand_r`'s own axes run *down the arm*, so the rifle's barrel (+Z) has to be turned toward the
 * left hand and its sights toward the sky in that bone's space. Where that is depends on the
 * clip, so `RIFLE_HOLD` carries one rotation per rifle clip and `#holdRifle` applies it on every
 * clip change; `rightHandContact` and `leftHandContact` (engine `boneContact`) prove both fists
 * reach the gun.
 */
function buildRifle(): Group {
  const rifle = new Group();
  rifle.name = "enemy-rifle";
  const part = (
    name: string,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
  ): void => {
    const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), rifleMaterial());
    mesh.name = name;
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    rifle.add(mesh);
  };
  part("receiver", [0.05, 0.09, 0.42], [0, 0, 0.06]);
  part("barrel", [0.03, 0.03, 0.3], [0, 0.01, 0.4]);
  part("magazine", [0.04, 0.14, 0.06], [0, -0.1, 0.02]);
  part("stock", [0.04, 0.08, 0.24], [0, -0.01, -0.26]);
  part("grip", [0.04, 0.1, 0.05], [0, -0.08, -0.04]);
  return rifle;
}

/** One shared material: the rifle never changes colour, so five meshes cost one pipeline. */
let rifleSurface: MeshStandardMaterial | undefined;
function rifleMaterial(): MeshStandardMaterial {
  rifleSurface ??= new MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.55, metalness: 0.5 });
  return rifleSurface;
}

export type EnemyHooks = {
  /** True when nothing solid blocks the segment. */
  readonly lineOfSight: (from: Vector3, to: Vector3) => boolean;
  readonly damagePlayer: (amount: number) => void;
  readonly onMuzzleFlash: (at: Vector3, direction: Vector3, distance: number) => void;
  /**
   * A foot planted while actually moving — at most twice per walk cycle, read off
   * the locomotion action's phase so steps stay glued to the animation.
   */
  readonly onFootstep?: (at: Vector3) => void;
};

/** Raised-deck footprints this soldier may be routed beneath. */
export type DeckFootprint = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
};

export type EnemyOptions = {
  /** Patrol loop to walk and return to; defaults to the single range route. */
  readonly route?: readonly Vector3[];
  /** Ground rectangle the navigation grid covers; defaults to the old yard. */
  readonly navBounds?: { readonly min: number; readonly max: number };
  /** Raised deck footprints, reported by `underDeck` so a scenario can see routing under them. */
  readonly decks?: readonly DeckFootprint[];
  /**
   * Scenario-placed sentry: stands at route[0] and never walks it. Hearing and vision
   * are disconnected, so rounds landing near him cannot turn the rest of the shot into
   * pursuit; a killing round still plays the full death. Shooting scenarios need a
   * target whose hit window does not depend on where a patrol happens to be.
   */
  readonly frozen?: boolean;
};

/** First bone whose name matches, for a model that renames the bones this rig relies on. */
function findBone(root: Object3D, pattern: RegExp): Object3D | undefined {
  let found: Object3D | undefined;
  root.traverse((object) => {
    if (found === undefined && pattern.test(object.name)) found = object;
  });
  return found;
}

/**
 * Give one mesh its own material instances, cloned off whatever it was assigned.
 *
 * `SkeletalMesh3D` clones the skeleton per soldier (three's own `SkeletonUtils.clone`), but its
 * own doc comment says the quiet part: "geometries and materials … are reused by reference." All
 * five soldiers' meshes point at the exact same `MeshStandardMaterial` objects the GLTF parsed
 * once. Tinting it is harmless — every soldier wants the same colour — but `#setOpacity` is not:
 * it writes `opacity` on that shared object to fade one corpse in or out, so for the ~0.35 s a
 * kill is respawning, every *other* soldier's mesh reads that same falling-then-rising opacity
 * and flickers transparent with him. That is the intermittent "enemy texture doesn't load" —
 * a live soldier going half-invisible because a dead one two lanes over is fading. Cloning here,
 * once per mesh at construction, is what makes a soldier's blend state his own.
 */
function ownMaterial(mesh: Mesh): void {
  mesh.material = Array.isArray(mesh.material)
    ? mesh.material.map((one) => one.clone())
    : (mesh.material as MeshStandardMaterial).clone();
}

/**
 * Recolour one body material in place.
 *
 * `color` is written rather than `set`, and `needsUpdate` is left alone: the diffuse colour is a
 * uniform the pipeline already carries, so a soldier joining the squad costs no shader compile.
 */
function tintEnemyMaterial(material: MeshStandardMaterial | MeshStandardMaterial[]): void {
  for (const one of Array.isArray(material) ? material : [material]) {
    one.color.setHex(ENEMY_TINT);
  }
}

export class Enemy {
  readonly group = new Group();
  readonly hitbox: Mesh;
  health = MAX_HEALTH;
  phase: EnemyPhase = "patrol";
  wounded = false;
  /**
   * Combat voice, assigned by the scene and throttled there (one shout at a time
   * across the squad). Optional so tests and headless rigs run mute.
   */
  voice:
    | {
        readonly spot: (at: Vector3) => void;
        readonly chase: (at: Vector3) => void;
        readonly pain: (at: Vector3) => void;
        readonly death: (at: Vector3) => void;
      }
    | undefined;
  /**
   * Whether the body is snapped down so its lowest posed point rests on the deck.
   *
   * On is right for a soldier walking a range: the planted foot has to touch the floor and
   * the corpse has to lie on it. Turn it off for anything that is legitimately airborne —
   * a fall, a ragdoll driven by physics, a vault, a scripted drop — otherwise this pins the
   * body to the ground and eats the motion. `footClearance` keeps reporting the real height
   * either way, so a scenario can still see where the body actually is.
   */
  groundSnap = true;
  /**
   * The rig, driven by its own clips.
   *
   * `SkeletalMesh3D` is the whole body layer: it clones the skeleton once per soldier, normalises
   * the clone, and mounts the clips with `requiredClips` so a missing one throws by name at load.
   * Its stride convention holds the current clip's playback rate against the ground the body
   * actually covered, measured off the root's world motion — which is what this file used to do
   * itself, with ninety lines of stride sampling and its own rate clamps.
   */
  #character: SkeletalMesh3D;
  /** Keeps the lowest posed point of the body on the deck, off a cached skin envelope. */
  #ground: GroundSnap;
  #clips: ReadonlySet<string>;
  #clipDurations = new Map<string, number>();
  #routeIndex = 0;
  #target = new Vector3();
  #lastSeen = new Vector3();
  #alertTimer = 0;
  #burstLeft = 0;
  #burstTimer = 0;
  #cooldown = 0;
  #strafe = 1;
  #strafeTimer = 0;
  #deadFor = 0;
  #fade = 1;
  /**
   * Sticky lowest body opacity this soldier has ever carried, so a scenario watching a
   * *different* soldier's respawn cycle can prove this one never dipped — the regression
   * `ownMaterial` fixes wrote every soldier's opacity to whichever one was fading.
   */
  #opacityFloor = 1;
  #bodyClearance: number | null = null;
  #footClearance: number | null = null;
  #deathObserved = false;
  /**
   * Sticky record of the last death: which clip ran and how many frames it advanced. Sticky
   * because the corpse is gone 4.5 s later, so a scenario sampling after the respawn would
   * otherwise see a live soldier and be unable to tell a played death from a frozen one.
   */
  #deathClip: string | null = null;
  #deathClipFrames = 0;
  /** Travel direction of the round that last connected, so the body falls away from the shooter. */
  #lastHitDirection: Vector3 | null = null;
  #hips: Object3D | undefined;
  /** Hip world position at the instant of death, so the fall direction can be measured. */
  #deathHipStart: Vector3 | null = null;
  /** Sticky fall measurement: the corpse is gone before a scenario can read a live value. */
  #deathFallMeasured: number | null = null;
  /** True while the last locomotion frame was a crouch, so standing up can play its transition. */
  #crouchMoving = false;
  /** Seconds left of the crouch-to-stand transition, during which no locomotion clip overrides it. */
  #standUp = 0;
  /** Seconds left of being under fire. Degrades aim and keeps the soldier low. */
  #suppressed = 0;
  #suppressedPeak = 0;
  /**
   * Frames each clip has actually advanced this session. The rig ships twenty clips; without a
   * per-clip count nothing catches four of them quietly going unused again.
   */
  #clipFrames = new Map<string, number>();
  /** Worst `boneContact` metres either hand has been from the rifle, per clip, sampled every 4th frame. */
  #contactPeak = new Map<string, number>();
  /** Locomotion clip currently committed to, and how long before another switch is allowed. */
  #locomotion = "";
  #locomotionHold = 0;
  /** Walk-cycle phase bookkeeping for the footstep hook: which half-cycle last planted a foot. */
  #lastStepClip = "";
  #lastStepHalf = -1;
  /** Clips by name, so a footstep can be read off the action the engine is playing. */
  #clipsByName = new Map<string, AnimationClip>();
  /** Where the body stood at the top of this frame, so ground speed is measured, not assumed. */
  #frameStart = new Vector3();
  #groundSpeed = 0;
  /**
   * Ground pace he is actually carrying, in metres per second. Ramped toward whatever the
   * current behaviour asked for rather than adopted outright — see `WALK_ACCEL`.
   */
  #pace = 0;
  /** True when a movement branch ran `#step` this frame; if none did, he coasts to a stop. */
  #stepped = false;
  /** Direction he is travelling, and which way the body is pointed. Both eased, both stateful. */
  #heading = new EasedYaw(STEER_RATE_MAX, STEER_ACCEL, STEER_SETTLE);
  #facing = new EasedYaw(FACE_RATE_MAX, FACE_ACCEL, FACE_SETTLE);
  /**
   * This soldier's own pace, as a multiplier. Five men walking at exactly 2.400 m/s in step
   * with each other is a tell no amount of animation work can cover. Seeded, so a replay of
   * the same run puts every soldier in the same place.
   */
  #gait = 1;
  /**
   * Seconds the flinch still owns the pose.
   *
   * Without it `Rifle_Hit` was set by `hurt` and overwritten by `#playLocomotion` on the very
   * next frame, because the locomotion branch re-asserts its clip every frame and `#play` only
   * declines when the clip it is asked for is already current. Measured over two 45 s runs and
   * 678 samples: the flinch was never the current clip on a single one. A soldier who does not
   * flinch when hit is the loudest "this is a state machine" cue in the game, and it was one line.
   */
  #reactionHold = 0;
  /** Seconds the body has been continuously still, so one blocked frame is not a stop. */
  #stillFor = 0;
  #lastHitMultiplier = 1;
  #modelHeightMeasured: number = scale.humanHeight;
  #hitboxWidth: number = scale.shoulderWidth;
  #hitboxHeight: number = scale.humanHeight;
  #hitboxDepth: number = scale.bodyDepth;
  #crown: Object3D | undefined;
  #head: Object3D | undefined;
  #leftKnee: Object3D | undefined;
  #rightKnee: Object3D | undefined;
  #colliders: readonly BoxCollider[];
  #bodyMeshes: Object3D[] = [];
  #poseBones: Object3D[] = [];
  #bodyProxy: Object3D | undefined;
  #body: CharacterBody3D | undefined;
  #weapon: Object3D | undefined;
  #weaponModel: Object3D | undefined;
  #weaponDetached = false;
  #weaponSettled = false;
  #weaponVelocity = new Vector3();
  #rifleLocalMinZ = -scale.rifleLength * 0.35;
  #rifleLocalMaxZ = scale.rifleLength * 0.65;
  #rightHand: Object3D | undefined;
  #leftHand: Object3D | undefined;
  #weaponNodes: string[] = [];
  #renderedRifleLength: number | null = null;
  /** Seconds left before it may fire after first seeing the player — it is not a turret. */
  #reaction = 0;
  /** Cached A* route. Dynamic combat goals are replanned without changing direction every frame. */
  #path: Vector3[] = [];
  #pathIndex = 0;
  #pathGoal = new Vector3();
  #replanIn = 0;
  /** Countdown for goal-drift replans, kept apart from the obstruction cooldown. */
  #goalReplanIn = 0;
  #searchAtGoal = 0;
  #patrolPause = 0;
  #previousGroundSpeed = 0;
  #decelPeak = 0;
  /** Set on the frames a hard stop is honest — walking into a wall, dying, being placed. */
  #decelExempt = false;
  #spawnGrace = SPAWN_GRACE_SECONDS;
  #route: readonly Vector3[] = ROUTE;
  #navMin = NAV_MIN;
  #navMax = NAV_MAX;
  #decks: readonly DeckFootprint[] = [];
  #frozen = false;

  constructor(
    ctx: GameCtx,
    model: Object3D,
    clips: readonly AnimationClip[],
    colliders: readonly BoxCollider[],
    options: EnemyOptions = {},
  ) {
    this.#colliders = colliders;
    this.#route = options.route ?? ROUTE;
    this.#navMin = options.navBounds?.min ?? NAV_MIN;
    this.#navMax = options.navBounds?.max ?? NAV_MAX;
    this.#decks = options.decks ?? [];
    this.#frozen = options.frozen ?? false;
    this.#pathGoal.copy(this.#route[0] ?? ROUTE_START);
    this.#target.copy(this.#route[0] ?? ROUTE_START);
    model.removeFromParent();
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.setScalar(1);
    model.updateWorldMatrix(false, true);
    // Bone names are read off the *source*, because `SkeletalMesh3D` clones it and remaps the
    // requested measurement joint onto its own copy.
    const sourceHead = model.getObjectByName("Head") ?? findBone(model, /head/i);
    this.#clips = new Set(clips.map((clip) => clip.name));
    this.#clipDurations = new Map(clips.map((clip) => [clip.name, clip.duration]));
    this.#clipsByName = new Map(clips.map((clip) => [clip.name, clip]));
    // `Head` is the base of the skull on this skeleton, not the crown, so 1.545 m at that joint
    // is the 1.8 m figure the rest of the game is measured against — the same convention
    // `minimal` opens every project with (see its `src/conventions.ts`).
    this.#character = new SkeletalMesh3D({
      clips,
      requiredClips: [...ENEMY_CLIPS],
      // Stride is measured from the *body's* motion, not the figure's: `group` is what `#step`
      // moves, and it is what `GroundSnap` corrects.
      strideRoot: this.group,
      size: { axis: "height", metres: 1.545, top: sourceHead ?? undefined },
      source: model,
    });
    const figure = this.#character.root;
    this.#crown = figure.getObjectByName("Head") ?? findBone(figure, /head/i);
    this.#head = this.#crown;
    // The mannequin's knees are its calves: `calf_l` / `calf_r`.
    this.#leftKnee = figure.getObjectByName("calf_l") ?? findBone(figure, /left.*knee|left.*leg/i);
    this.#rightKnee =
      figure.getObjectByName("calf_r") ?? findBone(figure, /right.*knee|right.*leg/i);
    this.#hips = figure.getObjectByName("pelvis") ?? findBone(figure, /hips/i);
    figure.traverse((object) => {
      if (/pelvis|hips|thigh|upleg|calf|leg|foot|ball|toe|head/i.test(object.name))
        this.#poseBones.push(object);
      const mesh = object as Mesh;
      if (mesh.isMesh === true) {
        this.#bodyMeshes.push(mesh);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        // Own material instances before touching them: see `ownMaterial`.
        ownMaterial(mesh);
        tintEnemyMaterial(mesh.material as MeshStandardMaterial | MeshStandardMaterial[]);
      }
    });
    this.group.add(figure);
    this.#ground = new GroundSnap(figure, { enabled: false, meshes: this.#bodyMeshes });
    this.#equip(figure);
    // Before the first draw, not on the first death. `#respawn` also calls this, but `#respawn`
    // only ever runs off the death timer, so a soldier that has never died would otherwise reach
    // his own death still carrying the blend state the asset shipped with — which is both a
    // mid-fight pipeline compile and, once `#setOpacity` stopped flipping the flag, a fade that
    // does not render at all because opacity is ignored on an opaque material.
    this.#fixBlendState();
    this.group.name = "enemy";
    this.group.position.copy(this.#route[0] ?? ROUTE_START);
    const firstWaypoint = this.#route[1];
    if (firstWaypoint !== undefined) {
      this.#target.copy(firstWaypoint);
      this.#routeIndex = 1;
      this.group.rotation.y = Math.atan2(
        this.#target.x - this.group.position.x,
        this.#target.z - this.group.position.z,
      );
    }
    this.group.rotation.y = Math.atan2(
      this.#target.x - this.group.position.x,
      this.#target.z - this.group.position.z,
    );
    this.#heading.set(this.group.rotation.y);
    this.#facing.set(this.group.rotation.y);
    // Seeded per soldier: 0.94–1.06 is enough to break the squad out of lockstep and still
    // leaves a walking soldier well clear of the walk/jog switch.
    this.#gait = ctx.random.range(0.94, 1.06);

    // Skinned meshes are the slow path for picking, so the rifle traces a plain
    // box proxy that follows the body. Invisible, but still raycastable.
    this.#modelHeightMeasured = this.modelHeight || scale.humanHeight;
    // Width and depth are declared sizes, not measurements. A whole-body AABB is not a
    // hitbox: in the bind pose this rig measures 1.11 m across because the arms are out in a
    // T, and over a walk cycle it measures 1.13 m deep because the stride reaches fore and
    // aft. Both would make a man a barn door to shoot at. Height stays measured, from the `Head`
    // joint, which is the base of the skull: the skull itself stands one head above it, so the box
    // adds that. Without it every round aimed above 1.545 m passed over a 1.80 m soldier.
    this.#hitboxWidth = scale.shoulderWidth;
    this.#hitboxHeight = this.#modelHeightMeasured + scale.headRadius * 2;
    this.#hitboxDepth = scale.bodyDepth;
    this.hitbox = new Mesh(
      new BoxGeometry(this.#hitboxWidth, this.#hitboxHeight, this.#hitboxDepth),
      new MeshBasicMaterial({ visible: false }),
    );
    this.hitbox.position.y = this.#hitboxHeight / 2;
    this.hitbox.userData.enemy = this;
    this.group.add(this.hitbox);

    const bodyProxy = new Group();
    bodyProxy.name = "enemy-body";
    ctx.add(bodyProxy);
    this.#bodyProxy = bodyProxy;
    this.#body = new CharacterBody3D({
      physics: ctx.physics,
      object: bodyProxy,
      entity: "enemy-body",
      shape: CollisionShape3D.box(this.#hitboxWidth, this.#hitboxHeight, this.#hitboxDepth),
      gravity: 0,
      collisionLayer: 2,
      collisionMask: 1,
    });
    this.#syncCollisionBody();

    this.#play("Rifle_Walk");
  }

  get alive(): boolean {
    return this.phase !== "dead";
  }

  /**
   * What the playtest bridge reads off a registered entity, and what `assert.animation[]` bounds.
   *
   * The harness already has a first-class assertion for the thing this file used to measure by
   * hand — `maxFootSlide` over `|feet - ground| / ground`, and `strideSynced` to prove the
   * convention is actually applied rather than bypassed. Publishing the engine's own stride
   * report is what makes those scenarios possible; without it a scenario has to re-derive the
   * same ratio from game-side numbers and can only agree with itself.
   */
  get animation(): {
    current: string;
    advancedFrames: number;
    finished: boolean;
    stride: IStrideReport;
  } {
    return {
      advancedFrames: this.#character.advancedFrames,
      current: this.#character.current ?? "",
      finished: this.#character.finished,
      stride: this.#character.stride,
    };
  }

  /** Chest height, used as the eye and muzzle origin. */
  get chest(): Vector3 {
    return new Vector3(
      this.group.position.x,
      this.group.position.y + this.bodyHeight * 0.8,
      this.group.position.z,
    );
  }

  /**
   * Rendered height, boots to head-top, measured off the skeleton.
   *
   * A `Box3` over a skinned mesh reports the *bind pose* transformed by the world matrix,
   * not the posed body — which is precisely how a 2.68 m soldier stood beside a 1.66 m
   * player without any gate noticing. The head-top bone is posed, so it tells the truth, and
   * `getWorldPosition` refreshes the bone chain itself rather than trusting a matrix written
   * by the last frame.
   */
  get modelHeight(): number {
    const crown =
      this.#crown ??
      findBone(this.group, /headtop|head_end|head.*end/i) ??
      findBone(this.group, /head/i);
    this.#crown = crown;
    if (crown === undefined) return 0;
    return crown.getWorldPosition(new Vector3()).y - this.group.position.y;
  }

  get bodyBase(): number {
    return this.group.position.y;
  }

  get bodyHeight(): number {
    return this.modelHeight || this.#modelHeightMeasured;
  }

  get headZoneMinY(): number {
    const head = this.#head?.getWorldPosition(new Vector3());
    return (head?.y ?? this.bodyBase + this.bodyHeight) - scale.headRadius;
  }

  get legZoneMaxY(): number {
    const left = this.#leftKnee?.getWorldPosition(new Vector3()).y;
    const right = this.#rightKnee?.getWorldPosition(new Vector3()).y;
    const knees = [left, right].filter((value): value is number => value !== undefined);
    return knees.length > 0
      ? Math.max(...knees)
      : this.bodyBase + this.bodyHeight * scale.legZoneFraction;
  }

  /**
   * Put the rifle in the enemy's right hand.
   *
   * The mannequin's clips pose a bare figure, so the arms are not already holding anything and
   * the rifle has to be welded to `hand_r` by hand. The grip block sits at the rifle's own
   * origin (see `buildRifle`), so attaching the rifle itself to the bone puts the fist around
   * the grip with no follow-up alignment — which is the whole reason the rifle is five boxes
   * rather than a model with a `Grip_Bone` in it.
   */
  #equip(model: Object3D): void {
    const hand = model.getObjectByName("hand_r") ?? findBone(model, /right.*hand|hand.*r$|hand_r/i);
    this.#rightHand = hand;
    this.#leftHand =
      model.getObjectByName("hand_l") ?? findBone(model, /left.*hand|hand.*l$|hand_l/i);

    const rifle = buildRifle();
    this.#weaponModel = rifle;
    this.#weaponNodes.push("receiver", "barrel", "magazine", "stock", "grip");
    const bounds = new Box3().setFromObject(rifle);
    this.#rifleLocalMinZ = bounds.min.z;
    this.#rifleLocalMaxZ = bounds.max.z;

    if (hand === undefined) {
      // No hand bone: hang it beside the hip rather than dropping it. A soldier without a
      // visible arm is already a broken rig; a rifle at his side still reads.
      rifle.position.set(0.16, 1.0, 0.06);
      this.group.add(rifle);
      this.#weapon = rifle;
      normaliseToMetres(rifle, { axis: "longest", metres: scale.rifleLength });
      this.#renderedRifleLength = this.#measureRenderedWeapon(rifle);
      return;
    }
    // The engine's attachment keeps the rifle's authored world scale under the hand bone;
    // the measured re-normalisation below still has the final word on length.
    attachToBone(model, hand.name, rifle);
    this.#weapon = rifle;
    normaliseToMetres(rifle, { axis: "longest", metres: scale.rifleLength });
    this.#holdRifle("Rifle_Idle");
    this.#renderedRifleLength = this.#measureRenderedWeapon(rifle);
  }

  #detachWeapon(ctx: GameCtx): void {
    const holder = this.#weapon;
    if (holder === undefined) return;
    ctx.scene.attach(holder);
    this.#weaponDetached = true;
    this.#weaponSettled = false;
    this.#weaponVelocity
      .set(0.45, 1.4, -0.25)
      .applyAxisAngle(new Vector3(0, 1, 0), this.group.rotation.y);
  }

  #updateDetachedWeapon(dt: number, deckY: number): void {
    const holder = this.#weapon;
    if (holder === undefined || !this.#weaponDetached || this.#weaponSettled) return;
    this.#weaponVelocity.y -= 9.81 * dt;
    holder.position.addScaledVector(this.#weaponVelocity, dt);
    holder.rotation.x += dt * 2.7;
    holder.rotation.z += dt * 1.9;
    holder.updateWorldMatrix(false, true);
    const minimum = new Box3().setFromObject(holder).min.y;
    if (minimum < deckY) {
      holder.position.y += deckY - minimum;
      this.#weaponVelocity.set(0, 0, 0);
      this.#weaponSettled = true;
    }
    holder.updateWorldMatrix(false, true);
  }

  #reattachWeapon(): void {
    const holder = this.#weapon;
    if (holder === undefined || this.#rightHand === undefined) return;
    this.#rightHand.add(holder);
    this.#weaponDetached = false;
    this.#weaponSettled = false;
    this.#weaponVelocity.set(0, 0, 0);
  }

  #measureRenderedWeapon(weapon: Object3D): number {
    weapon.updateWorldMatrix(true, true);
    const size = new Box3().setFromObject(weapon).getSize(new Vector3());
    return Math.max(size.x, size.y, size.z);
  }

  #syncCollisionBody(): void {
    const proxy = this.#bodyProxy;
    const body = this.#body;
    if (proxy === undefined || body === undefined) return;
    proxy.position.set(
      this.group.position.x,
      this.group.position.y + this.#hitboxHeight / 2,
      this.group.position.z,
    );
    body.teleport(proxy.position);
  }

  /**
   * Fade a soldier in or out without changing his pipeline.
   *
   * `transparent` and `depthWrite` are blend and depth state, not shader uniforms, so flipping
   * either one makes WebGPU compile a *new* render pipeline for every material it touches — and a
   * soldier is a skinned mesh with several. This used to set `transparent = alpha < 0.999` and
   * `depthWrite = alpha > 0.5`, which meant the first death in a round compiled a fresh pipeline
   * per material on the frame the corpse started fading. Measured as a single ~180 ms frame,
   * mid-round, entirely outside game logic: `outsideGame` peaked at 177-186 ms with a firefight in
   * the scenario and 28.6 ms without one, on identical movement.
   *
   * So the state is fixed at construction and never moves. Only `opacity` changes, which is a
   * uniform the existing pipeline already reads. `needsUpdate` is deliberately not set: it forces
   * the material to be re-evaluated, and there is nothing left to re-evaluate.
   *
   * Keeping `depthWrite` on for a fading corpse is the deliberate half of this. It costs a little
   * correctness on a half-faded body seen through another one, and it buys never compiling
   * mid-fight — and a corpse fading on the ground is not what anyone is looking at.
   */
  #setOpacity(alpha: number): void {
    const objects = [
      ...this.#bodyMeshes,
      ...(this.#weaponModel === undefined ? [] : [this.#weaponModel]),
    ];
    for (const object of objects) {
      object.traverse((child) => {
        const mesh = child as Mesh;
        if (mesh.isMesh !== true) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          material.opacity = alpha;
        }
      });
    }
    this.#fade = alpha;
    if (alpha < this.#opacityFloor) this.#opacityFloor = alpha;
  }

  /**
   * Put every material into its final blend state once, before the soldier is ever drawn.
   *
   * Called at construction so the transparent pipeline is compiled during loading, where a long
   * frame is part of the loading screen, rather than on the frame someone dies.
   */
  #fixBlendState(): void {
    const objects = [
      ...this.#bodyMeshes,
      ...(this.#weaponModel === undefined ? [] : [this.#weaponModel]),
    ];
    for (const object of objects) {
      object.traverse((child) => {
        const mesh = child as Mesh;
        if (mesh.isMesh !== true) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          material.transparent = true;
          material.depthWrite = true;
          material.needsUpdate = true;
        }
      });
    }
  }

  /** Muzzle point in world space: the weapon tip when equipped, the chest otherwise. */
  muzzle(): Vector3 {
    const weapon = this.#weapon;
    if (weapon === undefined) return this.chest;
    const tip = new Vector3(0, 0, this.#rifleLocalMaxZ);
    return weapon.localToWorld(tip);
  }

  /**
   * `override` is what makes the flinch survive.
   *
   * Every branch of the state machine re-asserts its own clip every frame, so a one-shot pose set
   * from outside the machine — the flinch, which is the only one — was replaced on the next frame
   * by whichever branch ran. Guarding the two call sites was not enough: the spawn-grace branch
   * plays `Rifle_Idle` directly rather than through `#playLocomotion`, and the burst plays
   * `Rifle_Shoot` on every round. One refusal here covers all of them, and death passes
   * `override` because a corpse outranks a flinch.
   */
  #play(name: string, fade = 0.18, mode: "loop" | "once" = "loop", override = false): void {
    if (!this.#clips.has(name)) return;
    if (!override && this.#reactionHold > 0) return;
    if (this.#character.current === name) return;
    this.#character.play(name, { fade, mode });
    this.#holdRifle(name);
  }

  #holdRifle(clip: string): void {
    const hold = RIFLE_HOLD[clip];
    if (hold !== undefined) {
      this.#weaponModel?.rotation.set(
        ...(hold.map(MathUtils.degToRad) as [number, number, number]),
      );
    }
  }

  /**
   * Pick the locomotion clip from what the body is actually doing.
   *
   * Two things this fixes beyond using more of the rig: the walk cycle no longer plays while
   * the soldier is standing still against a blocked path, and standing up out of a crouch runs
   * its authored transition instead of popping straight to idle.
   *
   * `armed` is the one state the locomotion set cannot express. A planted soldier on `Rifle_Idle`
   * has both arms at his sides while his rifle is welded to one of them, which reads as a man
   * carrying a rifle in his teeth; `Rifle_Idle` is a retargeted rifle-ready pose with both hands on
   * the gun.
   */
  #playLocomotion(
    moving: boolean,
    crouched: boolean,
    dt: number,
    poseLocked = false,
    armed = false,
  ): void {
    // Ground speed is measured from where the body actually got to this frame, not from the
    // speed constant it was asked for: a blocked step, a corner, or a slow turn all cut it.
    this.#groundSpeed =
      dt > 0
        ? Math.hypot(
            this.group.position.x - this.#frameStart.x,
            this.group.position.z - this.#frameStart.z,
          ) / dt
        : 0;
    // How hard the body braked this frame, in metres per second squared.
    //
    // A soldier sheds pace at WALK_DECEL and no faster. Anything above it means the body was
    // teleported to rest rather than walked to it, which is what a patrol pause used to do:
    // `#brake` decays `#pace`, `#pace` is read only by `#step`, and the pause called neither —
    // so ground speed went 2.31 to 0 between two frames while the legs were mid-stride.
    // Exempt frames are the stops that are honest: a wall, a death, a scenario placement.
    if (dt > 0 && !this.#decelExempt) {
      const braking = (this.#previousGroundSpeed - this.#groundSpeed) / dt;
      if (braking > this.#decelPeak) this.#decelPeak = braking;
    }
    this.#previousGroundSpeed = this.#groundSpeed;
    this.#decelExempt = false;
    // One frame against a wall, or one frame of a replan, is not a stop. Without this the
    // walk clip strobes against idle whenever the path is briefly blocked.
    this.#stillFor = moving ? 0 : this.#stillFor + dt;
    // The burst clip and the flinch own the pose while they last, but the body keeps reporting the
    // ground speed it is actually making. Returning before the measurement above froze
    // `#groundSpeed` at whatever it was when the burst started, which drove `#updateFootsteps`
    // into playing footfalls for a soldier standing still.
    if (poseLocked || this.#reactionHold > 0) return;
    const travelling = this.#stillFor < STILL_BEFORE_IDLE_SECONDS;

    let wanted: string;
    if (travelling) {
      // Crouch state changes on the frame he is suppressed or wounded, but the body takes
      // `WALK_DECEL` to shed the pace it was carrying. Dropping onto the crouch clip during
      // that window puts a 0.807 m/s creep under a body still making walking pace, which reads
      // as foot slide — so the clip waits for the legs.
      const creeping = this.#groundSpeed <= CROUCH_PACE * 1.02;
      wanted =
        crouched && creeping && this.#clips.has("Rifle_Crouch_Walk")
          ? "Rifle_Crouch_Walk"
          : "Rifle_Walk";
    } else if (this.#crouchMoving && this.#clips.has("Rifle_Crouch_To_Idle")) {
      // Standing up runs its authored transition, and owns the pose until it finishes.
      this.#crouchMoving = false;
      this.#standUp = this.#clipDurations.get("Rifle_Crouch_To_Idle") ?? 0.5;
      this.#locomotion = "Rifle_Crouch_To_Idle";
      this.#locomotionHold = this.#standUp;
      this.#play("Rifle_Crouch_To_Idle", LOCOMOTION_FADE, "once");
      return;
    } else {
      if (this.#standUp > 0) return;
      wanted = "Rifle_Idle";
    }

    // Commit to a locomotion clip for a beat. Crouch state can flicker as suppression decays
    // or a burst starts, and a rig that re-blends every frame reads as a twitch, not a soldier.
    if (wanted !== this.#locomotion && this.#locomotionHold > 0) return;
    if (wanted !== this.#locomotion) this.#locomotionHold = LOCOMOTION_HOLD_SECONDS;
    this.#locomotion = wanted;
    this.#crouchMoving = wanted === "Rifle_Crouch_Walk";
    this.#standUp = travelling ? 0 : this.#standUp;
    this.#play(wanted, LOCOMOTION_FADE);
  }

  /**
   * How far the corpse travelled along the killing round's direction, in metres, measured on
   * the hips and flattened to the deck. Positive means he fell away from the shooter, which is
   * true of both death clips when they are mapped the right way round.
   */
  #deathFallDot(): number | null {
    const start = this.#deathHipStart;
    const round = this.#lastHitDirection;
    if (start === null || round === null || this.#hips === undefined) return null;
    const now = this.#hips.getWorldPosition(new Vector3());
    const travel = new Vector3(now.x - start.x, 0, now.z - start.z);
    const heading = new Vector3(round.x, 0, round.z);
    if (heading.lengthSq() < 1e-6) return null;
    return travel.dot(heading.normalize());
  }

  #countClipFrame(): void {
    const current = this.#character.current;
    if (current === undefined) return;
    const frames = (this.#clipFrames.get(current) ?? 0) + 1;
    this.#clipFrames.set(current, frames);
    // Not the first frames: a clip that has only just started is still a crossfade from the last.
    if (frames < 12 || frames % 4 !== 0 || this.#weaponDetached) return;
    const worst = Math.max(this.#contact("hand_r") ?? 0, this.#contact("hand_l") ?? 0);
    this.#contactPeak.set(current, Math.max(this.#contactPeak.get(current) ?? 0, worst));
  }

  /**
   * Fire `hooks.onFootstep` each time the locomotion action crosses a half-cycle
   * boundary — one planted foot per half-cycle, so a re-timed walk keeps its steps
   * in step with the animation rather than with a timer. A clip switch resets the
   * phase so the first frame of a new clip cannot read as a plant.
   */
  #updateFootsteps(hooks: EnemyHooks): void {
    if (hooks.onFootstep === undefined || this.#groundSpeed < MOVING_SPEED_FLOOR) return;
    const clip = this.#clipsByName.get(this.#locomotion);
    if (clip === undefined || clip.duration <= 0) return;
    const action = this.#character.mixer.existingAction(clip);
    if (action === null || action === undefined) return;
    const half = Math.floor(((action.time / clip.duration) % 1) * 2);
    if (this.#locomotion !== this.#lastStepClip) {
      this.#lastStepClip = this.#locomotion;
      this.#lastStepHalf = half;
      return;
    }
    if (half === this.#lastStepHalf) return;
    this.#lastStepHalf = half;
    hooks.onFootstep(this.group.position);
  }

  /**
   * The one clip a killed soldier plays.
   *
   * The old rig carried three retargeted Mixamo deaths and chose between them by the direction
   * the killing round travelled. The mannequin ships one (`Death01`), so the choice is gone and
   * only the fall direction is still measured: the corpse must travel away from the shooter
   * whichever way it was hit, and that is what `deathFallDot` scores.
   */
  #deathClipFor(): string {
    return "Death01";
  }

  #occupied(x: number, z: number, padding: number): boolean {
    for (const box of this.#colliders) {
      // The raised deck is overhead, not a wall. Keep its supports and the lower range solids
      // in the navigation map, but let a soldier route through the open space underneath it.
      if (box.min[1] > scale.humanHeight + scale.ankleHeight * 6) continue;
      if (
        x > box.min[0] - padding &&
        x < box.max[0] + padding &&
        z > box.min[2] - padding &&
        z < box.max[2] + padding &&
        box.max[1] > 0.5
      ) {
        return true;
      }
    }
    return x < this.#navMin || x > this.#navMax || z < this.#navMin || z > this.#navMax;
  }

  /** True when the soldier stands in any raised deck's footprint — routing beneath it. */
  #underDeck(): boolean {
    const x = this.group.position.x;
    const z = this.group.position.z;
    for (const deck of this.#decks) {
      if (x > deck.minX && x < deck.maxX && z > deck.minZ && z < deck.maxZ) {
        return true;
      }
    }
    return false;
  }

  /**
   * The navigation grid's blocked cells, built once and shared by the whole squad.
   *
   * `#occupied` is a linear scan of every town collider, and A* asked it for up to three cells per
   * neighbour across a 46x46 grid — per search, per soldier. It was the single hottest function in
   * the game (197 ms of self time in a 3.7-minute trace) and it was recomputing one static answer
   * over and over: the town's colliders never move, so a cell that is blocked on the first frame is
   * blocked on the last. The bitmap is keyed on the collider array itself, so the five soldiers
   * that share `town.colliders` share one grid, and a scene that rebuilds its town gets a new one.
   *
   * Only cell-centre queries use this. `#segmentClear` interpolates arbitrary points between cells
   * and still runs the exact test, so no route changes shape.
   */
  #navGrid(width: number): Uint8Array {
    let byBounds = NAV_GRIDS.get(this.#colliders);
    if (byBounds === undefined) {
      byBounds = new Map();
      NAV_GRIDS.set(this.#colliders, byBounds);
    }
    const boundsKey = `${this.#navMin}|${this.#navMax}|${width}`;
    const cached = byBounds.get(boundsKey);
    if (cached !== undefined) return cached;
    const grid = new Uint8Array(width * width);
    for (let z = 0; z < width; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const worldX = this.#navMin + x * NAV_CELL;
        const worldZ = this.#navMin + z * NAV_CELL;
        grid[z * width + x] = this.#occupied(worldX, worldZ, AGENT_RADIUS + 0.16) ? 1 : 0;
      }
    }
    byBounds.set(boundsKey, grid);
    return grid;
  }

  #blocked(x: number, z: number): boolean {
    return this.#occupied(x, z, AGENT_RADIUS);
  }

  #navBlocked(x: number, z: number): boolean {
    // Grid nodes need slack: a mathematically tangent route clips a corner after interpolation.
    return this.#occupied(x, z, AGENT_RADIUS + 0.16);
  }

  /** True when the whole body-width corridor is clear, not merely its end point. */
  #segmentClear(from: Vector3, to: Vector3): boolean {
    const distance = from.distanceTo(to);
    const samples = Math.max(1, Math.ceil(distance / (NAV_CELL * 0.45)));
    for (let index = 1; index <= samples; index += 1) {
      const t = index / samples;
      if (this.#navBlocked(MathUtils.lerp(from.x, to.x, t), MathUtils.lerp(from.z, to.z, t))) {
        return false;
      }
    }
    return true;
  }

  /** Build a deterministic 8-way A* route and then remove grid points visible from each other. */
  #findPath(goalX: number, goalZ: number): Vector3[] {
    const navMin = this.#navMin;
    const navMax = this.#navMax;
    const width = Math.floor((navMax - navMin) / NAV_CELL) + 1;
    const toCell = (value: number): number =>
      MathUtils.clamp(Math.round((value - navMin) / NAV_CELL), 0, width - 1);
    const toWorld = (cell: number): number => navMin + cell * NAV_CELL;
    const key = (x: number, z: number): number => z * width + x;
    const grid = this.#navGrid(width);
    /** Cell-centre blocked test: one array read instead of a scan of every collider. */
    const cellBlocked = (x: number, z: number): boolean => grid[z * width + x] === 1;
    const sx = toCell(this.group.position.x);
    const sz = toCell(this.group.position.z);
    let gx = toCell(goalX);
    let gz = toCell(goalZ);
    const requestedGoalBlocked = this.#navBlocked(goalX, goalZ);

    // A requested point may sit within the body's clearance margin. Pick the nearest usable cell.
    if (cellBlocked(gx, gz)) {
      let replacement: [number, number] | undefined;
      for (let radius = 1; radius < width && replacement === undefined; radius += 1) {
        for (let dz = -radius; dz <= radius && replacement === undefined; dz += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
            const x = gx + dx;
            const z = gz + dz;
            if (x >= 0 && z >= 0 && x < width && z < width && !cellBlocked(x, z)) {
              replacement = [x, z];
              break;
            }
          }
        }
      }
      if (replacement === undefined) return [];
      [gx, gz] = replacement;
    }

    const start = key(sx, sz);
    const goal = key(gx, gz);
    const open = new Set<number>([start]);
    const cameFrom = new Map<number, number>();
    const gScore = new Map<number, number>([[start, 0]]);
    const fScore = new Map<number, number>([[start, Math.hypot(gx - sx, gz - sz)]]);
    const neighbours: readonly (readonly [number, number, number])[] = [
      [-1, 0, 1],
      [1, 0, 1],
      [0, -1, 1],
      [0, 1, 1],
      [-1, -1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [1, 1, Math.SQRT2],
    ];

    while (open.size > 0) {
      let current = -1;
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of open) {
        const score = fScore.get(candidate) ?? Number.POSITIVE_INFINITY;
        if (score < best) {
          best = score;
          current = candidate;
        }
      }
      if (current === goal) break;
      open.delete(current);
      const cx = current % width;
      const cz = Math.floor(current / width);
      for (const [dx, dz, cost] of neighbours) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= width) continue;
        if (cellBlocked(nx, nz)) continue;
        // Do not squeeze diagonally between two touching solids.
        if (dx !== 0 && dz !== 0 && (cellBlocked(cx + dx, cz) || cellBlocked(cx, cz + dz)))
          continue;
        const next = key(nx, nz);
        const tentative = (gScore.get(current) ?? Number.POSITIVE_INFINITY) + cost;
        if (tentative >= (gScore.get(next) ?? Number.POSITIVE_INFINITY)) continue;
        cameFrom.set(next, current);
        gScore.set(next, tentative);
        fScore.set(next, tentative + Math.hypot(gx - nx, gz - nz));
        open.add(next);
      }
    }
    if (start !== goal && !cameFrom.has(goal)) return [];

    const raw: Vector3[] = [];
    let cursor = goal;
    while (cursor !== start) {
      raw.push(new Vector3(toWorld(cursor % width), 0, toWorld(Math.floor(cursor / width))));
      const previous = cameFrom.get(cursor);
      if (previous === undefined) return [];
      cursor = previous;
    }
    raw.reverse();
    // Preserve clearance when the requested destination itself is inside an inflated obstacle.
    if (!requestedGoalBlocked) raw.push(new Vector3(goalX, 0, goalZ));

    const smooth: Vector3[] = [];
    let anchor = new Vector3(this.group.position.x, 0, this.group.position.z);
    for (let index = 0; index < raw.length; ) {
      let furthest = index;
      while (
        furthest + 1 < raw.length &&
        this.#segmentClear(anchor, raw[furthest + 1] as Vector3)
      ) {
        furthest += 1;
      }
      const waypoint = (raw[furthest] as Vector3).clone();
      smooth.push(waypoint);
      anchor = waypoint;
      index = furthest + 1;
    }
    return smooth;
  }

  /** Detection is an event: commit a route now instead of waiting for a movement branch. */
  #beginPursuit(target: Vector3): void {
    this.#path = this.#findPath(target.x, target.z);
    this.#pathIndex = 0;
    this.#pathGoal.set(target.x, 0, target.z);
    this.#replanIn = NAV_REPLAN_SECONDS;
  }

  /** Shed pace at the walking deceleration. Used by every branch that is not travelling. */
  #brake(dt: number): void {
    this.#pace = Math.max(0, this.#pace - WALK_DECEL * dt);
  }

  /**
   * Carry the last of his pace into the stop instead of dropping it in one frame.
   *
   * `#brake` only decays `#pace`, and `#pace` is read nowhere except `#step`. So every branch
   * that stopped by braking without stepping — a patrol pause, a consumed path, a waypoint
   * reached — took the body from walking pace to standing still between two frames while the
   * legs were still mid-stride. Measured on patrol before this existed: ground speed went
   * 2.31 -> 0 with no intermediate frame, twice in 2.6 s, and the locomotion clip snapped to
   * idle underneath a body that had already teleported to rest. It reads as a stutter, and it is
   * the same foot-slide defect a clip played too fast causes on the other end of the range.
   *
   * Returns whether he is still under way, so the caller can keep the walk clip on until the
   * body has actually finished moving rather than the frame the decision was made.
   */
  #coast(dt: number): boolean {
    // Coasting owns the pace for this frame. Without claiming the step, the tail brake at the
    // end of `update` — which exists for the branches that neither step nor coast, a burst or a
    // soldier standing and listening — decays it a second time, and the body stops at twice the
    // deceleration it was authored with. Measured: 18.0 m/s squared against a WALK_DECEL of 9.
    this.#stepped = true;
    this.#brake(dt);
    if (this.#pace <= COAST_FLOOR) {
      this.#pace = 0;
      return false;
    }
    const heading = this.#heading.value;
    const travel = this.#pace * dt;
    const nextX = this.group.position.x + Math.sin(heading) * travel;
    const nextZ = this.group.position.z + Math.cos(heading) * travel;
    // A body that walks into something does not coast through it.
    if (this.#blocked(nextX, nextZ)) {
      this.#pace = 0;
      this.#decelExempt = true;
      return false;
    }
    this.group.position.set(nextX, this.group.position.y, nextZ);
    return true;
  }

  /** Follow a cached route, replanning when a moving goal changes or the corridor becomes blocked. */
  /**
   * Returns true while he is walking the route — including the first few frames of the ramp,
   * where the body has barely moved. The old test was `travel > speed * dt * 0.05`, which is
   * false for the whole acceleration, so the walk clip would not start until he was already
   * gliding. What the caller wants to know is whether he is under way, not whether this
   * particular frame cleared a distance threshold.
   *
   * `faceTravel` is off for combat, where `#engage` owns the facing so the rifle can stay on
   * the player while the feet go somewhere else.
   */
  #step(dt: number, toX: number, toZ: number, speed: number, faceTravel = true): boolean {
    this.#stepped = true;
    this.#replanIn -= dt;
    this.#goalReplanIn -= dt;
    const goalMoved = Math.hypot(toX - this.#pathGoal.x, toZ - this.#pathGoal.z) > 0.8;
    const currentWaypoint = this.#path[this.#pathIndex];
    const routeObstructed =
      this.#replanIn <= 0 &&
      currentWaypoint !== undefined &&
      !this.#segmentClear(this.group.position, currentWaypoint);
    // A grid search is not a per-frame operation. `goalMoved` used to bypass the replan cooldown
    // entirely, so a soldier chasing a moving player re-planned his whole route on almost every
    // frame — measured at 16.7 ms across the squad, the largest single cost left in the game.
    // Having no path at all is still replanned immediately, because a soldier with nowhere to go
    // stands still and that is visible; a route four-tenths of a second out of date is not.
    // A grid search is not a per-frame operation. `goalMoved` used to bypass the replan cooldown
    // entirely, so a soldier chasing a moving player re-planned his whole route on almost every
    // frame — measured at 16.7 ms across the squad, the largest single cost left in the game.
    // Having no path at all is still replanned immediately, because a soldier with nowhere to go
    // stands still and that is visible; a route four-tenths of a second out of date is not.
    //
    // A squad-wide budget of one search per frame was tried on top of this and reverted: it holds
    // the worst frame down further, but a soldier pressed against geometry then has to win a race
    // for the token before he can re-route, and `enemy-reaches-walkway` caught him failing to.
    // The cooldown alone is the part that is safe to keep.
    const mustReplan = this.#path.length === 0;
    const goalDrifted = goalMoved && this.#goalReplanIn <= 0;
    if (goalDrifted) this.#goalReplanIn = GOAL_REPLAN_SECONDS;
    if (mustReplan || goalDrifted || routeObstructed) {
      this.#beginPursuit(scratchGoal.set(toX, 0, toZ));
    }
    let waypoint = this.#path[this.#pathIndex];
    while (waypoint !== undefined && this.group.position.distanceTo(waypoint) < 0.32) {
      this.#pathIndex += 1;
      waypoint = this.#path[this.#pathIndex];
    }
    if (waypoint === undefined) return this.#coast(dt);
    const dx = waypoint.x - this.group.position.x;
    const dz = waypoint.z - this.group.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-3) return this.#coast(dt);

    // Steer the direction of travel rather than snapping it to the bearing of the next grid
    // point. This is what turns the 0.7 m A* polyline into a path a body could have walked.
    const bearing = Math.atan2(dx, dz);
    const heading = this.#heading.step(bearing, dt);
    const error = Math.abs(angleDelta(heading, bearing));
    // Nobody walks a corner at full pace. This also keeps the arc tight: the harder he has to
    // turn, the less ground he covers while turning, so the curve stays in the cleared corridor.
    const cornering = MathUtils.clamp(1 - error / CORNER_FULL, CORNER_FLOOR, 1);
    // Ease off onto the last waypoint instead of stopping on the mark.
    const arriving =
      this.#pathIndex >= this.#path.length - 1
        ? MathUtils.clamp(distance / ARRIVE_DISTANCE, ARRIVE_FLOOR, 1)
        : 1;
    const wanted = speed * this.#gait * cornering * arriving;
    const gained = MathUtils.clamp(wanted - this.#pace, -WALK_DECEL * dt, WALK_ACCEL * dt);
    this.#pace += gained;

    const travel = Math.min(distance, this.#pace * dt);
    const nextX = this.group.position.x + Math.sin(heading) * travel;
    const nextZ = this.group.position.z + Math.cos(heading) * travel;
    if (this.#blocked(nextX, nextZ)) {
      this.#path = [];
      this.#replanIn = 0;
      // He walked into something. A body that hits a wall does not keep its momentum.
      this.#pace *= 0.3;
      this.#decelExempt = true;
      return false;
    }
    this.group.position.set(nextX, this.group.position.y, nextZ);
    if (faceTravel) this.group.rotation.y = this.#facing.step(heading, dt);
    return true;
  }

  /**
   * Can he see the player right now?
   *
   * Every frame, with no caching. Rationing this to one answer every few frames was tried and
   * reverted: `enemy-reaches-walkway` went from reliable to a coin flip, because a soldier acting
   * on a sight answer a tenth of a second stale takes a different route and does not arrive.
   * Vision is what the whole AI branches on, and stale input to a state machine is not a
   * shortcut — it is a different state machine.
   *
   * It is affordable because the sight line itself got cheap: the range and cone rejects here
   * cost three dot products, and `lineOfSight` answers most calls from a box test without
   * touching a raycast at all. See the two-stage test in `Play`.
   */
  #canSee(eye: Vector3, hooks: EnemyHooks): boolean {
    const chest = this.chest;
    scratchTo.subVectors(eye, chest);
    if (scratchTo.length() > VIEW_RANGE) return false;
    scratchFacing.set(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
    scratchFlat.set(scratchTo.x, 0, scratchTo.z).normalize();
    if (scratchFacing.dot(scratchFlat) < Math.cos(VIEW_HALF_ANGLE)) return false;
    return hooks.lineOfSight(chest, eye);
  }

  hearShot(shooter: Vector3): void {
    if (!this.alive || this.#frozen) return;
    if (shooter.distanceTo(this.group.position) > HEAR_RANGE) return;
    this.#lastSeen.copy(shooter);
    this.#beginPursuit(shooter);
    if (this.phase === "patrol" || this.phase === "return") {
      this.phase = "suspicious";
      this.#alertTimer = 0;
      // Only the men pulled off a calm route call it out; anyone already
      // fighting has said his piece.
      this.voice?.chase(this.group.position);
    }
  }

  /** Returns the score the shot earned: 300 for the kill, 100 for the first wound. */
  hurt(ctx: GameCtx, amount: number): number {
    if (!this.alive) return 0;
    this.health -= amount;
    let earned = 0;
    if (!this.wounded) {
      this.wounded = true;
      earned = 100;
    }
    if (this.health <= 0) {
      this.health = 0;
      this.phase = "dead";
      this.#decelExempt = true;
      this.voice?.death(this.group.position);
      this.#deadFor = 0;
      this.#deathObserved = true;
      this.#bodyClearance = null;
      this.#footClearance = null;
      this.#deathClipFrames = 0;
      this.#deathFallMeasured = null;
      this.#deathHipStart = this.#hips?.getWorldPosition(new Vector3()) ?? null;
      const clip = this.#deathClipFor();
      this.#deathClip = this.#clips.has(clip) ? clip : null;
      this.#play(clip, DEATH_FADE, "once", true);
      this.#detachWeapon(ctx);
      ctx.after(RESPAWN_SECONDS, () => this.#respawn());
      return earned + 300;
    }
    // Surviving a round costs him his composure for a couple of seconds, not just health.
    this.#suppressed = Math.max(this.#suppressed, 2.4);
    this.#suppressedPeak = Math.max(this.#suppressedPeak, this.#suppressed);
    this.voice?.pain(this.group.position);
    // "once", and held: the clip is a one-shot flinch, and the hold is what stops locomotion
    // reclaiming the rig before a single frame of it has been drawn.
    const flinch = "Rifle_Hit";
    this.#reactionHold = Math.min(this.#clipDurations.get(flinch) ?? 0.4, 0.45);
    this.#play(flinch, REACTION_FADE, "once", true);
    // A frozen sentry flinches at the impact but holds his ground: engaging here
    // would walk him out of a scenario-placed spawn on the first non-killing round.
    if (!this.#frozen && this.phase !== "engage") this.phase = "engage";
    return earned;
  }

  /** `shotDirection` is the round's travel direction, used to pick which way the body falls. */
  recordHit(multiplier: number, shotDirection?: Vector3): void {
    this.#lastHitMultiplier = multiplier;
    if (shotDirection !== undefined) {
      this.#lastHitDirection = shotDirection.clone().normalize();
    }
  }

  #respawn(): void {
    this.health = MAX_HEALTH;
    this.wounded = false;
    this.phase = "patrol";
    this.#suppressed = 0;
    this.#standUp = 0;
    this.#reactionHold = 0;
    this.#crouchMoving = false;
    this.#locomotion = "";
    this.#locomotionHold = 0;
    this.#stillFor = 0;
    this.#lastHitDirection = null;
    this.#reattachWeapon();
    this.#bodyClearance = null;
    this.#footClearance = null;
    // Blend state first, and only here: it is what costs a pipeline, so it is set once per
    // soldier and never again. The fade below is a uniform on the pipeline this just built.
    this.#fixBlendState();
    this.#setOpacity(0);
    this.#reaction = 0;
    this.#burstLeft = 0;
    this.#cooldown = 0;
    this.#path = [];
    this.#pathIndex = 0;
    this.#pathGoal.copy(this.#route[0] ?? ROUTE_START);
    this.#replanIn = 0;
    this.#searchAtGoal = 0;
    this.#patrolPause = 0;
    this.#spawnGrace = SPAWN_GRACE_SECONDS;
    this.#routeIndex = 0;
    this.group.position.copy(this.#route[0] ?? ROUTE_START);
    const firstWaypoint = this.#route[1];
    if (firstWaypoint !== undefined) {
      this.#target.copy(firstWaypoint);
      this.#routeIndex = 1;
    }
    this.group.rotation.set(
      0,
      Math.atan2(this.#target.x - this.group.position.x, this.#target.z - this.group.position.z),
      0,
    );
    // A fresh body starts still and pointed down its route, with no turn or pace carried over
    // from the one that died — otherwise he respawns already leaning out of a corner.
    this.#heading.set(this.group.rotation.y);
    this.#facing.set(this.group.rotation.y);
    this.#pace = 0;
    this.#play("Rifle_Walk", LOCOMOTION_FADE, "loop", true);
  }

  update(ctx: GameCtx, dt: number, playerEye: Vector3, deckY: number, hooks: EnemyHooks): void {
    this.#frameStart.copy(this.group.position);
    if (this.phase === "dead") {
      this.#deadFor += dt;
      this.#character.update(dt);
      this.#countClipFrame();
      this.#deathClipFrames = Math.max(this.#deathClipFrames, this.#character.advancedFrames);
      const fall = this.#deathFallDot();
      if (fall !== null && (this.#deathFallMeasured === null || fall > this.#deathFallMeasured)) {
        this.#deathFallMeasured = fall;
      }
      this.#updateDetachedWeapon(dt, deckY);
      this.#groundToDeck(deckY, dt);
      this.#syncCollisionBody();
      if (this.#deadFor > RESPAWN_SECONDS - 0.35) {
        this.#setOpacity(MathUtils.clamp((RESPAWN_SECONDS - this.#deadFor) / 0.35, 0, 1));
      }
      return;
    }
    this.#spawnGrace = Math.max(0, this.#spawnGrace - dt);
    this.#reactionHold = Math.max(0, this.#reactionHold - dt);
    const sees = !this.#frozen && this.#spawnGrace <= 0 && this.#canSee(playerEye, hooks);
    if (sees) {
      // Entering combat from anywhere else starts the reaction clock, so the player gets a
      // moment to react rather than taking a burst the instant they step into the open.
      if (this.phase !== "engage") {
        this.#reaction = REACTION_SECONDS;
        this.#beginPursuit(playerEye);
        this.voice?.spot(this.group.position);
      }
      this.#lastSeen.copy(playerEye);
      this.phase = "engage";
      this.#alertTimer = 0;
    }

    this.#stepped = false;
    switch (this.phase) {
      case "patrol": {
        if (this.#spawnGrace > 0) {
          this.#play("Rifle_Idle");
          break;
        }
        if (this.#patrolPause > 0) {
          this.#patrolPause -= dt;
          // Coasting, not stopping: he sheds the pace he was carrying over WALK_DECEL and the
          // legs stay under him until the body has actually come to rest.
          this.#playLocomotion(this.#coast(dt), false, dt);
          break;
        }
        this.#playLocomotion(this.#step(dt, this.#target.x, this.#target.z, WALK_SPEED), false, dt);
        if (this.group.position.distanceTo(this.#target) < 0.9) {
          const routeLength = this.#route.length;
          if (routeLength === 0) break;
          this.#routeIndex = (this.#routeIndex + 1) % routeLength;
          const nextWaypoint = this.#route[this.#routeIndex];
          if (nextWaypoint !== undefined) this.#target.copy(nextWaypoint);
          // A patrol that pauses for exactly 0.45 s at every corner reads as a machine.
          this.#patrolPause = 0.35 + ctx.random() * 1.1;
        }
        break;
      }
      case "suspicious": {
        // Heard something: turn toward it, then go looking.
        this.#alertTimer += dt;
        const wanted = Math.atan2(
          this.#lastSeen.x - this.group.position.x,
          this.#lastSeen.z - this.group.position.z,
        );
        // Slower than a combat turn: he is placing a sound, not swinging onto a target.
        this.group.rotation.y = this.#facing.step(wanted, dt, 0.55);
        // Something is wrong and he does not know what: stay low while he works it out.
        this.#playLocomotion(false, true, dt);
        if (this.#alertTimer > 0.8) this.phase = "search";
        break;
      }
      case "engage": {
        this.#engage(ctx, dt, playerEye, hooks, sees);
        break;
      }
      case "search": {
        this.#alertTimer += dt;
        if (this.group.position.distanceTo(this.#lastSeen) >= 1.6 && this.#alertTimer <= 7) {
          // Closing on a position someone was just shooting from: move low and quick.
          this.#playLocomotion(
            this.#step(dt, this.#lastSeen.x, this.#lastSeen.z, CHASE_SPEED * 0.85, true),
            true,
            dt,
          );
        } else {
          // Search the last known area before giving up; do not instantly snap back to patrol.
          this.#searchAtGoal += dt;
          // Through the eased yaw rather than straight onto the transform, so the sweep is
          // reported as angular velocity and the shoulders and head read it like any other turn.
          this.group.rotation.y = this.#facing.spin(this.#strafe > 0 ? 1.2 : -1.2, dt);
          this.#playLocomotion(false, true, dt);
        }
        if (this.#searchAtGoal > 2.4 || this.#alertTimer > 9.5) {
          this.phase = "return";
          this.#alertTimer = 0;
          this.#searchAtGoal = 0;
          this.#path = [];
        }
        break;
      }
      case "return": {
        const home = this.#route[this.#routeIndex] ?? this.#route[0] ?? this.group.position;
        this.#playLocomotion(this.#step(dt, home.x, home.z, WALK_SPEED), false, dt);
        if (this.group.position.distanceTo(home) < 1.0) this.phase = "patrol";
        break;
      }
    }
    // A branch that never called `#step` — a patrol pause, a burst, standing and listening —
    // is a soldier coming to a halt, not one who was never moving. Coast the pace down.
    if (!this.#stepped) this.#brake(dt);
    this.#standUp = Math.max(0, this.#standUp - dt);
    this.#suppressed = Math.max(0, this.#suppressed - dt);
    this.#locomotionHold = Math.max(0, this.#locomotionHold - dt);
    this.#character.update(dt);
    this.#countClipFrame();
    this.#updateFootsteps(hooks);
    this.#groundToDeck(deckY, dt);
    this.#syncCollisionBody();
    if (this.#fade < 1) {
      this.#setOpacity(MathUtils.clamp(this.#fade + dt / 0.35, 0, 1));
    }
  }

  /** Keep the lowest posed body point on the requested deck, and report the real clearance. */
  #groundToDeck(deckY: number, dt: number): void {
    // `GroundSnap` is the engine's own render grounding: a skin envelope calibrated once, so a
    // frame loop never runs the precise per-vertex bounds path, plus the clearance it measured.
    // `groundSnap` off is a range, not a mute — the measurement and both numbers below stay
    // truthful, which is what a scenario asserts against.
    this.#ground.enabled = this.groundSnap;
    this.#ground.apply(this.group, deckY, dt);
    const clearance = this.#ground.clearance;
    this.#footClearance = clearance === null ? null : Math.max(0, clearance);
    this.#bodyClearance = clearance === null ? null : Math.abs(clearance);
  }

  #engage(ctx: GameCtx, dt: number, playerEye: Vector3, hooks: EnemyHooks, sees: boolean): void {
    const chest = this.chest;
    const knownTarget = sees ? playerEye : this.#lastSeen;
    const aim = Math.atan2(knownTarget.x - chest.x, knownTarget.z - chest.z);
    const flatDistance = Math.hypot(playerEye.x - chest.x, playerEye.z - chest.z);

    this.#strafeTimer -= dt;
    if (this.#strafeTimer <= 0) {
      // A metronome flank is the loudest tell that this is a state machine. Vary it.
      this.#strafeTimer = 0.9 + ctx.random() * 1.4;
      this.#strafe = -this.#strafe;
    }

    // Stay low when hurt or when rounds are landing near him, and plant to shoot: nobody
    // sprints through their own burst. This is most of what separates a soldier from a turret
    // that happens to be walking.
    const firing = this.#burstLeft > 0;
    const crouched = this.wounded || this.#suppressed > 0;
    // Planted, not creeping. At 0.18 he still made 0.65 m/s under a firing clip that has both
    // feet nailed down — 16 frames of visible slide per engagement, measured. `#step` still runs,
    // so he decelerates into the plant over ~70 ms rather than stopping on the frame.
    const settle = firing ? 0 : crouched ? 0.72 : 1;
    let moved = false;

    if (this.#reaction > 0) {
      // Detection means pursuit immediately; tactical spacing begins only after reacting.
      moved = this.#step(dt, knownTarget.x, knownTarget.z, CHASE_SPEED * settle, false);
    } else {
      // Every later combat route is still derived from the player: close distance when far,
      // back off when rushed, and flank rather than running straight into the muzzle.
      const away = new Vector3(
        this.group.position.x - knownTarget.x,
        0,
        this.group.position.z - knownTarget.z,
      );
      if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
      away.normalize();
      const desiredRange = flatDistance > ENGAGE_RANGE ? 10.5 : 9;
      const lateral = new Vector3(away.z, 0, -away.x).multiplyScalar(this.#strafe * 2.6);
      const combatGoal = new Vector3(knownTarget.x, 0, knownTarget.z)
        .addScaledVector(away, desiredRange)
        .add(lateral);
      moved = this.#step(
        dt,
        combatGoal.x,
        combatGoal.z,
        (flatDistance > ENGAGE_RANGE ? CHASE_SPEED : WALK_SPEED) * settle,
        false,
      );
    }
    // Facing is the engage branch's, not `#step`'s. Standing, he squares up on the player;
    // moving, he keeps the rifle as far round as the feet can carry without moonwalking, which
    // is a flanker who never takes his weapon off you rather than one who turns his back.
    const carry = moved
      ? this.#heading.value +
        MathUtils.clamp(angleDelta(this.#heading.value, aim), -AIM_LEAD_MAX, AIM_LEAD_MAX)
      : aim;
    this.group.rotation.y = this.#facing.step(carry, dt, 1.25);
    // The firing clip owns the pose for as long as the burst lasts; locomotion resumes after.
    this.#playLocomotion(moved, crouched, dt, firing, sees);

    this.#cooldown -= dt;
    this.#burstTimer -= dt;
    this.#reaction -= dt;
    if (this.#burstLeft > 0) {
      if (this.#burstTimer <= 0) {
        this.#burstLeft -= 1;
        this.#burstTimer = BURST_SPACING;
        // A round only reaches the player if the shot is actually clear. Firing through a
        // barricade was the loudest tell that this was a timer and not a soldier.
        const clear = hooks.lineOfSight(chest, playerEye);
        // A round that connects costs the full 9; the ones that go wide do not.
        // Seeded, so a replay of the same run takes the same damage.
        // Taking rounds spoils a shooter's aim. Without this he shoots exactly as well while
        // being hit as he does unopposed, which reads as a machine no matter how he moves.
        const composure = this.#suppressed > 0 ? 0.45 : 1;
        const accuracy = MathUtils.clamp((0.75 - flatDistance * 0.035) * composure, 0.05, 0.75);
        const muzzle = this.muzzle();
        const shotDirection = playerEye.clone().sub(muzzle).normalize();
        const missDirection = shotDirection.clone();
        if (ctx.random() >= accuracy) {
          missDirection.x += (ctx.random() - 0.5) * 0.16;
          missDirection.y += (ctx.random() - 0.5) * 0.1;
          missDirection.normalize();
        }
        if (clear && shotDirection.angleTo(missDirection) < 0.02) hooks.damagePlayer(ROUND_DAMAGE);
        hooks.onMuzzleFlash(muzzle, missDirection, playerEye.distanceTo(muzzle));
        // `#play` declines while a flinch is held, so a soldier hit mid-burst keeps the reaction
        // rather than having it stomped by the very next round 110 ms later.
        this.#play("Rifle_Shoot", FIRE_FADE);
        if (this.#burstLeft === 0) {
          // Break contact for an irregular beat, longer when he is rattled. A fixed 3.2 s
          // gap between bursts is learnable within two engagements.
          this.#cooldown =
            BURST_COOLDOWN * (0.7 + ctx.random() * 0.6) + (this.#suppressed > 0 ? 0.9 : 0);
        }
      }
    } else if (sees && this.#cooldown <= 0 && this.#reaction <= 0) {
      // Bursts of two to four, not always three.
      this.#burstLeft = BURST_ROUNDS + Math.round((ctx.random() - 0.5) * 2);
      this.#burstTimer = 0;
    }

    if (!sees) {
      this.#burstLeft = 0;
      this.#alertTimer += dt;
      if (this.#alertTimer > 0.9) {
        this.phase = "search";
        this.#alertTimer = 0;
        this.#searchAtGoal = 0;
        this.#beginPursuit(this.#lastSeen);
      }
    }
  }

  debug(): {
    health: number;
    phase: EnemyPhase;
    position: number[];
    deadFor: number;
    armed: boolean;
    /**
     * This soldier's own body opacity — 1 unless he is mid-respawn-fade. Materials are cloned
     * per soldier (see `ownMaterial`) precisely so this number is his alone: before that fix, one
     * soldier's fade wrote every soldier's shared material and this field would have moved for
     * all five at once.
     */
    materialOpacity: number;
    /** Lowest `materialOpacity` this soldier has ever reported. See `#opacityFloor`. */
    materialOpacityFloor: number;
    reaction: number;
    bodyClearance: number | null;
    footClearance: number | null;
    modelHeight: number;
    hitboxHeight: number;
    headZoneMinY: number;
    legZoneMaxY: number;
    underWalkway: boolean;
    deathObserved: boolean;
    wounded: boolean;
    suppressedPeak: number;
    crouchClipFrames: number;
    clipsPlayed: string[];
    groundSnap: boolean;
    deathFallDot: number | null;
    crouching: boolean;
    suppressed: number;
    animation: string | null;
    decelPeakMs2: number;
    groundSpeed: number;
    locomotionRate: number;
    clipGroundSpeed: number;
    /**
     * Head joint height above the body's own origin, in metres, as the clip currently poses
     * it. This is the number that fails on a body folded at the waist or collapsed into its
     * own chest: 1.545 m is the authored height of the `Head` joint, and a rig that is playing
     * the wrong clip, bound to the wrong skeleton or wound about the wrong axis reads far
     * below it. A scenario asserts a floor on it, so a broken body cannot be a green run.
     */
    headHeight: number;
    strideSynced: boolean;
    deathClip: string | null;
    deathClipFrames: number;
    clips: string[];
    lastHitMultiplier: number;
    navigation: { goal: number[]; next: number[] | null; remaining: number };
    rifleForward: number[] | null;
    rifleForwardDot: number | null;
    clipMarkerDownDot: number | null;
    rifleLength: number | null;
    rightHandToGrip: number | null;
    leftHandToRifle: number | null;
    rightHandContact: number | null;
    leftHandContact: number | null;
    handContactPeak: Record<string, number>;
    weaponNodes: string[];
    bodyJoints: Record<string, number[]>;
  } {
    const weaponPose =
      this.#weapon === undefined || this.#weaponModel === undefined
        ? null
        : measureThreePose(this.#weapon, { bounds: false });
    const rifleForward = weaponPose === null ? null : new Vector3().fromArray(weaponPose.axes.z);
    const enemyForward = new Vector3(0, 0, 1)
      .applyQuaternion(this.group.getWorldQuaternion(this.group.quaternion.clone()))
      .normalize();
    // The grip is the rifle's own origin, so the hand's distance to it is the whole check:
    // a soldier holding his rifle anywhere else is a bug, and there is no bone to compare with.
    const gripPosition = this.#weapon?.getWorldPosition(new Vector3()) ?? null;
    const rightHandPosition = this.#rightHand?.getWorldPosition(new Vector3()) ?? null;
    const magazinePosition =
      this.#weaponModel?.getObjectByName("magazine")?.getWorldPosition(new Vector3()) ?? null;
    const leftHandPosition = this.#leftHand?.getWorldPosition(new Vector3()) ?? null;
    const rifleStart = this.#weapon?.localToWorld(new Vector3(0, 0, this.#rifleLocalMinZ)) ?? null;
    const rifleEnd = this.#weapon?.localToWorld(new Vector3(0, 0, this.#rifleLocalMaxZ)) ?? null;
    const bodyJoints: Record<string, number[]> = {};
    for (const bone of this.#poseBones) {
      bodyJoints[bone.name] = [...measureThreePose(bone, { bounds: false }).position];
    }
    const stride = this.#character.stride;
    return {
      health: this.health,
      phase: this.phase,
      position: this.group.position.toArray(),
      deadFor: this.#deadFor,
      armed: this.#weapon !== undefined,
      materialOpacity: this.#fade,
      materialOpacityFloor: this.#opacityFloor,
      reaction: this.#reaction,
      bodyClearance: this.#bodyClearance,
      footClearance: this.#footClearance,
      modelHeight: this.modelHeight,
      hitboxHeight: this.#hitboxHeight,
      headZoneMinY: this.headZoneMinY,
      legZoneMaxY: this.legZoneMaxY,
      underWalkway: this.#underDeck(),
      deathObserved: this.#deathObserved,
      wounded: this.wounded,
      suppressedPeak: this.#suppressedPeak,
      crouchClipFrames: this.#clipFrames.get("Rifle_Crouch_Walk") ?? 0,
      // Every clip the rig has actually run, so an unused animation is visible to a scenario.
      clipsPlayed: [...this.#clipFrames.keys()].sort(),
      groundSnap: this.groundSnap,
      // Whichever death clip ran, the body must travel the way the round did — i.e. away from
      // the shooter. One number that catches DeathFront and DeathBack being swapped.
      deathFallDot: this.#deathFallMeasured,
      crouching: this.#crouchMoving,
      suppressed: this.#suppressed,
      animation: this.#character.current ?? null,
      // Locomotion honesty, straight off the engine's own stride convention: how fast the body
      // is going, how fast the clip is being played to match, and how far the clip carries the
      // body at rate 1. `strideSynced` is the honest half — false means the rate is 1 because
      // the game (or a scenario) turned the convention off, not because the feet are matching.
      decelPeakMs2: this.#decelPeak,
      groundSpeed: this.#groundSpeed,
      locomotionRate: stride.rate,
      clipGroundSpeed: stride.clipGroundSpeed,
      headHeight:
        this.#head === undefined
          ? 0
          : this.#head.getWorldPosition(new Vector3()).y - this.group.position.y,
      strideSynced: stride.synced,
      deathClip: this.#deathClip,
      deathClipFrames: this.#deathClipFrames,
      clips: [...this.#clips].sort(),
      lastHitMultiplier: this.#lastHitMultiplier,
      navigation: {
        goal: this.#pathGoal.toArray(),
        next: this.#path[this.#pathIndex]?.toArray() ?? null,
        remaining: Math.max(0, this.#path.length - this.#pathIndex),
      },
      rifleForward: rifleForward?.toArray() ?? null,
      rifleForwardDot: rifleForward?.dot(enemyForward) ?? null,
      clipMarkerDownDot:
        magazinePosition === null || gripPosition === null
          ? null
          : magazinePosition
              .clone()
              .sub(gripPosition)
              .normalize()
              .dot(new Vector3(0, -1, 0)),
      rifleLength: weaponPose === null ? null : this.#renderedRifleLength,
      rightHandToGrip:
        rightHandPosition === null || gripPosition === null
          ? null
          : rightHandPosition.distanceTo(gripPosition),
      leftHandToRifle:
        leftHandPosition === null || rifleStart === null || rifleEnd === null
          ? null
          : this.#distanceToSegment(leftHandPosition, rifleStart, rifleEnd),
      // Engine `boneContact`: nearest rifle vertex to the hand joint, so a fist in the air reads
      // as a distance rather than as a screenshot.
      rightHandContact: this.#contact("hand_r"),
      leftHandContact: this.#contact("hand_l"),
      handContactPeak: Object.fromEntries(this.#contactPeak),
      weaponNodes: this.#weaponNodes,
      bodyJoints,
    };
  }

  #contact(bone: string): number | null {
    return this.#weaponModel === undefined
      ? null
      : boneContact(this.group, bone, this.#weaponModel).distance;
  }

  #distanceToSegment(point: Vector3, start: Vector3, end: Vector3): number {
    const segment = end.clone().sub(start);
    const lengthSquared = segment.lengthSq();
    if (lengthSquared === 0) return point.distanceTo(start);
    const t = MathUtils.clamp(point.clone().sub(start).dot(segment) / lengthSquared, 0, 1);
    return point.distanceTo(start.addScaledVector(segment, t));
  }

  dispose(): void {
    this.#character.dispose();
    this.#body?.dispose();
    this.#bodyProxy?.removeFromParent();
    this.group.removeFromParent();
  }
}
