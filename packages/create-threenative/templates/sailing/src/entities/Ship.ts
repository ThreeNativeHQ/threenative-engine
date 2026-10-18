import type { ICtx } from "@threenative/core";
import { SoftBody3D, type SpectralOcean } from "@threenative/core";
import {
  Buoyancy3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
} from "@threenative/physics";
import { Euler, Group, MathUtils, type Object3D, Quaternion, Vector3 } from "three";
import { measureHull, prepareShipConventions } from "../conventions.js";
import { createMaterials } from "../render/materials.js";
import { surfaceHeight } from "../render/ocean.js";
import { SHIP_SAILS, createSails, createShipModel } from "../render/props.js";
import type { ITouchInput } from "../render/touch-controls.js";
import type { GameState } from "../state.js";

/** What `Sailing.load()` hands the entity: `ship.glb`'s loaded scene. */
export interface IShipModel {
  readonly scene: Object3D;
}

type GameCtx = ICtx<GameState, IPhysicsContext>;

/** Scratch for composing a sail's rest rotation with the hull's. Allocating per tick is not free. */
const REST = new Quaternion();

/**
 * `SpectralOcean` as the water surface `Buoyancy3D` measures against.
 *
 * The two contracts differ by exactly this adapter: buoyancy asks for a height at a point and a
 * time, and the ocean answers with a height and the age in frames of the GPU copy it came from.
 * Before the first readback lands there is no answer at all, and mean sea level is the right one
 * to give — `Buoyancy3D` rejects a non-finite height by name, so returning nothing is not an
 * option and returning `NaN` would take the whole scene down on frame one.
 */
function oceanSurface(
  ocean: SpectralOcean,
  step: () => number,
): { sample(x: number, z: number): { height: number } } {
  return {
    // The same age-corrected read the drawn hull uses, so the solver pushes against the water the
    // player can see rather than against the water of several frames ago. `step` is a closure
    // because `Buoyancy3D` calls this from inside the physics step and has no delta to hand over.
    sample: (x, z) => ({ height: surfaceHeight(ocean, x, z, step()) ?? 0 }),
  };
}

/** Hull speed at full wind, in metres per second — about nine knots at the 4.6 m convention. */
const MAX_SPEED = 4.6;
/** Rate of turn with full way on and the rudder hard over, in radians per second. */
const TURN_RATE = 0.78;
/** How quickly the hull picks up and loses way, as an exponential rate. Ships are heavy. */
const WAY_RATE = 0.9;
/**
 * How far the model rides above its own origin, so the sea meets it lower down the topsides.
 *
 * `ship.glb`'s own origin is Poly Haven's design waterline, so this starts at 0 rather than the
 * caravel's hand-tuned 0.5 — override it here if the real hull needs trimming for the look.
 */
const FREEBOARD_TRIM = 0;
/**
 * How hard a full wind presses on a sail, as a local-space acceleration.
 *
 * Local, so it is in the model's own units rather than metres, and aft because that is where a
 * following wind fills a square course from.
 */
const SAIL_PRESS = 12;

