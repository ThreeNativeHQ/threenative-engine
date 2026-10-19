import { Heightfield, SnowField } from "@threenative/core/world";

/** The playable snowfield is a square this many metres across, centred on the origin. */
export const FIELD_SIZE = 24;
/**
 * Samples along each side. 401 puts one every 6 cm, fine enough for a boot's heel and toe and
 * the gap between two prints to read. The same samples are the drawn mesh and the collider, so
 * raising it costs triangles and collider rebuilds as well.
 */
export const FIELD_SAMPLES = 401;
/**
 * What the explorer's capsule stands on: the ground plus fresh snow, one sample every 24 cm.
 * Rapier sweeps a character's capsule against every collider triangle under it, so on the 6 cm
 * snow collider each step cost ~0.9 ms (measured); here it is a tenth of that. The body's drawn
 * height and its boots already come from the canonical snow, so nothing visible changes.
 */
export const WALK_SAMPLES = 101;
/** Collision layers: the deforming snow, the explorer's walk surface, and the explorer. */
export const SNOW_LAYER = 0b10;
export const WALK_LAYER = 0b100;
export const EXPLORER_LAYER = 0b1000;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Rolling ground under the snow: gentle swells in the glade, hills beyond it. */
export function terrainHeight(x: number, z: number): number {
  const radius = Math.hypot(x, z);
  const hills =
    smoothstep(14, 42, radius) * (0.8 + 0.85 * Math.sin(x * 0.085 + 1) * Math.cos(z * 0.075));
  return (
    0.2 * Math.sin(x * 0.16) * Math.cos(z * 0.12) +
    0.09 * Math.sin(x * 0.39 + z * 0.21) +
    0.07 * Math.cos(z * 0.53 - x * 0.24) +
    hills
  );
}

/** The ground plus `depth` of fresh snow at `WALK_SAMPLES`, in collider order. */
export function walkSurface(depth: number): Heightfield {
  return Heightfield.fromSampler({
    columns: WALK_SAMPLES,
    depth: FIELD_SIZE,
    origin: { x: 0, z: 0 },
    rows: WALK_SAMPLES,
    sampleHeight: (x, z) => terrainHeight(x, z) + depth,
    width: FIELD_SIZE,
  });
}

/** The canonical terrain and the deformable snow on it. Response coefficients are the study's. */
export function createSnowfield(depth: number, hardness: number): SnowField {
  const field = Heightfield.fromSampler({
    columns: FIELD_SAMPLES,
    depth: FIELD_SIZE,
    origin: { x: 0, z: 0 },
    rows: FIELD_SAMPLES,
    sampleHeight: terrainHeight,
    width: FIELD_SIZE,
  });
  return new SnowField({ depth, field, hardness });
}
