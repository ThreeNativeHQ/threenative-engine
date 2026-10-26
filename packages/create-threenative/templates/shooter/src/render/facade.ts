// Bayview's building faces. `town.ts` owns where the blocks stand; this file
// owns what a wall looks like once you are standing in front of it.
//
// The reference frames are not white boxes with blue rectangles painted on
// them. Every opening is a hole with thickness: a near-black reveal sunk into
// the wall, a proud stone surround (jambs, lintel, sill) around it, and the
// leaf sitting well back behind that surround so the sun cuts a hard line down
// one jamb. Three extra boxes per opening buy all of it, and the shadow in the
// reveal is most of the effect — a door drawn flush on the plaster reads as a
// decal from every angle a player can reach.
//
// Four rules this file lives under:
//
//  1. `CanvasTexture` samples BLACK under `WebGPURenderer`, so nothing here is
//     ever painted procedurally. Corrugated roller doors are modelled as real
//     ribs, the painted dado is a real proud band, and variety comes from
//     alternating palette entries.
//  2. Determinism: every placement is driven by `hash(seed)`, never
//     `Math.random()`, so a replay renders identically.
//  3. Budget: facade detail multiplies by ~50 lane faces. Every piece is a
//     mesh in the town group, and `collapseTown` merges the whole town into ONE
//     mesh per material at the end, so the whole town's joinery costs tens of
//     draw calls rather than the ~900 individual meshes it would otherwise be.
//  4. Dressing never gets a collider. The batch's meshes go into `hittable`
//     (a bullet stops on a door, as before) but no `TownCollider` is emitted
//     for any of it — a proud window sill must never be something a player
//     snags on.
//
// The one thing here that is not dressing is `addArchGateway`: the round-headed
// passages through a building are the most identity-bearing piece of
// architecture in the reference set, so those are real solids with real
// colliders on their piers and on the mass over the opening.
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  type Group,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Path,
  Shape,
  ShapeGeometry,
} from "three";
import { worldGridUVs } from "./materials.js";
import { roundedBox } from "./shapes.js";
import type { TownCollider } from "./town.js";
import type { TownMaterials } from "./townMaterials.js";

export type Face = "n" | "s" | "e" | "w";

export const FACE_NORMAL: Record<Face, readonly [number, number]> = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
};
export const FACE_INDEX: Record<Face, number> = { n: 0, s: 1, e: 2, w: 3 };

/** Deterministic layout hash: identical across runs, so replays match. */
const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * The part of a building this file needs. Structurally satisfied by `town.ts`'s
 * `BuildingSpec`, which carries the layout fields as well.
 */
export type FacadeSpec = {
  readonly x: readonly [number, number];
  readonly z: readonly [number, number];
  readonly h: number;
  readonly brick?: boolean;
  readonly tank?: boolean;
  readonly mast?: boolean;
  readonly ac?: boolean;
  readonly top?: { readonly i: number; readonly h: number };
};

/** Ground-floor door leaf, and the standard window light. */
export const DOOR = { w: 1.18, h: 2.35, d: 0.07 };
export const WINDOW = { w: 0.92, h: 1.3 };

/** How far a surround stands proud of the plaster: this is the shadow line. */
const RELIEF = 0.22;
/** Width of a jamb batten either side of an opening. */
const JAMB = 0.15;
/** Depth of the reveal panel's front face; everything that fills an opening
 *  sits in front of this and behind `RELIEF`, so it is genuinely recessed. */
const REVEAL_FACE = 0.07;
/** Floor-to-floor height, so upper windows line up storey by storey. */
const STOREY = 3.05;

/**
 * `townMaterials.ts` is owned elsewhere; a corrugated-steel material may or may
 * not exist there yet. Read it through this widening so the code compiles
 * either way and picks the real thing up the moment it lands.
 */
type WithRoller = TownMaterials & { readonly rollerSteel?: Material };

/**
 * Materials that belong to the facade rather than to the town's surfaces:
 * untextured, palette-driven, and built per scene so a `ctx.goto` rebuild never
 * hands the new scene a disposed material.
 */
type FacadeMaterials = {
  /** Near-black interior of every reveal; this is what sells the depth. */
  readonly reveal: Material;
  /** Wrought iron: balusters, window grilles, drainpipes, lamp brackets. */
  readonly iron: Material;
  /** The bulb inside a wall lamp. */
  readonly lampGlow: Material;
  /** Painted blue-grey dado along the foot of a lane wall. */
  readonly dado: Material;
  /** Weathered timber: double doors, awning frames, header boards. */
  readonly timber: Material;
  /** Sun-bleached stone: sills, steps, coping courses. */
  readonly stone: Material;
  /** Corrugated roller shutters — the town's own steel when it exists. */
  readonly roller: Material;
  /** Window glass: dark, but a mirror of the sky rather than a hole. */
  readonly glass: Material;
};

function createFacadeMaterials(materials: TownMaterials): FacadeMaterials {
  return {
    // Not pure black: a dead-black hole reads as a missing polygon. This sits
    // roughly two stops under the deepest plaster shadow, which is where an
    // unlit room behind an unglazed opening actually lands.
    reveal: new MeshStandardMaterial({ color: 0x322b24, roughness: 0.96 }),
    // Dark enough to read as ironwork against whitewash, light enough that a
    // downpipe does not become a black bar down the middle of a wall.
    iron: new MeshStandardMaterial({ color: 0x484e55, roughness: 0.5, metalness: 0.45 }),
    lampGlow: new MeshStandardMaterial({
      color: 0xffe6b8,
      emissive: 0xffbe62,
      emissiveIntensity: 1.9,
      roughness: 0.35,
    }),
    // The dado is painted render, not plastic: it reads `dadoBand` from
    // townMaterials, world-projected off the same field as the wall behind it.
    dado: materials.dadoBand,
    timber: new MeshStandardMaterial({ color: 0x6d4c33, roughness: 0.82, metalness: 0.03 }),
    stone: new MeshStandardMaterial({ color: 0xded6c4, roughness: 0.9, metalness: 0.01 }),
    roller: (materials as WithRoller).rollerSteel ?? materials.shutter,
    // An unglazed opening renders as a flat black rectangle, which reads as a
    // hole punched in card rather than as a window. Low roughness and some
    // metalness make the pane pick up the sky gradient instead, so the opening
    // has a value inside it even in full shade.
    glass: new MeshStandardMaterial({
      color: 0x2f4250,
      roughness: 0.16,
      metalness: 0.55,
    }),
  };
}

/**
 * Every facade piece is its own mesh until the scene merges the whole town per
 * material (`collapseTown`): ~900 small meshes cost a few dozen draw calls.
 * Each piece is already in world space by `put`, so `worldGridUVs` is honest
 * here: one grid tile is one metre on every wall, trim and shutter in the town,
 * however the face was authored and however big the building is.
 */
class FacadeBatch {
  readonly #group: Group;
  readonly #hittable: Mesh[];

  constructor(group: Group, hittable: Mesh[]) {
    this.#group = group;
    this.#hittable = hittable;
  }

