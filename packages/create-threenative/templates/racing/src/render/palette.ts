// Generated for you: every colour the race uses, in one place. ThreeNative does not read this file.
//
// Six named roles, and only one of them is saturated. That is the whole rule: a track read at
// speed is a grey circuit, a grey sky and one colour that means *this is the thing you are here
// for* — the rival's nose, the boost chevrons, the finish banner. Every other surface is a value
// on the same neutral ramp, so the eye goes to the racing, not to the paint job.
//
// The two `sky*` roles are the loading screen's backdrop and progress track (`loading.ts` reads
// them by name); `horizon` is the photographed sky's own haze, which is what distance fades into.
import { MeshStandardMaterial } from "three";

export const palette = {
  /** Loading screen backdrop. */
  skyLow: 0xb8bcc2,
  /** Loading screen progress track. */
  skyHigh: 0x2f3640,
  /** The sky photograph's own horizon: distance fades into this rather than into grey. */
  horizon: 0xacb1c1,
  /** Light grid: the run-off apron and the infield, so the ground reads as a measured surface. */
  floor: 0xb4b1ae,
  /** Dark grid: grandstands, hoardings, tyre walls, the treeline. */
  structure: 0x747578,
  /** The one saturated colour: the rival, the boost, the finish banner, a held touch control. */
  accent: 0x2a6cf0,
} as const;

const materials = new Map<string, MeshStandardMaterial>();

export function toon(color: number, roughness = 0.72): MeshStandardMaterial {
  const key = `${color}:${roughness}`;
  const cached = materials.get(key);
  if (cached !== undefined) return cached;
  const material = new MeshStandardMaterial({ color, roughness, metalness: 0.05 });
  materials.set(key, material);
  return material;
}
