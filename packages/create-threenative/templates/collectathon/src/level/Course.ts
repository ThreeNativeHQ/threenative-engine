import {
  Box3,
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  RingGeometry,
  Vector2,
  Vector3,
} from "three";
import { HERO_FEEL } from "../entities/Hero.js";
import type { WalkerKind } from "../entities/Walker.js";
import { buildCastle, buildSignpost, masonryMaps, planarUv, wrapUv } from "../render/castle.js";
import { type IMeadow, plantIsland } from "../render/foliage.js";
import { farHills, groundMaterial, paintGround } from "../render/ground.js";
import { lit, mottle, patches } from "../render/materials.js";
import { C, palette } from "../render/palette.js";
import { TERRAIN_BOUNDS, buildTerrain } from "./terrain.js";

type Point = readonly [number, number, number];

/**
 * One island course, laid out from `HERO_FEEL` rather than tuned the other way round. At full run a
 * single jump rises about 3.1 m and carries 6.4 m; a double 3.4 m; a triple 6 m and 8.9 m; a long
 * jump 14 m. So the summit's steps are 2.5 m (a single jump) and 3.5 m (a double or a ledge grab),
 * the east islet sits 8.5 m off the shore (a long or a triple jump, never a single), and the shaft's
 * walls stand 4 m apart, which one wall kick (18.6 m/s up, 7.2 m/s across) crosses 4.7 m higher.
 */
export const COURSE = {
  islandRadius: 36,
  seaLevel: -2.5,
  spawn: [0, 0, 14] as Point,
  /** Facing at spawn: -Z, toward the summit. */
  spawnYaw: 0,
  summit: {
    at: [-14, -22] as const,
    tiers: [
      [10, 2.5],
      [6.5, 5],
      [3.5, 8.5],
    ] as const,
  },
  islet: { at: [50, 6] as const, radius: 6 },
  /** The wall-kick shaft: a high slab you run under, a block you kick off, 4 m apart. */
  shaft: { slabX: 8, blockX: 13, blockTop: 11, z: [-30, -22] as const },
  pillar: { at: [-28, 18] as const, radius: 2.2, top: 7 },
  /** The orbiting platform circles the pillar and climbs from 0.6 m to 7.2 m once a lap. */
  platform: { radius: 5.5, low: 0.6, high: 7.2, period: 12, size: [3, 0.5, 3] as const },
  /** The practice yard: a grabbable 3 m ledge and a 4.5 m wall, 1.5 m higher, that is not. */
  yard: { ledge: [-20, 4] as const, wall: [-20, -6] as const, ledgeTop: 3, wallTop: 4.5 },
  /** The castle's plateau on the northern headland, x, z, radius, height; the door faces south. */
  castle: { pad: [2, -64, 14, 5] as const, door: [2, -56] as const },
  /**
   * Level ground, [x min, x max, z min, z max]: every scenario route runs on one of these, so the
   * terrain keeps them flat at y = 0 and the jumps measured in `HERO_FEEL` keep their meaning.
   */
  routes: [
    // The test lane, spawn to the summit's foot: the move, collect and combat scenarios.
    [-6, 6, -20, 34],
    // The shaft and the ground its camera watches from.
    [-2, 19, -34, -15],
    // The practice yard.
    [-25, -14, -10, 8],
    // The run-up to the islet gap.
    [24, 40, 0, 12],
  ] as const,
} as const;

export interface ICourse {
  readonly group: Group;
  /** Terrain height at (x, z): what pickups, walkers, checkpoints and a placed hero stand on. */
  ground(x: number, z: number): number;
  readonly spawn: Vector3;
  readonly checkpoints: readonly Vector3[];
  readonly coins: readonly Point[];
  readonly gems: readonly Point[];
  readonly seeds: Readonly<Record<"summit" | "shaft", Point>>;
  /** Walker homes by kind, each far enough off every scenario's route that it never wanders onto one. */
  readonly walkers: Readonly<Record<WalkerKind, readonly Point[]>>;
  /** The orbiting platform's mesh, its origin at the deck's centre. */
  readonly platform: Mesh;
  /** The grass's distance thinning; the scene calls `meadow.update` with the camera each frame. */
  readonly meadow: IMeadow;
  /** Where the platform is at `time` seconds. */
  platformAt(time: number, target: Vector3): Vector3;
  /**
   * Layout self-checks, read by `playtests/survives.playtest.json`: solids that neither stand on the
   * ground nor touch a solid that does, pickups within 1 m of a tree, rock, bush or hedge, and the
   * world's shape and landmarks (relief, slope shares, castle, grass, pebbles, signpost).
   */
  readonly audit: { readonly floating: number; readonly crowded: number } & Readonly<
    Record<
      | "castleParts"
      | "grassTufts"
      | "levelShare"
      | "pathPebbles"
      | "reliefMetres"
      | "signposts"
      | "steepShare",
      number
    >
  >;
}

