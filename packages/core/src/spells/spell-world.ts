/**
 * The world a spell lands in.
 *
 * A spell that reads `scene`, `camera` and a floor function directly has to be rewritten for every
 * game, and the upstream files show what happens when it is: 34 of them read the arena SDF, so the
 * arena is load-bearing and a game cannot replace it. Everything a spell needs therefore arrives
 * through here — the scene to add its pooled objects to, the floor to land on, the light pool that
 * never changes size, the surface field it paints, one shake and one flash limiter.
 *
 * Damage, mana, cooldowns and who the target actually is stay in the game. `SpellWorld` knows
 * nothing about them, and a game that wants a spell to hurt something reads the cast's `to` point
 * from its own update and decides.
 */

import { type Camera, Color, type Object3D, type Scene, Vector3 } from "three";
import { CameraShake, type CameraShakeCurve, type ICameraShakeOptions } from "../camera-shake.js";
import type { ICastEnvironment } from "./cast-pool.js";
import { type IReactionFieldOptions, ReactionField } from "./reaction-field.js";
import { SpellLights } from "./spell-lights.js";

export interface ISpellWorldShakeOptions {
  /** Metres. Defaults to 0.12, which reads as a thump and not as a broken camera. */
  readonly amplitude?: number;
  /** Radians. Defaults to 0.012. */
  readonly rotationAmplitude?: number;
  /** Cycles per second. Defaults to 11. */
  readonly frequency?: number;
  /** Exponential decay per second. Defaults to 5. */
  readonly decay?: number;
  readonly curve?: CameraShakeCurve;
}

export interface ISpellWorldOptions {
  /** Where every pooled object is added. The game owns it, and it outlives every cast. */
  readonly scene: Scene;
  /** The camera a spell may read for billboarding. Optional: most spells never look at it. */
  readonly camera?: Camera;
  /** Floor height under a point in metres. A spell lands here instead of at y = 0. */
  readonly groundAt?: (x: number, z: number) => number;
  /** Cast records. Defaults to 16. */
  readonly castSlots?: number;
  /** Lights in the pool. Defaults to 4. */
  readonly lightCount?: number;
  /** Surface field. Defaults to 96 cells over 120 m. `false` skips it and saves the float arrays. */
  readonly reaction?: IReactionFieldOptions | false;
  /**
   * Keep every spell to at most three flashes per second (WCAG 2.3.1). Defaults to false, which is
   * the upstream behaviour; a game with an accessibility setting turns it on.
   */
  readonly reducedFlashes?: boolean;
  /** Spells that shake the camera. `false` gives them nothing to shake. */
  readonly shake?: ISpellWorldShakeOptions | false;
  /**
   * Parent an object a spell built. A `GPUParticles3D` also needs a renderer before it can emit, and
   * only the game knows its own context: pass the game context's `add`, which parents *and* attaches.
   * The default parents to `scene`, which is enough for a test and not enough to draw.
   */
  readonly add?: (object: Object3D) => void;
}

/** The stock shake: one thump, gone in about a fifth of a second. */
const DEFAULT_SHAKE: Required<Omit<ISpellWorldShakeOptions, "curve">> = {
  amplitude: 0.12,
  decay: 5,
  frequency: 11,
  rotationAmplitude: 0.012,
};

const DEFAULT_CURVE: CameraShakeCurve = (phase) => Math.sin(phase) * Math.cos(phase * 1.7);

/**
 * Everything a spell is allowed to touch.
 *
 * One instance per game. `update` advances the light decay, the surface field and the shake; the
 * casts themselves live in a `CastPool` the game steps itself, so a paused game can stop casting
 * without also freezing a scorch that is still fading.
 */
