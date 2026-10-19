import type { SnowField } from "@threenative/core/world";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Object3D } from "three";
import { BOOT_AREA, bootPrint } from "../render/bootPrint.js";
import { ExplorerModel, type IFootPose } from "../render/explorer.js";
import type { SnowMaterials } from "../render/materials.js";
import { EXPLORER_LAYER, SNOW_LAYER, terrainHeight } from "../terrain.js";

/** One planted boot: where, how it was turned, and how far it sank. */
export interface IFootstep {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly angle: number;
  readonly penetration: number;
  readonly speed: number;
  readonly side: number;
}

interface IFoot extends IFootPose {
  side: number;
  x: number;
  y: number;
  z: number;
  angle: number;
  swing: boolean;
  progress: number;
  stop: number;
  from: { x: number; z: number };
  to: { x: number; z: number };
}

/** The explorer's weight, which every planted boot presses into the snow. */
const MASS = 80;
const GRAVITY = 9.81;
/** Capsule straight half-length and radius: 1.7 m tall, origin at the waist. */
const HALF_HEIGHT = 0.55;
const RADIUS = 0.3;
const WAIST = HALF_HEIGHT + RADIUS;
/**
 * How far each boot lands from the line of travel. Wide enough that the left and right prints
 * stay two rows with snow between them rather than merging into one trench.
 */
export const STANCE = 0.2;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const damp = (a: number, b: number, rate: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-rate * Math.max(0, dt)));
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Walking pace through powder: deeper, softer snow is slower; packed snow is faster. */
function paceThrough(depth: number, compaction: number, running: boolean): number {
  const resistance = clamp(depth, 0, 0.6) * (1 - clamp(compaction, 0, 1) * 0.75);
  return (running ? 3.25 : 1.65) / (1 + resistance * 3.5);
}

/**
 * The procedural explorer. Movement goes through a `CharacterBody3D`, so trees, rocks and the
 * ball stop or get pushed by real collision; each boot is planted by the walk cycle, and only a
 * grounded body plants one. A planted boot presses `bootPrint` into the snow with the explorer's
 * own weight over the sole's area — the snow decides how deep that goes.
 */
export class Explorer {
  readonly body: CharacterBody3D;
  readonly model: ExplorerModel;
  /** What a playtest or camera tracks: the drawn explorer, not the collision capsule. */
  readonly object: Object3D;
  readonly position = { x: 0, y: 0, z: 0 };
  heading = Math.PI;
  speed = 0;
  steps = 0;
  #velocity = { x: 0, z: 0 };
  #cycle = 0.1;
  #elapsed = 0;
  #last = { x: 0, z: 0 };
  readonly #feet: IFoot[] = [];
  readonly #snow: SnowField;
  readonly #onStep: (step: IFootstep) => void;