  /** `hit` puts the piece in the raycast set: doors stop bullets, trim does not. */
  push(material: Material, geometry: BufferGeometry, hit: boolean): void {
    const mesh = new Mesh(worldGridUVs(geometry), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.#group.add(mesh);
    if (hit) this.#hittable.push(mesh);
  }
}

/**
 * A piece of our own to transform: `roundedBox` hands back a cached geometry
 * shared with every other caller. `worldGridUVs` writes the UVs once the piece
 * is placed.
 */
function normalised(source: BufferGeometry): BufferGeometry {
  return source.clone();
}

export type Facade = {
  readonly group: Group;
  readonly hittable: Mesh[];
  readonly colliders: TownCollider[];
  readonly materials: TownMaterials;
  readonly extra: FacadeMaterials;
  readonly batch: FacadeBatch;
  /** Every block in town, so a face can be tested for being on show. */
  readonly blocks: readonly FacadeSpec[];
};

export function createFacade(
  group: Group,
  hittable: Mesh[],
  colliders: TownCollider[],
  materials: TownMaterials,
  blocks: readonly FacadeSpec[],
): Facade {
  return {
    group,
    hittable,
    colliders,
    materials,
    extra: createFacadeMaterials(materials),
    batch: new FacadeBatch(group, hittable),
    blocks,
  };
}

/** Half the playable deck; a face out here looks out of the world. See TOWN_HALF. */
const MAP_HALF = 42;

/**
 * Which faces of a block a player can actually see.
 *
 * The hand-written `j:` lists in `town.ts` name the faces someone judged to be
 * lane-facing, and they miss several walls that a player stands right next to —
 * the whole east side of the T-spawn courtyard was a blank white box because of
 * one absent letter. Rather than second-guess that data, this derives the
 * answer: a face is on show unless a neighbouring block abuts it along most of
 * its length and stands tall enough to bury it, or unless it faces off the edge
 * of the map. The `j:` list is unioned in, so nothing that was dressed before
 * stops being dressed.
 */
export function visibleFaces(facade: Facade, spec: FacadeSpec, declared: readonly Face[]): Face[] {
  const faces: Face[] = [];
  for (const face of ["n", "s", "e", "w"] as const) {
    if (declared.includes(face)) {
      faces.push(face);
      continue;
    }
    const [nx, nz] = FACE_NORMAL[face];
    const onX = nx !== 0;
    const plane = onX ? (nx < 0 ? spec.x[0] : spec.x[1]) : nz < 0 ? spec.z[0] : spec.z[1];
    if (Math.abs(plane) >= MAP_HALF - 0.01) continue;
    const from = onX ? spec.z[0] : spec.x[0];
    const to = onX ? spec.z[1] : spec.x[1];
    let buried = 0;
    for (const other of facade.blocks) {
      if (other === spec) continue;
      // Only a block whose own opposing face sits on this plane can bury it.
      const meeting = onX ? (nx < 0 ? other.x[1] : other.x[0]) : nz < 0 ? other.z[1] : other.z[0];
      if (Math.abs(meeting - plane) > 0.06) continue;
      // A neighbour barely more than half this height still leaves wall on show.
      if (other.h < spec.h * 0.6) continue;
      const low = Math.max(from, onX ? other.z[0] : other.x[0]);
      const high = Math.min(to, onX ? other.z[1] : other.x[1]);
      if (high - low > 0.05) buried += high - low;
    }
    if (buried < (to - from) * 0.6) faces.push(face);
  }
  return faces;
}

// ---------------------------------------------------------------------------
// Face-local placement
// ---------------------------------------------------------------------------

/**
 * A frame pinned to one building face: local +x runs along the wall, +y is up,
 * +z points out of the wall into the street, and the origin sits on the wall
 * surface at street level. Every opening below is authored in these coordinates
 * and never has to know which compass face it landed on.
 */
type Wall = {
  readonly matrix: Matrix4;
  /** Face width in metres. */
  readonly span: number;
  readonly seed: number;
  readonly facade: Facade;
};

function wallOf(facade: Facade, spec: FacadeSpec, face: Face, seed: number): Wall {
  const [x0, x1] = spec.x;
  const [z0, z1] = spec.z;
  const [nx, nz] = FACE_NORMAL[face];
  const onX = nx !== 0;
  const px = onX ? (nx < 0 ? x0 : x1) : (x0 + x1) / 2;
  const pz = onX ? (z0 + z1) / 2 : nz < 0 ? z0 : z1;
  const matrix = new Matrix4().makeRotationY(Math.atan2(nx, nz));
  matrix.setPosition(px, 0, pz);
  return { matrix, span: onX ? z1 - z0 : x1 - x0, seed, facade };
}

/** The same wall, lifted to a setback storey's floor. */
function raise(wall: Wall, y: number): Wall {
  return { ...wall, matrix: new Matrix4().setPosition(0, y, 0).multiply(wall.matrix) };
}

type PutOptions = {
  /** In the raycast set — bullets stop here. Trim and mouldings should not be. */
  readonly hit?: boolean;
  /** Roll about the face normal, for a shutter hanging off its hinge. */
  readonly roll?: number;
  /** Pitch about the wall's own horizontal, for an awning's fall. */
  readonly pitch?: number;
  /** Corner radius; only worth paying for on pieces big enough to read. */
  readonly soft?: number;
};

function place(at: readonly [number, number, number], options: PutOptions): Matrix4 {
  const local = new Matrix4().makeRotationZ(options.roll ?? 0);
  if (options.pitch !== undefined) {
    local.multiply(new Matrix4().makeRotationX(options.pitch));
  }
  local.setPosition(at[0], at[1], at[2]);
  return local;
}

/** One box in wall-local coordinates. */
function put(
  wall: Wall,
  material: Material,
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  options: PutOptions = {},
): void {
  const source =
    options.soft === undefined
      ? new BoxGeometry(size[0], size[1], size[2])
      : roundedBox(size[0], size[1], size[2], options.soft, 2);
  const geometry = normalised(source);
  // `roundedBox` hands back a cached geometry shared with every other caller;
  // only the throwaway boxes are ours to dispose.
  if (options.soft === undefined) source.dispose();
  geometry.applyMatrix4(place(at, options).premultiply(wall.matrix));
  wall.facade.batch.push(material, geometry, options.hit ?? false);
}

/** One cylinder in wall-local coordinates, axis along local +y unless pitched. */
function putTube(
  wall: Wall,
  material: Material,
  radius: number,
  length: number,
  at: readonly [number, number, number],
  segments = 6,
  pitch = 0,
): void {
  const source = new CylinderGeometry(radius, radius, length, segments, 1);
  const geometry = normalised(source);
  source.dispose();
  geometry.applyMatrix4(place(at, { pitch }).premultiply(wall.matrix));
  wall.facade.batch.push(material, geometry, false);
}

// ---------------------------------------------------------------------------
// The opening: a reveal, a surround, and whatever fills it
// ---------------------------------------------------------------------------

type OpeningOptions = {
  /** Stone sill course under the opening — windows have one, doors do not. */
  readonly sill?: boolean;
  /** Extra depth for the head, so a lintel over a wide opening reads heavier. */
  readonly lintel?: number;
};

/**
 * The boxes that turn a painted rectangle into a hole: a near-black reveal
 * panel oversized past the opening on every side, then jambs and a head
 * standing `RELIEF` proud of the plaster so the sun throws a hard line down one
 * side. Everything that fills an opening goes in front of the reveal face and
 * behind the surround's front, which is what makes it read as set back.
 */
function addOpening(
  wall: Wall,
  cx: number,
  sillY: number,
  w: number,
  h: number,
  options: OpeningOptions = {},
): void {
  const { extra, materials } = wall.facade;
  const trim = materials.plasterTrim;

  // Reveal: the dark box the opening looks into. Oversized so a hairline of
  // shadow survives at the edges even when the surround is foreshortened.
  put(wall, extra.reveal, [w + 0.09, h + 0.09, REVEAL_FACE], [cx, sillY + h / 2, REVEAL_FACE / 2]);

  // Jambs either side, standing proud.
  for (const side of [-1, 1]) {
    put(
      wall,
      trim,
      [JAMB, h + 0.16, RELIEF],
      [cx + side * (w / 2 + JAMB / 2 + 0.02), sillY + h / 2 + 0.02, RELIEF / 2],
    );
  }

  // Head: a lintel across the top, slightly deeper than the jambs so it reads
  // as bearing on them, plus a thin dark course under it for the shadow gap.
  const headDepth = RELIEF + (options.lintel ?? 0.03);
  put(wall, trim, [w + JAMB * 2 + 0.22, 0.19, headDepth], [cx, sillY + h + 0.155, headDepth / 2]);
  put(wall, extra.reveal, [w + 0.09, 0.05, 0.13], [cx, sillY + h + 0.04, 0.065]);

  if (options.sill === true) {
    // A stone sill projects further than anything else on the wall: it is the
    // horizontal that catches the key light and separates storey from storey.
    const depth = RELIEF + 0.08;
    put(
      wall,
      extra.stone,
      [w + JAMB * 2 + 0.34, 0.12, depth],
      [cx, sillY - 0.06, depth / 2 - 0.01],
    );
    put(wall, trim, [w + JAMB * 2 + 0.2, 0.08, 0.07], [cx, sillY - 0.16, 0.035]);
  }
}

/** Panelled leaves inside an opening: one or two, timber or painted. */
function addLeaves(
  wall: Wall,
  material: Material,
  cx: number,
  sillY: number,
  w: number,
  h: number,
  leaves: number,
): void {
  const { extra } = wall.facade;
  const leafW = (w - (leaves - 1) * 0.04) / leaves;
  const front = 0.075;
  const faceZ = front + DOOR.d / 2;
  for (let leaf = 0; leaf < leaves; leaf += 1) {
    const lx = cx - w / 2 + leafW / 2 + leaf * (leafW + 0.04);
    put(wall, material, [leafW, h, DOOR.d], [lx, sillY + h / 2, front], { hit: true, soft: 0.025 });
    // Raised panels, not sunken black ones. A dark plate on a door reads as a
    // hole straight through it; a panel standing 12 mm proud of the leaf with a
    // shadow line under its head reads as joinery, and costs the same two boxes.
    for (const share of [0.26, 0.73]) {
      put(wall, material, [leafW - 0.2, h * 0.29, 0.014], [lx, sillY + h * share, faceZ + 0.005]);
      put(
        wall,
        extra.reveal,
        [leafW - 0.2, 0.022, 0.016],
        [lx, sillY + h * share + h * 0.145, faceZ + 0.004],
      );
    }
    put(wall, material, [leafW, 0.09, DOOR.d + 0.02], [lx, sillY + h * 0.49, front]);
    // Handle on the meeting stile.
    const inward = leaves === 1 ? 1 : leaf === 0 ? 1 : -1;
    putTube(
      wall,
      extra.iron,
      0.028,
      0.12,
      [lx + inward * (leafW / 2 - 0.12), sillY + h * 0.46, faceZ + 0.06],
      6,
      Math.PI / 2,
    );
  }
}

/** Corrugated roller shutter: real ribs, because a painted one samples black. */
function addRoller(wall: Wall, cx: number, w: number, h: number): void {
  const { extra, materials } = wall.facade;
  const ribs = Math.max(11, Math.round(w / 0.19));
  const ribW = w / ribs;
  for (let rib = 0; rib < ribs; rib += 1) {
    const proud = rib % 2 === 1;
    put(
      wall,
      extra.roller,
      [ribW * 1.02, h, proud ? 0.09 : 0.05],
      [cx - w / 2 + ribW * (rib + 0.5), h / 2, proud ? 0.09 : 0.075],
      { hit: true },
    );
  }
  // Roller housing above the opening, and the closing rail at the floor.
  put(wall, materials.steelPost, [w + 0.16, 0.24, 0.2], [cx, h + 0.14, 0.11], { soft: 0.05 });
  put(wall, materials.steelPost, [w + 0.04, 0.1, 0.14], [cx, 0.05, 0.09]);
}

/**
 * The sash inside an opening: a painted frame, a mullion, a transom and four
 * panes. Without it the reveal is just a black rectangle — this is the single
 * biggest difference between a window and a hole in the reference frames.
 */
function addSash(wall: Wall, cx: number, sillY: number, w: number, h: number): void {
  const { extra, materials } = wall.facade;
  // Three boxes, not seven: the reveal already oversizes the opening by 45 mm
  // on every side, so that dark border reads as the outer frame and a modelled
  // one would be hidden behind the jambs. Multiplied by ~700 windows, the four
  // boxes it saves are worth more than the frame nobody can see.
  const front = 0.075;
  put(wall, extra.glass, [w - 0.06, h - 0.06, 0.03], [cx, sillY + h / 2, front]);
  put(wall, materials.shutter, [0.05, h - 0.04, 0.05], [cx, sillY + h / 2, front + 0.014]);
  put(wall, materials.shutter, [w - 0.06, 0.05, 0.05], [cx, sillY + h * 0.52, front + 0.014]);
}

type WindowKind = "shuttersOpen" | "shuttersShut" | "dark" | "grille" | "broken";

function windowKind(seed: number): WindowKind {
  const roll = hash(seed);
  if (roll < 0.32) return "shuttersOpen";
  if (roll < 0.53) return "shuttersShut";
  if (roll < 0.74) return "dark";
  if (roll < 0.9) return "grille";
  return "broken";
}

/**
 * A window: sill, lintel, and one of five deterministic fills. The dark ones
 * matter as much as the shuttered ones — the reference facades are mostly
 * unglazed holes, and a wall of identical blue shutters reads as wallpaper.
 */
function addWindow(wall: Wall, cx: number, sillY: number, seed: number): void {
  const { extra, materials } = wall.facade;
  const w = WINDOW.w;
  const h = WINDOW.h;
  addOpening(wall, cx, sillY, w, h, { sill: true });

  const kind = windowKind(seed);
  const leafW = w / 2 - 0.02;
  // Everything except a genuinely empty opening is glazed.
  if (kind !== "dark") addSash(wall, cx, sillY, w, h);
  switch (kind) {
    case "shuttersOpen":
    case "broken": {
      // Folded flat against the wall outside the jambs, where they throw their
      // own shadow across the plaster.
      const foldX = w / 2 + JAMB + leafW / 2 + 0.03;
      const hanging = kind === "broken";
      for (const side of [-1, 1]) {
        if (hanging && side > 0 && hash(seed + 3) > 0.5) continue; // one gone entirely
        const roll = hanging && side < 0 ? side * 0.17 : 0;
        put(
          wall,
          materials.shutter,
          [leafW, h * 0.98, 0.05],
          [cx + side * foldX, sillY + h / 2, 0.105],
          {
            hit: true,
            roll,
          },
        );
        for (const share of [0.32, 0.68]) {
          put(
            wall,
            extra.reveal,
            [leafW - 0.08, 0.022, 0.012],
            [cx + side * foldX, sillY + h * share, 0.136],
            { roll },
          );
        }
      }
      break;
    }
    case "shuttersShut":
      for (const side of [-1, 1]) {
        const lx = cx + side * (leafW / 2 + 0.015);
        put(wall, materials.shutter, [leafW, h * 0.98, 0.05], [lx, sillY + h / 2, 0.105], {
          hit: true,
        });
        for (const share of [0.28, 0.52, 0.76]) {
          put(wall, extra.reveal, [leafW - 0.07, 0.022, 0.012], [lx, sillY + h * share, 0.136]);
        }
      }
      break;
    case "grille":
      for (let bar = 0; bar < 4; bar += 1) {
        putTube(wall, extra.iron, 0.017, h - 0.06, [
          cx - w / 2 + (w * (bar + 0.5)) / 4,
          sillY + h / 2,
          0.1,
        ]);
      }
      put(wall, extra.iron, [w - 0.04, 0.028, 0.028], [cx, sillY + h * 0.55, 0.1]);
      break;
    case "dark":
      // Deliberately unglazed, the way half the openings in the references are:
      // a broken-out frame around a dark room, with the sash gone.
      for (const side of [-1, 1]) {
        put(
          wall,
          materials.shutter,
          [0.06, h, 0.05],
          [cx + side * (w / 2 - 0.03), sillY + h / 2, 0.085],
        );
      }
      put(wall, materials.shutter, [w, 0.055, 0.05], [cx, sillY + h - 0.03, 0.085]);
      put(wall, extra.stone, [w, 0.05, 0.06], [cx, sillY + 0.02, 0.09]);
      break;
  }
}

/** A door: reveal, surround, a stone step out into the lane, and its leaves. */
function addDoor(wall: Wall, cx: number, seed: number): void {
  const { extra, materials } = wall.facade;
  const wide = hash(seed + 61) > 0.62;
  const w = wide ? DOOR.w * 1.7 : DOOR.w;
  const h = wide ? DOOR.h * 1.06 : DOOR.h;
  addOpening(wall, cx, 0.05, w, h, { lintel: 0.05 });

  // Two shallow stone steps ground the door in the street.
  put(wall, extra.stone, [w + 0.7, 0.11, 0.5], [cx, 0.055, 0.22]);
  put(wall, extra.stone, [w + 0.42, 0.06, 0.32], [cx, 0.14, 0.15]);

  const timber = hash(seed + 23) > 0.62;
  addLeaves(
    wall,
    timber ? extra.timber : materials.doorBlue,
    cx,
    0.05,
    w,
    h,
    wide || hash(seed + 29) > 0.45 ? 2 : 1,
  );

  // A fanlight over some doors: a small dark light under the lintel.
  if (hash(seed + 31) > 0.6) {
    put(wall, extra.reveal, [w - 0.12, 0.26, 0.04], [cx, h + 0.03, REVEAL_FACE / 2]);
    put(wall, materials.shutter, [w - 0.12, 0.035, 0.05], [cx, h + 0.03, 0.09]);
  }
}

/**
 * Wall lamp: a bent iron bracket, a shade and a bulb. The CONNECTOR and CATWALK
 * reference frames both have one, and at this scale it costs four boxes for a
 * warm point of interest in a wall of white.
 */
function addWallLamp(wall: Wall, cx: number, y: number): void {
  const { extra } = wall.facade;
  put(wall, extra.iron, [0.05, 0.05, 0.3], [cx, y, 0.15]);
  put(wall, extra.iron, [0.05, 0.18, 0.05], [cx, y - 0.09, 0.27]);
  put(wall, extra.iron, [0.28, 0.07, 0.28], [cx, y - 0.21, 0.27], { soft: 0.03 });
  put(wall, extra.lampGlow, [0.16, 0.16, 0.16], [cx, y - 0.3, 0.27], { soft: 0.06 });
}

/** Cast-iron downpipe from a hopper at the parapet to a gully at the pavement. */
function addDrainpipe(wall: Wall, cx: number, height: number): void {
  const { extra } = wall.facade;
  putTube(wall, extra.iron, 0.055, height - 0.25, [cx, (height - 0.25) / 2, 0.085], 6);
  for (const y of [0.9, height * 0.55, height - 0.85]) {
    put(wall, extra.iron, [0.17, 0.05, 0.05], [cx, y, 0.055]);
  }
  put(wall, extra.iron, [0.21, 0.26, 0.17], [cx, height - 0.2, 0.09], { soft: 0.03 });
}

/** Air-con box on a bracket, the way every upper wall in the references has one. */
function addWallUnit(wall: Wall, cx: number, y: number): void {
  const { extra, materials } = wall.facade;
  put(wall, materials.steelPost, [0.72, 0.5, 0.34], [cx, y, 0.2], { soft: 0.04 });
  for (let slat = 0; slat < 4; slat += 1) {
    put(wall, extra.reveal, [0.6, 0.03, 0.02], [cx, y - 0.16 + slat * 0.1, 0.375]);
  }
  for (const side of [-1, 1]) {
    put(wall, extra.iron, [0.05, 0.05, 0.2], [cx + side * 0.3, y - 0.28, 0.11]);
  }
}

/** Satellite dish: a tilted disc on a short arm, cheap and very legible. */
function addDish(wall: Wall, cx: number, y: number): void {
  const { extra, materials } = wall.facade;
  put(wall, extra.iron, [0.05, 0.05, 0.26], [cx, y, 0.13]);
  putTube(wall, materials.plasterTrim, 0.3, 0.06, [cx, y + 0.08, 0.3], 12, Math.PI / 2 - 0.5);
  put(wall, extra.iron, [0.04, 0.17, 0.04], [cx, y + 0.02, 0.43]);
}

/**
 * Painted dado along the foot of a lane wall. Every ground-level wall in the
 * CT SPAWN and T MAIN frames carries one, and it is the single cheapest thing
 * that stops a white block reading as a white block. `gap` leaves a stretch
 * unpainted, for a wall with a passage through it.
 */
function addDado(wall: Wall, span: number, gap?: readonly [number, number]): void {
  const { extra } = wall.facade;
  const height = 1.22 + hash(wall.seed + 91) * 0.16;
  const runs: readonly (readonly [number, number])[] =
    gap === undefined
      ? [[-span / 2 + 0.03, span / 2 - 0.03]]
      : [
          [-span / 2 + 0.03, gap[0]],
          [gap[1], span / 2 - 0.03],
        ];
  for (const [from, to] of runs) {
    const width = to - from;
    if (width < 0.2) continue;
    put(wall, extra.dado, [width, height, 0.035], [(from + to) / 2, height / 2, 0.018]);
    // Capping batten: a hard line where paint meets plaster, with a shadow
    // under it. Without this the band reads as a flat sticker.
    put(wall, extra.stone, [width, 0.07, 0.06], [(from + to) / 2, height + 0.02, 0.03]);
  }
}

// ---------------------------------------------------------------------------
// Arches
// ---------------------------------------------------------------------------

/**
 * A round-headed arch outline: straight jambs to the springing line, then a
 * semicircular head. Closed at the base, so an outer outline with an inner one
 * punched out of it yields two proud jambs plus the arch band — an archivolt —
 * in a single extrusion.
 */
function archOutline(radius: number, springing: number, into: Shape | Path): void {
  into.moveTo(-radius, 0);
  into.lineTo(-radius, springing);
  into.absarc(0, springing, radius, Math.PI, 0, true);
  into.lineTo(radius, 0);
  into.closePath();
}

function archShape(radius: number, springing: number): Shape {
  const shape = new Shape();
  archOutline(radius, springing, shape);
  return shape;
}

function archHole(radius: number, springing: number): Path {
  const path = new Path();
  archOutline(radius, springing, path);
  return path;
}

/** The proud moulded band that follows an arch's jambs and head. */
function addArchivolt(
  wall: Wall,
  cx: number,
  radius: number,
  springing: number,
  width: number,
  depth: number,
  material: Material,
): void {
  const band = archShape(radius + width, springing);
  band.holes.push(archHole(radius, springing));
  const ring = normalised(
    new ExtrudeGeometry(band, { depth, bevelEnabled: false, curveSegments: 14 }),
  );
  ring.applyMatrix4(new Matrix4().setPosition(cx, 0, 0).premultiply(wall.matrix));
  wall.facade.batch.push(material, ring, false);
}

/**
 * A blind arched recess in a wall: the arcade motif without touching
 * navigation. Reads as an arched passage from any distance a player stands at,
 * and costs one shape, one ring and two boxes.
 */
function addArchNiche(wall: Wall, cx: number, width: number, height: number): void {
  const { extra, materials } = wall.facade;
  const radius = width / 2;
  const springing = Math.max(0.7, height - radius);

  const back = normalised(new ShapeGeometry(archShape(radius, springing), 14));
  back.applyMatrix4(new Matrix4().setPosition(cx, 0, 0.05).premultiply(wall.matrix));
  wall.facade.batch.push(extra.reveal, back, false);

  addArchivolt(wall, cx, radius, springing, 0.17, RELIEF, materials.plasterTrim);
  put(wall, extra.stone, [0.3, 0.34, RELIEF + 0.05], [cx, springing + radius - 0.02, RELIEF / 2]);
  put(wall, extra.stone, [width + 0.3, 0.09, 0.5], [cx, 0.045, 0.22]);
}

export type ArchGateway = {
  readonly x: readonly [number, number];
  readonly z: readonly [number, number];
  readonly height: number;
  /** Axis the wall face spans: "x" for a wall seen from ±z, "z" for ±x. */
  readonly along: "x" | "z";
  readonly openWidth: number;
  readonly openHeight: number;
};

/**
 * A real round-headed passage through a building — the CONNECTOR frame, and the
 * single most identity-bearing thing in the reference set. Unlike everything
 * else in this file it is a solid: the two piers and the mass over the opening
 * get colliders, the opening itself does not, so a player and a soldier both
 * walk straight through it. The extrusion's hole walls become the intrados, so
 * the passage is genuinely vaulted rather than a hole in a card.
 */
export function addArchGateway(facade: Facade, options: ArchGateway): void {
  const { materials, extra } = facade;
  const [x0, x1] = options.x;
  const [z0, z1] = options.z;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const alongX = options.along === "x";
  const span = alongX ? x1 - x0 : z1 - z0;
  const thickness = alongX ? z1 - z0 : x1 - x0;
  const height = options.height;
  const radius = options.openWidth / 2;
  const springing = options.openHeight - radius;

  const wallShape = new Shape();
  wallShape.moveTo(-span / 2, 0);
  wallShape.lineTo(span / 2, 0);
  wallShape.lineTo(span / 2, height);
  wallShape.lineTo(-span / 2, height);
  wallShape.closePath();
  wallShape.holes.push(archHole(radius, springing));
  const pierced = new ExtrudeGeometry(wallShape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 16,
  });
  // ExtrudeGeometry lays UVs out in world metres; the plaster variants tile
  // every 5 m, so scale them to match the buildings either side.
  const uv = pierced.getAttribute("uv");
  for (let index = 0; index < uv.count; index += 1) {
    uv.setXY(index, uv.getX(index) * 0.2, uv.getY(index) * 0.2);
  }
  uv.needsUpdate = true;
  const frame = new Matrix4().makeRotationY(alongX ? 0 : Math.PI / 2);
  frame.setPosition(alongX ? cx : x0, 0, alongX ? z0 : cz);
  pierced.applyMatrix4(frame);
  const mesh = new Mesh(pierced, materials.plaster(5));
  mesh.name = "arch-gateway";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  facade.group.add(mesh);
  facade.hittable.push(mesh);

