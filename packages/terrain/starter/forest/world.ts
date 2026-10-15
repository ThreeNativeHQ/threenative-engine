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
  type Box3,
  type BufferGeometry,
  Color,
  EquirectangularReflectionMapping,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
  Vector3,
} from "three";
import surface from "./surface.json" with { type: "json" };
import { type IForestWater, type IForestWaterFile, addForestWater } from "./water.js";
/** Where the game's asset source holds the baked `world/` folder. */
export const FOREST_URL = "terrain/forest/world.json";

/**
 * What stops the player, per placed asset, in metres at the placement's scale 1. `null` walks
 * through. A capsule stands on the placement's origin. Change a row to change every copy.
 */
export const COLLIDERS: Readonly<
  Record<
    string,
    { capsule: readonly [halfHeight: number, radius: number] } | { sphere: number } | null
  >
> = {
  fir: { capsule: [3, 0.35] },
  "fir-c": { capsule: [3, 0.35] },
  boulder: { sphere: 0.9 },
};

/** How strongly the sky lights the props; the sun stays the dominant light on a crown. */
export const PROP_SKY_LIGHT = 0.65;
/** Multiplies every boulder's albedo: the CC0 scan photographed pink-orange, the forest's stone is cool grey. */
export const BOULDER_TINT = new Color(0.6, 0.74, 0.86);

/** Metres around `follow` within which props collide; beyond it they only draw. */
export const PROP_COLLIDER_REACH = 60;

export interface IForestWorld extends IStarterWorld {
  readonly water: IForestWater;
}
const spec: IStarterWorldSpec<IForestWater> = {
  name: "Forest",
  url: FOREST_URL,
  colliders: COLLIDERS,
  colliderReach: PROP_COLLIDER_REACH,
  loadSurface: (ctx, url) =>
    loadTerrainSplat({
      assets: ctx.assets,
      url,
      table: surface as unknown as ILoadTerrainSplatOptions["table"],
    }),
  lighting: { sky: "sky.hdr", lods: true, dress: dressProp },
  streaming: {
    ring: 5,
    impostors: true,
    gpuScene: false,
    shadows: { cast: true, receive: true },
    budgets: { residentCells: 64, instances: 40_000, bytes: 64_000_000 },
    terrain: { streamRadius: 6 },
  },
  water: (ctx, file, field) => addForestWater(ctx, file as IForestWaterFile, field),
};
export class PropColliders extends StarterPropColliders {
  constructor(
    ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
    follow: Object3D,
    manifest: IWorldPackage,
    records: Float32Array,
  ) {
    super(ctx, follow, manifest, records, COLLIDERS, PROP_COLLIDER_REACH, "Forest");
  }
}
export async function addForest(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  follow: Object3D,
  url = FOREST_URL,
  whileCurrent: () => boolean = () => true,
): Promise<IForestWorld> {
  const result = await addStarterWorld(ctx, follow, spec, url, whileCurrent);
  if (!result.extra) throw new Error("Forest world: missing water.");
  return { ...result, water: result.extra };
}
/** One prop mesh: the sky as its envMap, and matte, crown-shaded foliage. */
function dressProp(
  mesh: Mesh,
  sky: Texture,
  id: string,
  originals: ReadonlyMap<MeshStandardMaterial, { color: Color }>,
): void {
  sky.mapping = EquirectangularReflectionMapping;
  const tint = id.startsWith("boulder") ? BOULDER_TINT : undefined;
  const surfaces = [mesh.material ?? []].flat() as MeshStandardMaterial[];
  const foliage = surfaces.some((material) => material.alphaTest > 0);
  for (const material of surfaces) {
    material.envMap = sky;
    material.envMapIntensity = foliage ? FOLIAGE_SKY_LIGHT : PROP_SKY_LIGHT;
    const original = originals.get(material);
    if (tint !== undefined && original !== undefined)
      material.color.copy(original.color).multiply(tint);
    if (material.alphaTest <= 0) continue;
    material.roughness = 0.85;
    (material as MeshStandardMaterial & { specularIntensity?: number }).specularIntensity = 0.15;
  }
  if (foliage && mesh.isMesh) bendCrownNormals(mesh.geometry, CROWN_NORMAL_BEND);
}

/** How strongly the sky lights foliage, which the sun alone leaves near-black from most sides. */
export const FOLIAGE_SKY_LIGHT = 2.2;
/** 0 keeps each card's own normal, 1 points every normal straight out from the crown's axis. */
export const CROWN_NORMAL_BEND = 0.7;

function bendCrownNormals(geometry: BufferGeometry, bend: number): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (position === undefined || normal === undefined) return;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as Box3;
  const midY = (box.min.y + box.max.y) / 2;
  const out = new Vector3();
  const own = new Vector3();
  for (let i = 0; i < position.count; i++) {
    out.set(position.getX(i), (position.getY(i) - midY) * 0.5, position.getZ(i)).normalize();
    own.fromBufferAttribute(normal, i).lerp(out, bend).normalize();
    normal.setXYZ(i, own.x, own.y, own.z);
  }
  normal.needsUpdate = true;
}
