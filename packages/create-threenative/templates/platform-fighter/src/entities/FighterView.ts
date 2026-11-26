import { MathUtils, type Mesh, type MeshStandardMaterial } from "three";
import {
  cpuMaterial,
  createShieldBubble,
  dress,
  ghostMaterial,
  p1Material,
} from "../render/fighters.js";
import { totalFrames } from "../sim/attacks.js";
import { GETUP_FRAMES, ROLL_FRAMES, STEP } from "../sim/constants.js";
import { shieldRadius } from "../sim/match.js";
import type { FighterId, IAttackRun, IFighter } from "../sim/types.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";

/** The clips `assets/mannequin-combat.glb` ships, by the stance or action this file plays them for. */
const CLIPS = {
  charge: "Sword_Idle",
  crouch: "Crouch_Idle_Loop",
  dodge: "Roll",
  getup: "Jump_Start",
  hang: "Jump_Loop",
  hit: "Hit_Chest",
  hitHard: "Hit_Head",
  idle: "Idle_Loop",
  jump: "Jump_Loop",
  jumpStart: "Jump_Start",
  run: "Sprint_Loop",
  stun: "Hit_Head",
  walk: "Walk_Loop",
} as const;

/** Above this ground speed the run clip plays instead of the walk. */
const RUN_CLIP_SPEED = 5;
/** A heavy hit tumbles the whole body; radians per second. */
const TUMBLE_RATE = 14;
const TURN_RATE = 18;

/** One mannequin driven by one simulated fighter: it reads the sim and never writes to it. */
export class FighterView extends Fighter {
  readonly #skin: MeshStandardMaterial;
  readonly #bubble: Mesh;
  #worn: MeshStandardMaterial | undefined;
  #mode = "";
  #attack: IAttackRun | undefined;
  #struck = false;
  #jumps = 1;
  #percent = 0;
  #turn = Math.PI / 2;

  constructor(ctx: GameCtx, model: IMannequin, id: FighterId) {
    super(ctx, model, [
      ...new Set(Object.values(CLIPS)),
      ...["Punch_Jab", "Punch_Cross", "Sword_Attack"],
    ]);
    this.#skin = id === "p1" ? p1Material : cpuMaterial;
    this.#bubble = createShieldBubble(id === "p1" ? 0x6aa8ff : 0xff9a72);
    this.mesh.add(this.#bubble);
    this.#wear(this.#skin);
    this.loop(CLIPS.idle, 0);
  }

  #wear(material: MeshStandardMaterial): void {
    if (this.#worn === material) return;
    this.#worn = material;
    dress(this.character.root, material);
  }

  /** Places the mannequin on the simulated fighter and plays the clip the fighter is really doing. */
  sync(f: IFighter, dt: number): void {
    this.mesh.visible = f.mode !== "dead";
    // Feet at `f.y`: the capsule centre is 0.9 m above, plus the 1 cm the figure floats.
    this.mesh.position.set(f.x, f.y + 0.91, 0);
    const turnTo = f.facing === 1 ? Math.PI / 2 : -Math.PI / 2;
    this.#turn += (turnTo - this.#turn) * Math.min(1, dt * TURN_RATE);
    this.figure.rotation.y = this.#turn;
    this.#wear(f.invuln > 0 && f.mode !== "hitstun" ? ghostMaterial : this.#skin);

    const tumbling = f.mode === "hitstun" && f.hitstunTotal > 32 && f.floor === undefined;
    this.mesh.rotation.z = tumbling
      ? this.mesh.rotation.z + Math.sign(f.kx || -f.facing) * -TUMBLE_RATE * dt
      : MathUtils.lerp(this.mesh.rotation.z, 0, Math.min(1, dt * 12));

    this.#bubble.visible = f.mode === "shield" && f.shieldRelease === 0;
    if (this.#bubble.visible) this.#bubble.scale.setScalar(shieldRadius(f));

    this.#animate(f);
    this.advance(dt);
    this.#mode = f.mode;
    this.#jumps = f.jumps;
    this.#percent = f.percent;
  }

  #animate(f: IFighter): void {
    const entered = f.mode !== this.#mode;
    const run = f.attack;
    if (f.mode === "attack" && run !== undefined) {
      if (run !== this.#attack) {
        this.#attack = run;
        this.#struck = false;
        // A strong attack raises the sword first; the swing clip starts when the charge ends.
        if (run.def.chargeFrame === undefined) this.play(run.def.clip, totalFrames(run.def) * STEP);
        else this.loop(CLIPS.charge, 0.05);
      } else if (
        run.def.chargeFrame !== undefined &&
        !this.#struck &&
        run.frame > run.def.chargeFrame &&
        !run.waiting
      ) {
        this.#struck = true;
        this.play(run.def.clip, (totalFrames(run.def) - run.def.chargeFrame) * STEP);
      }
      return;
    }
    this.#attack = undefined;
    switch (f.mode) {
      case "dodge":
        if (entered) this.play(CLIPS.dodge, ROLL_FRAMES * STEP);
        return;
      case "getup":
        if (entered) this.play(CLIPS.getup, GETUP_FRAMES * STEP, { record: false });
        return;
      case "hitstun":
        if (entered || f.percent !== this.#percent)
          this.play(
            f.hitstunTotal > 32 ? CLIPS.hitHard : CLIPS.hit,
            Math.max(0.2, Math.min(f.hitstunTotal, 40) * STEP),
            {
              record: false,
            },
          );
        return;
      case "stun":
        if (entered) this.play(CLIPS.stun, 0.5, { record: false });
        return;
      case "ledge":
        this.loop(CLIPS.hang);
        return;
      case "shield":
      case "squat":
        this.loop(CLIPS.crouch, 0.08);
        return;
      default:
        break;
    }
    if (f.floor === undefined) {
      if (f.jumps < this.#jumps && f.mode === "free")
        this.play(CLIPS.jumpStart, 0.3, { record: false });
      else this.loop(CLIPS.jump, 0.1);
      return;
    }
    const speed = Math.abs(f.vx);
    this.loop(speed > RUN_CLIP_SPEED ? CLIPS.run : speed > 0.3 ? CLIPS.walk : CLIPS.idle, 0.12);
  }
}
