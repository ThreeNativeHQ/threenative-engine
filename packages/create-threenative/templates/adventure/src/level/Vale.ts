import {
  BoxGeometry,
  CircleGeometry,
  Group,
  Mesh,
  type Object3D,
  PlaneGeometry,
  Vector3,
} from "three";
import { flat, lit, mottle, worldMaterials } from "../render/materials.js";
import { C } from "../render/palette.js";
import { createRock, createSign, createTree } from "../render/props.js";

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
  readonly swordChest: { readonly at: Vector3; readonly yaw: number };
  readonly sign: { readonly at: Vector3; readonly text: string };
  /** Walking into this point enters the Hollow. */
  readonly caveMouth: Vector3;
  /** Where Wren stands when she comes back out of the Hollow. */
  readonly caveExit: Vector3;
  /** Tuft transforms for one instanced draw (the scene batches them). */
  readonly grass: readonly {
    position: [number, number, number];
    scale: [number, number, number];
  }[];
}

/**
 * The clearing: a meadow ringed by stone and trees, a dirt path from Wren's start to the cave
 * mouth in the north cliff, a ruined wall the Mosslings must go around, two practice dummies, the
 * sword chest and a signpost. Coordinates are metres; north is -Z.
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
  const stoneBox = (w: number, h: number, d: number, x: number, z: number, y = 0): Mesh => {
    const segments = (n: number): number => Math.max(1, Math.min(8, Math.round(n / 1.5)));
    const geometry = mottle(
      new BoxGeometry(w, h, d, segments(w), segments(h), segments(d)),
      0.22,
      rng,
    );
    geometry.translate(x, y + h / 2, z);
    return solid(new Mesh(geometry, materials.stone));
  };

  // The meadow: a mottled plane, and the floor slab the colliders stand on.
  const meadow = new Mesh(
    mottle(new PlaneGeometry(140, 140, 70, 70).rotateX(-Math.PI / 2), 0.16, rng),
    materials.grass,
  );
  meadow.receiveShadow = true;
  group.add(meadow);
  solid(new Mesh(new BoxGeometry(60, 1, 52).translate(0, -0.5, -4), materials.grass)).visible =
    false;
  // The path from the start to the cave mouth.
  for (let i = 0; i < 14; i += 1) {
    const stone = new Mesh(
      new CircleGeometry(0.9 + rng() * 0.4, 9),
      lit(C.path, { roughness: 0.95 }),
    );
    stone.rotation.x = -Math.PI / 2;
    stone.position.set(Math.sin(i * 0.7) * 0.8, 0.012, 9 - i * 2.1);
    stone.receiveShadow = true;
    group.add(stone);
  }

  // The north cliff with the cave mouth at x = 0, and the low walls that close the clearing.
  stoneBox(28, 9, 3, -15.6, -21.5);
  stoneBox(28, 9, 3, 15.6, -21.5);
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

  // Boulders along the walls, trees behind them and a few inside.
  for (let i = 0; i < 26; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const rock = createRock(rng, 0.8 + rng() * 1.2);
    rock.position.x = side * (17 + rng() * 3);
    rock.position.z = -18 + rng() * 34;
    group.add(rock);
  }
  const trees: [number, number, number][] = [
    [-11, 11, 1.1],
    [12, 12, 1],
    [-14, -12, 1.2],
    [13.5, -14, 1.15],
    [9, 3, 0.9],
  ];
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    trees.push([
      Math.cos(a) * (26 + rng() * 6),
      Math.sin(a) * (24 + rng() * 6) - 2,
      1 + rng() * 0.5,
    ]);
  }
  for (const [x, z, s] of trees) {
    const tree = createTree(rng, s);
    tree.position.set(x, 0, z);
    group.add(tree);
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

  const grass: IVale["grass"][number][] = [];
  for (let i = 0; i < 900; i += 1) {
    const x = (rng() - 0.5) * 40;
    const z = -19 + rng() * 35;
    if (Math.abs(x) < 1.6 && z > -2) continue;
    const s = 0.7 + rng() * 0.9;
    grass.push({ position: [x, 0, z], scale: [s, s * (0.8 + rng() * 0.6), s] });
  }

  return {
    caveExit: new Vector3(0, 0, -17),
    caveMouth: new Vector3(0, 0, -23),
    dummies: [new Vector3(-1.6, 0, 4), new Vector3(1.8, 0, 4.5)],
    grass,
    group,
    mosslings: [new Vector3(-6, 0, -10), new Vector3(7, 0, -9)],
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
