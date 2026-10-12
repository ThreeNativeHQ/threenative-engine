// The forest's lake and river, drawn from the water the bake wrote to `world/water.json`. The lake covers
// the ground that its level floods from the lake's centre, read from the same heightfield the physics
// stands on, so the water sits where the bake floods it. WaterSurface3D mirrors the sky in the lake and
// shows the bed through it, and the water thins to nothing where the ground rises through the level: that
// is the shore. A river follows the ground, so it is a ribbon the game shades itself. Colours, depths and
// the shore are this file's to change: the kit owns its look.
import type { ICtx } from "@threenative/core";
import { WaterSurface3D } from "@threenative/core";
import type { Heightfield } from "@threenative/core/world";
import type { IPhysicsContext } from "@threenative/physics";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type Material,
  Mesh,
  MeshStandardMaterial,
} from "three";
import {
  cameraPosition,
  clamp,
  dot,
  float,
  mix,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  vec3,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";

/** The generator's own water, written beside the world by `bake.mjs`. */
export interface IForestWaterFile {
  readonly lakes: readonly ILake[];
  readonly rivers: readonly IRiver[];
}

interface ILake {
  readonly id: string;
  readonly at: readonly [number, number];
  readonly radius: number;
  readonly level: number;
}

interface IRiver {
  readonly id: string;
  readonly width: number;
  readonly points: readonly (readonly [number, number, number])[];
}

export interface IForestWater {
  readonly lakes: number;
  readonly rivers: number;
  dispose(): void;
}

/** The layer the sky sits on, so the lake's mirror can show it (see `sky.ts`). */
export const SKY_REFLECTION_LAYER = 3;
/** The ribbon sits this far above its profile, clear of the carved bed. */
const RIVER_LIFT = 0.05;
/** Metres of water over the bed at which the lake is fully opaque; thinner water fades into the shore. */
const SHORE_DEPTH = 0.3;
/**
 * The colour the mirrored sky takes at grazing angles, in linear light. The sky's horizon is near-neutral,
 * so the tint carries the lake's blue; the mirror keeps the sky's gradient.
 */
const SHEEN = new Color(0x8fa2b1);
/** Deep water's own colour; the bed shows through where the lake is shallow. */
const BODY = new Color(0x1c3d3f);
const RIVER = new Color(0x2a4b4c);
/** The pale, silty band where the water thins over the bank; it reads as a wet shore, not a cut edge. */
const SHORE = new Color(0xb8c2b2);
/** Water thinner than this many metres takes the SHORE colour, fading in as it thins. */
const SHORE_BAND = 2;

/** The heightfield's sample grid in world metres: one node per column and row, the first at (x0, z0). */
function gridOf(field: Heightfield): { stepX: number; stepZ: number; x0: number; z0: number } {
  return {
    stepX: field.width / (field.columns - 1),
    stepZ: field.depth / (field.rows - 1),
    x0: field.origin.x - field.width / 2,
    z0: field.origin.z - field.depth / 2,
  };
}

/**
 * The grid nodes the lake covers: the nodes below its level that a flood from its centre reaches inside
 * its radius. This reproduces the generator's own flood on the heightfield the physics stands on.
 */
function floodedNodes(field: Heightfield, lake: ILake): Uint8Array {
  const { columns, rows } = field;
  const { stepX, stepZ, x0, z0 } = gridOf(field);
  const [cx, cz] = lake.at;
  const worldX = (node: number): number => x0 + (node % columns) * stepX;
  const worldZ = (node: number): number => z0 + Math.floor(node / columns) * stepZ;
  const below = (node: number): boolean => field.heightAt(worldX(node), worldZ(node)) < lake.level;
  const within = (node: number): boolean =>
    Math.hypot(worldX(node) - cx, worldZ(node) - cz) <= lake.radius;
  const start = Math.round((cz - z0) / stepZ) * columns + Math.round((cx - x0) / stepX);
  const flooded = new Uint8Array(columns * rows);
  const seen = new Uint8Array(columns * rows);
  const queue: number[] = [start];
  seen[start] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    if (node === undefined || !below(node)) continue;
    flooded[node] = 1;
    const i = node % columns;
    const j = Math.floor(node / columns);
    const neighbours = [
      i > 0 ? node - 1 : -1,
      i < columns - 1 ? node + 1 : -1,
      j > 0 ? node - columns : -1,
      j < rows - 1 ? node + columns : -1,
    ];
    for (const next of neighbours) {
      if (next < 0 || seen[next] === 1 || !within(next)) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
  return flooded;
}

/**
 * The lake's surface: a level sheet over every grid cell that touches a flooded node. The sheet runs a
 * cell past the flood, so the shore is where `lakeMaterial` thins the water, not the sheet's edge.
 */
function lakeGeometry(field: Heightfield, lake: ILake, flooded: Uint8Array): BufferGeometry {
  const { columns, rows } = field;
  const { stepX, stepZ, x0, z0 } = gridOf(field);
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexOf = new Map<number, number>();
  const vertex = (node: number): number => {
    const known = vertexOf.get(node);
    if (known !== undefined) return known;
    const index = positions.length / 3;
    positions.push(
      x0 + (node % columns) * stepX,
      lake.level,
      z0 + Math.floor(node / columns) * stepZ,
    );
    vertexOf.set(node, index);
    return index;
  };
  for (let j = 0; j < rows - 1; j += 1)
    for (let i = 0; i < columns - 1; i += 1) {
      const a = j * columns + i;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      if (!(flooded[a] || flooded[b] || flooded[c] || flooded[d])) continue;
      const va = vertex(a);
      const vb = vertex(b);
      const vc = vertex(c);
      const vd = vertex(d);
      indices.push(va, vc, vb, vb, vc, vd);
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The lake's surface: the sky mirrored in it at grazing angles, the bed seen through it where it is
 * shallow, and the body's own colour where it is deep. Schlick at water's 1.333 index, so the water at
 * your feet is clear and the far bank is a mirror. Where the water is thinner than SHORE_DEPTH it fades
 * to nothing, because the ground has risen through the level there.
 */
function lakeMaterial(surface: WaterSurface3D): MeshBasicNodeMaterial {
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(dot(vec3(0, 1, 0), view), float(0), float(1));
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));
  const thickness = surface.thicknessAt();
  const body = vec3(BODY.r, BODY.g, BODY.b);
  const submerged = mix(surface.refractionAt(), body, smoothstep(float(0.4), float(3), thickness));
  const material = new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide });
  // The HDR mirror is compressed, then tinted: its horizon is neutral, the water should not be.
  const mirror = surface.reflectionAt();
  const compressed = mirror.div(mirror.add(vec3(1, 1, 1)));
  const open = mix(submerged, compressed.mul(vec3(SHEEN.r, SHEEN.g, SHEEN.b)), fresnel);
  const edge = float(1).sub(smoothstep(float(0.05), float(SHORE_BAND), thickness));
  material.colorNode = mix(open, vec3(SHORE.r, SHORE.g, SHORE.b), edge.mul(0.16));
  material.opacityNode = smoothstep(float(0), float(SHORE_DEPTH), thickness);
  return material;
}