  // Colliders: the two piers full height, and the mass over the opening from
  // the crown up. Nothing across the passage itself.
  if (alongX) {
    facade.colliders.push({ min: [x0, 0, z0], max: [cx - radius, height, z1] });
    facade.colliders.push({ min: [cx + radius, 0, z0], max: [x1, height, z1] });
    facade.colliders.push({
      min: [cx - radius, options.openHeight, z0],
      max: [cx + radius, height, z1],
    });
  } else {
    facade.colliders.push({ min: [x0, 0, z0], max: [x1, height, cz - radius] });
    facade.colliders.push({ min: [x0, 0, cz + radius], max: [x1, height, z1] });
    facade.colliders.push({
      min: [x0, options.openHeight, cz - radius],
      max: [x1, height, cz + radius],
    });
  }

  // Dress both faces: archivolt, keystone, coping course, a lamp on one pier
  // and the dado carried across the piers but not across the passage.
  const spec: FacadeSpec = { x: options.x, z: options.z, h: height };
  const faces = alongX ? (["n", "s"] as const) : (["e", "w"] as const);
  for (const face of faces) {
    const wall = wallOf(facade, spec, face, Math.round(cx * 7 + cz * 13) + FACE_INDEX[face]);
    addArchivolt(wall, 0, radius, springing, 0.2, 0.15, materials.plasterTrim);
    put(wall, extra.stone, [0.38, 0.44, 0.24], [0, springing + radius - 0.05, 0.12]);
    put(wall, materials.plasterTrim, [span + 0.2, 0.36, 0.22], [0, height - 0.18, 0.1]);
    put(wall, extra.stone, [span + 0.5, 0.12, 0.34], [0, height + 0.06, 0.15]);
    addWallLamp(wall, -span / 2 + 0.6, options.openHeight - 0.4);
    addDado(wall, span, [-radius - 0.05, radius + 0.05]);
  }
}

