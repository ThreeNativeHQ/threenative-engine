import { readFile, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { IBakedBiome } from "../biome/bake-biome.js";
import type { IBiomeSpec } from "../biome/biome.js";
import { round } from "../core/math.js";
import type { ITerrainState } from "../core/types.js";
import type { IFarRing, IGroundResult } from "../ground/ground.js";
import { measureGlb } from "../package/glb-stats.js";
import type { IBakedWorldPackage } from "../package/world-package.js";
import { floodedBodies } from "../water/stages.js";
import type { ICookRequest, ICooker } from "./cook.js";

/** Everything a finished cook knows once the world package is on disk, and nothing of how it got there. */
export interface IWorldReply {
  readonly request: ICookRequest;
  readonly cooked: Awaited<ReturnType<ICooker["cookTerrainWorld"]>>;
  /** The package `bakeBiome` wrote: its manifest, its splat and the bytes of each file. */
  readonly baked: IBakedWorldPackage;
  readonly bands: IBakedBiome["bands"];
  readonly state: ITerrainState;
  readonly biome: IBiomeSpec;
  readonly ground: IGroundResult;
  readonly farRing: IFarRing;
  /** The seed the world was cooked with, which the reply hands back for a reroll. */
  readonly seed: number;
  readonly arborTrees: boolean;
  readonly started: number;
}

/**
 * The tool result: what the cook wrote, measured, with the game source that loads it. Kept apart
 * from the stage order so the reply format changes without touching what a cook computes.
 */
export async function worldReply(input: IWorldReply): Promise<string> {
  const {
    request,
    cooked,
    baked,
    bands,
    state,
    biome,
    ground,
    farRing,
    seed,
    arborTrees,
    started,
  } = input;
  const { manifest, files } = baked;
  const shown = relative(await realpath(request.projectRoot), request.out)
    .split(sep)
    .join("/");
  // The same source-relative key resolves through the dev and production asset manifests.
  const url = relative(request.assetSource as string, request.out)
    .split(sep)
    .join("/");
  const worldUrl = `${url}/world.json`;
  const ring =
    Math.ceil(Math.max(manifest.extent.sizeX, manifest.extent.sizeZ) / manifest.cellSize / 2) + 1;
  const instances = manifest.cells.reduce(
    (count, cell) => count + cell.runs.reduce((sum, run) => sum + run.count, 0),
    0,
  );
  const placementBytes = files[manifest.placements];
  if (placementBytes === undefined)
    throw new Error("cook: world package has no placement records.");
  const budgets = {
    residentCells: Math.max(1, manifest.cells.length),
    instances: Math.max(1, instances),
    bytes: Math.max(1, placementBytes.byteLength),
  };
  const heightmapUrl = `${url}/${cooked.manifest.terrain.heightmap}`;
  // The GLB carries no collider, so the snippet also builds the ground; aliases dodge stock names.
  const physical = JSON.stringify({
    extent: cooked.manifest.extent,
    terrain: cooked.manifest.terrain,
  });
  return JSON.stringify({
    recipe: request.kit,
    out: shown,
    worldGlb: `${shown}/world.glb`,
    recipeJson: `${shown}/recipe.json`,
    worldPackage: `${shown}/world.json`,
    ...measureGlb(cooked.worldGlb),
    placementCounts: cooked.placementCounts,
    biome: biome.look,
    ground: ground.ground,
    // The seed this world was cooked with: pass another as `seed` to reroll it.
    seed,
    backdrop: farRing.decision,
    water: floodedBodies(state),
    bands,
    worldGlbBytes: cooked.worldGlb.length,
    ms: Math.round(performance.now() - started),
    load: [
      'import { WorldCells as TerrainWorldCells, Heightfield as TerrainHeightfield, heightSamplerFromHeightmap as sampleTerrainHeight, loadWorldHeightmap as loadTerrainHeightmap, loadTerrainSplat, type IWorldCellsLoadOptions as TerrainWorldOptions } from "@threenative/core/world";',
      'import { CollisionShape3D as TerrainCollisionShape, RigidBody3D as TerrainRigidBody } from "@threenative/physics";',
      'import { Object3D as TerrainAnchor } from "three";',
      ...(arborTrees ? ['import { arborWind } from "./render/arborWind.js";'] : []),
      "// This world is the level: delete the template's prototype arena (its grid ground, walls and ramp)",
      "// and keep only the player, spawned at the centre on terrainField.heightAt(0, 0) + terrainSeat.",
      `const terrainWorld = ${physical};`,
      `const [terrainHeightmapUrl] = await ctx.assets.resolve(${JSON.stringify(heightmapUrl)});`,
      'if (terrainHeightmapUrl === undefined) throw new Error("terrain: the world heightmap is not served.");',
      "const terrainHeights = await loadTerrainHeightmap(terrainHeightmapUrl);",
      "const terrainField = TerrainHeightfield.fromSampler({",
      "  columns: terrainWorld.terrain.columns,",
      "  depth: terrainWorld.extent.sizeZ,",
      "  origin: { x: terrainWorld.extent.minX + terrainWorld.extent.sizeX / 2, z: terrainWorld.extent.minZ + terrainWorld.extent.sizeZ / 2 },",
      "  rows: terrainWorld.terrain.rows,",
      "  sampleHeight: sampleTerrainHeight(terrainWorld.terrain, terrainWorld.extent, terrainHeights),",
      "  width: terrainWorld.extent.sizeX,",
      "});",
      "const terrainCentre = { x: terrainWorld.extent.minX + terrainWorld.extent.sizeX / 2, z: terrainWorld.extent.minZ + terrainWorld.extent.sizeZ / 2 };",
      "// Seats the cooked centre pad 5 cm under the game's floor (y = 0), so the floor draws over it. Add",
      "// terrainSeat to a terrainField.heightAt read. Named override: terrainSeat = 0 keeps the cooked heights.",
      "const terrainSeat = -terrainField.heightAt(terrainCentre.x, terrainCentre.z) - 0.05;",
      "const terrainAnchor = new TerrainAnchor();",
      "terrainAnchor.position.set(terrainCentre.x, terrainSeat, terrainCentre.z);",
      "const terrainBody = new TerrainRigidBody({",
      '  entity: "terrain",',
      "  object: terrainAnchor,",
      "  physics: ctx.physics,",
      "  shape: TerrainCollisionShape.heightfield(terrainField.rows, terrainField.columns, terrainField.toColliderHeights(), { x: terrainWorld.extent.sizeX, y: 1, z: terrainWorld.extent.sizeZ }),",
      '  type: "fixed",',
      "});",
      "let world: TerrainWorldCells | undefined;",
      "let terrainSurface: Awaited<ReturnType<typeof loadTerrainSplat>> | undefined;",
      "// The anchor owns the streamed world, caller-supplied surface and full-world collider.",
      'terrainAnchor.addEventListener("removed", () => { world?.dispose(); terrainSurface?.dispose(); terrainBody.dispose(); });',
      "ctx.add(terrainAnchor);",
      "let terrainFollow = terrainAnchor;",
      'let terrainInvalidate: NonNullable<TerrainWorldOptions["shadows"]>["invalidate"];',
      "try {",
      `  terrainSurface = await loadTerrainSplat({ assets: ctx.assets, renderer: ctx.renderer, url: ${JSON.stringify(worldUrl)} });`,
      "  world = await TerrainWorldCells.load({",
      `  assets: ctx.assets, url: ${JSON.stringify(worldUrl)}, surface: terrainSurface,`,
      "  follow: { get position() { return terrainFollow.position; } },",
      `  ring: ${ring}, budgets: ${JSON.stringify(budgets)}, terrain: { streamRadius: ${ring + 1} },`,
      "  shadows: { cast: true, receive: true, invalidate: (region) => terrainInvalidate?.(region) },",
      ...(arborTrees ? ["  partMaterial: arborWind,"] : []),
      "});",
      "  world.position.y = terrainSeat;",
      "  ctx.add(world);",
      "  // The curtain stays up until the ground the camera sees has streamed, so no tree stands over a hole.",
      "  const terrainStreamed = world;",
      '  if (!ctx.startup.ready) ctx.startup.hold("terrain", () => { const ground = terrainStreamed.terrainReadinessInView(ctx.camera); return ground.loaded >= ground.required; });',
      "} catch (error) { terrainAnchor.removeFromParent(); throw error; }",
      'const loadCells = (follow: TerrainAnchor, invalidate?: NonNullable<TerrainWorldOptions["shadows"]>["invalidate"]) => { terrainFollow = follow; terrainInvalidate = invalidate; };',
      "// Call loadCells(player.mesh) after creating the player; optionally forward streamed shadow invalidation.",
    ].join("\n"),
    grass: grassSnippet(biome, state, cooked.manifest.extent),
    // The sway the load's `partMaterial: arborWind` names: write it to `trees.file` before the load runs.
    trees: arborTrees
      ? {
          file: "src/render/arborWind.ts",
          source: await readFile(new URL("../../starter/arbor/wind.ts", import.meta.url), "utf8"),
        }
      : null,
  });
}

/**
 * The lines that grow the biome's grass rows as a streamed `GrassField3D` on the cooked ground, run
 * after `load`; null when the biome has no grass row. The blade and material are the game's look.
 */
function grassSnippet(
  biome: Pick<IBiomeSpec, "grass" | "seed">,
  state: ITerrainState,
  extent: { minX: number; minZ: number; sizeX: number; sizeZ: number },
): string | null {
  if (biome.grass.length === 0) return null;
  const ocean = state.waters.find((water) => water.kind === "ocean");
  return [
    'import { GrassField3D } from "@threenative/core";',
    'import { grassFieldFromBiome } from "@threenative/terrain";',
    "// The look: copy src/render/grass.ts from the adventure kit (npm create threenative -- --template adventure).",
    'import { grassBlade, grassMaterial } from "./render/grass.js";',
    // `as const` keeps the rows' [min, max] pairs as the tuples grassFieldFromBiome reads.
    `const grassBiome = ${JSON.stringify({ grass: biome.grass, seed: biome.seed })} as const;`,
    `const grassPlacement = grassFieldFromBiome(grassBiome, { heightAt: (x, z) => terrainField.heightAt(x, z) + terrainSeat, floor: terrainSeat, waterLevel: ${ocean === undefined ? "null" : `${ocean.level} + terrainSeat`} });`,
    'if (grassPlacement === null) throw new Error("terrain: the biome has no grass row.");',
    "// Named override: set grassKeepOut to a floor's half-size to keep blades from growing through it.",
    "const grassKeepOut: { x: number; z: number } | null = null;",
    "const grassCover = grassPlacement.getDensity;",
    `const grass = new GrassField3D({ ...grassPlacement, getDensity: (x, z, y, normalY) => (grassKeepOut !== null && Math.abs(x) < grassKeepOut.x && Math.abs(z) < grassKeepOut.z ? 0 : grassCover(x, z, y, normalY)), blade: grassBlade(), material: grassMaterial, bounds: { minX: ${extent.minX}, minZ: ${extent.minZ}, maxX: ${extent.minX + extent.sizeX}, maxZ: ${extent.minZ + extent.sizeZ} } });`,
    "ctx.add(grass);",
    "grass.prewarm();",
    "// In enter(), after creating the player: once per drawn frame the player parts the grass and the camera streams the chunks.",
    "ctx.beforeRender(() => { grass.pushers[0]?.set(player.position.x, player.position.y, player.position.z, 1.2); grass.update(ctx.camera); });",
  ].join("\n");
}
