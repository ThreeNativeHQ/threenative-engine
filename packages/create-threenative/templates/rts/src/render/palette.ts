// Generated for you. Keep these roles coherent when you change the look.
import { Color, LinearSRGBColorSpace } from "three";
// The AstraCraft battlefield: the painted ground lives in `ground.ts`; these are the few colours
// other files share, plus the three faction colours the simulation owns (`STARTS` in src/sim/terrain.ts).
export const palette = {
  /** The skirt under the map edge: the plain a wide zoom sees past the mesas. */
  cliff: 0x353f38,
  /** Ground nobody has ever seen, and the dark backing behind rings and bars. */
  unseen: 0x060f16,
  /** Distance haze: the fog colour the far battlefield fades into. */
  horizon: 0x31464a,
  /** The order marker ring: the one saturated colour, what the player just touched. */
  accent: 0xffffff,
  /** The fog-of-war sheet `materials.ts` blends over that unseen ground, read as linear light. */
  fogOfWar: 0x020a16,
} as const;

/**
 * An AstraCraft colour as AstraCraft drew it. It ran three r140, whose legacy colour handling used a
 * hex value as linear light; three today decodes hex as sRGB, which turns the same number warmer,
 * darker and more saturated (the sun's 0xffe7c4 became orange). Lights, fog and flat materials taken
 * from the reference go through this; painted textures stay sRGB, as they were there.
 */
export function legacyColor(hex: number): Color {
  return new Color().setHex(hex, LinearSRGBColorSpace);
}

/**
 * A hex colour's three channels as 0–1 numbers, undecoded: a shader node takes numbers rather than a
 * `Color`, and the fog-of-war sheet is linear light the way AstraCraft's canvas wrote it.
 */
export function channels(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}
