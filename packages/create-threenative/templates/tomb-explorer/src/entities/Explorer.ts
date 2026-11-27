import { type ICtx, SkeletalMesh3D } from "@threenative/core";
import { type AnimationClip, Box3, Group, MathUtils, type Object3D } from "three";
import { type IRigConventions, prepareRigConventions } from "../conventions.js";
import { SPAWN } from "../level.js";
import { climberMaterial, dress } from "../render/props.js";
import { toWorld } from "../render/temple.js";
import { type ExplorerState, type IBody, type IInput, createBody } from "../sim/body.js";
import { stepExplorer } from "../sim/step.js";
import type { GameState } from "../state.js";
import { ANGLE, BODY_HEIGHT, TICK, UNIT } from "../tuning.js";

export type GameCtx = ICtx<GameState>;

/** What `ctx.assets.model("mannequin-combat.glb")` hands back. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

/** The clips `assets/mannequin-combat.glb` ships, by the state this file plays them under. */
const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  run: "Jog_Fwd_Loop",
  compress: "Jump_Start",
  air: "Jump_Loop",
  land: "Jump_Land",
  hang: "Jump_Loop",
  climb: "Interact",
  pickup: "PickUp_Table",
  swim: "Sprint_Loop",
  tread: "Spell_Simple_Idle_Loop",
  death: "Death01",
  hit: "Hit_Chest",
} as const;

/** The clip each state plays, and whether it loops. A state not listed keeps what it plays. */
const STATE_CLIP: Readonly<Record<ExplorerState, readonly [keyof typeof CLIPS, boolean]>> = {
  idle: ["idle", true],
  walk: ["walk", true],
  run: ["run", true],
  back: ["walk", true],
  compress: ["compress", false],
  jump: ["air", true],
  fall: ["air", true],
  hang: ["hang", true],
  shimmy: ["hang", true],
  climb: ["climb", false],
  pickup: ["pickup", false],
  surface: ["tread", true],
  swim: ["swim", true],
  glide: ["swim", true],
  tread: ["tread", true],
  dead: ["death", false],
};

/** States that lie the body along its swim direction. */
const SWIMMING = new Set<ExplorerState>(["swim", "glide", "tread"]);
const LANDING_SECONDS = 0.3;

/**
 * The climber: the simulation body (`src/sim/`) driven at the reference engine's 30 updates a
 * second, and the combat mannequin posed to match it. The body knows nothing about three.js.
 */
export class Explorer {
  readonly mesh = new Group();
  readonly body: IBody;
  readonly character: SkeletalMesh3D;
  readonly conventions: IRigConventions;
  /** Pitch and lean live here, so they tilt the figure about its middle. */
  readonly #tilt = new Group();
  readonly #figure = new Group();
  #accumulator = 0;
  #tick = 0;
  #clip = "";
  #jumpEdge = false;
  #landing = 0;
  #hit = 0;
  /** Counters the HUD and the playtests read. */
  jumps = 0;
  grabs = 0;
  hangs = 0;
  climbs = 0;
  bladeHits = 0;
  /** The last note worth a HUD message: the scene reads it and clears it. */
  lastNote = "";

