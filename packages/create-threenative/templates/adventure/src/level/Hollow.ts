import { BoxGeometry, Group, IcosahedronGeometry, Mesh, type PointLight, Vector3 } from "three";
import { instanced } from "../render/foliage.js";
import { torch } from "../render/lighting.js";
import { lit, mottle, worldMaterials } from "../render/materials.js";
import { C } from "../render/palette.js";
import { createTorch } from "../render/props.js";
import { surfaced } from "../render/surface.js";

/** The Hollow is built 100 m east of the clearing; the cave mouth carries Wren between them. */
export const HOLLOW_X = 100;

export interface IHollow {
  readonly group: Group;
  readonly torches: readonly PointLight[];
  /** Where Wren arrives from the cave mouth, and respawns until she passes the locked door. */
  readonly entry: Vector3;
  /** Walking into this point leads back out to the clearing. */
  readonly exit: Vector3;
  readonly guards: readonly Vector3[];
  readonly flickers: readonly Vector3[];
  readonly thornbacks: readonly { readonly at: Vector3; readonly yaw: number }[];
  readonly block: Vector3;
  readonly switchAt: Vector3;
  readonly grate: { readonly at: Vector3; readonly yaw: number; readonly width: number };
  readonly keyChest: { readonly at: Vector3; readonly yaw: number };
  readonly lockedDoor: { readonly at: Vector3; readonly width: number };
  /** Where Wren respawns once the locked door is behind her. */
  readonly bossCheckpoint: Vector3;
  readonly warden: Vector3;
  /** True when a point is inside the Hollow's footprint (the zone the slower run speed covers). */
  contains(point: Vector3): boolean;
}

/**
 * The Moss Hollow: three rooms in a line running north, under one ceiling.
 *
 * - Guard room (z 0 to -12): a Mossling, a Flicker and a Thornback.
 * - Block room (z -12 to -26): the push block two cells south of the floor switch, which sits
 *   against the north wall; the grate on the east wall over the alcove with the small-key chest;
 *   the locked door in the north wall.
 * - Warden room (z -26 to -44): 16 m by 18 m of open floor for the Stone Warden to charge across.
 *
 * Grid cells are 1 m with integer centres, so the block lands exactly on the switch.
 */