/** Counts floating solids and crowded pickups in a built course group (see `ICourse.audit`). */
function auditCourse(
  group: Group,
  pickups: readonly Point[],
  ground: (x: number, z: number) => number,
): { floating: number; crowded: number } {
  group.updateMatrixWorld(true);
  // The terrain is the ground itself; every other solid must reach it, or a solid that does.
  const solids: Object3D[] = [];
  group.traverse((object) => {
    if (object.userData.solid === true && object.name !== "terrain") solids.push(object);
  });
  const boxes = solids.map((object) => new Box3().setFromObject(object).expandByScalar(0.02));
  const centre = new Vector3();
  const grounded = boxes.map((box) => {
    box.getCenter(centre);
    return box.min.y <= ground(centre.x, centre.z) + 0.05;
  });
  for (let changed = true; changed; ) {
    changed = false;
    boxes.forEach((box, i) => {
      if (grounded[i] || !boxes.some((other, j) => grounded[j] && other.intersectsBox(box))) return;
      grounded[i] = true;
      changed = true;
    });
  }
  // Props are the shadow casters nobody walks on; the orbiting platform moves, so it is skipped.
  const props: Box3[] = [];
  const matrix = new Matrix4();
  group.traverse((object) => {
    if (!(object instanceof Mesh) || !object.castShadow || object.userData.solid === true) return;
    if (object.name === "orbiting-platform") return;
    if (!(object instanceof InstancedMesh)) {
      props.push(new Box3().setFromObject(object));
      return;
    }
    // `new Box3().copy`, not `clone`: the owned engine's Box3 has no `clone` (2026-10-24).
    object.geometry.computeBoundingBox();
    const local = object.geometry.boundingBox;
    if (local === null) return;
    for (let i = 0; i < object.count; i += 1) {
      object.getMatrixAt(i, matrix);
      matrix.premultiply(object.matrixWorld);
      props.push(new Box3().copy(local).applyMatrix4(matrix));
    }
  });
  const point = new Vector3();
  const crowded = pickups.filter((at) =>
    props.some((box) => box.distanceToPoint(point.set(...at)) < 1),
  ).length;
  return { crowded, floating: grounded.filter((g) => !g).length };
}

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** `grassShare` is the share of grass tufts the quality tier draws (`GRASS_SHARE` in `quality.ts`). */
export function buildCourse(rng: () => number, grassShare = 1): ICourse {
  const group = new Group();
  group.name = "course";
  const [doorX, doorZ] = COURSE.castle.door;
  const [sx, sz] = COURSE.summit.at;
  const [px, pz] = COURSE.pillar.at;
  // The dirt paths: spawn along the coin line to the summit's ramp, and a branch up to the castle.
  const paths = [
    [
      [0, 33],
      [0, 12],
      [-2.5, 2],
      [-5.6, -7.6],
    ],
    [
      [-2.5, 2],
      [-1, -12],
      [2.5, -24],
      [3, -36],
      [3, -46],
      [doorX, doorZ + 1],
    ],
  ] as const;
  const terrain = buildTerrain({
    level: [
      ...COURSE.routes,
      // The pillar with the platform's orbit, and the summit's foot with its ramp.
      [px, pz, COURSE.pillar.radius + COURSE.platform.radius + 1.5],
      [sx, sz, COURSE.summit.tiers[0][0] + 2],
    ],
    pad: COURSE.castle.pad,
    paths,
    seaLevel: COURSE.seaLevel,
  });
  const ground = (x: number, z: number): number => terrain.ground(x, z);
  /** A point `above` metres over the ground at (x, z). */
  const onGround = (x: number, above: number, z: number): Point => [x, ground(x, z) + above, z];
  const grass = lit(palette.grass, { vertexColors: true });
  // Blocks and drum cliffs are the castle's coursed stone, so the whole course is one masonry.
  const rock = new MeshStandardMaterial({
    ...masonryMaps(),
    normalScale: new Vector2(1.2, 1.2),
    roughness: 0.9,
    vertexColors: true,
  });
  const boulder = lit(palette.rock, { flat: true, vertexColors: true });
  const dirt = lit(C.dirt, { vertexColors: true });
  /** Walkable: `Play.ts` builds a fixed trimesh body from every mesh tagged `solid`. */
  const solid = (
    geometry: BufferGeometry,
    material: Material,
    variance = 0.12,
    courses = 0,
  ): Mesh => {
    const mesh = new Mesh(
      material === grass
        ? patches(geometry)
        : mottle(geometry, variance, rng, material === rock, courses),
      material,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.solid = true;
    group.add(mesh);
    return mesh;
  };
  /**
   * A stone block cut into 1 m courses, each its own tint, with a faint per-block jitter, so a tower
   * reads as masonry rows (a strong per-block tint read as a checkerboard).
   */
  const box = (min: Point, max: Point, material: Material = rock): Mesh => {
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as const;
    const geometry = new BoxGeometry(
      size[0],
      size[1],
      size[2],
      Math.ceil(size[0]),
      Math.ceil(size[1]),
      Math.ceil(size[2]),
    );
    geometry.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    return solid(planarUv(geometry, 2), material, 0.06);
  };
  /** A grass-capped rock drum: the shape of every tier, islet and pillar. */
  const drum = (x: number, z: number, radius: number, top: number, bottom: number): void => {
    const segments = Math.max(16, Math.round(radius * 4));
    const cliff = new CylinderGeometry(
      radius,
      radius * 0.92,
      top - bottom - 0.3,
      segments,
      3,
      true,
    );
    cliff.translate(x, (top - 0.3 + bottom) / 2, z);
    solid(wrapUv(cliff, radius, 2), rock, 0.12);
    const lip = new CylinderGeometry(radius + 0.15, radius + 0.15, 0.4, segments, 1, true);
    lip.translate(x, top - 0.2, z);
    solid(lip, grass, 0);
    // The lawn is a disc of concentric rings, not a cylinder's cap: a cap is one fan of long
    // triangles from the centre, and any per-vertex tint on it reads as radial streaks.
    const lawn = new RingGeometry(0, radius + 0.15, segments, Math.ceil(radius / 2.5));
    lawn.rotateX(-Math.PI / 2);
    lawn.translate(x, top, z);
    solid(lawn, grass, 0);
  };

  // The island: one terrain mesh, walkable, painted grass, path, sand and rock. Then the sea.
  const land = new Mesh(
    paintGround(
      terrain.field.toGeometry().translate(terrain.field.origin.x, 0, terrain.field.origin.z),
      { ...terrain, seaLevel: COURSE.seaLevel },
    ),
    groundMaterial(),
  );
  land.name = "terrain";
  land.receiveShadow = true;
  land.castShadow = true;
  land.userData.solid = true;
  group.add(land);
  const sea = new Mesh(
    new PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2),
    lit(C.water, { roughness: 0.3 }),
  );
  sea.position.y = COURSE.seaLevel;
  group.add(farHills(COURSE.seaLevel));
  sea.receiveShadow = true;
  group.add(sea);

  // The summit: three tiers, then the Sunseed on top.
  for (const [radius, top] of COURSE.summit.tiers) drum(sx, sz, radius, top, -0.5);
  // A dirt ramp onto the first tier, so the climb has a walking start.
  const ramp = new BoxGeometry(3, 0.5, 8, 2, 1, 4);
  ramp.rotateX(Math.atan2(2.5, 7.5));
  ramp.translate(sx + 8, 1.15, sz + 9.5);
  solid(ramp, dirt);

  // The east islet, past a gap only a long jump or a triple jump crosses.
  drum(COURSE.islet.at[0], COURSE.islet.at[1], COURSE.islet.radius, 0, -10);

  // The wall-kick shaft. Run in under the slab, kick off the block, kick off the slab, and the third
  // kick carries you over the block's top. The slab starts 5 m up: a running single jump's head
  // (3 m apex + 1.6 m of hero) passes under it.
  const { slabX, blockX, blockTop, z } = COURSE.shaft;
  box([slabX, 5, z[0]], [slabX + 1, 16, z[1]]);
  box([blockX, 0, z[0]], [blockX + 4, blockTop, z[1]]);
  // Its ends are 3 m kerbs, not walls: the open sides are where the camera watches the climb from.
  box([slabX, 0, z[0] - 0.6], [blockX, 3, z[0]]);
  box([slabX, 0, z[1]], [blockX, 3, z[1] + 0.6]);
  // Two piers carry the slab down to the ground at its ends, an arch you run through.
  box([slabX, 0, z[0] - 0.6], [slabX + 1, 16, z[0]]);
  box([slabX, 0, z[1]], [slabX + 1, 16, z[1] + 0.6]);

  // The pillar the orbiting platform rises to.
  drum(px, pz, COURSE.pillar.radius, COURSE.pillar.top, -0.5);
  const deck = new BoxGeometry(...COURSE.platform.size);
  const platform = new Mesh(deck, lit(C.wood));
  platform.castShadow = true;
  platform.receiveShadow = true;
  platform.name = "orbiting-platform";
  group.add(platform);
  const { radius, low, high, period } = COURSE.platform;
  const platformAt = (time: number, target: Vector3): Vector3 => {
    const angle = (time / period) * Math.PI * 2;
    return target.set(
      px + Math.cos(angle) * radius,
      low + ((high - low) * (1 - Math.cos(angle))) / 2,
      pz + Math.sin(angle) * radius,
    );
  };
  platformAt(0, platform.position);

  // The practice yard.
  const { ledge, wall, ledgeTop, wallTop } = COURSE.yard;
  box([ledge[0] - 2, 0, ledge[1] - 3], [ledge[0] + 2, ledgeTop, ledge[1] + 3]);
  box([wall[0] - 2, 0, wall[1] - 3], [wall[0] + 2, wallTop, wall[1] + 3]);

  const coins: Point[] = [];
  // A line from spawn to the summit's ramp, an arc over the islet gap, a ring round the pillar.
  for (let i = 0; i < 10; i += 1) coins.push(onGround(-1 - i * 0.6, 1, 10 - i * 2));
  for (let i = 0; i < 8; i += 1) {
    const t = (i + 1) / 9;
    coins.push([35.5 + t * 8.5, 1.2 + Math.sin(t * Math.PI) * 3.2, 6]);
  }
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2;
    coins.push(onGround(px + Math.cos(a) * 3.5, 1, pz + Math.sin(a) * 3.5));
  }
  for (let i = 0; i < 6; i += 1) coins.push(onGround(2 + i * 1.2, 1, -26));
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    coins.push([sx + Math.cos(a) * 8.2, 3.5, sz + Math.sin(a) * 8.2]);
  }
  const gems: Point[] = [
    [48, 1.2, 4],
    [52, 1.2, 8],
    [50, 1.2, 6],
    [px, COURSE.pillar.top + 1.2, pz],
    [px - 4, COURSE.platform.high + 1.5, pz],
    [sx + 5, COURSE.summit.tiers[1][1] + 1.2, sz],
    [ledge[0], ledgeTop + 1.2, ledge[1]],
    onGround(-6, 1.2, 28),
  ];
  const seeds = {
    shaft: [blockX + 2, blockTop + 1.4, (z[0] + z[1]) / 2] as Point,
    summit: [sx, COURSE.summit.tiers[2][1] + 1.4, sz] as Point,
  };
  /** Every pickup: scenery keeps a clear metre round each, so none hangs inside a tree or a rock. */
  const pickups = [...coins, ...gems, ...Object.values(seeds)];
  const nearPickup = (x: number, zz: number, reach: number): boolean =>
    pickups.some(([kx, , kz]) => Math.hypot(x - kx, zz - kz) < reach);

  // Scenery: boulders where the ground breaks into a slope, never on a route and never inside a
  // landmark (a rock through the shaft's wall, under the pillar's coin ring or in the castle).
  const keepOut = [
    [px, pz, COURSE.pillar.radius + 5],
    [(slabX + blockX + 4) / 2, (z[0] + z[1]) / 2, 8],
    [ledge[0], ledge[1], 5],
    [wall[0], wall[1], 5],
    [COURSE.castle.pad[0], COURSE.castle.pad[1], COURSE.castle.pad[2] + 2],
    [sx, sz, COURSE.summit.tiers[0][0] + 1],
  ] as const;
  const onRoute = (x: number, zz: number, w: number): boolean =>
    COURSE.routes.some(
      ([x0, x1, z0, z1]) => x > x0 - w && x < x1 + w && zz > z0 - w && zz < z1 + w,
    );
  const boulders: [number, number, number][] = [];
  for (let i = 0; i < 60 && boulders.length < 16; i += 1) {
    const x = TERRAIN_BOUNDS.minX + rng() * (TERRAIN_BOUNDS.maxX - TERRAIN_BOUNDS.minX);
    const zz = TERRAIN_BOUNDS.minZ + rng() * (TERRAIN_BOUNDS.maxZ - TERRAIN_BOUNDS.minZ);
    const size = 0.7 + rng() * 1.1;
    const slope = terrain.flatness(x, zz);
    // A rock is up to 2 m across its middle: 3.5 m keeps a metre clear of every pickup.
    if (slope > 0.93 || slope < 0.6 || ground(x, zz) < COURSE.seaLevel + 1) continue;
    if (keepOut.some(([kx, kz, kr]) => Math.hypot(x - kx, zz - kz) < kr) || nearPickup(x, zz, 3.5))
      continue;
    if (onRoute(x, zz, 2) || terrain.pathDistance(x, zz) < size + 1.5) continue;
    const stone = new Mesh(mottle(new DodecahedronGeometry(size, 0), 0.25, rng), boulder);
    stone.position.set(x, ground(x, zz) + size * 0.2, zz);
    stone.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    stone.castShadow = true;
    stone.receiveShadow = true;
    group.add(stone);
    boulders.push([x, zz, size + 0.3]);
  }

  // The castle on its plateau, its door at the end of the castle path; its stone is walkable.
  const castle = buildCastle();
  castle.group.position.set(doorX, COURSE.castle.pad[3], doorZ);
  castle.stone.userData.solid = true;
  group.add(castle.group);
  // The arrow sign beside the path near spawn, its board broadside to a camera behind the hero.
  const sign = buildSignpost(rng);
  sign.position.set(-4.2, ground(-4.2, 9.5), 9.5);
  group.add(sign);

  // Planting (`render/foliage.ts`): never on a route a scenario runs, a landmark or a boulder.
  const taken = [...keepOut, ...boulders] as const;
  const planting = plantIsland({
    bounds: TERRAIN_BOUNDS,
    clear: (x, zz, w) =>
      !onRoute(x, zz, w) &&
      !taken.some(([kx, kz, kr]) => Math.hypot(x - kx, zz - kz) < kr + w) &&
      !nearPickup(x, zz, w + 1),
    flatness: terrain.flatness,
    grassShare,
    ground,
    pathDistance: terrain.pathDistance,
    rng,
    seaLevel: COURSE.seaLevel,
    // The islet's drum cliff radius at the waterline: it narrows to 92% over its height.
    shores: [[COURSE.islet.at[0], COURSE.islet.at[1], COURSE.islet.radius * 0.98]],
  });
  group.add(planting.group);

  // The world's shape on a 1 m grid of land: the climb from the shore to the top, the share of
  // ground too steep to walk, and the share left dead level for the routes.
  let landCells = 0;
  let steep = 0;
  let level = 0;
  let bottom = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (let zz = TERRAIN_BOUNDS.minZ + 0.5; zz < TERRAIN_BOUNDS.maxZ; zz += 1) {
    for (let x = TERRAIN_BOUNDS.minX + 0.5; x < TERRAIN_BOUNDS.maxX; x += 1) {
      const y = ground(x, zz);
      if (y < COURSE.seaLevel) continue;
      landCells += 1;
      bottom = Math.min(bottom, y);
      top = Math.max(top, y);
      if (terrain.flatness(x, zz) < 0.7) steep += 1;
      if (Math.abs(y) < 0.02) level += 1;
    }
  }
  let castleParts = 0;
  castle.group.traverse((object) => {
    if (object instanceof Mesh) castleParts += 1;
  });
  const pebbles = planting.group.getObjectByName("path-pebbles");
  const world = {
    castleParts,
    grassTufts: planting.meadow.total,
    levelShare: level / landCells,
    pathPebbles: pebbles instanceof InstancedMesh ? pebbles.count : 0,
    reliefMetres: top - bottom,
    signposts: group.getObjectByName("signpost") === undefined ? 0 : 1,
    steepShare: steep / landCells,
  };

  return {
    audit: { ...auditCourse(group, pickups, ground), ...world },
    checkpoints: [
      new Vector3(...COURSE.spawn),
      new Vector3(...onGround(sx + 9, 0, sz + 13)),
      new Vector3(...onGround(slabX - 6, 0, -26)),
      new Vector3(COURSE.islet.at[0], 0, COURSE.islet.at[1]),
    ],
    coins,
    gems,
    ground,
    group,
    meadow: planting.meadow,
    platform,
    platformAt,
    seeds,
    spawn: new Vector3(...onGround(COURSE.spawn[0], 0.85, COURSE.spawn[2])),
    walkers: {
      bumblet: [
        onGround(6, 0, 2),
        onGround(-8, 0, -4),
        [sx + 2, COURSE.summit.tiers[0][1], sz + 7],
        [50, 0, 4],
        onGround(-12, 0, 12),
      ],
      hopper: [onGround(20, 0, 18), onGround(24, 0, -12)],
      thornback: [onGround(-30, 0, -2), onGround(13, 0, 26)],
    },
  };
}

/** The fall that ends in the sea, from `HERO_FEEL`, for the scene's respawn test. */
export const KILL_PLANE = HERO_FEEL.killPlane;
