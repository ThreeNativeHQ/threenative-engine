import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";

/**
 * A value-noise field, 0..1, as the numbers that shape it.
 *
 * Every per-biome field the placement rules read — a stand's density, a mat plain's cover, the
 * drift a blade grows on — is this one formula: a floor plus two octaves of value noise. A field is
 * therefore a value a biome carries, not a branch that picks a function: a sixth biome tunes the
 * floor, the gains and the frequencies, and the code that samples it does not change.
 */
export interface ICoverField {
  /** The weight the field stands at where the noise is zero. */
  readonly base: number;
  /** Octaves, low frequency first: how much of it lands in the sum, and where it is sampled. */
  readonly octaves: readonly {
    /** How much of this octave's noise lands in the sum. */
    readonly gain: number;
    /** Metres⁻¹ the field is sampled at: a small frequency gives broad patches. */
    readonly frequency: number;
    /** The field's own seed axis, so two octaves do not line up. */
    readonly offset: number;
  }[];
}

/** Value noise is stateless and its permutation table fixed, so one instance serves every field. */
const noise = new ImprovedNoise();

/** Clamped to 0..1, because a field weight is a share of the ground. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A field's weight at (x, z), clamped to 0..1.
 *
 * @requires npm i -D @threenative/terrain
 * @situation sample the stand field a biome's trees and cover thin on
 * @situation measure the drift a biome's blades grow by, or the mat field its cover follows
 * @constraint the field is a value, so two worlds sample the same formula with their own numbers
 * @example const stand = fieldWeight(STAND_FIELD, x, z);
 */
export function fieldWeight(field: ICoverField, x: number, z: number): number {
  let sum = field.base;
  for (const octave of field.octaves)
    sum += octave.gain * noise.noise(x * octave.frequency, octave.offset, z * octave.frequency);
  return clamp01(sum);
}

/**
 * The stand field: where the wood closes and where it opens. Two octaves of value noise rather than
 * a sum of sines, whose stripes read as "Tree Tree Tree" from the air.
 */
export const STAND_FIELD: ICoverField = {
  base: 0.5,
  octaves: [
    { gain: 0.3, frequency: 0.0075, offset: 3.1 },
    { gain: 0.2, frequency: 0.026, offset: 8.7 },
  ],
};

/** The mat field a mat plain is measured by: lichen mats, thicker and finer than a stand's patches. */
export const MATS_FIELD: ICoverField = {
  base: 0.52,
  octaves: [
    { gain: 0.85, frequency: 0.043, offset: 11 },
    { gain: 0.15, frequency: 0.11, offset: 19 },
  ],
};
