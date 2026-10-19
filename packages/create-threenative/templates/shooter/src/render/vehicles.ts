// The two vehicles Bayview needs and no CC0 catalogue has: the yellow panel
// van parked in T MAIN and the open fishing boat moored at the B-site pier.
//
// ## Why these are written rather than downloaded
//
// Poly Haven's entire Watercraft category is four colonial sailing ships
// (69k-184k triangles) plus three buoys — a galleon at a modern industrial pier
// is worse than an empty berth. Its whole road-vehicle catalogue is one car
// under a dust cover, which reads as an abandoned garage, not a working street.
// ambientCG's 3D catalogue is 34 items and they are all food. So both props are
// sculpted here from `shapes.ts` primitives against the reference frames.
//
// ## Constraints this file respects
//
//   * `CanvasTexture` samples BLACK under `WebGPURenderer`. Nothing here paints
//     a canvas; every surface is a flat-coloured `MeshStandardMaterial` derived
//     by cloning one the town already owns, and the variety comes from having
//     eight of them rather than from a bitmap.
//   * `flatShading` is never set, because `roundedBox` welds its seams so
//     normals interpolate across them and the two fight.
//   * Every geometry is built ONCE per prop and merged per material, so the van
//     costs eight draw calls and the boat seven however many are placed.
//   * The van is a solid: one simple box collider on the BODY only. Mirrors,
//     bumpers and the number plate are outside it on purpose — a player must
//     never snag on a wing mirror. The boat floats past the playable deck and
//     carries no collider at all.
//
// ## The boat's idle
//
// A hull sitting perfectly still on the sea reads as welded to the water plane,
// so the boat heaves, rolls and pitches on three incommensurate sine periods.
// That is a continuous idle, which `ctx.tween` is the wrong tool for (tween is
// for things that start, run once and finish) — and this file is handed no
// frame callback, so the boat drives itself by overriding `updateMatrixWorld`,
// which the renderer already calls on the whole graph every frame.
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  type Material,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  TorusGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { worldGridUVs } from "./materials.js";
import { roundedBox } from "./shapes.js";
import type { TownMaterials } from "./townMaterials.js";

/** Structurally identical to `TownCollider`; declared here to avoid a cycle. */
export type PropCollider = {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
};

export type VanPlacement = {
  readonly x: number;
  readonly z: number;
  /** Yaw in radians; the van's nose is local +x, so −π/2 points it at +z. */
  readonly yaw: number;
};

export type BoatPlacement = {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** World Y of the sea surface the hull floats on. */
  readonly waterY: number;
  /** Optional pier post to run a painter line to, as [x, y, z]. */
  readonly moorTo?: readonly [number, number, number];
};

// ---------------------------------------------------------------------------
// Batching: one merged mesh per material, per prop
// ---------------------------------------------------------------------------

const ONE = new Vector3(1, 1, 1);

/** A transform for a part, authored in the prop's own local frame. */
function place(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
    ONE,
  );
}

/**
 * Merging demands identical attribute sets and the sources disagree —
 * `roundedBox` deletes its UVs, the lofted hull strips never had any. Bring
 * everything to one shape before it enters a bucket; the zero UVs are harmless
 * because no material in this file reads a map.
 */