/**
 * Where the arched passages go.
 *
 * Both sit in lanes that are already flanked by buildings on either side, and
 * both were placed against `town.ts`'s five patrol routes rather than by eye:
 * no route segment enters either footprint, and the nearest route to an arch
 * pier passes 1.1 m clear of it. That constraint is the reason there are two
 * rather than five — the connector proper is crossed diagonally by the mid
 * defender's loop with under 20 cm to spare, so it takes a blind arch instead.
 *
 * Each footprint is inset 4 cm from its neighbouring building so no two faces
 * end up coplanar; that neighbour's own joinery then falls inside the arch's
 * pier, hidden rather than fighting for the same pixels.
 */
export const BAYVIEW_ARCHES: readonly ArchGateway[] = [
  // South corridor, the T-spawn ↔ outside-long artery: fills the 6 m gap
  // between the two x 15…30 blocks, so the lane runs through a real arch.
  {
    x: [19.2, 21.8],
    z: [26.04, 31.96],
    height: 6,
    along: "z",
    openWidth: 3.9,
    openHeight: 4,
  },
  // Outside long, north end: spans the 7 m waterfront lane between the B-site
  // block and the east perimeter. The waterfront rover walks through the
  // opening 1.1 m clear of the east pier.
  {
    x: [30.04, 36.96],
    z: [21.5, 24.1],
    height: 6,
    along: "x",
    openWidth: 4.4,
    openHeight: 4.4,
  },
];

