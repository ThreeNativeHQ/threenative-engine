import { type IAssetLoader, createRandom } from "@threenative/core";
import { buildStaticColliders } from "@threenative/physics";
import {
  type BufferGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  type Mesh,
  type Object3D,
  Quaternion,
  RepeatWrapping,
  type Texture,
  Vector3,
} from "three";
import {
  abs,
  dot,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  texture,
  transformNormalToView,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import type { TerrainCtx } from "../../sceneState.js";
import { BIOMES, measureBiome } from "../biomes.js";
import { loadSkyLight, skyIrradiance } from "./pack.js";
import { type IPropGround, createRockGround } from "./propMaterials.js";

/**
 * The desert's rock: Outcrop sandstone (`bake-rocks.mjs`, `desert_rocks/`), every form of it.
 * Cliff walls run along the contours of the steep slopes, their backs and ends in the hill;
 * fractured outcrops stand on the gentler ones with their talus below; fins and hoodoos stand in
 * gardens away from the spawn, with one arch; boulders, slabs, cobbles and pebbles lie on the dunes.
 * Placement is the game's: change a row to change what stands where.
 */

/** [file, x, z, height in metres, yaw in degrees]: a landmark, its base sunk into the sand. */
const LANDMARKS: readonly (readonly [string, number, number, number, number])[] = [
  // One distant accent: the surveyed horizon holds the real mesas, and a 30 m butte baked whole
  // drew a smooth slab in the walker's path.
  ["spire", 40, -170, 20, 30],
];
/** A rock row: GLB, and the range of its longest side in metres. */
type Row = readonly [string, number, number];
/** Fallen blocks: under a landmark, round an outcrop and at the foot of a wall. */
const BLOCKS: readonly Row[] = [
  ["boulder-a", 0.8, 3],
  ["boulder-b", 0.7, 2.4],
  ["boulder-c", 0.8, 3],
  ["boulder-d", 1, 3.4],
  ["block-a", 1, 3.4],
  ["slab-b", 1.2, 4],
  ["slab-c", 1, 3],
];
/** Talus and the loose stone on the dunes; the cobbles repeat so most stones are small. */
const LOOSE: readonly Row[] = [
  ["boulder-a", 0.4, 1.5],
  ["boulder-b", 0.4, 1.3],
  ["boulder-c", 0.4, 1.6],
  ["boulder-d", 0.5, 1.8],
  ["block-a", 0.5, 1.8],
  ["slab-b", 0.6, 2.2],
  ["slab-c", 0.5, 1.7],
  ["cobble", 0.18, 0.5],
  ["cobble", 0.18, 0.5],
  ["cobble", 0.2, 0.6],
  ["cobble", 0.25, 0.7],
];
const COBBLE: Row = ["cobble", 0.18, 0.6];
const PEBBLES: readonly Row[] = [
  ["pebble", 0.05, 0.2],
  ["pebble-b", 0.06, 0.24],
];
/** The flagstones a wall's cap bed breaks into; they lie on its rim. */
const CAPS: readonly Row[] = [
  ["slab-b", 1.4, 3.6],
  ["slab-c", 1.2, 2.8],
  ["block-a", 1.2, 3],
];
/** The jointed core of an outcrop. */
const CORES: readonly Row[] = [
  ["crag-a", 2.6, 5.5],
  ["crag-b", 3, 6.5],
];
/** What a wall leaves standing: fins and hoodoos, by their height. */
const STANDING: readonly Row[] = [
  ["fin-a", 4, 9],
  ["fin-b", 3, 6.5],
  ["hoodoo-a", 3.5, 8],
  ["hoodoo-b", 2.5, 5.5],
];
/**
 * A cliff wall: the modules of one Outcrop run (`<file>-<n>`), which join only in this order, and
 * the range of its scale. Each module is `bake-rocks.mjs`'s size times the scale.
 */
const WALLS: readonly (readonly [string, number, number, number])[] = [
  ["wall-a", 4, 0.8, 1.2],
  ["wall-b", 3, 0.85, 1.35],
];
/**
 * Where walls stand: the slope band in degrees, the grid step in metres, the share of sites kept,
 * and how near two walls at one height may stand. The ends of a wall turn `turn` radians into the
 * hill so the cut face of its last module is under the sand.
 */
const WALL = {
  slope: [15, 52],
  step: 16,
  share: 0.8,
  half: 250,
  apart: 26,
  turn: 0.5,
  face: 0.9,
} as const;
/** Outcrops: the same for the gentler slopes. */
const OUTCROP = { slope: [5, 38], step: 27, share: 0.4, half: 250 } as const;
const SPAWN: readonly [number, number] = [180, 65];
/** Gardens of fins and hoodoos: how many, the ring round the spawn, and the steepest ground. */
const GARDENS = { count: 8, ring: [105, 240], slope: 13, radius: 9 } as const;
/** The arch: its width in metres and the ring round the spawn it stands in. */
const ARCH = { width: 19, ring: [95, 150], slope: 7 } as const;
/** Stone clusters on the dunes: how many, how far from the spawn, and the steepest ground kept. */
const CLUSTERS = { count: 90, reach: 170, slope: 14 } as const;
/** Single pebbles strewn near the spawn, thinning outward. */
const STREWN = { count: 2600, reach: 85 } as const;
/** A rock this near the spawn draws its full level, a farther one its `-far` level. */
const NEAR = 190;
/** Rocks draw in square cells this wide, so the ones behind the camera are culled as a group. */
const CELL = 128;
/** World height under which a rock can be walked into: above the highest ground of the square. */
const CEILING = 2000;
/** Stones under this longest side get no collider: the capsule steps over them. */
const SOLID_FROM = 0.6;
/** The ground's own sky-light weight (`render/ground/terrain.ts` GROUND_SKY_LIGHT). */
const SKY_LIGHT = 0.6;
/** The bakes are lighter than the sand they stand on; this takes them under it. */
const ROCK_TINT: readonly [number, number, number] = [0.62, 0.62, 0.7];
/** The mean linear vertex colour of the bakes, for the sky term (the engine has no colour node). */
const ROCK_MEAN: readonly [number, number, number] = [0.22, 0.085, 0.05];
/**
 * The surface a bake's vertices cannot hold: Poly Haven's bedded cliff (CC0), its colour as grain
 * and its normal map as relief, projected on the three world axes so the beds lie level on every
 * face. Metres per tile, the scan's mean luminance, and how much of each the rock takes.
 */
const DETAIL = {
  map: "cliff_side/cliff_side_diff_1k.jpg",
  normal: "cliff_side/cliff_side_nor_gl_1k.jpg",
  tile: 3.2,
  mean: 0.15,
  share: 0.75,
  relief: 1.1,
} as const;
/** Each rock mesh is named this plus its GLB, so the collider filter reads the GLB back. */
const ROCK_NAME = "desert-rock:";
/** The bakes with no `-far` level: the landmarks, and the stones too small to need one. */
const ONE_LEVEL = new Set(["butte", "mesa", "spire", "cobble", "pebble", "pebble-b"]);

interface IRock {
  readonly geometry: BufferGeometry;
  /** Metres along x (a wall module's width), y and z (its depth, face to +z). */
  readonly size: Vector3;
  readonly longest: number;
  /** Metres from the origin to the highest point: a wall module's rim. */
  readonly top: number;
}
const REACH = 3;
type Ground = (x: number, z: number) => number;
type Point = readonly [number, number];

async function loadRock(assets: IAssetLoader, file: string): Promise<IRock> {
  const gltf = await assets.model<{ scene: Object3D }>(`desert_rocks/${file}.glb`);
  let geometry: BufferGeometry | undefined;
  gltf.scene.traverse((object) => {
    if ((object as Mesh).isMesh) geometry ??= (object as Mesh).geometry;
  });
  if (!geometry) throw new Error(`TN_DESERT_ROCK: desert_rocks/${file}.glb holds no mesh`);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) throw new Error(`TN_DESERT_ROCK: desert_rocks/${file}.glb has no bounds`);
  const size = box.getSize(new Vector3());
  return { geometry, size, longest: Math.max(size.x, size.y, size.z), top: box.max.y };
}