/** A ribbon along the river's profile: each point's left and right edge across the course. */
function riverGeometry(river: IRiver): BufferGeometry {
  const half = river.width / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  river.points.forEach(([x, y, z], i) => {
    const before = river.points[Math.max(0, i - 1)] ?? [x, y, z];
    const after = river.points[Math.min(river.points.length - 1, i + 1)] ?? [x, y, z];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const length = Math.hypot(tx, tz) || 1;
    const sx = (-tz / length) * half;
    const sz = (tx / length) * half;
    positions.push(x + sx, y + RIVER_LIFT, z + sz, x - sx, y + RIVER_LIFT, z - sz);
    if (i > 0) {
      const a = 2 * (i - 1);
      const b = 2 * i;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Adds the lake and river the bake wrote. `field` is the ground the props and the colliders stand on.
 * The caller owns the returned handle: its `dispose` removes both meshes and releases each surface.
 */
export function addForestWater(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  water: IForestWaterFile,
  field: Heightfield,
): IForestWater {
  const surfaces: WaterSurface3D[] = [];
  const meshes: Mesh[] = [];
  for (const lake of water.lakes) {
    const surface = new WaterSurface3D({
      level: lake.level,
      maxThickness: 4,
      // The mirror holds only the sky, which barely changes: redrawing it every fourth frame keeps the
      // water's look and takes the second world draw off most frames (the lake's cost in the ground view).
      reflection: { resolutionScale: 0.5, layers: 1 << SKY_REFLECTION_LAYER, refreshInterval: 4 },
    });
    surfaces.push(surface);
    meshes.push(
      new Mesh(lakeGeometry(field, lake, floodedNodes(field, lake)), lakeMaterial(surface)),
    );
  }
  for (const river of water.rivers) {
    const material = new MeshStandardMaterial({
      color: RIVER,
      roughness: 0.18,
      metalness: 0,
      transparent: true,
      opacity: 0.9,
      side: DoubleSide,
    });
    meshes.push(new Mesh(riverGeometry(river), material));
  }
  for (const mesh of meshes) ctx.add(mesh);
  return {
    lakes: water.lakes.length,
    rivers: water.rivers.length,
    dispose() {
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        (mesh.material as Material).dispose();
      }
      for (const surface of surfaces) surface.dispose();
    },
  };
}
