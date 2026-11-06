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
import { type ICoastalSea, type ICoastalSeaData, addCoastalSea } from "./sea.js";
import surface from "./surface.json" with { type: "json" };
/** Where the game's asset source holds the baked `world/` folder. */
export const COASTAL_URL = "terrain/coastal/world.json";

/**
 * What stops the player, per placed asset, in metres at the placement's scale 1. `null` walks
 * through. A sphere sits on the placement's origin. Change a row to change every copy.
 */
export const COLLIDERS: Readonly<Record<string, { sphere: number } | null>> = {
  fir: { sphere: 0.6 },
};

/** How strongly the sky lights the props. The sun stays the dominant light on a fir. */
export const PROP_SKY_LIGHT = 0.5;

/** Metres around `follow` within which props collide. Beyond that, props only draw. */
export const PROP_COLLIDER_REACH = 60;

export interface ICoastalWorld extends IStarterWorld {
  readonly seaLevel: number;
  readonly sea: ICoastalSea;
}
/** What `water.json` holds for the coastal kit: the sea, as one lake with a level. */
interface ICoastalWaterFile {
  readonly lakes: readonly {
    readonly id: string;
    readonly radius: number;
    readonly level: number;
  }[];
  readonly rivers: readonly unknown[];
}

const spec: IStarterWorldSpec<{ dispose(): void; sea: ICoastalSea; seaLevel: number }> = {
  name: "Coastal",
  url: COASTAL_URL,
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
  water: (ctx, file, _field, manifest, heightmap) => {
    const seaLevel = (file as ICoastalWaterFile).lakes[0]?.level;
    if (seaLevel === undefined) throw new Error("Coastal world: water.json names no sea level.");
    const sea = addCoastalSea(ctx, coastalSeaData(manifest, heightmap, seaLevel));
    return { seaLevel, sea, dispose: () => sea.dispose() };
  },
};
export class PropColliders extends StarterPropColliders {
  constructor(
    ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
    follow: Object3D,
    manifest: IWorldPackage,
    records: Float32Array,
  ) {
    super(ctx, follow, manifest, records, COLLIDERS, PROP_COLLIDER_REACH, "Coastal");
  }
}
export async function addCoastal(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  follow: Object3D,
  url = COASTAL_URL,
  whileCurrent: () => boolean = () => true,
): Promise<ICoastalWorld> {
  const result = await addStarterWorld(ctx, follow, spec, url, whileCurrent);
  if (!result.extra) throw new Error("Coastal world: missing sea.");
  return { ...result, ...result.extra };
}
/** One prop mesh: the sky as its envMap. */
function dressProp(mesh: Mesh, sky: Texture): void {
  for (const material of [mesh.material ?? []].flat() as MeshStandardMaterial[]) {
    sky.mapping = EquirectangularReflectionMapping;
    material.envMap = sky;
    material.envMapIntensity = PROP_SKY_LIGHT;
  }
}

function coastalSeaData(
  manifest: IWorldPackage,
  heightmap: Uint16Array,
  seaLevel: number,
): ICoastalSeaData {
  const { terrain, extent } = manifest;
  const heights = Float32Array.from(
    heightmap,
    (value) => terrain.heightMin + (value / 65535) * (terrain.heightMax - terrain.heightMin),
  );
  return { heights, resolution: terrain.columns, size: extent.sizeX, waterLevel: seaLevel };
}