/** Outcrop's beds, cracks and drifted sand are vertex colours; this adds the scanned surface. */
function rockMaterial(
  grain: Texture | undefined,
  relief: Texture | undefined,
  sky: Awaited<ReturnType<typeof loadSkyLight>>,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.94 });
  const axis = abs(normalWorld).pow(4);
  const share = axis.div(axis.x.add(axis.y).add(axis.z));
  const planes = [positionWorld.zy, positionWorld.xz, positionWorld.xy].map((plane) =>
    plane.div(DETAIL.tile),
  ) as [Node<"vec2">, Node<"vec2">, Node<"vec2">];
  let tint: Node<"vec3"> = vec3(...ROCK_TINT);
  if (grain) {
    const tap = (plane: Node<"vec2">) =>
      dot(texture(grain, plane).rgb, vec3(0.2126, 0.7152, 0.0722));
    const light = share.x
      .mul(tap(planes[0]))
      .add(share.y.mul(tap(planes[1])))
      .add(share.z.mul(tap(planes[2])));
    tint = tint.mul(mix(1, light.div(DETAIL.mean).clamp(0.35, 1.9), DETAIL.share));
  }
  material.colorNode = tint;
  if (relief) {
    // Each plane's tangent normal leans the surface normal along that plane's two axes.
    const lean = (plane: Node<"vec2">) =>
      texture(relief, plane).xy.mul(2).sub(1).mul(DETAIL.relief);
    const [x, y, z] = planes.map(lean) as [Node<"vec2">, Node<"vec2">, Node<"vec2">];
    material.normalNode = transformNormalToView(
      normalize(
        normalWorld
          .add(vec3(0, x.y, x.x).mul(share.x))
          .add(vec3(y.x, 0, y.y).mul(share.y))
          .add(vec3(z.x, z.y, 0).mul(share.z)),
      ),
    );
  }
  if (sky) {
    // Shaded sandstone reads the sky and the sand's bounce, as the ground does, not black. The
    // owned engine has no vertex-colour node, so the term takes the bakes' mean rock colour.
    const { up, down } = skyIrradiance(sky);
    material.emissiveNode = mix(vec3(...down), vec3(...up), normalWorld.y.mul(0.5).add(0.5))
      .mul(vec3(...ROCK_MEAN))
      .mul(tint)
      .mul(SKY_LIGHT);
  }
  return material;
}

