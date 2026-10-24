import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type Object3D,
  PlaneGeometry,
  Vector3,
} from "three";
import { type IValeSite, plantVale, valeGround } from "../render/foliage.js";
import { flat, lit, mottle, worldMaterials } from "../render/materials.js";
import { C } from "../render/palette.js";
import { createHut, createPitcherLantern, createSign } from "../render/props.js";

/** A small seeded generator, so the clearing is the same clearing every run. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface IVale {
  /** Everything the clearing draws. Meshes with `userData.solid` become fixed colliders. */
  readonly group: Group;
  readonly spawn: Vector3;
  readonly spawnYaw: number;
  readonly dummies: readonly Vector3[];
  readonly mosslings: readonly Vector3[];
  readonly flickers: readonly Vector3[];
  readonly thornbacks: readonly { readonly at: Vector3; readonly yaw: number }[];
  readonly swordChest: { readonly at: Vector3; readonly yaw: number };
  readonly sign: { readonly at: Vector3; readonly text: string };
  /** Walking into this point enters the Hollow. */
  readonly caveMouth: Vector3;
  /** Where Wren stands when she comes back out of the Hollow. */
  readonly caveExit: Vector3;
  /** The lantern-keeper's hut: where it stands and how many lanterns hang from it. */
  readonly hut: { readonly at: Vector3; readonly lanterns: number };
  /** Flagstones laid along the path, and the share of the path's centre line they cover. */
  readonly path: { readonly stones: number; readonly cover: number };
}

// ------------------------------------------------------------------------------------ the ground
// One height function is the whole landform: the floor Wren walks (a trimesh collider), the floor
// she sees, and the height every plant, prop, entity and playtest placement stands at. Metres, y up.

const smooth = (a: number, b: number, t: number): number => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
/** 0..1 rolling noise from two crossed sine sheets. */
const wave = (x: number, z: number, f: number): number =>
  0.5 + 0.25 * (Math.sin(x * f + z * f * 0.55) + Math.sin(z * f * 1.4 - x * f * 0.37 + 1.3));

/** The path's centre line, x at a given z: it winds from Wren's start to the cave mouth at x = 0. */
export const pathX = (z: number): number =>
  Math.sin((9 - z) * 0.3) * 1.4 * Math.min(1, Math.max(0, (z + 20) / 5));

/** The clearing's walkable box: x from -HALF to HALF, z from NORTH to SOUTH. */
const CLEARING = { half: 20, north: -20, south: 16.5 };
/**
 * Flat play spaces, x, z, radius: the playtests and the fights stand here, so the ground under them
 * is level and every placement's height is the clearing floor's. The start yard (the chest, the
 * dummies, the sign), the ruin lane the Mosslings walk round, the Thornback lane, the Flicker's
 * circle, the second Mossling's post, and the hut's ledge.
 */
const PADS: readonly (readonly [number, number, number])[] = [
  [0.4, 6.6, 4.6],
  [-6, -6, 6.5],
  [-6, -2.5, 4],
  [-13, 1.5, 3.5],
  [-13, 6, 3.5],
  [-13, 10.5, 3.5],
  [12, -2, 5.5],
  [7, -9, 2.5],
];
/** The lantern-keeper's hut on its ledge, north-east of the path: x, z, ledge radius, ledge height. */
const HUT = { x: 10.5, z: -13.5, radius: 3.6, lift: 0.6 };
/** Steep mossy outcrops, x, z, radius, height: their sides pass the walk limit, so they are walls. */
const OUTCROPS: readonly (readonly [number, number, number, number])[] = [
  [-16.5, -14, 3.4, 2.8],
  [16, -17.5, 3, 2.4],
  [-17, 14.5, 3, 2.2],
  [-17.5, -4.5, 2.4, 2.2],
  [-9.5, -17.5, 2.6, 2],
  [14.5, -9.5, 1.8, 1.5],
];
/** A stream bed in the south-east corner, as a polyline; its water sits at `STREAM.water`. */
export const STREAM = {
  points: [
    [6, 18.5],
    [12, 12.5],
    [17, 9.5],
    [23, 8],
  ] as readonly (readonly [number, number])[],
  bed: -0.55,
  water: -0.3,
};

