// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The battlefield: a plane displaced by the simulation's own `terrainHeight`, so the art, the
// navigation grid and every click agree about where the ground is by construction. What the ground
// *looks* like is `materials.ts`; this file is the ground itself, its water, and the one texture
// the fog of war lives in.
import {
  Color,
  DataTexture,
  InstancedMesh,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from "three";
import type { Game } from "../sim/game.js";
import { MAP_CELL, POOLS, WORLD, terrainHeight } from "../sim/terrain.js";
import { createTerrainMaterial, createWaterMaterial, waterDisc } from "./materials.js";
import { palette } from "./palette.js";

/**
 * Quads across the map: one every 2 m, which is exactly the simulation's navigation cell, so the
 * drawn surface and the walkable surface are the same resolution. Measured, not guessed: at 176
 * segments this plane was 31 000 triangles and cost 5.3 s of boot compile here, against 12 600 and
 * 2.8 s at 112 — and the heightfield is two octaves of smooth noise, so there is nothing between
 * the vertices for the extra rings to find.
 */
const SEGMENTS = 112;

/**
 * The plain the battlefield stands on, in metres across and in metres below the map.
 *
 * Wide enough that the widest zoom cannot reach its edge: the rig's ground parallelogram reaches
 * about 195 m from the origin at most, so 800 is four times the reach. Low enough to sit under
 * every hollow the simulation digs — the deepest pool bed is 1.45 m up, the water 0.18 m up — and
 * high enough that the terrain's own lowest ground, 0.15 m, never sinks into it.
 */
const APRON = 800;
const APRON_Y = -1.75;

/**
 * AstraCraft blurs its fog sheet by 5 px at 4 px a cell, a Gaussian of 1.25 cells: the sheet reaches
 * into the edge of what a unit sees and the lit ground fades out over about 5 m. Unblurred, the lit
 * sand ran full-bright up to the fog's edge, and the frame read as a ring of yellow (owner,
 * 2026-10-28). Weights for distances 0..3 cells, summing to one over -3..3.
 */
const FOG_BLUR = [0, 1, 2, 3].map((d) => Math.exp(-(d * d) / (2 * 1.25 * 1.25)));
const FOG_BLUR_SUM = FOG_BLUR.reduce((sum, w, d) => sum + (d === 0 ? w : 2 * w), 0);

export interface ITerrain {
  /** Rewrite the fog texture from the simulation's vision arrays. Cheap; not every frame. */
  readonly updateFog: (game: Game) => void;
  readonly root: Object3D;
}

export function createTerrain(): ITerrain {
  const root = new Object3D();

  const geometry = new PlaneGeometry(WORLD, WORLD, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index += 1)
    position.setY(index, terrainHeight(position.getX(index), position.getZ(index), false));
  geometry.computeVertexNormals();

  // How much ground shows through: 105 = never seen, 194 = remembered, 255 = in sight right now.
  const cells = WORLD / MAP_CELL;
  const fogBytes = new Uint8Array(cells * cells * 4);
  const fog = new DataTexture(fogBytes, cells, cells);
  const sheet = new Float32Array(cells * cells);
  const pass = new Float32Array(cells * cells);
  fog.minFilter = LinearFilter;
  fog.magFilter = LinearFilter;
  fog.needsUpdate = true;

  const ground = new Mesh(geometry, createTerrainMaterial(fog));
  ground.receiveShadow = true;
  root.add(ground);

  // The plain the battlefield stands on, so no camera angle looks off the map into a void.
  //
  // The orthographic rig covers a 228 m x 128 m parallelogram of ground at its widest zoom —
  // wider than the 224 m map — and an orthographic camera's rays are parallel, so every one of
  // them meets the ground at the same depth: past the map's rim there is nothing left to hit, and
  // the background, sampled at the one direction every ray shares, filled the corner of the frame
  // with a flat grey wedge. One plane, two triangles, below the deepest pool bed so no water is
  // covered, and the battlefield reads as a plateau over a plain instead of a floating sheet.
  const plain = new Mesh(
    new PlaneGeometry(APRON, APRON).rotateX(-Math.PI / 2),
    // AstraCraft's underlay is an `envStandard`, which decodes its hex from sRGB.
    new MeshStandardMaterial({ color: new Color(palette.cliff), roughness: 1 }),
  );
  plain.position.y = APRON_Y;
  root.add(plain);

  // The pools the simulation refuses to path across: one instanced disc, so four lakes cost one
  // draw. The matrices never move, so the pool is sized for the world's sites rather than grown.
  const water = new InstancedMesh(waterDisc(), createWaterMaterial(), POOLS.length);
  const dummy = new Object3D();
  POOLS.forEach((pool, index) => {
    dummy.position.set(pool.x, -0.18, pool.z);
    dummy.scale.set(pool.rx * 1.04, 1, pool.rz * 1.04);
    dummy.updateMatrix();
    water.setMatrixAt(index, dummy.matrix);
  });
  water.renderOrder = 1;
  root.add(water);

  return {
    root,
    updateFog: (game) => {
      const size = game.gridSize;
      for (let cell = 0; cell < size * size; cell += 1)
        sheet[cell] = game.visible[cell] === 1 ? 255 : game.explored[cell] === 1 ? 194 : 105;
      // Separable: along x into `pass`, then along z back into `sheet`, clamped at the map's rim.
      blur(sheet, pass, size, 1);
      blur(pass, sheet, size, size);
      for (let cell = 0; cell < size * size; cell += 1) {
        const value = Math.round(sheet[cell] as number);
        fogBytes[cell * 4] = value;
        fogBytes[cell * 4 + 1] = value;
        fogBytes[cell * 4 + 2] = value;
        fogBytes[cell * 4 + 3] = 255;
      }
      fog.needsUpdate = true;
    },
  };
}

/** One pass of the fog blur along a row (`stride` 1) or a column (`stride` = `size`). */
function blur(from: Float32Array, to: Float32Array, size: number, stride: number): void {
  for (let cell = 0; cell < size * size; cell += 1) {
    const at = stride === 1 ? cell % size : Math.floor(cell / size);
    let sum = 0;
    for (let d = -3; d <= 3; d += 1) {
      const step = Math.max(-at, Math.min(size - 1 - at, d));
      sum += (from[cell + step * stride] as number) * (FOG_BLUR[Math.abs(d)] as number);
    }
    to[cell] = sum / FOG_BLUR_SUM;
  }
}
