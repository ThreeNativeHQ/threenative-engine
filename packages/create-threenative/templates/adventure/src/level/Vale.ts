import { BoxGeometry, Group, Mesh, type Object3D, PlaneGeometry, Vector3 } from "three";
import { type IValeSite, plantVale, valeGround } from "../render/foliage.js";
import { flat, lit, mottle, worldMaterials } from "../render/materials.js";
import { C } from "../render/palette.js";
import { createSign } from "../render/props.js";

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
}

/**
 * The clearing: a meadow ringed by stone and woods, a worn path from Wren's start to the cave
 * mouth in the north cliff, a ruined wall the Mosslings must go around, two practice dummies, the
 * sword chest, a signpost, a Flicker and a Thornback. Coordinates are metres; north is -Z. The
 * planting and the floor's look are `render/foliage.ts`; this file decides what blocks.
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
    return solid(new Mesh(geometry, materials.stone));
  };

  // The floor slab the colliders stand on; the floor Wren sees is `valeGround`, built below.
  solid(new Mesh(new BoxGeometry(60, 1, 52).translate(0, -0.5, -4), materials.grass)).visible =
    false;
  // The path from the start to the cave mouth: its centre line, painted into the floor.
  const pathX = (z: number): number => Math.sin(((9 - z) / 2.1) * 0.7) * 0.8;

  // The north cliff with the cave mouth at x = 0: buttresses of uneven height and depth, so its
  // skyline and its face break up, and two ledges. Then the low walls that close the clearing.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i += 1) {
      const w = 7 + rng() * 0.6;
      const h = 7.4 + rng() * 3.2;
      const d = 3 + rng() * 1.4;
      stoneBox(w, h, d, side * (1.7 + 3.5 + i * 7), -20 - d / 2, 0, 0.32);
    }
    stoneBox(3.2, 0.7, 1.1, side * (6 + rng() * 3), -20.1, 3.4 + rng(), 0.3);
    stoneBox(2.4, 0.6, 0.9, side * (13 + rng() * 3), -20.1, 5.2 + rng(), 0.3);
  }
  stoneBox(3.4, 5.4, 3, 0, -21.5, 3.6);
  stoneBox(2, 4, 40, -21, -2);
  stoneBox(2, 4, 40, 21, -2);
  stoneBox(44, 3, 2, 0, 17.5);
  // The tunnel behind the mouth: dark walls, a dark back so the mouth reads as a way in.
  stoneBox(1, 3.6, 6, -2.1, -26);
  stoneBox(1, 3.6, 6, 2.1, -26);
  const back = new Mesh(new PlaneGeometry(4, 4), flat(0x050605));
  back.position.set(0, 2, -28.8);
  group.add(back);
  const roof = new Mesh(new BoxGeometry(5, 1, 6).translate(0, 4.1, -26), lit(C.stoneDark));
  roof.castShadow = true;
  group.add(roof);

  // The ruin the Mosslings have to walk around.
  stoneBox(6, 1.6, 0.6, -6, -6);
  stoneBox(1.2, 0.5, 0.9, -2.4, -6.4);

  // Trees: five inside the clearing, two rings of woods outside it.
  const trees: [number, number, number, "broadleaf" | "pine" | "dead"][] = [
    [-11, 11, 1.1, "broadleaf"],
    [12, 12, 1, "pine"],
    [-14, -12, 1.2, "broadleaf"],
    [13.5, -14, 1.15, "pine"],
    [9, 3, 0.9, "broadleaf"],
  ];
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    trees.push([
      Math.cos(a) * (26 + rng() * 6),
      Math.sin(a) * (24 + rng() * 6) - 2,
      1 + rng() * 0.5,
      i % 6 === 5 ? "dead" : i % 2 === 0 ? "broadleaf" : "pine",
    ]);
  }
  for (let i = 0; i < 20; i += 1) {
    const a = (i / 20) * Math.PI * 2 + 0.15;
    trees.push([
      Math.cos(a) * (36 + rng() * 8),
      Math.sin(a) * (34 + rng() * 8) - 2,
      1.1 + rng() * 0.6,
      i % 3 === 0 ? "broadleaf" : "pine",
    ]);
  }
  for (const [x, z, s] of trees) {
    if (Math.abs(x) < 20 && z > -20 && z < 16) {
      // Trees inside the clearing are solid at the trunk.
      solid(
        new Mesh(new BoxGeometry(0.5 * s, 3, 0.5 * s).translate(x, 1.5, z), materials.stone),
      ).visible = false;
    }
  }

  const sign = createSign();
  sign.position.set(3.5, 0, 9.5);
  sign.rotation.y = -0.4;
  group.add(sign);

  // Planting and the floor. The open spaces: the path, the spawn yard with the dummies and the
  // chest, the ruin's lane, and the cave mouth.
  const open: [number, number, number][] = [
    [0, 6, 4.5],
    [-6, -6, 3.5],
    [-6, -2.5, 3],
    [0, -19, 3],
  ];
  const site: IValeSite = {
    clear: (x, z, width) =>
      Math.abs(x - pathX(z)) > 1.8 + width / 2 &&
      open.every(([ox, oz, r]) => Math.hypot(x - ox, z - oz) > r + width / 2),
    clearing: { half: 20, north: -20, south: 16.5 },
    pathX,
    rng,
    trees,
    walls: [
      [-14, 4.5, -19.95, 12, 7, 0],
      [14, 4.5, -19.95, 12, 7, 0],
      [-19.95, 2, -2, 36, 4, Math.PI / 2],
      [19.95, 2, -2, 36, 4, -Math.PI / 2],
      [0, 1.5, 16.45, 36, 3, Math.PI],
      [-6, 0.8, -5.65, 6, 1.6, 0],
      [-6, 0.8, -6.35, 6, 1.6, Math.PI],
    ],
  };
  const planting = plantVale(site);
  group.add(planting.group, valeGround(site, planting.shade));

  return {
    caveExit: new Vector3(0, 0, -17),
    caveMouth: new Vector3(0, 0, -23),
    dummies: [new Vector3(-1.6, 0, 4), new Vector3(1.8, 0, 4.5)],
    group,
    mosslings: [new Vector3(-6, 0, -10), new Vector3(7, 0, -9)],
    flickers: [new Vector3(12, 0, -6)],
    thornbacks: [{ at: new Vector3(-13, 0, 5), yaw: Math.PI / 2 }],
    sign: {
      at: new Vector3(3.5, 0, 9.5),
      text: "LANTERN VALE — The Moss Hollow lies north. Mind the Warden.",
    },
    spawn: new Vector3(0, 0, 8),
    spawnYaw: Math.PI,
    swordChest: { at: new Vector3(-1.6, 0, 8.4), yaw: Math.PI / 2 },
  };
}

/** True for the meshes `buildStaticColliders` should turn into fixed bodies. */
export function isSolid(object: Object3D): boolean {
  return object.userData.solid === true;
}