const distanceToSegment = (
  x: number,
  z: number,
  [ax, az]: readonly [number, number],
  [bx, bz]: readonly [number, number],
): number => {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
};

/** Metres from the stream's centre line. */
export function streamDistance(x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < STREAM.points.length; i += 1) {
    const a = STREAM.points[i - 1];
    const b = STREAM.points[i];
    if (a !== undefined && b !== undefined) best = Math.min(best, distanceToSegment(x, z, a, b));
  }
  return best;
}

/** 1 on a play space, the path or the cave approach, easing to 0 over a few metres round them. */
function flatness(x: number, z: number): number {
  let f = 1 - smooth(2.2, 4.4, Math.abs(x - pathX(z)));
  if (z < -15) f = Math.max(f, 1 - smooth(3.5, 5.5, Math.abs(x)));
  f = Math.max(f, 1 - smooth(HUT.radius, HUT.radius + 1.6, Math.hypot(x - HUT.x, z - HUT.z)));
  for (const [px, pz, r] of PADS)
    f = Math.max(f, 1 - smooth(r, r + 3.2, Math.hypot(x - px, z - pz)));
  return f;
}

/** The ground's height at (x, z): the one landform every system reads. */
export function valeHeight(x: number, z: number): number {
  // The rise to the cave mouth: the clearing's north end climbs 1.2 m to the cliff.
  const rise = 1.2 * smooth(-11, -17, z);
  const ledge =
    HUT.lift * (1 - smooth(HUT.radius, HUT.radius + 1.6, Math.hypot(x - HUT.x, z - HUT.z)));
  // Inside the walls: rolling banks, higher toward the walls, and the outcrops.
  const edge = Math.min(CLEARING.half - Math.abs(x), z - CLEARING.north, CLEARING.south - z);
  const tunnel = Math.abs(x) < 3.5 && z < CLEARING.north + 1;
  let relief = 0.35 + 1.3 * wave(x, z, 0.23) + 0.45 * wave(x + 7, z - 3, 0.61);
  if (edge > 0) relief += 1.4 * (1 - smooth(0, 4.5, edge));
  for (const [ox, oz, r, h] of OUTCROPS)
    relief += h * (1 - smooth(r * 0.5, r, Math.hypot(x - ox, z - oz)));
  // Outside them: a steep rocky bank, then wooded hills.
  if (edge < 0 && !tunnel)
    relief += 2.2 * smooth(0, 3, -edge) + (0.8 + 3.4 * wave(x, z, 0.09)) * smooth(2, 14, -edge);
  let h = rise + ledge + relief * (1 - flatness(x, z));
  // The stream cuts its bed through whatever stands there.
  const cut = 1 - smooth(0.7, 2.4, streamDistance(x, z));
  h += (Math.min(h, STREAM.bed) - h) * cut;
  return h;
}

/**
 * The clearing's landform on a 0.5 m grid: its height range, the share steeper than `walkLimit`
 * (radians; the character controller's climb limit) and the share under 6°, which the fights need.
 */
export function measureRelief(walkLimit = Math.PI / 4): {
  readonly range: number;
  readonly steepShare: number;
  readonly levelShare: number;
} {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let steep = 0;
  let level = 0;
  let samples = 0;
  const step = 0.5;
  for (let x = -CLEARING.half + step; x < CLEARING.half; x += step)
    for (let z = CLEARING.north + step; z < CLEARING.south; z += step) {
      const h = valeHeight(x, z);
      const slope = Math.atan(
        Math.hypot(valeHeight(x + 0.1, z) - h, valeHeight(x, z + 0.1) - h) / 0.1,
      );
      low = Math.min(low, h);
      high = Math.max(high, h);
      samples += 1;
      if (slope > walkLimit) steep += 1;
      if (slope < (6 * Math.PI) / 180) level += 1;
    }
  return { levelShare: level / samples, range: high - low, steepShare: steep / samples };
}

/**
 * The clearing: a forest glade under old trees, a winding flagstone path from Wren's start to the
 * cave mouth in the north cliff, banks and mossy outcrops between the play spaces, a stream bed, the
 * lantern-keeper's hut on its ledge, a ruined wall the Mosslings must go around, two practice
 * dummies, the sword chest, signposts, a Flicker and a Thornback. Coordinates are metres; north is
 * -Z. The planting and the floor's look are `render/foliage.ts`; this file decides what blocks.
 */