/**
 * Metres of rise per metre along x and z, and the slope in degrees, over `REACH` metres each way:
 * the dunes carry ripples a metre or two long, and a slope read across one of them is not the
 * slope a wall five metres deep stands in.
 */
function gradientOf(heightAt: Ground, x: number, z: number) {
  const dx = (heightAt(x + REACH, z) - heightAt(x - REACH, z)) / (2 * REACH);
  const dz = (heightAt(x, z + REACH) - heightAt(x, z - REACH)) / (2 * REACH);
  return { dx, dz, degrees: (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI };
}

/**
 * The joints of a wall of `count` modules, each `width` metres, along the contour through
 * (`x`, `z`): `count + 1` points, module n between point n and point n + 1 with its face downhill.
 * Undefined where the ground leaves the slope band, which a wall cannot stand in.
 */
function traceWall(
  heightAt: Ground,
  x: number,
  z: number,
  width: number,
  count: number,
): Point[] | undefined {
  const level = heightAt(x, z);
  const joints: Point[] = [[x, z]];
  let [cx, cz] = [x, z];
  for (let n = 0; n < count; n++) {
    const here = gradientOf(heightAt, cx, cz);
    if (here.degrees < WALL.slope[0] * 0.7 || here.degrees > WALL.slope[1]) return undefined;
    const steep = Math.hypot(here.dx, here.dz);
    // A module's +x with its face (+z) down the slope.
    let nx = cx + (-here.dz / steep) * width;
    let nz = cz + (here.dx / steep) * width;
    // Back onto the contour, then exactly one width from the last joint so the modules meet.
    for (let pass = 0; pass < 2; pass++) {
      const there = gradientOf(heightAt, nx, nz);
      const square = there.dx ** 2 + there.dz ** 2;
      if (square < 1e-4) return undefined;
      const lift = Math.max(-width / 2, Math.min(width / 2, level - heightAt(nx, nz)));
      nx += (lift * there.dx) / square;
      nz += (lift * there.dz) / square;
    }
    const span = Math.hypot(nx - cx, nz - cz);
    if (span < width * 0.4) return undefined;
    cx += ((nx - cx) / span) * width;
    cz += ((nz - cz) / span) * width;
    joints.push([cx, cz]);
  }
  return joints;
}

/** Turns the wall's end joint about its neighbour, `WALL.turn` radians up the slope. */
function turnIn(heightAt: Ground, end: Point, pivot: Point): Point {
  const { dx, dz } = gradientOf(heightAt, end[0], end[1]);
  const steep = Math.hypot(dx, dz) || 1;
  const span = Math.hypot(end[0] - pivot[0], end[1] - pivot[1]);
  const along = [(end[0] - pivot[0]) / span, (end[1] - pivot[1]) / span] as const;
  const x = along[0] * Math.cos(WALL.turn) + (dx / steep) * Math.sin(WALL.turn);
  const z = along[1] * Math.cos(WALL.turn) + (dz / steep) * Math.sin(WALL.turn);
  const length = Math.hypot(x, z);
  return [pivot[0] + (x / length) * span, pivot[1] + (z / length) * span];
}

/**
 * Stands the rock on the ground `heightAt` describes, makes the large stones solid on the player's
 * collision layer, and returns their disposal.
 */
export async function addFormations(
  ctx: TerrainCtx,
  assets: IAssetLoader,
  heightAt: Ground,
  /** The baked heights the ground is drawn from: the rock's foot blends into the sand over them. */
  ground: IPropGround,
): Promise<() => void> {
  const names = new Set([
    ...[...LANDMARKS, ...BLOCKS, ...LOOSE, ...PEBBLES, ...CAPS, ...CORES, ...STANDING].map(
      ([file]) => file,
    ),
    ...WALLS.flatMap(([file, count]) => Array.from({ length: count }, (_, n) => `${file}-${n}`)),
    "arch",
  ]);
  const files = [...names].flatMap((file) =>
    ONE_LEVEL.has(file) ? [file] : [file, `${file}-far`],
  );
  const map = (path: string, data: boolean) =>
    // No scan is not fatal: the rock keeps its vertex colours.
    assets
      .texture(path, { anisotropy: 8, data, wrap: RepeatWrapping })
      .catch(() => undefined);
  const [rocks, sky, grain, relief, blend] = await Promise.all([
    Promise.all(files.map(async (file) => [file, await loadRock(assets, file)] as const)),
    loadSkyLight(assets),
    map(DETAIL.map, false),
    map(DETAIL.normal, true),
    createRockGround(assets, ground, measureBiome(BIOMES.desert, ground.heights)),
  ]);
  const rock = new Map(rocks);
  const material = rockMaterial(grain, relief, sky);
  // Sand banks against the rock's foot and dusts its lowest half metre, as the pack's stones do.
  blend?.apply(material, ROCK_MEAN);

  const next = createRandom(0x0de5e47);
  const pick = <T>(rows: readonly T[]): T => rows[Math.floor(next() * rows.length)] as T;
  const between = (low: number, high: number, power = 1) => low + (high - low) * next() ** power;
  const slopeAt = (x: number, z: number) => gradientOf(heightAt, x, z).degrees;
  const matrices = new Map<string, Matrix4[]>();
  const solid = new Set<string>();
  /** Puts one rock at `y`, `scale` times its baked size, at its full or far level by distance. */
  const place = (name: string, x: number, y: number, z: number, scale: number, turn: Euler) => {
    const far = !ONE_LEVEL.has(name) && Math.hypot(x - SPAWN[0], z - SPAWN[1]) > NEAR;
    const key = `${far ? `${name}-far` : name}@${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    const list = matrices.get(key) ?? [];
    list.push(
      new Matrix4().compose(
        new Vector3(x, y, z),
        new Quaternion().setFromEuler(turn),
        new Vector3(scale, scale, scale),
      ),
    );
    matrices.set(key, list);
    if (scale * (rock.get(name) as IRock).longest >= SOLID_FROM) solid.add(key);
  };
  /** The lowest ground under a stone `reach` metres across. */
  const floorAt = (x: number, z: number, reach: number) =>
    Math.min(
      heightAt(x, z),
      heightAt(x + reach, z),
      heightAt(x - reach, z),
      heightAt(x, z + reach),
      heightAt(x, z - reach),
    );
  /** A loose stone: on the lowest ground under it, sunk a share of its height, tipped a little. */
  const drop = ([name, small, large]: Row, x: number, z: number, sink: number, power = 2) => {
    const shape = rock.get(name) as IRock;
    const scale = between(small, large, power) / shape.longest;
    const tip = new Euler((next() - 0.5) * 0.5, next() * Math.PI * 2, (next() - 0.5) * 0.5);
    const y = floorAt(x, z, (shape.longest * scale) / 2) - shape.size.y * scale * sink;
    place(name, x, y, z, scale, tip);
  };
  /** A standing stone `height` metres tall: upright, its foot a little under the sand. */
  const stand = (name: string, x: number, z: number, height: number, sink = 0.07) => {
    const shape = rock.get(name) as IRock;
    const scale = height / shape.size.y;
    const lean = new Euler((next() - 0.5) * 0.1, next() * Math.PI * 2, (next() - 0.5) * 0.1);
    place(name, x, floorAt(x, z, (shape.size.x * scale) / 2) - height * sink, z, scale, lean);
    return (Math.max(shape.size.x, shape.size.z) * scale) / 2;
  };
  /** `count` stones from `rows` scattered `near` to `far` metres round a point. */
  const strew = (
    rows: readonly Row[],
    count: number,
    x: number,
    z: number,
    near: number,
    far: number,
    sink = 0.3,
  ) => {
    for (let n = 0; n < count; n++) {
      const turn = next() * Math.PI * 2;
      const away = between(near, far, 1.6);
      drop(pick(rows), x + Math.cos(turn) * away, z + Math.sin(turn) * away, sink);
    }
  };

  for (const [name, x, z, height, yaw] of LANDMARKS) {
    const shape = rock.get(name) as IRock;
    const scale = height / shape.size.y;
    place(
      name,
      x,
      heightAt(x, z) - height * 0.08,
      z,
      scale,
      new Euler(0, (yaw * Math.PI) / 180, 0),
    );
    // Most blocks lie close under the face they fell from; a few rolled out onto the sand.
    const radius = (shape.longest * scale) / 2;
    strew(BLOCKS, Math.round(height), x, z, radius * 0.75, radius * 2.3, 0.25);
  }

  // A cliff wall follows a contour of a steep slope. Its modules stand in the order they were
  // baked in, so each joins the next; its two ends turn into the hill; its top is level with the
  // ground behind it, so the flat back Outcrop gives a module is under the sand.
  const walls: (readonly [number, number, number])[] = [];
  const buildWall = (x: number, z: number) => {
    const [file, count, small, large] = pick(WALLS);
    const shape = rock.get(`${file}-0`) as IRock;
    const scale = between(small, large);
    // The rim: a module's flat top stands a little under its highest chip.
    const [width, height, depth] = [
      shape.size.x * scale,
      shape.top * scale * 0.94,
      shape.size.z * scale,
    ];
    const level = heightAt(x, z);
    if (
      walls.some(
        ([wx, wz, wy]) => Math.hypot(wx - x, wz - z) < WALL.apart && Math.abs(wy - level) < height,
      )
    )
      return;
    const joints = traceWall(heightAt, x, z, width, count);
    if (!joints) return;
    joints[0] = turnIn(heightAt, joints[0] as Point, joints[1] as Point);
    joints[count] = turnIn(heightAt, joints[count] as Point, joints[count - 1] as Point);
    // Module n: its centre, the way its face looks, and the ground behind and before it.
    const modules = Array.from({ length: count }, (_, n) => {
      const [a, b] = [joints[n] as Point, joints[n + 1] as Point];
      const along: Point = [(b[0] - a[0]) / width, (b[1] - a[1]) / width];
      const face: Point = [-along[1], along[0]];
      // The joints run along the middle of the face, which is 0.4 of the depth before the centre.
      const centre: Point = [
        (a[0] + b[0]) / 2 - face[0] * depth * 0.4,
        (a[1] + b[1]) / 2 - face[1] * depth * 0.4,
      ];
      const row = (out: number) =>
        [-0.35, 0, 0.35].map((side) =>
          heightAt(
            centre[0] + face[0] * out + along[0] * width * side,
            centre[1] + face[1] * out + along[1] * width * side,
          ),
        );
      return { along, centre, face, behind: row(-depth * 0.5), before: row(depth * 0.5) };
    });
    // The straight modules set the height; the two turned ends go under the slope by design.
    const straight = modules.slice(1, -1);
    const foot = Math.min(...modules.flatMap((module) => module.before));
    const top = Math.min(...straight.flatMap((module) => module.behind), foot - 0.4 + height);
    const shown = top - Math.max(...straight.flatMap((module) => module.before));
    if (shown < WALL.face) return;
    walls.push([x, z, level]);
    for (const [n, { along, centre, face }] of modules.entries()) {
      const yaw = Math.atan2(-along[1], along[0]);
      place(`${file}-${n}`, centre[0], top - height, centre[1], scale, new Euler(0, yaw, 0));
      const edge = n > 0 && n < count - 1;
      // Flagstones on the rim, where the cap bed broke; talus at the foot of the face.
      for (let k = edge ? Math.round(between(1, 3)) : 0; k > 0; k--) {
        const [name, small, large] = pick(CAPS);
        const cap = rock.get(name) as IRock;
        const size = between(small, large) / cap.longest;
        const side = (next() - 0.5) * width * 0.9;
        const out = between(-0.25, 0.3) * depth;
        place(
          name,
          centre[0] + along[0] * side + face[0] * out,
          top - cap.size.y * size * 0.35,
          centre[1] + along[1] * side + face[1] * out,
          size,
          new Euler((next() - 0.5) * 0.3, next() * Math.PI * 2, (next() - 0.5) * 0.3),
        );
      }
      for (let k = Math.round(between(2, 6)); k > 0; k--) {
        const fall = depth * 0.6 + next() ** 2 * 12;
        const side = (next() - 0.5) * width * 1.1;
        drop(
          pick(next() < 0.35 ? BLOCKS : LOOSE),
          centre[0] + face[0] * fall + along[0] * side,
          centre[1] + face[1] * fall + along[1] * side,
          0.3,
        );
      }
    }
  };
  for (let gz = -WALL.half; gz < WALL.half; gz += WALL.step)
    for (let gx = -WALL.half; gx < WALL.half; gx += WALL.step) {
      const x = gx + (next() - 0.5) * WALL.step;
      const z = gz + (next() - 0.5) * WALL.step;
      const degrees = slopeAt(x, z);
      if (degrees >= WALL.slope[0] && degrees <= WALL.slope[1] && next() < WALL.share)
        buildWall(x, z);
    }
  // An outcrop on a gentler slope: a jointed crag in the sand, the blocks that split from it
  // against its sides, a slab leaning on it, and its talus down the slope.
  for (let gz = -OUTCROP.half; gz < OUTCROP.half; gz += OUTCROP.step)
    for (let gx = -OUTCROP.half; gx < OUTCROP.half; gx += OUTCROP.step) {
      const x = gx + (next() - 0.5) * OUTCROP.step;
      const z = gz + (next() - 0.5) * OUTCROP.step;
      const { dx, dz, degrees } = gradientOf(heightAt, x, z);
      if (degrees < OUTCROP.slope[0] || degrees > OUTCROP.slope[1] || next() > OUTCROP.share)
        continue;
      if (walls.some(([wx, wz]) => Math.hypot(wx - x, wz - z) < 18)) continue;
      const [core, small, large] = pick(CORES);
      const shape = rock.get(core) as IRock;
      const size = between(small, large);
      const radius = (Math.max(shape.size.x, shape.size.z) / shape.longest) * size * 0.5;
      drop([core, size, size], x, z, 0.3, 1);
      for (let k = Math.round(between(3, 7)); k > 0; k--) {
        const turn = next() * Math.PI * 2;
        const away = radius * between(0.75, 1.25);
        drop(pick(BLOCKS), x + Math.cos(turn) * away, z + Math.sin(turn) * away, 0.38, 1.3);
      }
      const steep = Math.hypot(dx, dz) || 1;
      for (let k = Math.round(between(5, 13)); k > 0; k--) {
        const fall = radius + next() ** 1.6 * 13;
        const side = (next() - 0.5) * (radius * 2 + fall * 0.8);
        drop(
          pick(LOOSE),
          x - (dx / steep) * fall + (dz / steep) * side,
          z - (dz / steep) * fall - (dx / steep) * side,
          0.3,
        );
      }
      strew(PEBBLES, Math.round(between(10, 22)), x, z, radius * 0.6, radius + 6, 0.35);
    }

  // Fins and hoodoos stand in gardens, a few close together, away from the spawn: the reference
  // keeps its foreground to dune, scrub and the rocky hillside.
  const ring = ([near, far]: readonly [number, number], slope: number): Point | undefined => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const angle = next() * Math.PI * 2;
      const out = between(near, far);
      const point: Point = [SPAWN[0] + Math.cos(angle) * out, SPAWN[1] + Math.sin(angle) * out];
      if (slopeAt(point[0], point[1]) <= slope) return point;
    }
    return undefined;
  };
  for (let k = 0; k < GARDENS.count; k++) {
    const site = ring(GARDENS.ring, GARDENS.slope);
    if (!site) continue;
    for (let n = Math.round(between(3, 7)); n > 0; n--) {
      const turn = next() * Math.PI * 2;
      const away = between(0, GARDENS.radius);
      const [x, z] = [site[0] + Math.cos(turn) * away, site[1] + Math.sin(turn) * away];
      const [name, low, high] = pick(STANDING);
      const radius = stand(name, x, z, between(low, high));
      strew(LOOSE, Math.round(between(2, 5)), x, z, radius * 0.8, radius + 3);
    }
    strew(BLOCKS, Math.round(between(4, 9)), site[0], site[1], 2, GARDENS.radius + 5, 0.3);
  }
  const span = ring(ARCH.ring, ARCH.slope);
  if (span) {
    const shape = rock.get("arch") as IRock;
    const scale = ARCH.width / shape.size.x;
    const y = floorAt(span[0], span[1], ARCH.width / 2) - shape.size.y * scale * 0.06;
    place("arch", span[0], y, span[1], scale, new Euler(0, next() * Math.PI, 0));
    strew(BLOCKS, 12, span[0], span[1], 2, ARCH.width * 0.8, 0.3);
  }

  // On the dunes stone lies in clusters: one boulder or slab, cobbles beside it, pebbles around.
  for (let k = 0; k < CLUSTERS.count; k++) {
    const angle = next() * Math.PI * 2;
    const out = 6 + CLUSTERS.reach * Math.sqrt(next());
    const x = SPAWN[0] + Math.cos(angle) * out;
    const z = SPAWN[1] + Math.sin(angle) * out;
    if (slopeAt(x, z) > CLUSTERS.slope) continue;
    drop(pick(LOOSE), x, z, 0.3);
    strew([COBBLE], Math.round(between(2, 6)), x, z, 0.4, 2.6);
    strew(PEBBLES, Math.round(between(6, 16)), x, z, 0.3, 4, 0.35);
  }
  for (let k = 0; k < STREWN.count; k++) {
    const angle = next() * Math.PI * 2;
    const out = 2 + STREWN.reach * next() ** 0.75;
    drop(
      pick(PEBBLES),
      SPAWN[0] + Math.cos(angle) * out,
      SPAWN[1] + Math.sin(angle) * out,
      0.35,
      1.5,
    );
  }

  // The rocks live in one group, so the colliders scan exactly them.
  const root = new Group();
  root.name = "desert-rocks";
  const meshes: InstancedMesh[] = [];
  for (const [key, list] of matrices) {
    const file = key.slice(0, key.indexOf("@"));
    const mesh = new InstancedMesh((rock.get(file) as IRock).geometry, material, list.length);
    mesh.name = `${ROCK_NAME}${key}`;
    for (const [at, matrix] of list.entries()) mesh.setMatrixAt(at, matrix);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    meshes.push(mesh);
  }
  ctx.add(root);
  root.updateMatrixWorld(true);
  const bodies = buildStaticColliders(ctx, root, {
    predicate: (object) =>
      object.name.startsWith(ROCK_NAME) && solid.has(object.name.slice(ROCK_NAME.length)),
    collisionLayer: 4,
    // The helper's 4.5 m default assumes a level on y = 0; these dunes stand tens of metres up,
    // and a rock above the ceiling got no body at all.
    reachableCeiling: CEILING,
  });
  return () => {
    for (const body of bodies) body.dispose();
    root.removeFromParent();
    for (const mesh of meshes) mesh.dispose();
    material.dispose();
    blend?.dispose();
  };
}
