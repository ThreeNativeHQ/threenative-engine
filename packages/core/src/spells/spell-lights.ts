/**
 * The lights a spell throws, without the light count ever moving.
 *
 * A point light added at cast time is a shader recompile and a lighting-state change in the middle
 * of a fight. This pool creates its lights once, parks every one of them at zero intensity, and
 * hands them out for the duration of an impact. A cast therefore changes what the lights do and
 * never what they are. Niagara submits spell-sized lights as plain simple lights for the same
 * reason (UE 5.8.3: Engine/Plugins/FX/Niagara/Source/Niagara/Private/NiagaraRendererLights.cpp:100,
 * :201).
 */

import { type Color, type Object3D, PointLight } from "three";

export interface ISpellLightsOptions {
  /** Where the lights are added. A scene, or any object that outlives the casts. */
  readonly parent: Object3D;
  /** Lights in the pool. Defaults to 4: a charge glow, an impact flash, and two in flight. */
  readonly count?: number;
  /** Lights are cheaper than shadows for a flash; a spell never casts one. */
  readonly shadows?: boolean;
}

interface ISlotState {
  /** Seconds left on the current flash. */
  remaining: number;
  /** Seconds the current flash was asked for. */
  duration: number;
  /** Intensity the current flash started at. */
  peak: number;
}

/** One light, and the game-owned look it was given. */
export interface ISpellLightFlash {
  /** World position of the flash. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: Color;
  /** Peak intensity in candela. */
  readonly intensity: number;
  /** Metres the light reaches. */
  readonly range: number;
  /** Seconds the flash takes to decay to zero. */
  readonly seconds: number;
}

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
};

/**
 * A fixed pool of spell lights.
 *
 * `flash` returns false when every light is busy: a spell reports that and carries on without
 * one rather than growing the pool. Intensity decays linearly to zero, which reads as a flash
 * rather than a lamp fading, and Update runs on the same fixed delta as the casts.
 */
export class SpellLights {
  readonly lights: readonly PointLight[];
  readonly #slots: ISlotState[];

  constructor(options: ISpellLightsOptions) {
    if (options.parent === undefined || options.parent === null)
      throw new Error("SpellLights.parent is required.");
    const count = options.count ?? 4;
    if (!Number.isInteger(count) || count < 1 || count > 32)
      throw new RangeError("SpellLights.count must be an integer in 1..32");
    this.lights = Array.from({ length: count }, (_, index) => {
      const light = new PointLight(0xffffff, 0, 10, 2);
      light.name = `spell-light-${index}`;
      light.intensity = 0;
      light.castShadow = options.shadows ?? false;
      light.visible = false;
      options.parent.add(light);
      return light;
    });
    this.#slots = this.lights.map(() => ({ duration: 1, peak: 0, remaining: 0 }));
  }

  /** True while at least one light is lit, so a game can skip its own light bookkeeping. */
  get active(): boolean {
    return this.#slots.some((slot) => slot.remaining > 0);
  }

  /** The light this flash took, or undefined when the pool was full. */
  flash(request: ISpellLightFlash): PointLight | undefined {
    const seconds = finite(request.seconds, "flash.seconds");
    if (seconds <= 0) throw new RangeError("flash.seconds must be positive");
    const index = this.#slots.findIndex((slot) => slot.remaining <= 0);
    if (index < 0) return undefined;
    const light = this.lights[index] as PointLight;
    const slot = this.#slots[index] as ISlotState;
    const intensity = finite(request.intensity, "flash.intensity");
    slot.peak = Math.max(0, intensity);
    slot.duration = seconds;
    slot.remaining = seconds;
    light.position.set(
      finite(request.x, "flash.x"),
      finite(request.y, "flash.y"),
      finite(request.z, "flash.z"),
    );
    light.color.copy(request.color);
    light.distance = Math.max(0, finite(request.range, "flash.range"));
    light.intensity = slot.peak;
    light.visible = slot.peak > 0;
    return light;
  }

  /** Put every light out now, without waiting for its decay. */
  clear(): void {
    for (const [index, slot] of this.#slots.entries()) {
      slot.remaining = 0;
      slot.peak = 0;
      const light = this.lights[index] as PointLight;
      light.intensity = 0;
      light.visible = false;
    }
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("SpellLights.update delta must be finite and non-negative");
    for (const [index, slot] of this.#slots.entries()) {
      if (slot.remaining <= 0) continue;
      slot.remaining -= dt;
      const light = this.lights[index] as PointLight;
      if (slot.remaining <= 0) {
        slot.remaining = 0;
        slot.peak = 0;
        light.intensity = 0;
        light.visible = false;
        continue;
      }
      light.intensity = slot.peak * (slot.remaining / slot.duration);
    }
  }
}