export function buildVale(rng: () => number): IVale {
  const group = new Group();
  group.name = "vale";
  const materials = worldMaterials();
  const solid = (mesh: Mesh): Mesh => {
    mesh.userData.solid = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const hidden = (mesh: Mesh): void => {
    solid(mesh).visible = false;
  };
  const at = (x: number, z: number, lift = 0): Vector3 =>
    new Vector3(x, valeHeight(x, z) + lift, z);
  const stoneBox = (
    w: number,
    h: number,
    d: number,
    x: number,
    z: number,
    y = 0,
    variance = 0.22,
  ): Mesh => {
    const segments = (n: number): number => Math.max(1, Math.min(8, Math.round(n / 1.5)));
    const geometry = mottle(
      new BoxGeometry(w, h, d, segments(w), segments(h), segments(d)),
      variance,
      rng,
    );
    geometry.translate(x, y + h / 2, z);
    return solid(new Mesh(geometry, materials.cliff));
  };

  // The north cliff with the cave mouth at x = 0: buttresses of uneven height and depth, so its
  // skyline and its face break up, and two ledges. Their feet sink into the rise.
  const top = valeHeight(0, -19);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i += 1) {
      const w = 7 + rng() * 0.6;
      const h = 7.4 + rng() * 3.2;
      const d = 3 + rng() * 1.4;
      stoneBox(w, h, d, side * (1.7 + 3.5 + i * 7), -20 - d / 2, top - 1, 0.32);
    }
    stoneBox(3.2, 0.7, 1.1, side * (6 + rng() * 3), -20.1, top + 3.4 + rng(), 0.3);
    stoneBox(2.4, 0.6, 0.9, side * (13 + rng() * 3), -20.1, top + 5.2 + rng(), 0.3);
  }
  stoneBox(3.4, 5.4, 3, 0, -21.5, top + 3.6);
  // The walls that close the clearing stand where the banks steepen into the woods: they hold Wren
  // in, but the bank, the rocks and the trees are what she sees.
  hidden(new Mesh(new BoxGeometry(2, 6, 40).translate(-21, 3, -2)));
  hidden(new Mesh(new BoxGeometry(2, 6, 40).translate(21, 3, -2)));
  hidden(new Mesh(new BoxGeometry(44, 6, 2).translate(0, 3, 17.5)));
  // The tunnel behind the mouth: dark walls, a dark back so the mouth reads as a way in.
  stoneBox(1, 3.6, 6, -2.1, -26, top);
  stoneBox(1, 3.6, 6, 2.1, -26, top);
  const back = new Mesh(new PlaneGeometry(4, 4), flat(0x050605));
  back.position.set(0, top + 2, -28.8);
  group.add(back);
  const roof = new Mesh(new BoxGeometry(5, 1, 6).translate(0, top + 4.1, -26), lit(C.stoneDark));
  roof.castShadow = true;
  group.add(roof);

  // The ruin the Mosslings have to walk around.
  stoneBox(6, 1.6, 0.6, -6, -6);
  stoneBox(1.2, 0.5, 0.9, -2.4, -6.4);

  // Old trees: a few giants inside the clearing that frame the path, and two rings of woods on the
  // hills round it. `giant` trees carry roots and the full crown; the far rings a lighter cut.
  const trees: [number, number, number, "giant" | "far"][] = [
    [-11, 12, 1.25, "giant"],
    [-16, -9, 1.35, "giant"],
    [-13.5, -15.5, 1.5, "giant"],
    [15.5, -12.5, 1.4, "giant"],
    [9, 6.5, 1.15, "giant"],
    [-4.3, -12.8, 1.15, "giant"],
    [4.4, -13.2, 1.2, "giant"],
    [6, 13.5, 1.25, "giant"],
    [-6.5, 15, 1.05, "giant"],
    [16.5, 2.5, 1.1, "giant"],
  ];
  for (let i = 0; i < 22; i += 1) {
    const a = (i / 22) * Math.PI * 2 + rng() * 0.15;
    trees.push([
      Math.cos(a) * (25 + rng() * 5),
      Math.sin(a) * (23 + rng() * 5) - 2,
      1.1 + rng() * 0.5,
      "far",
    ]);
  }
  for (let i = 0; i < 18; i += 1) {
    const a = (i / 18) * Math.PI * 2 + 0.17;
    trees.push([
      Math.cos(a) * (36 + rng() * 8),
      Math.sin(a) * (33 + rng() * 8) - 2,
      1.3 + rng() * 0.6,
      "far",
    ]);
  }
  for (const [x, z, s, kind] of trees) {
    if (kind !== "giant") continue;
    // A giant is solid at the trunk; its roots are scenery Wren walks over.
    const w = 1.2 * s;
    hidden(new Mesh(new BoxGeometry(w, 4, w).translate(x, valeHeight(x, z) + 1.5, z)));
  }

  // The lantern-keeper's hut on its ledge, its round door to the path; solid at the trunk-house.
  const hutAt = at(HUT.x, HUT.z);
  const hut = createHut();
  hut.group.position.copy(hutAt);
  hut.group.rotation.y = Math.atan2(pathX(HUT.z) - HUT.x, 2) + Math.PI / 2;
  group.add(hut.group);
  hidden(new Mesh(new CylinderGeometry(2.2, 2.4, 4, 10).translate(hutAt.x, hutAt.y + 2, hutAt.z)));

  const sign = createSign();
  sign.position.copy(at(3.5, 9.5));
  sign.rotation.y = -0.4;
  group.add(sign);
  const hutSign = createSign();
  hutSign.position.copy(at(5.4, -11.2));
  hutSign.rotation.y = -0.9;
  group.add(hutSign);
  const pitcher = createPitcherLantern();
  pitcher.position.copy(at(4.3, 3));
  group.add(pitcher);

  // Planting and the floor. The open spaces: the path, the spawn yard with the dummies and the
  // chest, the ruin's lane, the cave mouth and the hut's door.
  const open: [number, number, number][] = [
    [0, 6, 4.5],
    [-6, -6, 3.5],
    [-6, -2.5, 3],
    [0, -19, 3],
    [HUT.x, HUT.z, HUT.radius],
  ];
  const site: IValeSite = {
    clear: (x, z, width) =>
      Math.abs(x - pathX(z)) > 1.8 + width / 2 &&
      open.every(([ox, oz, r]) => Math.hypot(x - ox, z - oz) > r + width / 2),
    clearing: CLEARING,
    height: valeHeight,
    pathX,
    rng,
    stream: { ...STREAM, distance: streamDistance },
    trees,
    walls: [
      [-14, top + 4.5, -19.95, 12, 7, 0],
      [14, top + 4.5, -19.95, 12, 7, 0],
      [-6, 0.8, -5.65, 6, 1.6, 0],
      [-6, 0.8, -6.35, 6, 1.6, Math.PI],
    ],
  };
  const planting = plantVale(site);
  const ground = valeGround(site, planting.shade);
  // The floor Wren sees is the floor she stands on: its inner, detailed part is the collider.
  ground.inner.userData.solid = true;
  group.add(planting.group, ground.inner, ground.outer);

  return {
    caveExit: at(0, -17),
    caveMouth: at(0, -23),
    dummies: [at(-1.6, 4), at(1.8, 4.5)],
    group,
    hut: { at: hutAt, lanterns: hut.lanterns },
    mosslings: [at(-6, -10), at(7, -9)],
    flickers: [at(12, -6)],
    path: planting.path,
    thornbacks: [{ at: at(-13, 5), yaw: Math.PI / 2 }],
    sign: {
      at: at(3.5, 9.5),
      text: "LANTERN VALE — The Moss Hollow lies north. Mind the Warden.",
    },
    spawn: at(0, 8),
    spawnYaw: Math.PI,
    swordChest: { at: at(-1.6, 8.4), yaw: Math.PI / 2 },
  };
}

/** True for the meshes `buildStaticColliders` should turn into fixed bodies. */
export function isSolid(object: Object3D): boolean {
  return object.userData.solid === true;
}
