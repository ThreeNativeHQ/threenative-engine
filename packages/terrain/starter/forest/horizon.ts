// The forest past its 512 m square: the engine's far collar (`HeightfieldCollar`) grows rings out from
// the square's own edge heights, settles into low rolling hills and rises to a far ridge, so an
// elevated view sees forested country fading into the haze instead of a tile floating in a void.
// Every height and colour here is this kit's look; change them freely.
import type { ICtx } from "@threenative/core";
import { type Heightfield, HeightfieldCollar, type IWorldPackage } from "@threenative/core/world";
import { MathUtils, Mesh } from "three";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { color, mix, mx_noise_float, positionWorld, smoothstep } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** How far the collar reaches past the square's edge, metres; inside the kit camera's 5 km far plane. */
export const HORIZON_REACH = 3000;
/** Rings from the edge out; spaced on a square curve, so the near rings are dense. */
export const HORIZON_RINGS = 48;
/** Metres over which the square's own edge relief settles into the rolling hills. */
export const HORIZON_SETTLE = 500;
/** The rolling hills' height and size, metres. */
export const HORIZON_HILLS = { height: 90, size: 420 } as const;
/** The far ridge that frames the horizon: how high it rises over the hills and where it starts. */
export const HORIZON_RIDGE = { height: 220, from: 700 } as const;
/** Conifer canopy seen from far away, linear albedo: dark needle mass and its sunlit olive crowns. */
export const HORIZON_CANOPY = { shade: [0.03, 0.05, 0.028], lit: [0.06, 0.085, 0.04] } as const;

export interface IForestHorizon {
  readonly mesh: Mesh;
  dispose(): void;
}

/** Adds the far collar around the world square. The caller owns the handle and disposes it. */
export function addForestHorizon(
  ctx: Pick<ICtx, "add">,
  field: Heightfield,
  extent: IWorldPackage["extent"],
): IForestHorizon {
  const half = extent.sizeX / 2;
  const centreX = extent.minX + half;
  const centreZ = extent.minZ + extent.sizeZ / 2;
  const edge = (x: number, z: number): number =>
    field.heightAt(
      centreX + Math.min(half - 0.01, Math.max(-half + 0.01, x)),
      centreZ + Math.min(half - 0.01, Math.max(-half + 0.01, z)),
    );
  let base = 0;
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * 2 - 1;
    base +=
      edge(t * half, -half) + edge(t * half, half) + edge(-half, t * half) + edge(half, t * half);
  }
  base /= 256;
  const noise = new ImprovedNoise();
  const collar = new HeightfieldCollar({
    resolution: 65,
    rings: HORIZON_RINGS,
    ringDistance: (ring) => (ring / HORIZON_RINGS) ** 2 * HORIZON_REACH,
    size: extent.sizeX,
    walkBand: 0,
    height: ({ distance, x, z }) => {
      const scale = 1 + distance / half;
      const own = edge(x / scale, z / scale);
      const hills =
        base +
        HORIZON_HILLS.height * noise.noise(x / HORIZON_HILLS.size, 0.5, z / HORIZON_HILLS.size) +
        HORIZON_HILLS.height * 0.3 * noise.noise(x / 140, 1.5, z / 140) +
        HORIZON_RIDGE.height *
          MathUtils.smoothstep(distance, HORIZON_RIDGE.from, HORIZON_REACH) *
          (0.6 + 0.4 * noise.noise(x / 900, 2.5, z / 900));
      return own + (hills - own) * MathUtils.smoothstep(distance, 0, HORIZON_SETTLE);
    },
  });
  collar.geometry.computeVertexNormals();
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  // Stands and gaps a few hundred metres across, and groves inside them: no feature under about
  // 30 m, because from the overview a finer pattern reads as ripples on water, not as canopy.
  const clumps = mx_noise_float(positionWorld.xz.mul(0.004))
    .mul(0.6)
    .add(mx_noise_float(positionWorld.xz.mul(0.016)).mul(0.4));
  material.colorNode = mix(
    color(...HORIZON_CANOPY.shade),
    color(...HORIZON_CANOPY.lit),
    smoothstep(-0.4, 0.5, clumps),
  );
  const mesh = new Mesh(collar.geometry, material);
  mesh.name = "forest-horizon";
  mesh.position.set(centreX, 0, centreZ);
  ctx.add(mesh);
  return {
    mesh,
    dispose() {
      mesh.removeFromParent();
      collar.geometry.dispose();
      material.dispose();
    },
  };
}