export class Ship {
  /** The physics body's transform. Heave comes from here; attitude does not. */
  readonly mesh = new Group();
  /** What the player sees: the body's position, with an attitude taken from the swell. */
  readonly visual = new Group();
  readonly body: RigidBody3D;
  readonly buoyancy: Buoyancy3D;
  #capsized = false;
  #normaliseFactor: number;
  #heading = 0;
  /** The extremes of `sailBelly` seen so far, for the one number that proves the canvas moves. */
  #bellyLow = Number.POSITIVE_INFINITY;
  #bellyHigh = 0;
  /** Way on, in metres per second along the bow. The hull carries it; the keys only ask for it. */
  #speed = 0;
  /** What the hull is actually making good over the ground, measured off the body. */
  #groundSpeed = 0;
  /** The last fixed step, in seconds, for readers that are called without one. */
  #step = 1 / 60;
  /** Heel, eased. A ship leans away from its turn and to leeward under press of sail. */
  #heel = 0;
  /** The blade on the stern post, kept out of the merged hull so it can answer the helm. */
  readonly #rudder: Object3D | undefined;
  /**
   * The cloth, and where on the ship each piece of it hangs.
   *
   * These are not children of the hull. `SoftBody3D` disposes itself the moment it leaves the
   * scene, and `ctx.add` — the call that attaches it to the renderer at all — puts it at the
   * scene root, so parenting it to the ship afterwards would tear it down on the same frame.
   * They are carried to their yards each tick instead, which costs three matrix updates.
   */
  readonly #sails: { body: SoftBody3D; anchor: Vector3; rest: Euler }[] = [];
  /** The hull inside `visual`. Its transform carries the metre normalisation the yards are in. */
  readonly #model: Group;
  #elapsed = 0;
  #immersion = 0.5;
  #seaHeight = 0;
  #staleFrames = -1;
  readonly #ocean: SpectralOcean;
  /** Half the hull's length and beam, measured off `ship.glb` rather than assumed. */
  readonly #halfLength: number;
  readonly #halfBeam: number;
  /** The hull's draught, measured the same way. */
  readonly #draft: number;

