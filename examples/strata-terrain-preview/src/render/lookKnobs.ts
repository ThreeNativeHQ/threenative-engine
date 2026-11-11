import { Color, Vector3 } from "three";
import { uniform } from "three/tsl";
import type { Node } from "three/webgpu";
import { BIOMES } from "./biomes.js";

const row = BIOMES.forest;
const mist = row.atmosphere.groundMist;
const tint = (r: number, g: number, b: number) =>
  uniform(new Vector3(r, g, b)) as unknown as Node<"vec3"> & { value: Vector3 };
const amount = (value: number) => uniform(value) as unknown as Node<"float"> & { value: number };

/**
 * The wood's look numbers a tweak box can move while the game runs (`?tweak`): each is a uniform
 * that starts at the forest row's own value, so a game that never opens the box draws the row.
 * A value that looks right is copied from the box and written back into `biomes.ts`.
 */
export const LOOK = {
  /** Multiplies every blade, frond and mat (`swardTint`). */
  sward: tint(...(row.swardTint ?? [1, 1, 1])),
  /** Multiplies the open turf under them (`turfTint`). */
  turf: tint(...(row.turfTint ?? [1, 1, 1])),
  /** Multiplies the spruce crowns. */
  crown: tint(1, 1, 1),
  /** Multiplies the trunk bark, and the limbs. */
  bark: amount(1),
  limb: amount(1),
  /** Multiplies the massif's rock. */
  rock: tint(1, 1, 1),
  /** The share of ambient and sky light a plant keeps under a closed crown (`understoreySkyLight`). */
  plantShade: amount(row.understoreySkyLight ?? 1),
  mistColor: uniform(new Color(mist?.color ?? 0x808080)) as unknown as Node<"vec3"> & {
    value: Color;
  },
  mistDensity: amount(mist?.term.density ?? 0),
  mistOpacity: amount(mist?.maxOpacity ?? 0),
  mistScale: amount(mist?.term.scale ?? 1),
};
