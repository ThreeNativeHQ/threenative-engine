// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Every prop in the vale and the Hollow, from primitives: chests, doors, the grate, the push
// block, the floor switch, trees, rocks, grass, the signpost, torches and the heart vessel. Each
// builder returns a group with its origin on the floor; the level files place them.
import {
  BoxGeometry,
  type BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  type Material,
  Mesh,
  SphereGeometry,
} from "three";
import { glow, lit, mottle } from "./materials.js";
import { C, palette } from "./palette.js";

function part(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export interface IChestRig {
  readonly group: Group;
  /** 0 closed, 1 open. */
  setOpen(amount: number): void;
}

/** A banded wooden chest. The lid pivots on its back edge. */
export function createChest(): IChestRig {
  const group = new Group();
  const wood = lit(C.wood);
  const band = lit(palette.accent, { metalness: 0.7, roughness: 0.4 });
  group.add(part(new BoxGeometry(0.9, 0.5, 0.6), wood, 0, 0.25));
  for (const x of [-0.32, 0.32]) group.add(part(new BoxGeometry(0.07, 0.52, 0.62), band, x, 0.26));
  const lid = new Group();
  lid.position.set(0, 0.5, -0.3);
  group.add(lid);
  const top = part(new CylinderGeometry(0.3, 0.3, 0.9, 12, 1, false, 0, Math.PI), wood, 0, 0, 0.3);
  top.rotation.z = Math.PI / 2;
  lid.add(top);
  lid.add(part(new BoxGeometry(0.12, 0.14, 0.05), band, 0, 0.02, 0.62));
  return {
    group,
    setOpen(amount: number): void {
      lid.rotation.x = -amount * 1.9;
    },
  };
}

/** A heavy door in a stone frame. `locked` adds the brass lock plate. Slides down to open. */
export function createDoor(width: number, height: number, locked: boolean): Group {
  const group = new Group();
  const plank = lit(C.woodDark);
  group.add(part(new BoxGeometry(width, height, 0.22), plank, 0, height / 2));
  for (const y of [0.4, height - 0.4])
    group.add(part(new BoxGeometry(width, 0.12, 0.26), lit(C.iron, { metalness: 0.7 }), 0, y));
  if (locked) {
    group.add(
      part(
        new BoxGeometry(0.42, 0.5, 0.3),
        lit(palette.accent, { metalness: 0.8, roughness: 0.35 }),
        0,
        1.2,
      ),
    );
    group.add(part(new CylinderGeometry(0.05, 0.05, 0.32, 8), lit(C.eye), 0, 1.15));
  }
  return group;
}

/** An iron grate: vertical bars and two rails. Rises into the lintel to open. */
export function createGrate(width: number, height: number): Group {
  const group = new Group();
  const iron = lit(C.iron, { metalness: 0.8, roughness: 0.45 });
  const bars = Math.round(width / 0.32);
  for (let i = 0; i <= bars; i += 1)
    group.add(
      part(
        new CylinderGeometry(0.04, 0.04, height, 6),
        iron,
        -width / 2 + (i * width) / bars,
        height / 2,
      ),
    );
  for (const y of [0.3, height - 0.3])
    group.add(part(new BoxGeometry(width, 0.1, 0.1), iron, 0, y));
  return group;
}

/** The 1 m push block: cut stone with a moss cap and a carved lantern glyph. */
export function createBlock(rng: () => number): Group {
  const group = new Group();
  group.add(
    part(
      mottle(new BoxGeometry(0.98, 0.98, 0.98, 2, 2, 2), 0.2, rng),
      lit(C.stoneDark, { flat: true, vertexColors: true }),
      0,
      0.49,
    ),
  );
  group.add(part(new BoxGeometry(1, 0.08, 1), lit(C.moss), 0, 0.99));
  for (const [x, z] of [
    [0, 0.5],
    [0, -0.5],
  ] as const)
    group.add(part(new BoxGeometry(0.3, 0.3, 0.02), glow(palette.accent, 1.2), x, 0.5, z));
  return group;
}

/** The floor switch: a stone plate in a brass ring. `pressed` sinks it and lights the ring. */
export function createSwitchPlate(): { readonly group: Group; setPressed(pressed: boolean): void } {
  const group = new Group();
  const ring = part(
    new CylinderGeometry(0.62, 0.62, 0.04, 20),
    lit(C.brass, { metalness: 0.7, roughness: 0.4 }),
    0,
    0.02,
  );
  const plate = part(new CylinderGeometry(0.5, 0.5, 0.1, 20), lit(C.stoneDark), 0, 0.06);
  group.add(ring, plate);
  return {
    group,
    setPressed(pressed: boolean): void {
      plate.position.y = pressed ? 0.025 : 0.06;
      ring.material = pressed
        ? glow(palette.accent, 2)
        : lit(C.brass, { metalness: 0.7, roughness: 0.4 });
    },
  };
}

/** A broadleaf tree: a tapered trunk and three clustered crowns. */
export function createTree(rng: () => number, scale = 1): Group {
  const group = new Group();
  const h = (3.2 + rng() * 1.6) * scale;
  group.add(part(new CylinderGeometry(0.18 * scale, 0.32 * scale, h, 7), lit(C.bark), 0, h / 2));
  for (let i = 0; i < 3; i += 1) {
    const r = (1.1 + rng() * 0.6) * scale;
    const crown = part(
      new IcosahedronGeometry(r, 1),
      lit(i === 0 ? C.leaf : C.leafLight, { flat: true }),
      (rng() - 0.5) * 1.2 * scale,
      h + (rng() - 0.2) * 0.8 * scale,
      (rng() - 0.5) * 1.2 * scale,
    );
    crown.scale.y = 0.8;
    group.add(crown);
  }
  return group;
}

/** A boulder: a squashed dodecahedron with baked facet variation. */
export function createRock(rng: () => number, size: number): Mesh {
  const rock = part(
    mottle(new DodecahedronGeometry(size, 0), 0.25, rng),
    lit(palette.stone, { flat: true, vertexColors: true }),
    0,
    size * 0.45,
  );
  rock.scale.set(1 + rng() * 0.4, 0.6 + rng() * 0.3, 1 + rng() * 0.3);
  rock.rotation.y = rng() * Math.PI;
  return rock;
}

/** One grass tuft: three thin blades. Instanced by the vale, never added one by one. */
export function grassTuft(): BufferGeometry {
  return new ConeGeometry(0.05, 0.38, 3, 1).translate(0, 0.19, 0);
}

/** A signpost: a post and a plank. */
export function createSign(): Group {
  const group = new Group();
  group.add(part(new BoxGeometry(0.1, 1.2, 0.1), lit(C.woodDark), 0, 0.6));
  const board = part(new BoxGeometry(0.9, 0.45, 0.07), lit(C.wood), 0, 1.15, 0.06);
  group.add(board);
  return group;
}

/** A wall torch: a bracket and a flame that is its own light source. */
export function createTorch(): Group {
  const group = new Group();
  group.add(
    part(new CylinderGeometry(0.04, 0.06, 0.4, 6), lit(C.iron, { metalness: 0.6 }), 0, 0, 0),
  );
  group.add(part(new SphereGeometry(0.1, 8, 6), glow(C.ember, 10), 0, 0.27, 0));
  group.add(part(new ConeGeometry(0.07, 0.22, 6), glow(C.lamp, 12), 0, 0.4, 0));
  return group;
}

/** The heart vessel: a faceted red crystal heart that spins and bobs. */
export function createHeartVessel(): Group {
  const group = new Group();
  const crystal = glow(C.heart, 2.5);
  for (const side of [-1, 1])
    group.add(part(new SphereGeometry(0.2, 10, 8), crystal, 0.13 * side, 0.12, 0));
  const point = part(new ConeGeometry(0.31, 0.42, 4), crystal, 0, -0.14, 0);
  point.rotation.x = Math.PI;
  point.rotation.y = Math.PI / 4;
  group.add(point);
  return group;
}

/** The small key: brass bow and bit. */
export function createKey(): Group {
  const group = new Group();
  const brass = glow(palette.accent, 1.5);
  group.add(part(new CylinderGeometry(0.1, 0.1, 0.04, 12), brass, 0, 0.3));
  group.add(part(new BoxGeometry(0.04, 0.32, 0.04), brass, 0, 0.1));
  group.add(part(new BoxGeometry(0.1, 0.05, 0.04), brass, 0.05, -0.03));
  return group;
}