// ---------------------------------------------------------------------------
// The whole face
// ---------------------------------------------------------------------------

/**
 * Everything a lane-facing wall gets: a painted dado, ground-floor doors and
 * roller shutters, storey-by-storey windows on their sills, a balcony, an
 * awning, a lamp, a drainpipe and the odd air-con box or dish. Placement runs
 * off a fixed coordinate hash, so replays render identically.
 */
export function addDoorsAndShutters(
  facade: Facade,
  spec: FacadeSpec,
  face: Face,
  seed: number,
): void {
  const wall = wallOf(facade, spec, face, seed);
  const span = wall.span;
  if (span < 3.4) return;
  const half = span / 2;
  const margin = 1.4;
  const usable = span - margin * 2;

  if (hash(seed + 91) > 0.34) addDado(wall, span);

  // --- ground floor ---------------------------------------------------------
  const taken: { x: number; w: number }[] = [];
  const clear = (x: number, w: number): boolean =>
    taken.every((other) => Math.abs(other.x - x) > (other.w + w) / 2 + 0.7);

  // A roller/garage shutter on the wider faces: the blue corrugated doors that
  // dominate CT SPAWN and T MAIN.
  if (span >= 8.5 && hash(seed + 5) > 0.42) {
    const rollerW = 2.7;
    const rollerH = Math.min(3.05, spec.h - 1.6);
    const rx = -half + 1.8 + (span - 3.6 - rollerW) * (0.15 + hash(seed + 9) * 0.55);
    addOpening(wall, rx, 0.03, rollerW, rollerH, { lintel: 0.09 });
    addRoller(wall, rx, rollerW, rollerH);
    if (hash(seed + 11) > 0.5) {
      // Flat steel canopy on two braces, as over the garages in the reference.
      put(wall, facade.materials.steelPost, [rollerW + 0.8, 0.07, 0.8], [rx, rollerH + 0.55, 0.42]);
      for (const side of [-1, 1]) {
        put(
          wall,
          facade.extra.iron,
          [0.05, 0.5, 0.05],
          [rx + side * (rollerW / 2 + 0.22), rollerH + 0.3, 0.6],
          { roll: side * 0.6 },
        );
      }
    }
    taken.push({ x: rx, w: rollerW + 0.6 });
  }

  const doors = span >= 12 ? 3 : span >= 7 && hash(seed) > 0.3 ? 2 : 1;
  for (let index = 0; index < doors; index += 1) {
    const dx = -half + margin + usable * ((index + 0.25 + hash(seed + index * 3) * 0.5) / doors);
    if (!clear(dx, DOOR.w * 1.7)) continue;
    addDoor(wall, dx, seed + index * 17);
    taken.push({ x: dx, w: DOOR.w * 1.7 });
    if (index === 0 && hash(seed + 41) > 0.5) addAwning(wall, dx, seed);
    else if (hash(seed + 43) > 0.5) addWallLamp(wall, dx + 1.05, DOOR.h + 0.75);
  }

  // Small ground-floor lights between the doors. Their sills clear the dado's
  // capping batten, or the batten would run straight across the opening.
  const lights = span >= 11 ? 3 : span >= 6.5 ? 1 : 0;
  for (let light = 0; light < lights; light += 1) {
    const gx =
      -half + margin + usable * ((light + 0.35 + hash(seed + 19 + light * 7) * 0.3) / lights);
    if (!clear(gx, WINDOW.w + JAMB * 2)) continue;
    addWindow(wall, gx, 1.6, seed + 200 + light * 23);
    taken.push({ x: gx, w: WINDOW.w + JAMB * 2 });
  }

  // A blind arch on the taller, longer faces: the arcade motif, everywhere.
  if (span >= 9 && spec.h >= 6 && hash(seed + 47) > 0.5) {
    const ax = -half + 2.2 + (span - 4.4 - 2.9) * hash(seed + 49);
    if (clear(ax, 2.9)) {
      addArchNiche(wall, ax, 2.5, 3.3);
      taken.push({ x: ax, w: 2.9 });
    }
  }

  // --- upper storeys --------------------------------------------------------
  const storeys = Math.max(1, Math.floor((spec.h - 1.4) / STOREY));
  const perStorey = Math.max(1, Math.min(6, Math.round(span / 3.4)));
  let balconied = false;
  let banded = false;
  for (let storey = 1; storey <= storeys; storey += 1) {
    const floorY = storey * STOREY - 0.35;
    // A 5 m block does not fit a 3.05 m storey plus a sill plus a head, and
    // dropping its window band left several walls blank from dado to parapet.
    // Where the grid does not fit, hang the band off the roofline instead.
    const gridded = floorY + 0.8 + WINDOW.h + 0.35 <= spec.h;
    const sillY = gridded ? floorY + 0.8 : spec.h - WINDOW.h - 0.95;
    if (!gridded && (storey > 1 || sillY < 2.2)) break;
    banded = true;
    for (let index = 0; index < perStorey; index += 1) {
      const slot = -half + margin + (usable * (index + 0.5)) / perStorey;
      const jitter = (hash(seed + storey * 71 + index * 13) - 0.5) * 0.5;
      const cx = Math.max(-half + 1, Math.min(half - 1, slot + jitter));
      const here = seed * 3 + storey * 101 + index * 37;

      // One window per face becomes a balcony door, with its balcony under it.
      if (!balconied && storey === 1 && spec.h >= 6 && span >= 5 && hash(here + 13) > 0.55) {
        addOpening(wall, cx, floorY, DOOR.w, 2.05, { lintel: 0.04 });
        addLeaves(wall, facade.materials.doorBlue, cx, floorY, DOOR.w, 2.05, 2);
        addBalcony(wall, cx, floorY - 0.07);
        balconied = true;
        continue;
      }
      addWindow(wall, cx, sillY, here);
    }
    if (!gridded) break;
  }
  void banded;

  // --- fittings -------------------------------------------------------------
  if (span >= 4.5) addDrainpipe(wall, hash(seed + 53) > 0.5 ? -half + 0.34 : half - 0.34, spec.h);
  if (spec.ac === true || hash(seed + 59) > 0.68) {
    addWallUnit(wall, -half + margin + usable * (0.2 + hash(seed + 63) * 0.6), spec.h - 1.5);
  }
  if (spec.h >= 6 && hash(seed + 67) > 0.72) {
    addDish(wall, -half + margin + usable * (0.15 + hash(seed + 71) * 0.7), spec.h - 0.9);
  }
}