export function buildHollow(rng: () => number): IHollow {
  const X = HOLLOW_X;
  const group = new Group();
  group.name = "hollow";
  const materials = worldMaterials();
  const wallMaterial = surfaced(C.stoneDark, "stone-wall", { flat: true, vertexColors: true });
  const box = (
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    y0: number,
    y1: number,
    material = wallMaterial,
  ): Mesh => {
    const w = x1 - x0;
    const h = y1 - y0;
    const d = z1 - z0;
    const segments = (n: number): number => Math.max(1, Math.min(10, Math.round(n / 1.2)));
    const geometry = mottle(
      new BoxGeometry(w, h, d, segments(w), segments(h), segments(d)),
      0.24,
      rng,
    );
    geometry.translate(X + (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const mesh = new Mesh(geometry, material);
    mesh.userData.solid = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const H = 5;
  /** Walls run up into the ceiling slab, so no seam between them lets light through. */
  const TOP = H + 0.3;
  // Floor and ceiling. Coordinates below are relative to X. The floor slab is the collider; what
  // Wren sees is a bed of flagstones (below) on dark grout just under it.
  box(-10, 12, -46, 4, -1, 0, materials.stone).visible = false;
  box(-10, 12, -46, 4, H, H + 0.6);
  // Entrance tunnel, and the guard room's south wall around its doorway.
  box(-2.5, -1.5, 0, 3.5, 0, TOP);
  box(1.5, 2.5, 0, 3.5, 0, TOP);
  box(-2.5, 2.5, 3.5, 4.5, 0, TOP);
  box(-7, -1.5, -0.5, 0.5, 0, TOP);
  box(1.5, 7, -0.5, 0.5, 0, TOP);
  // Guard room sides.
  box(-7, -6, -12.5, 0.5, 0, TOP);
  box(6, 7, -12.5, 0.5, 0, TOP);
  // Wall between the guard room and the block room, open in the middle.
  box(-7, -1.5, -12.5, -11.5, 0, TOP);
  box(1.5, 7, -12.5, -11.5, 0, TOP);
  // Block room sides; the east side is open over the alcove (z -20 to -16).
  box(-7, -6, -26.5, -12.5, 0, TOP);
  box(6, 7, -16, -12.5, 0, TOP);
  box(6, 7, -26.5, -20, 0, TOP);
  // The alcove behind the grate.
  box(7, 11, -16, -15, 0, TOP);
  box(7, 11, -21, -20, 0, TOP);
  box(10, 11, -20, -16, 0, TOP);
  box(6, 7, -20, -16, 3, TOP);
  // North wall of the block room, the locked door's frame in it (x 0 to 2), and its lintel.
  box(-9, 0, -26.5, -25.5, 0, TOP);
  box(2, 9, -26.5, -25.5, 0, TOP);
  box(0, 2, -26.5, -25.5, 3, TOP);
  // Warden room.
  box(-9, -8, -45, -26.5, 0, TOP);
  box(8, 9, -45, -26.5, 0, TOP);
  box(-9, 9, -45, -44, 0, TOP);

  // Torches: each a flame mesh and a short-range point light.
  const torches: PointLight[] = [];
  const sconce = (x: number, z: number, yaw: number): void => {
    const flame = createTorch();
    flame.position.set(X + x, 2.4, z);
    flame.rotation.z = yaw;
    group.add(flame);
    const light = torch();
    light.position.set(X + x, 2.9, z);
    group.add(light);
    torches.push(light);
  };
  sconce(-5.6, -6, 0);
  sconce(5.6, -6, 0);
  sconce(-5.6, -19, 0);
  sconce(5.6, -23, 0);
  sconce(9.6, -18, 0);
  sconce(-2, -25, 0);
  sconce(4, -25, 0);
  sconce(-7.6, -33, 0);
  sconce(7.6, -33, 0);
  sconce(-7.6, -41, 0);
  sconce(7.6, -41, 0);

  // The flagstone floor: 1 m slabs in three shades, each a little off the grid, on dark grout,
  // and hairline cracks across some of them. Four draws for the whole Hollow.
  const grout = new Mesh(new BoxGeometry(22, 0.1, 50).translate(X + 1, -0.052, -21), lit(C.grout));
  grout.receiveShadow = true;
  group.add(grout);
  const shades: [number, number, number, number, number, number, number, number, number][][] = [
    [],
    [],
    [],
  ];
  const cracks: [number, number, number, number, number, number, number, number, number][] = [];
  for (let x = -10; x < 12; x += 1) {
    for (let z = -46; z < 4; z += 1) {
      const cx = X + x + 0.5 + (rng() - 0.5) * 0.04;
      const cz = z + 0.5 + (rng() - 0.5) * 0.04;
      shades[Math.floor(rng() * 3)]?.push([
        cx,
        -0.012,
        cz,
        0.94,
        1,
        0.94,
        0,
        (rng() - 0.5) * 0.04,
        0,
      ]);
      if (rng() < 0.12)
        cracks.push([
          cx + (rng() - 0.5) * 0.4,
          0.0135,
          cz + (rng() - 0.5) * 0.4,
          1,
          1,
          0.3 + rng() * 0.5,
          0,
          rng() * Math.PI,
          0,
        ]);
    }
  }
  const slab = new BoxGeometry(1, 0.05, 1);
  [C.flagstone, C.flagstoneDark, C.flagstoneLight].forEach((shade, i) => {
    group.add(instanced(slab, surfaced(shade, "rock", { flat: true }), shades[i] ?? [], false));
  });
  group.add(instanced(new BoxGeometry(0.025, 0.004, 1), lit(C.grout), cracks, false));

  // Moss mounds at the foot of the walls: soft raised cushions in two greens, not flat paint.
  const mounds: [number, number, number, number, number, number, number, number, number][][] = [
    [],
    [],
  ];
  for (let i = 0; i < 46; i += 1) {
    const room = rng();
    const z = -1 - room * 42;
    const wall = z < -26.5 ? 7.4 : 5.4;
    const s = 0.35 + rng() * 0.5;
    mounds[i % 2]?.push([
      X + (rng() < 0.5 ? -wall : wall) + (rng() - 0.5) * 0.5,
      0,
      z,
      s * (1.2 + rng()),
      s * (0.3 + rng() * 0.25),
      s * (0.9 + rng() * 0.6),
      0,
      rng() * Math.PI,
      0,
    ]);
  }
  const cushion = new IcosahedronGeometry(1, 1);
  group.add(
    instanced(cushion, lit(C.moss, { flat: true }), mounds[0] ?? [], false),
    instanced(cushion, lit(C.mossLight, { flat: true }), mounds[1] ?? [], false),
  );

  return {
    block: new Vector3(X - 3, 0, -23),
    bossCheckpoint: new Vector3(X + 1, 0, -28),
    contains: (point) => point.x > X - 15 && point.x < X + 15,
    entry: new Vector3(X, 0, -2),
    exit: new Vector3(X, 0, 2.6),
    grate: { at: new Vector3(X + 6.5, 0, -18), width: 4, yaw: Math.PI / 2 },
    group,
    guards: [new Vector3(X + 2, 0, -8)],
    flickers: [new Vector3(X - 4, 0, -5)],
    thornbacks: [{ at: new Vector3(X + 4, 0, -9), yaw: -Math.PI / 2 }],
    keyChest: { at: new Vector3(X + 8.6, 0, -18), yaw: -Math.PI / 2 },
    lockedDoor: { at: new Vector3(X + 1, 0, -26), width: 2 },
    switchAt: new Vector3(X - 3, 0, -25),
    torches,
    warden: new Vector3(X, 0, -38),
  };
}