  constructor(
    physics: IPhysicsContext,
    snow: SnowField,
    materials: SnowMaterials,
    start: { x: number; z: number },
    onStep: (step: IFootstep) => void,
  ) {
    this.#snow = snow;
    this.#onStep = onStep;
    const anchor = new Object3D();
    anchor.position.set(start.x, snow.heightAt(start.x, start.z) + WAIST + 0.05, start.z);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.25, minWidth: 0.1 },
      maxSlopeClimbAngle: 0.8,
      object: anchor,
      physics,
      // Stands on the coarse walk surface, never the 6 cm snow collider (see `WALK_SAMPLES`).
      collisionLayer: EXPLORER_LAYER,
      collisionMask: 0xffff & ~SNOW_LAYER,
      pushesDynamicBodies: true,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
      snapToGround: 0.3,
    });
    this.model = new ExplorerModel(materials);
    this.object = this.model.root;
    this.position.x = start.x;
    this.position.z = start.z;
    this.position.y = snow.heightAt(start.x, start.z) - 0.07;
    this.#last = { x: start.x, z: start.z };
    for (const side of [-1, 1]) {
      const x = start.x + side * STANCE * Math.cos(this.heading);
      const z = start.z - side * STANCE * Math.sin(this.heading);
      this.#feet.push({
        angle: this.heading,
        from: { x, z },
        progress: 0,
        side,
        stop: 0,
        swing: false,
        to: { x, z },
        x,
        y: snow.heightAt(x, z) + 0.14,
        z,
      });
    }
    this.model.pose(this.position, this.heading, this.#feet, this.#cycle, 0, 0);
  }

  /** Steer towards `move` (a world-space direction, length up to 1) for one fixed step. */
  update(dt: number, move: { x: number; z: number }, running: boolean, hardness: number): void {
    this.#elapsed += dt;
    const snow = this.#snow;
    const anchor = this.body.object.position;
    // The walk cycle advances by the ground the body actually covered, so a blocked explorer
    // treads in place instead of skating.
    const travelled = Math.hypot(anchor.x - this.#last.x, anchor.z - this.#last.z);
    this.speed = travelled / Math.max(1e-4, dt);
    this.#last = { x: anchor.x, z: anchor.z };
    this.position.x = anchor.x;
    this.position.z = anchor.z;

    const pace = paceThrough(snow.depth, snow.sample(anchor.x, anchor.z).compaction, running);
    const length = Math.hypot(move.x, move.z);
    const scale = length > 1 ? 1 / length : 1;
    const moving = length > 0.01;
    this.#velocity.x = damp(this.#velocity.x, move.x * scale * pace, moving ? 5 : 8, dt);
    this.#velocity.z = damp(this.#velocity.z, move.z * scale * pace, moving ? 5 : 8, dt);
    if (!moving && Math.hypot(this.#velocity.x, this.#velocity.z) < 0.025) {
      this.#velocity.x = 0;
      this.#velocity.z = 0;
    }
    this.body.velocity.x = this.#velocity.x;
    this.body.velocity.z = this.#velocity.z;
    this.body.moveAndSlide(dt);

    if (this.speed > 0.05) {
      const desired = Math.atan2(this.#velocity.x, this.#velocity.z);
      const turn = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading));
      this.heading += turn * (1 - Math.exp(-7 * dt));
    }
    this.#cycle += travelled / (running ? 1.22 : 1.04);
    this.#stepFeet(dt, running, hardness);

    const sink = this.#sinkDepth(hardness) * 0.6;
    const bob =
      this.speed > 0.02
        ? Math.cos(this.#cycle * Math.PI * 4) * 0.016
        : Math.sin(this.#elapsed * 1.8) * 0.003;
    this.position.y = damp(
      this.position.y,
      terrainHeight(anchor.x, anchor.z) + snow.depth - sink + bob,
      14,
      dt,
    );
    this.model.pose(
      this.position,
      this.heading,
      this.#feet,
      this.#cycle,
      this.speed,
      this.#elapsed,
    );
  }

  /** How far an 80 kg boot sinks in this snow, for the body's visual height. */
  #sinkDepth(hardness: number): number {
    const pressure = (MASS * GRAVITY) / BOOT_AREA;
    const resistance = 18_000 + clamp(hardness, 0, 1) ** 1.5 * 140_000;
    return clamp(this.#snow.depth * (0.16 + pressure / resistance), 0, this.#snow.depth * 0.82);
  }

  #stepFeet(dt: number, running: boolean, hardness: number): void {
    const snow = this.#snow;
    const forward = { x: Math.sin(this.heading), z: Math.cos(this.heading) };
    const right = { x: Math.cos(this.heading), z: -Math.sin(this.heading) };
    for (const foot of this.#feet) {
      const phase = (this.#cycle + (foot.side > 0 ? 0.5 : 0)) % 1;
      if (!foot.swing && phase >= 0.58 && this.speed > 0.08) {
        foot.swing = true;
        foot.progress = 0;
        foot.stop = 0;
        foot.from = { x: foot.x, z: foot.z };
        foot.angle = this.heading;
        const reach = running ? 0.64 : 0.49;
        foot.to = {
          x: this.position.x + forward.x * reach + right.x * foot.side * STANCE,
          z: this.position.z + forward.z * reach + right.z * foot.side * STANCE,
        };
      }
      if (foot.swing) {
        if (phase < 0.58 && this.speed > 0.08) {
          this.#plant(foot, running, hardness);
          continue;
        }
        let progress = clamp((phase - 0.58) / 0.42, 0, 1);
        if (this.speed < 0.08) {
          foot.stop += dt * 3.2;
          progress = Math.max(foot.progress, clamp(foot.progress + foot.stop, 0, 1));
        }
        foot.progress = progress;
        const eased = smoothstep(0, 1, progress);
        foot.x = lerp(foot.from.x, foot.to.x, eased);
        foot.z = lerp(foot.from.z, foot.to.z, eased);
        const lift =
          Math.sin(progress * Math.PI) * (0.15 + snow.depth * 0.3 + (running ? 0.07 : 0));
        foot.y = this.#surface(foot.x, foot.z) + 0.14 + lift;
        if (progress >= 0.999) this.#plant(foot, running, hardness);
      } else foot.y = this.#surface(foot.x, foot.z) + 0.14;
    }
  }

  #surface(x: number, z: number): number {
    const half = this.#snow.field.width / 2 - 1e-3;
    return this.#snow.heightAt(clamp(x, -half, half), clamp(z, -half, half));
  }

  #plant(foot: IFoot, running: boolean, hardness: number): void {
    foot.x = foot.to.x;
    foot.z = foot.to.z;
    foot.swing = false;
    foot.stop = 0;
    // A boot only presses snow when the body is standing on it: a jump or a fall plants nothing.
    const penetration = this.body.grounded
      ? this.#snow.stamp({
          area: BOOT_AREA,
          footprint: bootPrint,
          hardness,
          load: MASS * GRAVITY * (running ? 1.2 : 1),
          rotation: foot.angle,
          x: foot.x,
          z: foot.z,
        })
      : 0;
    if (penetration > 0) this.steps += 1;
    foot.y = this.#surface(foot.x, foot.z) + 0.14;
    this.#onStep({
      angle: foot.angle,
      penetration,
      side: foot.side,
      speed: this.speed,
      x: foot.x,
      y: foot.y - 0.12,
      z: foot.z,
    });
  }

  debug(): Record<string, unknown> {
    return {
      grounded: this.body.grounded,
      heading: this.heading,
      position: [this.position.x, this.position.y, this.position.z],
      speed: this.speed,
      steps: this.steps,
    };
  }
}