/**
 * Canvas on a frame: a header board, a sloping deck in five bands so a striped
 * one really alternates, two iron struts, a front bar and a scalloped valance
 * hanging off it. Never a painted texture.
 */
function addAwning(wall: Wall, cx: number, seed: number): void {
  const { extra, materials } = wall.facade;
  const width = 2.3;
  const reach = 1.2;
  const drop = 0.42;
  const top = DOOR.h + 0.68;
  const striped = hash(seed + 57) > 0.45;
  const slope = Math.hypot(reach, drop);
  const pitch = Math.atan2(drop, reach);
  const midY = top - drop / 2;
  const midZ = reach / 2 + 0.06;

  put(wall, extra.timber, [width + 0.16, 0.15, 0.1], [cx, top + 0.06, 0.06]);

  const bands = 5;
  const bandW = width / bands;
  for (let band = 0; band < bands; band += 1) {
    const material = striped && band % 2 === 1 ? materials.awningStripe : materials.awningCanvas;
    // Bands overlap slightly so no gap opens along the fall, and alternate
    // bands sit 3 mm apart in depth so the overlapping side faces are never
    // coplanar — from directly under an awning they dither if they are.
    put(
      wall,
      material,
      [bandW + 0.02, 0.05, slope],
      [cx - width / 2 + bandW * (band + 0.5), midY, midZ + (band % 2) * 0.003],
      { pitch },
    );
  }
  // Iron struts under the canvas, back to the wall.
  for (const side of [-1, 1]) {
    put(
      wall,
      extra.iron,
      [0.05, 0.05, slope],
      [cx + side * (width / 2 - 0.08), midY - 0.06, midZ],
      {
        pitch,
      },
    );
  }
  // Front bar and the valance hanging from it, scalloped by alternating drop.
  put(wall, extra.timber, [width + 0.12, 0.08, 0.08], [cx, top - drop, reach + 0.06]);
  const scallops = 7;
  for (let index = 0; index < scallops; index += 1) {
    const material = striped && index % 2 === 1 ? materials.awningStripe : materials.awningCanvas;
    const depth = index % 2 === 0 ? 0.26 : 0.18;
    put(
      wall,
      material,
      [width / scallops - 0.015, depth, 0.035],
      [
        cx - width / 2 + (width * (index + 0.5)) / scallops,
        top - drop - depth / 2 - 0.04,
        reach + 0.06,
      ],
    );
  }
}

