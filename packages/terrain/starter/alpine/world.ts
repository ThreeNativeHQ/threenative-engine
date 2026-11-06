import type { ICtx } from "@threenative/core";
import {
  type ILoadTerrainSplatOptions,
  type IWorldPackage,
  loadTerrainSplat,
} from "@threenative/core/world";
import type { IPhysicsContext } from "@threenative/physics";
import {
  type IStarterWorld,
  type IStarterWorldSpec,
  PropColliders as StarterPropColliders,
  addStarterWorld,
} from "@threenative/terrain/starter";
import {
  EquirectangularReflectionMapping,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from "three";
import surface from "./surface.json" with { type: "json" };
/** Where the game's asset source holds the baked `world/` folder. */
export const ALPINE_URL = "terrain/alpine/world.json";

/**
 * What stops the player, per placed asset, in metres at the placement's scale 1. `null` walks
 * through. A sphere sits on the placement's origin. Change a row to change every copy.
 */
export const COLLIDERS: Readonly<Record<string, { sphere: number } | null>> = {
  boulder: { sphere: 0.9 },
};

/** How strongly the sky lights the props. The sun stays the dominant light on a boulder. */
export const PROP_SKY_LIGHT = 0.5;

/** Metres around `follow` within which props collide. Beyond that, props only draw. */
export const PROP_COLLIDER_REACH = 60;

export interface IAlpineWorld extends IStarterWorld {}
const spec: IStarterWorldSpec<{ dispose(): void }> = {
  name: "Alpine",
  url: ALPINE_URL,
  colliders: COLLIDERS,
  colliderReach: PROP_COLLIDER_REACH,
  loadSurface: (ctx, url) =>
    loadTerrainSplat({
      assets: ctx.assets,
      url,
      table: surface as unknown as ILoadTerrainSplatOptions["table"],
    }),
  lighting: { sky: "sky.hdr", lods: false, dress: dressProp },
  streaming: {
    ring: 5,
    impostors: false,
    gpuScene: false,
    shadows: { cast: true, receive: true },
    budgets: { residentCells: 64, instances: 40_000, bytes: 64_000_000 },
    terrain: { streamRadius: 6 },
  },
};
export class PropColliders extends StarterPropColliders {
  constructor(
    ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
    follow: Object3D,
    manifest: IWorldPackage,
    records: Float32Array,
  ) {
    super(ctx, follow, manifest, records, COLLIDERS, PROP_COLLIDER_REACH, "Alpine");
  }
}
export async function addAlpine(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  follow: Object3D,
  url = ALPINE_URL,
  whileCurrent: () => boolean = () => true,
): Promise<IAlpineWorld> {
  const result = await addStarterWorld(ctx, follow, spec, url, whileCurrent);
  return result;
}
/** One prop mesh: the sky as its envMap. */
function dressProp(mesh: Mesh, sky: Texture): void {
  for (const material of [mesh.material ?? []].flat() as MeshStandardMaterial[]) {
    sky.mapping = EquirectangularReflectionMapping;
    material.envMap = sky;
    material.envMapIntensity = PROP_SKY_LIGHT;
  }
}