  constructor(ctx: GameCtx, ocean: SpectralOcean, shipModel: IShipModel) {
    this.#ocean = ocean;
    this.mesh.position.set(0, 0.24, 7);
    this.visual.position.set(0, 0.24, 7);
    this.mesh.castShadow = true;
    const model = createShipModel(shipModel);
    this.#model = model;
    // `ship.glb` has no articulated rudder — its hull is one static mesh — so this is `undefined`
    // and the helm's rudder-angle feedback below is silently skipped rather than crashing.
    this.#rudder = model.getObjectByName("rudder");
    this.#normaliseFactor = prepareShipConventions(model);
    const hull = measureHull(model);
    this.#halfLength = hull.halfLength;
    this.#halfBeam = hull.halfBeam;
    // Floored: `immersion` divides by this, and a mismeasured hull (the named node missing, say)
    // must not turn into a division by zero.
    this.#draft = Math.max(0.1, hull.draft);
    // `ship.glb`'s own origin is Poly Haven's design waterline, unlike the caravel this replaces
    // (built about y = 0 with its keel at -0.73), so no lift is needed by default —
    // `FREEBOARD_TRIM` is the look-only override if the real hull needs trimming.
    model.position.y = FREEBOARD_TRIM;

    // The canvas. `belliedSail` baked the belly into the vertices, so the sails looked exactly as
    // full in a dying breeze as in a fresh one — on a passage whose entire fail state is running
    // out of wind, and whose HUD counts that wind down in percent, the rig was the one thing on
    // screen that never mentioned it.
    for (const [index, cloth] of createSails(createMaterials()).entries()) {
      const sail = SHIP_SAILS[index];
      if (sail === undefined) continue;
      const body = new SoftBody3D(cloth.mesh, {
        damping: 2.2,
        // Local-space, so metres per second squared divided by the model's own scale. Handing the
        // solver 9.81 in a model normalised to 0.57 gives cloth on a body nearly twice the size of
        // the world it is in, and the sails hang like chainmail.
        gravity: [0, -9.81 / this.#normaliseFactor, 0],
        pinned: cloth.pinned,
        // A throttled copy of the cloth's own vertices, so a scenario can assert that the canvas is
        // actually filling rather than that three quads exist. A still sail passes every visual
        // assertion this template has.
        //
        // The fore course alone, and only every twelfth frame. Three sails copying ninety-nine
        // vec4s off the GPU every fourth frame is three copies buying one number.
        readbackEveryFrames: index === 0 ? 12 : 0,
        // Canvas, and a long way stiffer than it looks like it should need. Spring acceleration is
        // stiffness times stretch, so the top row has to carry eight rows of cloth against a local
        // gravity of seventeen: at 52 that balanced at three quarters of a unit of stretch and the
        // sails hung to the waterline. This holds them to within a few per cent of their cut, and
        // 1/60 is still far inside the explicit solver's stability limit of 2/sqrt(k).
        stiffness: 1_200,
        wind: [0, 0, 0],
      });
      body.name = `sail-${index}`;
      body.castShadow = true;
      body.scale.setScalar(this.#normaliseFactor);
      ctx.add(body);
      ctx.interpolate(body);
      this.#sails.push({
        anchor: new Vector3(sail.x, sail.y, sail.z),
        body,
        rest: new Euler(sail.pitch, sail.yaw, 0),
      });
    }
    // The hull hangs off `visual`, not off the physics body.
    //
    // `Buoyancy3D` applies its displaced-volume force at each hull point, so a point that is
    // deeper than its neighbour torques the body — which is right. What no game can reach is the
    // other half of that: Rapier's angular damping is not on `IRigidBody3DOptions`, and the drag
    // term inside `Buoyancy3D` is computed from the body's *linear* velocity, so it is identical
    // at every point and damps no rotation at all. The torque therefore accumulates with nothing
    // opposing it, and within a few seconds of spawning the ship is tumbling. It always was: the
    // template's own first frame showed the old model lying on its side, and that read as "the
    // boat is a plank" rather than as a boat rolled ninety degrees.
    //
    // So the body keeps the heave — that is what buoyancy is for and it is worth having — and the
    // attitude is read off the swell instead: three height samples around the hull give the pitch
    // and the roll, so the ship pitches into the face of a wave and rolls with the beam of it,
    // which is both stable and closer to what a boat does than a free-spinning rigid body ever was.
    this.visual.add(model);
    ctx.add(this.mesh);
    ctx.add(this.visual);
    ctx.interpolate(this.visual);

    this.body = new RigidBody3D({
      collisionLayer: 1,
      collisionMask: 0,
      mass: 420,
      object: this.mesh,
      physics: ctx.physics,
      // Half-extents, from the measured hull rather than the caravel's hand-tuned box: the real
      // ship is narrower for its length (beam 0.97 m against 1.9 m), and a box sized for the old
      // hull would give the wrong moment of inertia for this one.
      shape: CollisionShape3D.box(this.#halfBeam, 0.6, this.#halfLength),
    });
    this.buoyancy = new Buoyancy3D({
      body: this.body,
      density: 1_000,
      drag: 12,
      field: oceanSurface(ocean, () => this.#step),
      gravity: 9.81,
      // All four points sit **below** the body's centre, at the hull's bottom corners, scaled from
      // the caravel's tuned positions by the measured beam and length so they stay inside the real
      // hull's footprint instead of poking out past its sides. `volume` stays the caravel's own
      // figure: it is a buoyancy-feel tuning constant, not a literal displacement, and the mass and
      // drag above were tuned against it.
      hullPoints: [
        { position: [-this.#halfBeam * 0.47, -0.3, -this.#halfLength * 0.44], volume: 0.275 },
        { position: [this.#halfBeam * 0.47, -0.3, -this.#halfLength * 0.44], volume: 0.275 },
        { position: [-this.#halfBeam * 0.47, -0.3, this.#halfLength * 0.44], volume: 0.275 },
        { position: [this.#halfBeam * 0.47, -0.3, this.#halfLength * 0.44], volume: 0.275 },
      ],
      pointSpacing: 0.64,
      volume: 1.1,
    });
  }

  /** The unit vector the bow points along. The model's stem is at **-Z**, so both terms negate. */
  get forward(): { x: number; z: number } {
    return { x: -Math.sin(this.#heading), z: -Math.cos(this.#heading) };
  }

  /** The unit vector out over the starboard rail: the bow turned ninety degrees to the right. */
  get starboard(): { x: number; z: number } {
    return { x: Math.cos(this.#heading), z: -Math.sin(this.#heading) };
  }

  get heading(): number {
    return this.#heading;
  }

  /** Speed made good over the ground. This is the number the HUD shows. */
  get speed(): number {
    return this.#groundSpeed;
  }

  /** Speed the sails are asking for, before the water has its say. */
  get demandedSpeed(): number {
    return this.#speed;
  }

  /**
   * Steer a ship, rather than slide a box around the world axes.
   *
   * What this replaces drove the body's velocity straight from the input — `x` from the left and
   * right keys, `z` from forward — and then turned the *drawn* hull by a slow separate angle that
   * nothing else read. So the ship crabbed: it visibly pointed one way and travelled another, the
   * rudder had no effect on where it went, and the four course marks could be collected by
   * strafing past them broadside. The heading is now the only direction the ship can make way
   * along, which is what makes steering a mechanic instead of a decoration.
   */
  update(ctx: GameCtx, deltaTime: number, wind: number, touch?: ITouchInput): void {
    this.#elapsed += deltaTime;
    this.#step = deltaTime;
    // Two axes, read separately — see the binding comment in `game.ts` for why this is not
    // `vector("move")`. The touch stick *is* a stick, so it stays clamped and adds into both.
    const helm = ctx.input.vector("helm");
    const sheets = ctx.input.vector("sheets");
    const press = Math.max(0, Math.min(1, wind));
    // `sheets.y` is +up and means forward: the one conversion to the model's -Z bow happens in
    // `forward`, not here. Astern input spills the sails rather than driving the ship backwards —
    // a square rig cannot make sternway, so it reads as a brake.
    const throttle = MathUtils.clamp(sheets.y + (touch?.move.y ?? 0), -1, 1);
    const rudder = MathUtils.clamp(helm.x + (touch?.move.x ?? 0), -1, 1);
    const target = MAX_SPEED * press * Math.max(0, throttle);
    // Losing way is faster than gaining it when the sails are spilled, and much faster than the
    // hull's own drag would manage on its own.
    const rate = target < this.#speed ? WAY_RATE * (throttle < 0 ? 3.4 : 1.6) : WAY_RATE;
    this.#speed += (target - this.#speed) * Math.min(1, Math.max(0, deltaTime) * rate * 2);

    // A rudder is a foil: it only bites on water flowing past it. Standing still, the ship swings
    // slowly on its sails alone, and the floor keeps that from being a dead helm.
    const authority = Math.max(0.2, Math.min(1, this.#speed / (MAX_SPEED * 0.55)));
    this.#heading -= rudder * TURN_RATE * authority * deltaTime;

    const forward = this.forward;
    const velocity = this.body.linearVelocity;
    // Read **before** it is overwritten, so this is what the last physics step actually left the
    // hull doing rather than what the sails asked for. The two differ: `Buoyancy3D` applies a drag
    // term from the body's linear velocity, which opposes the drive horizontally as well as
    // vertically. Reporting the demanded speed as though it were the achieved one puts a number in
    // the HUD that the ship never makes good.
    this.#groundSpeed = Math.hypot(velocity.x, velocity.z);
    this.body.linearVelocity = {
      x: forward.x * this.#speed,
      // Heave stays the buoyancy solver's. Overwriting it here would be the game deciding how far
      // the sea can lift its own hull.
      y: velocity.y,
      z: forward.z * this.#speed,
    };

    // Heel: outward in a turn, and a constant lean to leeward under press of sail. Positive
    // `rotation.z` lifts the starboard rail, so a turn to starboard leans the ship to port.
    const heelTarget = rudder * authority * 0.13 + press * 0.04;
    this.#heel += (heelTarget - this.#heel) * Math.min(1, Math.max(0, deltaTime) * 2.4);
    // The rig shows the helm's decision, not only the weather. Spilling the sheets takes the press
    // off the canvas: the sails go slack, the ship loses way, and the two happen together — which
    // is the feedback that makes `S` read as spilling wind rather than as a brake pedal. A quarter
    // of the press stays because a square course does not vanish when it is not drawing.
    // Hard over is about thirty-five degrees on a real ship, and the blade eases across rather
    // than snapping: a rudder that teleports between its stops is the tell that the helm is a
    // number rather than a thing hanging in the water.
    if (this.#rudder !== undefined) {
      const blade = -rudder * 0.6;
      this.#rudder.rotation.y += (blade - this.#rudder.rotation.y) * Math.min(1, deltaTime * 6);
    }
    this.#rideTheSwell(deltaTime);
    this.#trimSails(press * (0.25 + 0.75 * Math.max(0, throttle)));
  }

  /**
   * Carry each sail to its yard, and put the wind into it.
   *
   * The wind vector is in the cloth's **own** space, which is what makes this three numbers rather
   * than a rotation: a square course is turned to face forward, so pressing it along its local +Z
   * fills it aft whatever course the ship is steering; the mizzen lateen is turned side-on by its
   * own rest rotation, so the same +Z presses it to leeward. The gust term is not decoration —
   * canvas that holds one shape is canvas the simulation is not moving, and a still sail on a
   * moving ship reads as a bug.
   */
  #trimSails(press: number): void {
    this.visual.updateMatrixWorld(true);
    for (const sail of this.#sails) {
      // Through the **model's** matrix, not the visual's. The yard coordinates in `SHIP_SAILS`
      // are in the hull's own authored units, and the model sits inside `visual` carrying the
      // metre normalisation and the freeboard trim: read through `visual` alone, a yard at y=4.27
      // put the sail 4.27 *metres* above the sea with the masts bare underneath it.
      sail.body.position.copy(sail.anchor).applyMatrix4(this.#model.matrixWorld);
      sail.body.quaternion.copy(this.visual.quaternion).multiply(REST.setFromEuler(sail.rest));
      const gust = 1 + Math.sin(this.#elapsed * 1.7 + sail.anchor.z) * 0.16;
      // Placement is taken from the drawn hull rather than the physics body, so the rig rides on
      // the ship the player can see.
      sail.body.wind.set(0, press * SAIL_PRESS * 0.12, press * SAIL_PRESS * gust);
    }
    const belly = this.sailBelly;
    if (belly > 0) {
      this.#bellyLow = Math.min(this.#bellyLow, belly);
      this.#bellyHigh = Math.max(this.#bellyHigh, belly);
    }
  }

  /**
   * Read the swell under the ship and set the visual's attitude from it.
   *
   * Two samples a boat-length apart give the pitch, two across the beam give the roll. Both are
   * eased rather than snapped, so the ship lags the water the way a hull with mass does.
   */
  #rideTheSwell(deltaTime: number): void {
    if (this.#capsized) return;
    const { x, z } = this.mesh.position;
    // `SpectralOcean` has no closed form, so its CPU height is a throttled copy of what the GPU
    // produced and can be `undefined` until the first readback lands. Falling back to the mean
    // sea level for those frames is the whole handling this needs — a boat sitting flat at y = 0
    // for the first fraction of a second is invisible, and throwing is not.
    //
    // Every probe is taken **upwind** by however far the swell will have run during the copy's
    // age. `sampleHeight` hands back a height from a GPU copy that is `staleFrames` old, and a
    // hull floated straight onto that number rides water the renderer stopped drawing several
    // frames ago: the ship visibly cut down through a crest and hung above the following trough,
    // and the waterline reading swung between a third and two thirds of the hull between two
    // captures a second apart. Deep-water waves travel, so reading the stale field a little
    // upwind reads what this patch of sea is about to become.
    const heightAt = (sampleX: number, sampleZ: number): number =>
      surfaceHeight(this.#ocean, sampleX, sampleZ, deltaTime) ?? 0;
    // Sampled across the hull's real length and beam, not a token metre. The height copy is a
    // bilinear read of a grid about three metres across, so two probes closer together than that
    // largely describe the same cell and the ship barely responds to the swell it is in.
    //
    // Probed along the **ship's** axes, not the world's. Sampling a fixed north-south pair gave a
    // hull that pitched into swell it was running along the length of and rolled to seas it was
    // meeting head on: turn ninety degrees and the pitch and the roll swapped over. Rotating the
    // four probes by the heading is what makes the attitude belong to this ship rather than to
    // the compass.
    const forward = this.forward;
    const starboard = this.starboard;
    const aheadHeight = heightAt(
      x + forward.x * this.#halfLength,
      z + forward.z * this.#halfLength,
    );
    const asternHeight = heightAt(
      x - forward.x * this.#halfLength,
      z - forward.z * this.#halfLength,
    );
    const starboardHeight = heightAt(
      x + starboard.x * this.#halfBeam,
      z + starboard.z * this.#halfBeam,
    );
    const portHeight = heightAt(x - starboard.x * this.#halfBeam, z - starboard.z * this.#halfBeam);
    const hereHeight = heightAt(x, z);
    this.#seaHeight = hereHeight;
    this.#staleFrames = this.#ocean.sampleHeight(x, z)?.staleFrames ?? -1;
    // The ship's bow is at **-Z**, so a positive `rotation.x` lifts it — which means the pitch is
    // driven by how much higher the water *ahead* is, not the water astern. Written the other way
    // round the bow rose over troughs and drove into the face of every wave, and the ship
    // photographed as though it were going under bow-first.
    //
    // Clamped, because the height field is a copy of a GPU buffer read on a grid coarser than the
    // hull: two probes can disagree by more than the sea actually does, and without a limit one
    // bad pair throws the ship onto its beam ends for a frame.
    // Eight degrees, not seventeen. The clamp exists because the height copy is a grid coarser
    // than the hull, and at the old limit a bad pair of probes threw a 4.6 m caravel onto its
    // bilge every few seconds, which reads as a ship in danger rather than as a boat in a swell.
    const pitch = MathUtils.clamp(
      Math.atan2(aheadHeight - asternHeight, this.#halfLength * 2),
      -0.14,
      0.14,
    );
    // How deep the bow is in the water it is meeting. This is the number the HUD's waterline
    // shows: `Buoyancy3D.submergedFraction` measures its hull points through the body's own
    // quaternion, and with the body free to tumble that reading swings between 0 and 1 with
    // nothing to do with what the player can see.
    this.#immersion = Math.min(
      1,
      Math.max(0, 0.5 + (aheadHeight - this.visual.position.y) / this.#draft),
    );
    // Seven degrees for the same reason, and a caravel's working ballast is amidships: she stands
    // up to a sea rather than lying over into it.
    const roll =
      MathUtils.clamp(Math.atan2(starboardHeight - portHeight, this.#halfBeam * 2), -0.12, 0.12) +
      this.#heel;
    const blend = Math.min(1, Math.max(0, deltaTime) * 3.2);
    this.visual.position.x = this.mesh.position.x;
    this.visual.position.z = this.mesh.position.z;
    // The design waterline sits **on** the surface, not eased towards it.
    //
    // Easing at 3.2 per second is a third of a second of lag, and against a sea whose surface
    // rises at three metres a second that is nearly half a metre of hull hanging in the air over
    // its own trough — most of this ship's draught. A boat this size has no such lag: it is a
    // float, and a float is wherever the water is. The inertia that *is* real lives in the
    // attitude below, where a hull's mass genuinely resists being rolled.
    this.visual.position.y = hereHeight;
    // `YXZ`: yaw, then pitch and roll about the ship's **own** axes. In the default `XYZ` order
    // the pitch is applied in world space and the heel goes wherever the heading happens to point
    // it, so a ship on a westerly course rolled when it should have pitched.
    this.visual.rotation.order = "YXZ";
    this.visual.rotation.y = this.#heading;
    this.visual.rotation.x += (pitch - this.visual.rotation.x) * blend;
    this.visual.rotation.z += (roll - this.visual.rotation.z) * blend;
  }

  capsize(): void {
    if (this.#capsized) return;
    this.#capsized = true;
    this.visual.rotation.z = Math.PI / 2;
  }

  get capsized(): boolean {
    return this.#capsized;
  }

  /**
   * How far the canvas has blown out of its cut, in the cloth's own units.
   *
   * The sails are authored dead flat, so every millimetre of this is the simulation's. It is the
   * only number that separates cloth from three static quads, and it is the one a dying wind has
   * to bring down.
   */
  get sailBelly(): number {
    let furthest = 0;
    for (const sail of this.#sails) {
      const sample = sail.body.sample;
      if (sample === undefined) continue;
      for (let index = 2; index < sample.data.length; index += 3) {
        const z = sample.data[index];
        if (z === undefined || !Number.isFinite(z)) continue;
        furthest = Math.max(furthest, Math.abs(z));
      }
    }
    return furthest;
  }

  /**
   * How far the canvas has travelled between its slackest and its fullest, in the cloth's units.
   *
   * Zero before anything has been observed, and it only grows — which is the whole reason it
   * exists. `sailBelly` on its own is a large number from the first frame the sails have filled,
   * so a threshold on it is already true before a scenario starts and proves nothing; this is
   * false at the start by construction and can only become true if the wind is actually moving
   * the cloth.
   *
   * **Zero also means "not measured yet" until two readbacks have landed**, and `sailSamples`
   * is how a scenario tells those apart. One copy makes the slackest and the fullest the same
   * frame, so the difference is zero by arithmetic rather than by observation, and a bound on it
   * passed a run whose canvas had never been read twice. Do not read a zero here as a still sail
   * without the sample count beside it.
   */
  get sailMotion(): number {
    if (this.#bellyLow > this.#bellyHigh) return 0;
    return this.#bellyHigh - this.#bellyLow;
  }

  /**
   * How many cloth readbacks have landed, so `sailMotion` is not read as a measured zero.
   *
   * Counted from the readback that produced the extremes rather than per tick, because the two
   * are not the same number: `GPUReadback` keeps one copy in flight and drops requests made while
   * it is pending, so a landed copy is *reused* for every tick until the next one arrives. On a
   * CPU rasteriser one copy lands every two to six **seconds** while hundreds of ticks pass, and a
   * per-tick count would report thousands of samples from a single frame's worth of bytes.
   *
   * `sailBelly` needs this context: on a CPU adapter the copy is a `mapAsync` round trip, so how
   * many land inside a scenario is a property of the adapter's readback latency and not of the
   * scenario's tick count. A scenario that binds `sailMotion` should bind this too. Two is the
   * floor: with one copy the range is zero whatever the cloth did.
   */
  get sailSamples(): number {
    const debug = this.#sails[0]?.body.debug() as { readbackStats?: { lands: number } } | undefined;
    return debug?.readbackStats?.lands ?? 0;
  }

  /** Fraction of the hull the sea is over, from the swell the ship is actually sitting in. */
  get immersion(): number {
    return this.#capsized ? 1 : this.#immersion;
  }

  debug(): Record<string, unknown> {
    const velocity = this.body.linearVelocity;
    return {
      capsized: this.#capsized,
      linearVelocity: [velocity.x, velocity.y, velocity.z],
      normaliseFactor: this.#normaliseFactor,
      demandedSpeed: this.#speed,
      groundSpeed: this.#groundSpeed,
      position: this.mesh.position.toArray(),
      immersion: this.#immersion,
      // The three numbers a scenario needs to prove the ship is *floating* rather than merely
      // existing: the sea under it, how far the drawn hull sits off that surface, and whether the
      // height copy is arriving at all. A screenshot cannot tell a still ocean from a moving one.
      seaHeight: this.#seaHeight,
      sailBelly: this.sailBelly,
      sailMotion: this.sailMotion,
      // Beside `sailMotion` on purpose: one landed readback makes that number a zero by
      // arithmetic, and a screenshot cannot tell a canvas that was never sampled from a still one.
      sailSamples: this.sailSamples,
      floatGap: this.visual.position.y - this.#seaHeight,
      readbackStaleFrames: this.#staleFrames,
      oceanSteps: this.#ocean.steps,
      submergedFraction: this.buoyancy.submergedFraction,
    };
  }

  dispose(): void {
    for (const sail of this.#sails) sail.body.removeFromParent();
    this.body.dispose();
    this.mesh.removeFromParent();
    this.visual.removeFromParent();
  }
}