/**
 * Iron balcony: a stone slab on two corbels, thin balusters between a bottom
 * rail and a top rail, and heavier newels at the corners. The reference
 * balconies read as bars against a bright wall, so the bars stay thin and there
 * are enough of them to hold the line.
 */
function addBalcony(wall: Wall, cx: number, y: number): void {
  const { extra, materials } = wall.facade;
  const width = 2.4;
  const reach = 0.92;
  const railH = 0.94;
  const railZ = reach - 0.07;

  put(wall, extra.stone, [width, 0.12, reach], [cx, y, reach / 2], { soft: 0.03 });
  put(wall, materials.plasterTrim, [width + 0.14, 0.06, reach + 0.07], [cx, y + 0.08, reach / 2]);
  for (const side of [-1, 1]) {
    put(
      wall,
      materials.plasterTrim,
      [0.17, 0.32, 0.44],
      [cx + side * (width / 2 - 0.18), y - 0.22, 0.22],
    );
  }

  const bars = 11;
  for (let bar = 0; bar < bars; bar += 1) {
    const bx = cx - width / 2 + 0.1 + ((width - 0.2) * bar) / (bars - 1);
    putTube(wall, extra.iron, 0.02, railH, [bx, y + railH / 2 + 0.07, railZ]);
  }
  for (const side of [-1, 1]) {
    const nx = cx + side * (width / 2 - 0.05);
    putTube(wall, extra.iron, 0.033, railH, [nx, y + railH / 2 + 0.07, railZ]);
    put(wall, extra.iron, [0.045, railH, reach - 0.12], [nx, y + railH / 2 + 0.07, reach / 2]);
  }
  put(wall, extra.iron, [width - 0.04, 0.055, 0.055], [cx, y + railH + 0.07, railZ]);
  put(wall, extra.iron, [width - 0.04, 0.04, 0.04], [cx, y + 0.26, railZ]);
}

// ---------------------------------------------------------------------------
// Roofline
// ---------------------------------------------------------------------------

/**
 * Parapet, coping course and the rooftop clutter that makes the skyline. The
 * parapet is what a player actually sees of a roof from the street, so it gets
 * a proper coping stone and a dark course under it; the clutter is only worth
 * its triangles where it breaks the skyline, which means the tanks and masts
 * stand tall and the flat things stay flat.
 */