export class SpellWorld implements ICastEnvironment {
  readonly scene: Scene;
  readonly camera: Camera | undefined;
  readonly groundAt: ((x: number, z: number) => number) | undefined;
  readonly castSlots: number;
  readonly lights: SpellLights;
  readonly reaction: ReactionField | undefined;
  readonly shake: CameraShake | undefined;
  readonly reducedFlashes: boolean;
  /** Where a spell with no `from` starts: the caster's hand, in world metres. */
  readonly focus = new Vector3();
  /** Parent a spell's pooled object. See `ISpellWorldOptions.add`. */
  readonly add: (object: Object3D) => void;
  /** Everything a spell has parented through `add`, in creation order. */
  readonly objects: Object3D[] = [];
  /** Seconds since the world was created. */
  time = 0;
  /** Flashes the limiter refused, so a game can see its own accessibility setting working. */
  suppressedFlashes = 0;

  /** Millisecond stamps of the flashes that were allowed, newest last, at most `FLASH_WINDOW`. */
  #flashes: number[] = [];

  constructor(options: ISpellWorldOptions) {
    if (options.scene === undefined || options.scene === null)
      throw new Error("SpellWorld.scene is required.");
    this.scene = options.scene;
    this.camera = options.camera;
    this.groundAt = options.groundAt;
    this.castSlots = options.castSlots ?? 16;
    this.add = (object: Object3D) => {
      if (this.objects.includes(object)) return;
      this.objects.push(object);
      if (options.add === undefined) options.scene.add(object);
      else options.add(object);
    };
    this.reducedFlashes = options.reducedFlashes ?? false;
    this.lights = new SpellLights({ count: options.lightCount ?? 4, parent: options.scene });
    this.reaction =
      options.reaction === false ? undefined : new ReactionField(options.reaction ?? {});
    if (options.shake === false) this.shake = undefined;
    else {
      const shake = options.shake ?? {};
      const amplitude = shake.amplitude ?? DEFAULT_SHAKE.amplitude;
      const rotationAmplitude = shake.rotationAmplitude ?? DEFAULT_SHAKE.rotationAmplitude;
      const settings: ICameraShakeOptions = {
        amplitude: new Vector3(amplitude, amplitude * 0.6, amplitude),
        curve: shake.curve ?? DEFAULT_CURVE,
        decay: shake.decay ?? DEFAULT_SHAKE.decay,
        frequency: shake.frequency ?? DEFAULT_SHAKE.frequency,
        rotationAmplitude: new Vector3(
          rotationAmplitude,
          rotationAmplitude,
          rotationAmplitude * 0.5,
        ),
      };
      this.shake = new CameraShake(settings);
    }
  }

  /**
   * Ask the limiter whether a flash may be shown.
   *
   * With reduced flashes on, a fourth flash inside one second is refused and the spell draws its
   * impact without one. Returning a boolean rather than quietly dimming keeps the spell honest:
   * the spell still happens, the flash does not.
   */
  flash(): boolean {
    if (!this.reducedFlashes) return true;
    const now = this.time * 1000;
    this.#flashes = this.#flashes.filter((at) => now - at < 1000);
    if (this.#flashes.length >= FLASH_PER_SECOND) {
      this.suppressedFlashes += 1;
      return false;
    }
    this.#flashes.push(now);
    return true;
  }

  /** Surface height of the floor under a point, or 0 when the game supplied none. */
  floorAt(x: number, z: number): number {
    return this.groundAt?.(x, z) ?? 0;
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("SpellWorld.update delta must be finite and non-negative");
    this.time += dt;
    this.lights.update(dt);
    this.reaction?.update(dt);
    this.shake?.update(dt);
  }

  /** Put out every light, clear the floor and stop the shake, keeping every pool warm. */
  clear(): void {
    this.lights.clear();
    this.reaction?.clear();
    this.shake?.stop();
    this.#flashes = [];
    this.suppressedFlashes = 0;
  }
}

/** WCAG 2.3.1: no more than three flashes in any one-second window. */
const FLASH_PER_SECOND = 3;

/** A colour the spell factories share, so a stock look and an override read the same. */
export function color(value: string | Color): Color {
  return value instanceof Color ? value : new Color(value);
}