  constructor(ctx: GameCtx, model: IMannequin) {
    this.body = createBody(SPAWN.x, SPAWN.z, 11 * 256, SPAWN.yaw);
    this.character = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      requiredClips: Object.values(CLIPS),
      strideRoot: this.mesh,
    });
    this.mesh.rotation.order = "YXZ";
    this.#figure.add(this.character.root);
    this.#tilt.add(this.#figure);
    this.mesh.add(this.#tilt);
    dress(this.character.root, climberMaterial);
    // Measured, not guessed: the figure's soles sit on the floor of the body, half a body below
    // the mesh origin, whatever pose the asset was authored in.
    const soles = new Box3().setFromObject(this.#figure, true).min.y;
    this.#figure.position.y = -(BODY_HEIGHT / 2) * UNIT - soles;
    this.conventions = prepareRigConventions(this.character.root);
    this.character.root.traverse((object) => {
      object.castShadow = true;
    });
    this.#play("idle", true, 0);
    this.sync();
    ctx.add(this.mesh);
  }

  /** The state the HUD and the playtests read. */
  get state(): ExplorerState {
    return this.body.state;
  }

  /** The update count the blade's cycle runs on. A station restarts it so a trap is on a known beat. */
  get tick(): number {
    return this.#tick;
  }

  resetClock(): void {
    this.#tick = 0;
  }

  /** Called every frame. Runs as many 30 Hz updates as the frame time covers. */
  update(ctx: GameCtx, dt: number, frozen: boolean): void {
    if (ctx.input.justPressed("jump")) this.#jumpEdge = true;
    this.#accumulator += Math.min(dt, 0.1);
    while (this.#accumulator >= TICK) {
      this.#accumulator -= TICK;
      this.#step(ctx, frozen);
    }
    this.#animate(dt);
    this.sync();
  }

  #step(ctx: GameCtx, frozen: boolean): void {
    const held = (name: string): boolean => !frozen && ctx.input.pressed(name);
    // The tank controls read the shared axis: y drives, x turns.
    const move = frozen ? { x: 0, y: 0 } : ctx.input.vector("move");
    const input: IInput = {
      up: move.y > 0.5,
      down: move.y < -0.5,
      left: move.x < -0.5,
      right: move.x > 0.5,
      walk: held("walk"),
      action: held("action"),
      jump: held("jump"),
      jumpEdge: !frozen && this.#jumpEdge,
    };
    this.#jumpEdge = false;
    const before = this.body.state;
    stepExplorer(this.body, input, this.#tick);
    this.#tick += 1;
    this.#note(before);
  }

  /** What an update reports, as counters and as a one-shot flinch or landing. */
  #note(before: ExplorerState): void {
    const { note, state } = this.body;
    if (note !== "") this.lastNote = note;
    if (note === "launch") this.jumps += 1;
    else if (note === "grab" || note === "vault") this.grabs += 1;
    else if (note === "climbed") this.climbs += 1;
    else if (note === "land" || note === "land-hard") {
      this.#landing = LANDING_SECONDS;
      if (note === "land-hard") this.#hit = 0.4;
    } else if (note === "blade") {
      this.bladeHits += 1;
      this.#hit = 0.4;
    }
    if (state === "hang" && before !== "hang" && before !== "shimmy") this.hangs += 1;
  }

  /** Pick the clip the body's state needs, and advance the rig. */
  #animate(dt: number): void {
    this.#landing = Math.max(0, this.#landing - dt);
    this.#hit = Math.max(0, this.#hit - dt);
    const state = this.body.state;
    if (state === "dead") this.#play("death", false, 0.1);
    else if (this.#hit > 0 && state !== "hang" && !SWIMMING.has(state))
      this.#play("hit", false, 0.05);
    else if (this.#landing > 0 && (state === "idle" || state === "walk" || state === "run"))
      this.#play("land", false, 0.05);
    else {
      const [clip, loop] = STATE_CLIP[state];
      this.#play(clip, loop, 0.12);
    }
    this.character.update(dt);
    if (state === "idle" || state === "walk" || state === "run" || state === "back")
      this.conventions.applyGrounding(this.body.y * UNIT, dt);
  }

  #play(action: keyof typeof CLIPS, loop: boolean, fade: number): void {
    const clip = CLIPS[action];
    if (clip === this.#clip) return;
    this.#clip = clip;
    this.character.play(clip, { fade, mode: loop ? "loop" : "once" });
  }

  /** Put the mesh where the body is: yaw, the swim pitch and the turn lean on top. */
  sync(): void {
    const { body } = this;
    const swimming = SWIMMING.has(body.state) || body.state === "surface";
    // `y` is the feet on land and the body centre in water.
    const centre = swimming ? body.y : body.y + BODY_HEIGHT / 2;
    const [x, y, z] = toWorld(body.x, centre, body.z);
    this.mesh.position.set(x, y, z);
    this.mesh.rotation.y = body.yaw;
    // A swimmer lies along her heading: nose-up pitch p tips the body by pi/2 - p about x.
    const lie =
      body.state === "surface"
        ? Math.PI / 2
        : SWIMMING.has(body.state)
          ? Math.PI / 2 - body.pitch
          : 0;
    this.#tilt.rotation.x = MathUtils.lerp(this.#tilt.rotation.x, lie, 0.25);
    this.#tilt.rotation.z = body.lean * ANGLE;
  }

  /** What the playtest bridge reads off a registered entity. */
  debug(): Record<string, unknown> {
    const { body } = this;
    return {
      air: body.air,
      cause: body.cause,
      clip: this.#clip,
      health: Math.round(body.health),
      hangTop: body.hang?.top ?? 0,
      normaliseFactor: this.conventions.normaliseFactor,
      pitch: Math.round(body.pitch * 100) / 100,
      position: this.mesh.position.toArray(),
      relic: body.relic ? 1 : 0,
      state: body.state,
      turnRate: body.turn,
      unitsX: Math.round(body.x),
      unitsY: Math.round(body.y),
      unitsZ: Math.round(body.z),
      yaw: Math.round(MathUtils.euclideanModulo(body.yaw, Math.PI * 2) * 1000) / 1000,
    };
  }

  /** Back to the start: the scene restarts instead (`goto`), so this is for stations. */
  place(x: number, y: number, z: number, yaw: number, state: ExplorerState, air = 1800): void {
    Object.assign(this.body, createBody(x, z, y, yaw), {
      relic: this.body.relic,
      health: this.body.health,
      air,
    });
    this.body.state = state;
    this.#clip = "";
    this.sync();
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}
