// Generated for you. The temple's meshes, built from the grid in `src/level.ts`.
//
// The level is a grid of sectors, each with a floor and a ceiling height, so the whole room set is
// four merged meshes: floors, walls, the water plane, nothing else. The simulation never touches
// these meshes: it reads the grid. Edit the grid, not this builder.
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial } from "three";
import { cellCeiling, cellFloor, COLUMNS, OPEN, ROWS, SOLID, WATER } from "../level.js";
import { CLICK, SECTOR, UNIT } from "../tuning.js";
import { floorMaterial, structureMaterial, worldGridUVs } from "./materials.js";

/** World metres of the grid's centre, so the temple sits around the origin the light is aimed at. */
const CENTRE_X = (COLUMNS * SECTOR) / 2;
const CENTRE_Z = (ROWS * SECTOR) / 2;

/** A unit-space point as scene metres. */
export function toWorld(x: number, y: number, z: number): [number, number, number] {
  return [(x - CENTRE_X) * UNIT, y * UNIT, (z - CENTRE_Z) * UNIT];
}

/** Walls that bound open air stand this tall, so the rooms read as rooms. */
const WALL_TOP = 26 * CLICK;
/** A low ceiling is the underside of a block this thick, so water and sky stay outside it. */
const SLAB = 5 * CLICK;

class Faces {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly #index: number[] = [];

  /** One quad from four corners in unit space, wound counter-clockwise seen from `normal`. */
  quad(
    corners: readonly [number, number, number][],
    normal: readonly [number, number, number],
  ): void {
    const start = this.positions.length / 3;
    for (const [x, y, z] of corners) {
      this.positions.push(...toWorld(x, y, z));
      this.normals.push(...normal);
    }
    this.#index.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(this.normals, 3));
    geometry.setIndex(this.#index);
    return worldGridUVs(geometry);
  }
}

const NEIGHBOURS = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
] as const;

/** The vertical quad on one side of a cell between two heights, facing into the cell. */
function sideQuad(
  faces: Faces,
  cx: number,
  cz: number,
  side: number,
  low: number,
  high: number,
): void {
  const x0 = cx * SECTOR;
  const x1 = x0 + SECTOR;
  const z0 = cz * SECTOR;
  const z1 = z0 + SECTOR;
  // Wound so the face looks into the cell it belongs to.
  if (side === 0)
    faces.quad(
      [
        [x1, low, z1],
        [x0, low, z1],
        [x0, high, z1],
        [x1, high, z1],
      ],
      [0, 0, -1],
    );
  else if (side === 1)
    faces.quad(
      [
        [x1, low, z0],
        [x1, low, z1],
        [x1, high, z1],
        [x1, high, z0],
      ],
      [-1, 0, 0],
    );
  else if (side === 2)
    faces.quad(
      [
        [x0, low, z0],
        [x1, low, z0],
        [x1, high, z0],
        [x0, high, z0],
      ],
      [0, 0, 1],
    );
  else
    faces.quad(
      [
        [x0, low, z1],
        [x0, low, z0],
        [x0, high, z0],
        [x0, high, z1],
      ],
      [1, 0, 0],
    );
}

export interface ITemple {
  readonly group: Group;
}

export function createTemple(): ITemple {
  const floors = new Faces();
  const walls = new Faces();
  for (let cz = 0; cz < ROWS; cz += 1)
    for (let cx = 0; cx < COLUMNS; cx += 1) {
      const floor = cellFloor(cx, cz);
      if (floor >= SOLID) continue;
      const ceiling = cellCeiling(cx, cz);
      const x0 = cx * SECTOR;
      const z0 = cz * SECTOR;
      floors.quad(
        [
          [x0, floor, z0],
          [x0, floor, z0 + SECTOR],
          [x0 + SECTOR, floor, z0 + SECTOR],
          [x0 + SECTOR, floor, z0],
        ],
        [0, 1, 0],
      );
      if (ceiling < OPEN) {
        // The underside of a low block, so the grab and the hang have something to be under.
        walls.quad(
          [
            [x0, ceiling, z0],
            [x0 + SECTOR, ceiling, z0],
            [x0 + SECTOR, ceiling, z0 + SECTOR],
            [x0, ceiling, z0 + SECTOR],
          ],
          [0, -1, 0],
        );
        walls.quad(
          [
            [x0, ceiling + SLAB, z0],
            [x0, ceiling + SLAB, z0 + SECTOR],
            [x0 + SECTOR, ceiling + SLAB, z0 + SECTOR],
            [x0 + SECTOR, ceiling + SLAB, z0],
          ],
          [0, 1, 0],
        );
      }
      for (const [side, [dx, dz]] of NEIGHBOURS.entries()) {
        const nx = cx + dx;
        const nz = cz + dz;
        const nFloor = cellFloor(nx, nz);
        const nCeiling = cellCeiling(nx, nz);
        // Below a neighbour that stands higher, this side is the neighbour's wall.
        if (nFloor > floor)
          sideQuad(walls, cx, cz, side, floor, nFloor >= SOLID ? WALL_TOP : nFloor);
        // The low block's open face: from its underside up to the top of its slab.
        if (ceiling < OPEN && nFloor < SOLID && nCeiling > ceiling)
          sideQuad(walls, cx, cz, side, ceiling, ceiling + SLAB);
      }
    }

  const group = new Group();
  group.name = "temple";
  const make = (faces: Faces, material: MeshStandardMaterial, name: string): void => {
    const mesh = new Mesh(faces.geometry(), material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  make(floors, floorMaterial, "temple-floors");
  make(walls, structureMaterial, "temple-walls");

  // The water: one plane over its cells, drawn after the rest and never written to depth.
  const water = new Faces();
  const { x0, x1, z0, z1, level } = WATER;
  const wx0 = x0 * SECTOR;
  const wx1 = (x1 + 1) * SECTOR;
  const wz0 = z0 * SECTOR;
  const wz1 = (z1 + 1) * SECTOR;
  water.quad(
    [
      [wx0, level, wz0],
      [wx0, level, wz1],
      [wx1, level, wz1],
      [wx1, level, wz0],
    ],
    [0, 1, 0],
  );
  const surface = new Mesh(
    water.geometry(),
    new MeshStandardMaterial({
      color: 0x4fa6c8,
      depthWrite: false,
      opacity: 0.55,
      roughness: 0.15,
      transparent: true,
    }),
  );
  surface.name = "water";
  surface.renderOrder = 2;
  group.add(surface);
  return { group };
}