export function addRoofLife(facade: Facade, spec: FacadeSpec, index: number): void {
  const { materials, extra, batch } = facade;
  const [x0, x1] = spec.x;
  const [z0, z1] = spec.z;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const trim = spec.brick === true ? materials.brickTrim : materials.plasterTrim;

  const box = (
    material: Material,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    hit = false,
    soft?: number,
  ): void => {
    const source =
      soft === undefined
        ? new BoxGeometry(size[0], size[1], size[2])
        : roundedBox(size[0], size[1], size[2], soft, 2);
    const geometry = normalised(source);
    if (soft === undefined) source.dispose();
    geometry.applyMatrix4(new Matrix4().setPosition(at[0], at[1], at[2]));
    batch.push(material, geometry, hit);
  };
  const cyl = (
    material: Material,
    radius: number,
    length: number,
    at: readonly [number, number, number],
    segments = 8,
    hit = false,
  ): void => {
    const source = new CylinderGeometry(radius, radius, length, segments, 1);
    const geometry = normalised(source);
    source.dispose();
    geometry.applyMatrix4(new Matrix4().setPosition(at[0], at[1], at[2]));
    batch.push(material, geometry, hit);
  };

  /** Parapet, coping and shadow course around one roof plane. */
  const parapet = (
    px0: number,
    px1: number,
    pz0: number,
    pz1: number,
    y: number,
    height: number,
  ): void => {
    const pw = px1 - px0;
    const pd = pz1 - pz0;
    const mx = (px0 + px1) / 2;
    const mz = (pz0 + pz1) / 2;
    const t = 0.2;
    box(trim, [pw + t * 2, height, t], [mx, y + height / 2, pz0 - t / 2], true);
    box(trim, [pw + t * 2, height, t], [mx, y + height / 2, pz1 + t / 2], true);
    box(trim, [t, height, pd], [px0 - t / 2, y + height / 2, mz], true);
    box(trim, [t, height, pd], [px1 + t / 2, y + height / 2, mz], true);
    // Coping: wider than the parapet, so it draws a line along the whole top.
    const c = 0.36;
    box(extra.stone, [pw + c * 2, 0.11, c], [mx, y + height + 0.055, pz0 - t / 2]);
    box(extra.stone, [pw + c * 2, 0.11, c], [mx, y + height + 0.055, pz1 + t / 2]);
    box(extra.stone, [c, 0.11, pd + c], [px0 - t / 2, y + height + 0.055, mz]);
    box(extra.stone, [c, 0.11, pd + c], [px1 + t / 2, y + height + 0.055, mz]);
    // Dark course just under the coping.
    const s = 0.28;
    box(extra.reveal, [pw + s * 2, 0.05, s], [mx, y + height - 0.1, pz0 - t / 2]);
    box(extra.reveal, [pw + s * 2, 0.05, s], [mx, y + height - 0.1, pz1 + t / 2]);
    box(extra.reveal, [s, 0.05, pd + s], [px0 - t / 2, y + height - 0.1, mz]);
    box(extra.reveal, [s, 0.05, pd + s], [px1 + t / 2, y + height - 0.1, mz]);
  };

  parapet(x0, x1, z0, z1, spec.h, 0.62);

  let by = spec.h;
  let bx0 = x0 + 1.2;
  let bx1 = x1 - 1.2;
  let bz0 = z0 + 1.2;
  let bz1 = z1 - 1.2;
  if (spec.top !== undefined) {
    const i = spec.top.i;
    box(trim, [w - i * 2, spec.top.h, d - i * 2], [cx, spec.h + spec.top.h / 2, cz], true);
    by = spec.h + spec.top.h;
    bx0 = x0 + i + 0.9;
    bx1 = x1 - i - 0.9;
    bz0 = z0 + i + 0.9;
    bz1 = z1 - i - 0.9;
    if (hash(index * 53 + 3) > 0.4) parapet(x0 + i, x1 - i, z0 + i, z1 - i, by, 0.44);

    // The setback storey is the piece of a building that reads highest on the
    // skyline; blank, it is a white brick sitting on a white block. Give it a
    // window band on the faces the hash picks.
    const setback: FacadeSpec = {
      x: [x0 + i, x1 - i],
      z: [z0 + i, z1 - i],
      h: spec.top.h,
      brick: spec.brick,
    };
    for (const face of ["n", "s", "e", "w"] as const) {
      const wall = raise(wallOf(facade, setback, face, index * 23 + FACE_INDEX[face]), spec.h);
      if (wall.span < 3.2) continue;
      if (hash(index * 29 + FACE_INDEX[face] * 7) < 0.4) continue;
      const lights = Math.max(1, Math.min(3, Math.floor(wall.span / 3)));
      for (let light = 0; light < lights; light += 1) {
        addWindow(
          wall,
          -wall.span / 2 + (wall.span * (light + 0.5)) / lights,
          0.55,
          index * 131 + FACE_INDEX[face] * 11 + light * 5,
        );
      }
    }
  }

  const zw = bx1 - bx0;
  const zd = bz1 - bz0;
  if (zw < 1.6 || zd < 1.6) return;

  type Clutter = "tank" | "mast" | "ac" | "vents" | "skylight";
  const candidates: { kind: Clutter; gate: number }[] = [];
  if (spec.tank === true) candidates.push({ kind: "tank", gate: 0 });
  if (spec.mast === true) candidates.push({ kind: "mast", gate: 0 });
  candidates.push(
    { kind: "ac", gate: 0.25 },
    { kind: "vents", gate: 0.45 },
    { kind: "skylight", gate: 0.62 },
    { kind: "ac", gate: 0.78 },
  );
  const picked = candidates.filter((c, i) => hash(index * 31 + i * 17) >= c.gate);
  const chosen = picked.length >= 2 ? picked : candidates.slice(0, Math.min(2, candidates.length));

  chosen.forEach((c, slot) => {
    const qx = slot % 2;
    const qz = Math.floor(slot / 2) % 2;
    const px = bx0 + ((qx + 0.28 + hash(index * 13 + slot * 7) * 0.44) * zw) / 2;
    const pz = bz0 + ((qz + 0.28 + hash(index * 19 + slot * 11) * 0.44) * zd) / 2;
    switch (c.kind) {
      case "tank": {
        // Stands well clear of the parapet on purpose: from the street this is
        // most of what says "roof" instead of "flat white top".
        for (const lx of [-0.46, 0.46]) {
          for (const lz of [-0.46, 0.46]) {
            cyl(materials.steelPost, 0.05, 0.95, [px + lx, by + 0.475, pz + lz], 5);
          }
        }
        cyl(materials.tankDark, 0.84, 1.36, [px, by + 1.63, pz], 14, true);
        cyl(materials.steelPost, 0.88, 0.1, [px, by + 2.35, pz], 14);
        cyl(materials.steelPost, 0.045, 1.5, [px + 0.84, by + 0.75, pz], 5);
        break;
      }
      case "mast": {
        const height = 3.1 + hash(index * 7) * 1.4;
        cyl(materials.steelMast, 0.045, height, [px, by + height / 2, pz], 5, true);
        const across = hash(index * 23) > 0.5;
        for (const [share, arm] of [
          [0.62, 1.25],
          [0.78, 0.95],
          [0.9, 0.62],
        ] as const) {
          box(materials.steelMast, across ? [arm, 0.04, 0.04] : [0.04, 0.04, arm], [
            px,
            by + height * share,
            pz,
          ]);
        }
        break;
      }
      case "ac":
        box(materials.steelPost, [0.68, 0.5, 0.5], [px, by + 0.25, pz], true, 0.05);
        box(extra.reveal, [0.56, 0.36, 0.03], [px, by + 0.26, pz + 0.26]);
        break;
      case "vents":
        cyl(materials.steelPost, 0.09, 0.7, [px, by + 0.35, pz], 6);
        cyl(materials.tankDark, 0.13, 0.08, [px, by + 0.72, pz], 6);
        cyl(
          materials.steelPost,
          0.09,
          0.5,
          [px + 0.38 * (hash(index + slot) > 0.5 ? 1 : -1), by + 0.25, pz + 0.32],
          6,
        );
        break;
      case "skylight":
        box(materials.steelPost, [0.98, 0.14, 0.74], [px, by + 0.07, pz]);
        box(extra.reveal, [0.8, 0.05, 0.58], [px, by + 0.16, pz]);
        break;
    }
  });
}