function normalised(source: BufferGeometry): BufferGeometry {
  const geometry = source.clone();
  if (!geometry.hasAttribute("uv")) {
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("uv", new Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geometry.index === null ? geometry : geometry.toNonIndexed();
}

class PartBatch {
  readonly #buckets = new Map<Material, BufferGeometry[]>();

  add(material: Material, geometry: BufferGeometry, matrix?: Matrix4): void {
    const part = normalised(geometry);
    if (matrix !== undefined) part.applyMatrix4(matrix);
    const bucket = this.#buckets.get(material);
    if (bucket === undefined) this.#buckets.set(material, [part]);
    else bucket.push(part);
  }

  /** Mirror a part to the other side of the hull / the other flank of the van. */
  addMirrored(material: Material, geometry: BufferGeometry, matrix: Matrix4): void {
    this.add(material, geometry, matrix);
    this.add(material, geometry, new Matrix4().makeScale(1, 1, -1).multiply(matrix));
  }

  flush(group: Group, name: string, castShadow: boolean): Mesh[] {
    const meshes: Mesh[] = [];
    for (const [material, geometries] of this.#buckets) {
      if (geometries.length === 0) continue;
      // World-projected grid: the parts are already placed in the prop's own space, so this
      // is one metre per tile on the van's flank exactly as it is on the wall behind it.
      const geometry = worldGridUVs(mergeGeometries(geometries, false));
      for (const source of geometries) source.dispose();
      const mesh = new Mesh(geometry, material);
      mesh.name = name;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      meshes.push(mesh);
    }
    this.#buckets.clear();
    return meshes;
  }
}

// ---------------------------------------------------------------------------
// Derived materials
// ---------------------------------------------------------------------------

/**
 * Painted steel, glass, rubber and varnished timber, all cloned off surfaces
 * the town already owns so tone mapping and lighting stay consistent with it.
 *
 * These live here rather than in `townMaterials.ts` deliberately: that file
 * builds every surface from a triplanar node graph whose tint is baked into the
 * shader, so a `.clone()` of one cannot be re-coloured from this side. The
 * plain `steel` material is the one honest base to derive flat paint from.
 */
type VehicleMaterials = {
  readonly paint: Material;
  readonly paintShade: Material;
  readonly glass: Material;
  readonly rubber: Material;
  readonly trimDark: Material;
  readonly trimGrey: Material;
  readonly chrome: Material;
  readonly lens: Material;
  readonly pale: Material;
  readonly hullWhite: Material;
  readonly hullDark: Material;
  readonly interior: Material;
  readonly rope: Material;
};

/** Clone a town material and repaint it, falling back if it is not a standard one. */
function tint(
  source: Material,
  colour: number,
  roughness: number,
  metalness: number,
  doubleSided = false,
): MeshStandardMaterial {
  const clone = source.clone();
  const material =
    clone instanceof MeshStandardMaterial
      ? clone
      : new MeshStandardMaterial({ color: colour, roughness, metalness });
  if (material !== clone) clone.dispose();
  material.color.setHex(colour);
  material.roughness = roughness;
  material.metalness = metalness;
  // The lofted hull is an open shell seen from inside and out. DoubleSide keeps
  // it solid from every angle and lets the shader flip the normal on backfaces,
  // so a wrong-handed strip can never come out lit inside-out.
  if (doubleSided) material.side = DoubleSide;
  return material;
}

const CACHE = new WeakMap<TownMaterials, VehicleMaterials>();

function vehicleMaterials(town: TownMaterials): VehicleMaterials {
  const cached = CACHE.get(town);
  if (cached !== undefined) return cached;
  const steel = town.steel;
  const made: VehicleMaterials = {
    // Reference paint is a warm ochre yellow gone slightly chalky in the sun,
    // not a saturated taxi yellow.
    paint: tint(steel, 0xd2a343, 0.46, 0.2),
    paintShade: tint(steel, 0xb08733, 0.52, 0.18),
    glass: tint(steel, 0x171b20, 0.12, 0.16),
    rubber: tint(steel, 0x1a1a1a, 0.94, 0.0),
    trimDark: tint(steel, 0x33363a, 0.62, 0.24),
    trimGrey: tint(steel, 0x8c8c88, 0.62, 0.2),
    chrome: tint(steel, 0xc7cbd0, 0.26, 0.86),
    lens: tint(steel, 0xd5802b, 0.3, 0.12),
    pale: tint(steel, 0xdedad2, 0.44, 0.1),
    hullWhite: tint(steel, 0xdcd6c9, 0.74, 0.02, true),
    hullDark: tint(steel, 0x2f3338, 0.66, 0.06, true),
    interior: tint(steel, 0xa5a598, 0.86, 0.02, true),
    rope: tint(steel, 0xb5a381, 0.95, 0.0),
  };
  CACHE.set(town, made);
  return made;
}

// ---------------------------------------------------------------------------
// The van
// ---------------------------------------------------------------------------

/**
 * Every dimension the silhouette depends on, in metres. A van is recognised
 * from its outline, and the give-aways are the flat slab side, the tall boxy
 * rear and a roof at 2.2 m — just above a 1.78 m soldier's head.
 */
const VAN = {
  nose: 2.18,
  tail: -2.18,
  bumper: 2.3,
  half: 0.95,
  sill: 0.6,
  waist: 1.02,
  roof: 2.2,
  bonnetTop: 1.3,
  cabFront: 1.72,
  frontAxle: 1.42,
  rearAxle: -1.48,
  tyreRadius: 0.33,
  tyreWidth: 0.21,
  track: 0.8,
  archRadius: 0.48,
  archCentre: 0.58,
} as const;

function vanParts(batch: PartBatch, m: VehicleMaterials): void {
  const sideZ = VAN.half + 0.008;

  // Upper body: one slab from the tail to the windscreen base, carrying the
  // roof. Radius 0.10 — real body panels are all softly radiused, and a sharp
  // box here is the single thing that makes a vehicle read as Minecraft.
  batch.add(
    m.paint,
    roundedBox(VAN.cabFront - VAN.tail, VAN.roof - VAN.waist, VAN.half * 2, 0.1),
    place((VAN.tail + VAN.cabFront) / 2, (VAN.waist + VAN.roof) / 2, 0),
  );

  // Sill band, broken into three so the wheel arches are real gaps in the slab
  // side rather than a decal over it.
  const archFront: readonly [number, number] = [
    VAN.frontAxle - VAN.archRadius,
    VAN.frontAxle + VAN.archRadius,
  ];
  const archRear: readonly [number, number] = [
    VAN.rearAxle - VAN.archRadius,
    VAN.rearAxle + VAN.archRadius,
  ];
  const sills: readonly (readonly [number, number])[] = [
    [VAN.tail, archRear[0]],
    [archRear[1], archFront[0]],
    [archFront[1], VAN.nose],
  ];
  for (const [x0, x1] of sills) {
    batch.add(
      m.paint,
      roundedBox(x1 - x0, VAN.waist - VAN.sill, VAN.half * 2, 0.06),
      place((x0 + x1) / 2, (VAN.sill + VAN.waist) / 2, 0),
    );
  }

  // Short bonnet ahead of the windscreen, topping out well below the roof.
  batch.add(
    m.paint,
    roundedBox(VAN.nose - VAN.cabFront, VAN.bonnetTop - VAN.waist, 1.86, 0.08),
    place((VAN.cabFront + VAN.nose) / 2, (VAN.waist + VAN.bonnetTop) / 2, 0),
  );

  // Dark chassis mass behind the wheels: this is what you see through the arch
  // gaps, and it is what gives the van a shadow to sit in rather than on.
  batch.add(m.trimDark, new BoxGeometry(4.1, 0.74, 1.48), place(0, 0.65, 0));

  // Running gear: one tyre and one hub geometry, reused at four transforms.
  const tyre = new CylinderGeometry(VAN.tyreRadius, VAN.tyreRadius, VAN.tyreWidth, 16);
  const hub = new CylinderGeometry(0.195, 0.195, 0.04, 12);
  const arch = new TorusGeometry(VAN.archRadius, 0.042, 5, 14, Math.PI);
  for (const axle of [VAN.frontAxle, VAN.rearAxle]) {
    batch.addMirrored(m.rubber, tyre, place(axle, VAN.tyreRadius, VAN.track, Math.PI / 2));
    batch.addMirrored(m.trimGrey, hub, place(axle, VAN.tyreRadius, 0.912, Math.PI / 2));
    // Flared arch lip: the outline break that stops the side reading as a slab.
    batch.addMirrored(m.paint, arch, place(axle, VAN.archCentre, VAN.half + 0.005));
  }

  // Glazing: dark plates proud of the body, the same trick the town's doors and
  // shutters use. The windscreen is raked 11° so its head sits back under the
  // roof header and its base overhangs the bonnet.
  batch.add(m.glass, new BoxGeometry(0.05, 0.76, 1.74), place(1.79, 1.74, 0, 0, 0, 0.2));
  batch.add(m.trimDark, new BoxGeometry(0.2, 0.12, 1.8), place(1.86, 1.34, 0));
  batch.addMirrored(m.glass, new BoxGeometry(0.84, 0.56, 0.04), place(1.2, 1.76, sideZ));
  batch.addMirrored(m.glass, new BoxGeometry(0.6, 0.42, 0.04), place(0.21, 1.78, sideZ));
  batch.addMirrored(m.glass, new BoxGeometry(0.04, 0.4, 0.62), place(-2.19, 1.82, 0.38));

  // Creases: the shoulder swage under the glass line and a dark rub strip over
  // the sill. Two long horizontals are most of what says "panel van" in profile.
  batch.addMirrored(
    m.paintShade,
    new BoxGeometry(3.86, 0.05, 0.02),
    place(-0.23, 1.46, sideZ + 0.004),
  );
  batch.addMirrored(
    m.trimDark,
    new BoxGeometry(3.86, 0.08, 0.03),
    place(-0.23, 1.18, sideZ + 0.006),
  );

  // Sliding door: leading and trailing shut lines plus the upper track it rides.
  for (const x of [-0.32, 0.74]) {
    batch.addMirrored(
      m.trimDark,
      new BoxGeometry(0.035, 1.14, 0.025),
      place(x, 1.61, sideZ + 0.006),
    );
  }
  batch.addMirrored(
    m.trimDark,
    new BoxGeometry(1.85, 0.05, 0.025),
    place(0.12, 2.06, sideZ + 0.006),
  );
  batch.addMirrored(
    m.trimDark,
    new BoxGeometry(3.86, 0.05, 0.055),
    place(-0.23, 2.14, VAN.half - 0.005),
  );
  for (const x of [0.8, -0.24]) {
    batch.addMirrored(m.chrome, new BoxGeometry(0.03, 0.05, 0.14), place(x, 1.36, sideZ + 0.01));
  }

  // Twin rear doors: a vertical split down the tail and two hinges per leaf.
  batch.add(m.trimDark, new BoxGeometry(0.03, 1.14, 0.04), place(-2.19, 1.61, 0));
  for (const y of [1.18, 2.02]) {
    batch.addMirrored(m.trimDark, new BoxGeometry(0.06, 0.08, 0.1), place(-2.2, y, 0.84));
  }

  // Face: recessed grille, rectangular lamps, amber indicators, low bumper,
  // number plate. None of it is in the collider.
  batch.add(m.trimDark, new BoxGeometry(0.05, 0.28, 1.1), place(2.185, 1.06, 0));
  const slat = new BoxGeometry(0.06, 0.022, 1.04);
  for (const y of [0.97, 1.04, 1.11, 1.18]) batch.add(m.chrome, slat, place(2.2, y, 0));
  batch.addMirrored(m.pale, new BoxGeometry(0.05, 0.18, 0.3), place(2.19, 1.1, 0.7));
  batch.addMirrored(m.lens, new BoxGeometry(0.05, 0.12, 0.11), place(2.19, 1.1, 0.865));
  const bumper = roundedBox(0.14, 0.22, 1.88, 0.05);
  batch.add(m.trimGrey, bumper, place(2.23, 0.6, 0));
  batch.add(m.trimGrey, bumper, place(-2.23, 0.6, 0));
  const plate = new BoxGeometry(0.03, 0.11, 0.5);
  batch.add(m.pale, plate, place(2.305, 0.62, 0));
  batch.add(m.pale, plate, place(-2.305, 0.62, 0));

  // Wing mirrors on stalks. They stand outside the collider so nobody snags on
  // one, and they are the thing that breaks the roof-to-bonnet line.
  batch.addMirrored(
    m.trimDark,
    new CylinderGeometry(0.022, 0.022, 0.14, 6),
    place(1.6, 1.74, 0.99, Math.PI / 2),
  );
  batch.addMirrored(m.trimDark, new BoxGeometry(0.05, 0.24, 0.12), place(1.62, 1.76, 1.08));
}

/**
 * Place a van. Returns its collider: one axis-aligned box around the BODY, not
 * around the mirrors or the bumpers — a bullet stops on the van and a player
 * can hide behind it, but nothing sticks out of the shape they can feel.
 */
export function addVan(
  group: Group,
  hittable: Mesh[],
  materials: TownMaterials,
  at: VanPlacement,
): PropCollider {
  const m = vehicleMaterials(materials);
  const van = new Group();
  van.name = "van";
  const batch = new PartBatch();
  vanParts(batch, m);
  hittable.push(...batch.flush(van, "van", true));
  van.position.set(at.x, 0, at.z);
  van.rotation.y = at.yaw;
  group.add(van);

  const cos = Math.abs(Math.cos(at.yaw));
  const sin = Math.abs(Math.sin(at.yaw));
  const halfX = (VAN.bumper - VAN.tail) / 2;
  const spanX = halfX * cos + VAN.half * sin;
  const spanZ = halfX * sin + VAN.half * cos;
  return {
    min: [at.x - spanX, 0, at.z - spanZ],
    max: [at.x + spanX, VAN.roof, at.z + spanZ],
  };
}

// ---------------------------------------------------------------------------
// The fishing boat
// ---------------------------------------------------------------------------

/**
 * A hull is a loft, not a box. Six plank courses are stacked between a rockered
 * keel line and a sheer line that rises hard at the bow and again at the
 * transom; each course keeps one radius over its whole height, so the step out
 * to the next course is a real lapstrake ledge that catches the sun. That step
 * is the clinker read, and it is why the courses are not blended smooth.
 */
const BOAT = {
  halfLength: 2.25,
  halfBeam: 0.8,
  sheer: 0.46,
  keel: -0.42,
  stations: 22,
  /** Aft cut: the hull stops short of the point and a transom board closes it. */
  stern: -0.97,
} as const;

/** Fraction of the depth each course boundary sits at, keel (0) to sheer (1). */
const COURSE_Y = [0, 0.16, 0.34, 0.52, 0.7, 0.87, 1] as const;
/** Fraction of the beam each course boundary carries; the hull tucks to the keel. */
const COURSE_W = [0.1, 0.4, 0.66, 0.83, 0.93, 0.985, 1] as const;

const tableAt = (table: readonly number[], index: number): number => table[index] ?? 0;

/** Plan-form half-beam at station `u` ∈ [−1, 1]; +1 is the bow. */
function halfBeamAt(u: number): number {
  if (u >= 0) return BOAT.halfBeam * Math.max(0, 1 - u * u * u) ** 0.55;
  return BOAT.halfBeam * (1 - 0.3 * Math.min(1, -u) ** 2.6);
}

/** Sheer line: higher at bow and stern than amidships. */
function sheerAt(u: number): number {
  return BOAT.sheer + 0.24 * Math.max(0, u) ** 2.4 + 0.14 * Math.max(0, -u) ** 2.6;
}

/** Keel line, with rocker lifting both ends clear of the water. */
function keelAt(u: number): number {
  return BOAT.keel + 0.34 * Math.abs(u) ** 2.8;
}

const courseY = (u: number, k: number): number =>
  keelAt(u) + tableAt(COURSE_Y, k) * (sheerAt(u) - keelAt(u));
const courseR = (u: number, k: number): number => halfBeamAt(u) * tableAt(COURSE_W, k);

/** Station parameters from the transom to the stem, bow-dense so the point is clean. */
function stations(): number[] {
  const out: number[] = [];
  for (let index = 0; index <= BOAT.stations; index += 1) {
    out.push(BOAT.stern + (1 - BOAT.stern) * (index / BOAT.stations));
  }
  return out;
}

/**
 * An indexed quad grid over rows × columns of points. `flip` reverses the
 * winding for the port side, whose mirrored coordinates reverse handedness.
 */
function grid(rows: readonly (readonly Vector3[])[], flip: boolean): BufferGeometry {
  const first = rows[0];
  const cols = first === undefined ? 0 : first.length;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const row of rows) {
    for (const point of row) positions.push(point.x, point.y, point.z);
  }
  for (let r = 0; r + 1 < rows.length; r += 1) {
    for (let c = 0; c + 1 < cols; c += 1) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + c + 1;
      if (flip) indices.push(a, d, b, b, d, e);
      else indices.push(a, b, d, b, e, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hullParts(batch: PartBatch, m: VehicleMaterials): void {
  const us = stations();
  const x = (u: number): number => u * BOAT.halfLength;
  // Dark antifouling on the courses that meet the water, white topsides above,
  // one varnished sheer strake under the cap rail.
  const skin = [m.hullDark, m.hullDark, m.hullDark, m.hullWhite, m.hullWhite, m.interior];

  for (let k = 0; k < 6; k += 1) {
    const material = skin[k] ?? m.hullWhite;
    for (const side of [1, -1]) {
      const flip = side < 0;
      // Plank face: one radius over the whole course height.
      batch.add(
        material,
        grid(
          [
            us.map((u) => new Vector3(x(u), courseY(u, k), side * courseR(u, k + 1))),
            us.map((u) => new Vector3(x(u), courseY(u, k + 1), side * courseR(u, k + 1))),
          ],
          flip,
        ),
      );
      // The lap: a horizontal ledge stepping out to this course from the last.
      batch.add(
        material,
        grid(
          [
            us.map((u) => new Vector3(x(u), courseY(u, k), side * courseR(u, k))),
            us.map((u) => new Vector3(x(u), courseY(u, k), side * courseR(u, k + 1))),
          ],
          !flip,
        ),
      );
    }
  }

  // Keel panel closing the bottom between the two garboard courses.
  batch.add(
    m.hullDark,
    grid(
      [
        us.map((u) => new Vector3(x(u), courseY(u, 0), -courseR(u, 0))),
        us.map((u) => new Vector3(x(u), courseY(u, 0), courseR(u, 0))),
      ],
      false,
    ),
  );

  // Transom: a flat board across the aft section outline, raked slightly aft.
  const aft = BOAT.stern;
  batch.add(
    m.hullWhite,
    grid(
      COURSE_Y.map((_, k) => [
        new Vector3(x(aft) - 0.05, courseY(aft, k), -courseR(aft, k)),
        new Vector3(x(aft) - 0.05, courseY(aft, k), courseR(aft, k)),
      ]),
      false,
    ),
  );

  // Pale interior liner from the floor to just under the rail, wound inward so
  // looking down from the pier shows a boat with an inside, not a shell.
  const floor = (u: number): number => courseY(u, 2) + 0.02;
  for (const side of [1, -1]) {
    batch.add(
      m.interior,
      grid(
        [
          us.map((u) => new Vector3(x(u), floor(u), side * courseR(u, 3) * 0.96)),
          us.map((u) => new Vector3(x(u), sheerAt(u) - 0.03, side * courseR(u, 6) * 0.95)),
        ],
        side > 0,
      ),
    );
  }
  batch.add(
    m.interior,
    grid(
      [
        us.map((u) => new Vector3(x(u), floor(u), -courseR(u, 3) * 0.96)),
        us.map((u) => new Vector3(x(u), floor(u), courseR(u, 3) * 0.96)),
      ],
      true,
    ),
  );

  // Varnished cap rail following the sheer all round: a top ribbon plus an
  // outer and an inner face, so it reads as a real capping from any angle.
  for (const side of [1, -1]) {
    const flip = side < 0;
    const outer = (u: number): number => side * (courseR(u, 6) + 0.035);
    const inner = (u: number): number => side * (courseR(u, 6) - 0.075);
    const top = (u: number): number => sheerAt(u) + 0.03;
    batch.add(
      m.hullWhite,
      grid(
        [
          us.map((u) => new Vector3(x(u), top(u), inner(u))),
          us.map((u) => new Vector3(x(u), top(u), outer(u))),
        ],
        !flip,
      ),
    );
    batch.add(
      m.hullWhite,
      grid(
        [
          us.map((u) => new Vector3(x(u), top(u) - 0.09, outer(u))),
          us.map((u) => new Vector3(x(u), top(u), outer(u))),
        ],
        flip,
      ),
    );
  }
}

function boatDressing(batch: PartBatch, m: VehicleMaterials, timber: Material): void {
  const x = (u: number): number => u * BOAT.halfLength;

  // Stem post: covers the point where the courses converge, and gives the bow
  // the vertical accent the reference has above the sheer.
  batch.add(m.hullWhite, roundedBox(0.12, 0.46, 0.1, 0.04), place(2.13, 0.62, 0, 0, 0, -0.16));

  // Three thwarts sunk below the gunwale, each with a knee at either end.
  const knee = new BoxGeometry(0.16, 0.14, 0.05);
  for (const u of [0.42, 0, -0.46]) {
    const beam = halfBeamAt(u) * 1.92;
    const y = sheerAt(u) - 0.15;
    batch.add(timber, new BoxGeometry(0.26, 0.05, beam), place(x(u), y, 0));
    batch.addMirrored(timber, knee, place(x(u), y - 0.08, beam / 2 - 0.06));
  }

  // Two oars stowed diagonally, looms over the gunwale, blades across the bow.
  const loom = new CylinderGeometry(0.026, 0.032, 2.2, 7);
  const blade = new BoxGeometry(0.5, 0.02, 0.13);
  for (const side of [1, -1]) {
    const lean = side * 0.14;
    batch.add(timber, loom, place(-0.35, 0.24, side * 0.4, 0, lean, -Math.PI / 2));
    batch.add(timber, blade, place(0.9, 0.25, side * 0.24, 0, lean, 0));
  }

  // A coil of mooring line forward and two fish crates aft.
  batch.add(m.rope, new TorusGeometry(0.15, 0.042, 5, 14), place(1.35, -0.03, 0.12, Math.PI / 2));
  const crate = roundedBox(0.44, 0.28, 0.3, 0.03);
  batch.add(timber, crate, place(-1.28, 0.02, 0.24, 0, 0.18, 0));
  batch.add(timber, crate, place(-1.36, 0.02, -0.22, 0, -0.1, 0));

  // Small clamp-on outboard hanging off the transom, its leg under the water.
  batch.add(m.trimDark, roundedBox(0.26, 0.3, 0.24, 0.05), place(-2.34, 0.36, 0));
  batch.add(m.trimDark, new BoxGeometry(0.1, 0.6, 0.08), place(-2.36, -0.03, 0));
  batch.add(
    m.trimGrey,
    new CylinderGeometry(0.02, 0.02, 0.42, 6),
    place(-2.16, 0.36, 0.16, 0, 0, Math.PI / 2 - 0.25),
  );
}

/**
 * One shared clock for every hull afloat. `THREE.Clock` is deprecated and
 * `performance` is browser-only, so this is the same guarded `now()` three
 * itself uses — which keeps the boat working on the DOM-less native target.
 */
const NOW = typeof performance === "undefined" ? Date : performance;
const SEA_EPOCH = NOW.now();
const seaSeconds = (): number => (NOW.now() - SEA_EPOCH) / 1000;

/**
 * Heave, roll and pitch on three periods that never line up, so the loop never
 * becomes visible. Driven from `updateMatrixWorld` because this file is handed
 * no frame callback and the renderer already walks the graph every frame; the
 * motion is continuous, which is exactly what `ctx.tween` is NOT for.
 */
function driftOnTheSwell(boat: Group, baseY: number, phase: number): void {
  boat.updateMatrixWorld = (force?: boolean): void => {
    const t = seaSeconds() + phase;
    boat.position.y = baseY + Math.sin(t * 2.64) * 0.035;
    boat.rotation.x = Math.sin(t * 1.95) * 0.037;
    boat.rotation.z = Math.sin(t * 1.44) * 0.021;
    Object3D.prototype.updateMatrixWorld.call(boat, force);
  };
}

/**
 * Place a moored fishing boat. No collider: it floats past the playable deck,
 * and a bullet or a footstep must never meet it.
 */
export function addFishingBoat(group: Group, materials: TownMaterials, at: BoatPlacement): Group {
  const m = vehicleMaterials(materials);
  const boat = new Group();
  boat.name = "fishing-boat";
  const batch = new PartBatch();
  hullParts(batch, m);
  boatDressing(batch, m, materials.deckWood);
  batch.flush(boat, "boat", true);
  boat.position.set(at.x, at.waterY, at.z);
  boat.rotation.y = at.yaw;
  group.add(boat);
  driftOnTheSwell(boat, at.waterY, at.x * 0.31 + at.z * 0.17);

  // Painter line from the stem to a pier post, drawn in world space so its
  // fixed end stays put while the hull moves under it.
  const post = at.moorTo;
  if (post !== undefined) {
    const stem = new Vector3(2.1, 0.45, 0)
      .applyEuler(new Euler(0, at.yaw, 0))
      .add(new Vector3(at.x, at.waterY, at.z));
    const target = new Vector3(post[0], post[1], post[2]);
    const span = target.clone().sub(stem);
    const rope = new Mesh(new CylinderGeometry(0.022, 0.022, span.length(), 5), m.rope);
    rope.name = "boat-painter";
    rope.position.copy(stem).add(span.clone().multiplyScalar(0.5));
    rope.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), span.clone().normalize());
    // A little sag: rope is not a tensioned cable.
    rope.position.y -= MathUtils.clamp(span.length() * 0.06, 0, 0.12);
    group.add(rope);
  }
  return boat;
}
