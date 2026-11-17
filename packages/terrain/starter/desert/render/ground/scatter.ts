import { createRandom } from "@threenative/core";
// The meadow past the square: the one placement rule the GAME still runs.
//
// The bake's rules moved to `@threenative/terrain` (`core/scatter-ordered.ts`, one ordered stream):
// the package places a biome's props and `scripts/bake/bake.mjs` writes them. What is left here is the
// cover a camera view plants at runtime, off the baked square, from the game's own seed.
import type { IPlacement } from "@threenative/terrain";

/** The seed the meadow's own carpet draws from, a step past the bake's ordered stream. */
const MEADOW_SEED = 466_468 + 31;

/**
 * Ground cover for a fixed view whose eye stands on the surveyed surroundings, where the bake places
 * nothing (`put` keeps to the playable square): a carpet of short grass mats, fine within 25 m and
 * thinning to `reach` (each far mat grown to keep the slope covered), taller clumps, low
 * ground-foliage mats and wildflowers near the eye, flower patches, and a few low stones. The
 * carpet is full density across the view of `look` and a quarter elsewhere; patches and stones go
 * where the view looks (within 40 degrees). Only ground past the square's edge
 * and inside `band` (the walk band whose collider grounds each placement) is planted. `y` is 0: the
 * game's ground query sets the height. UE 5.8.3 plants grass the same way, on whatever landscape lies
 * within the cull distance of a rendered view, on a jittered grid
 * (`Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:2925` and `:1482-1489`: grid on,
 * jitter 1, cull distance 100 m). Past 80 m the mats draw a thinned far level (`pack.ts`).
 */
export function meadowCover(
  eye: { readonly x: number; readonly z: number },
  look: { readonly x: number; readonly z: number },
  half: number,
  band: number,
  reach = 220,
): IPlacement[] {
  const random = createRandom(MEADOW_SEED);
  const placements: IPlacement[] = [];
  const counts: Record<string, number> = {};
  // White and violet blooms, with the odd red poppy.
  const flower = () => (random() < 0.8 ? "bloom" : "poppy");
  const put = (asset: string, x: number, z: number, scale: number) => {
    const out = Math.max(Math.abs(x), Math.abs(z));
    if (out <= half + 1 || out >= half + band) return;
    const index = counts[asset] ?? 0;
    counts[asset] = index + 1;
    placements.push({
      asset,
      id: `temperate-${asset}:meadow-${index}`,
      layer: `temperate-${asset}`,
      alignToNormal: false,
      normal: [0, 1, 0],
      position: [x, 0, z],
      rotation: random() * Math.PI * 2,
      scale,
    });
  };
  const heading = Math.atan2(look.z - eye.z, look.x - eye.x);
  for (const [from, to, step] of [
    [0, 25, 0.5],
    [25, 80, 1.2],
    [80, reach, 2.4],
  ] as const)
    for (let dz = -to; dz <= to; dz += step)
      for (let dx = -to; dx <= to; dx += step) {
        const distance = Math.hypot(dx, dz);
        if (distance < from || distance >= to) continue;
        // Full density across the frame (55 degrees either side of the look), a quarter elsewhere:
        // the meadow stays a meadow off-frame without drawing three times the grass.
        const off = Math.abs(
          ((Math.atan2(dz, dx) - heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
        );
        if (off > 0.96 && random() > 0.25) continue;
        const x = eye.x + dx + (random() - 0.5) * step;
        const z = eye.z + dz + (random() - 0.5) * step;
        // A short mat everywhere; a far one grows with distance (twice its size at 220 m) so the
        // thinner far grid still covers a slope instead of dotting it.
        put("meadow", x, z, (0.9 + random() * 0.5) * (1 + Math.max(0, distance - 80) / 140));
        if (distance >= 80) continue;
        // An unmown meadow: taller clumps than the forest's 0.8-1.45 over the mats.
        if (random() < 0.35) put("grass", x, z, 0.95 + random() * 0.6);
        if (random() < 0.08)
          put("scrub", x + random() - 0.5, z + random() - 0.5, 0.9 + random() * 0.6);
        if (random() < 0.08)
          put(flower(), x + random() - 0.5, z + random() - 0.5, 0.9 + random() * 0.5);
      }
  const ahead = (near: number, far: number): [number, number] => {
    const angle = heading + (random() - 0.5) * 1.4;
    const distance = near + Math.sqrt(random()) * (far - near);
    return [eye.x + Math.cos(angle) * distance, eye.z + Math.sin(angle) * distance];
  };
  // Flowers also grow in drifts, inside the flower draw reach.
  for (let patch = 0; patch < 60; patch++) {
    const [px, pz] = ahead(8, 60);
    const radius = 1.5 + random() * 3;
    const kind = flower();
    for (let k = 0; k < 30 + random() * 30; k++) {
      const a = random() * Math.PI * 2;
      const r = radius * Math.sqrt(random());
      put(kind, px + Math.cos(a) * r, pz + Math.sin(a) * r, 0.9 + random() * 0.5);
    }
  }
  // A few low stones lying in the turf, not boulders: a third of the bake's boulder scale.
  for (let stone = 0; stone < 12; stone++) {
    const [x, z] = ahead(10, 35);
    put("boulder", x, z, 0.2 + random() * 0.2);
  }
  return placements;
}
