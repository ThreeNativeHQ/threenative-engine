// Generated for you. Draws the field the rules in `farm/field.ts` keep.
//
// Every kind of thing in the field is one `InstancedMesh` with a slot per tile: soil, leaves,
// fruit, weeds and rocks. A tile that has none of a kind scales its slot to zero. `sync` rewrites
// the slots after anything changes, so the whole field costs about a dozen draw calls.
import {
  BoxGeometry,
  type BufferGeometry,
  ConeGeometry,
  DodecahedronGeometry,
  Euler,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { CROPS, CROP_IDS, type CropId } from "../farm/crops.js";
import { type Field, type ITile, isRipe } from "../farm/field.js";
import { ROCK_HITS } from "../farm/tools.js";
import { FIELD, tileCenter } from "../level.js";
import {
  deadLeafMaterial,
  leafMaterial,
  rockMaterial,
  soilMaterial,
  wetSoilMaterial,
} from "./materials.js";

const SOIL_TOP = 0.16;
/** Weeds per tile: three tufts at fixed offsets. */
const TUFTS: readonly (readonly [number, number, number])[] = [
  [-0.45, -0.3, 0.9],
  [0.4, -0.1, 1.2],
  [-0.05, 0.5, 1],
];
/** How tall a fully grown leaf mound is, per crop. The tomato is a staked plant, the pumpkin a vine. */
const HEIGHT: Readonly<Record<CropId, number>> = { pumpkin: 0.45, tomato: 1.15, turnip: 0.6 };

const _matrix = new Matrix4();
const _position = new Vector3();
const _scale = new Vector3();
const _rotation = new Quaternion();
const _euler = new Euler();

function slots(geometry: BufferGeometry, material: Material, count: number): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The slots move, so the bounds taken at build time would cull them.
  mesh.frustumCulled = false;
  return mesh;
}

function place(
  mesh: InstancedMesh,
  index: number,
  at: readonly [number, number, number],
  scale: readonly [number, number, number],
  yaw = 0,
): void {
  _matrix.compose(
    _position.set(...at),
    _rotation.setFromEuler(_euler.set(0, yaw, 0)),
    _scale.set(...scale),
  );
  mesh.setMatrixAt(index, _matrix);
}

function hide(mesh: InstancedMesh, index: number): void {
  place(mesh, index, [0, -5, 0], [0, 0, 0]);
}

export class FieldView {
  readonly root = new Group();
  readonly #soil: InstancedMesh;
  readonly #wet: InstancedMesh;
  readonly #leaves: InstancedMesh;
  readonly #dead: InstancedMesh;
  readonly #fruit = new Map<CropId, InstancedMesh>();
  readonly #weeds: InstancedMesh;
  readonly #rocks: InstancedMesh;
  readonly #field: Field;

  constructor(field: Field) {
    this.#field = field;
    this.root.name = "field-view";
    const count = FIELD.cols * FIELD.rows;
    const soilGeometry = new BoxGeometry(FIELD.tile - 0.16, SOIL_TOP, FIELD.tile - 0.16).translate(
      0,
      SOIL_TOP / 2,
      0,
    );
    this.#soil = slots(soilGeometry, soilMaterial, count);
    this.#wet = slots(soilGeometry, wetSoilMaterial, count);
    this.#leaves = slots(new SphereGeometry(0.5, 10, 8), leafMaterial, count);
    this.#dead = slots(new SphereGeometry(0.5, 8, 6), deadLeafMaterial, count);
    this.#weeds = slots(
      new ConeGeometry(0.22, 0.8, 5).translate(0, 0.4, 0),
      leafMaterial,
      count * TUFTS.length,
    );
    this.#rocks = slots(new DodecahedronGeometry(0.7, 0), rockMaterial, count);
    this.root.add(this.#soil, this.#wet, this.#leaves, this.#dead, this.#weeds, this.#rocks);
    for (const id of CROP_IDS) {
      const fruit = slots(
        new SphereGeometry(0.5, 14, 10),
        new MeshStandardMaterial({ color: CROPS[id].color, roughness: 0.45 }),
        count,
      );
      this.#fruit.set(id, fruit);
      this.root.add(fruit);
    }
    this.sync();
  }

  /** Rewrite every slot from the field. Cheap: 48 tiles. */
  sync(): void {
    for (let index = 0; index < this.#field.tiles.length; index += 1) {
      const tile = this.#field.tiles[index] as ITile;
      this.#syncTile(index, tile, tileCenter(index % FIELD.cols, Math.floor(index / FIELD.cols)));
    }
    for (const mesh of this.root.children as InstancedMesh[])
      mesh.instanceMatrix.needsUpdate = true;
  }

  #syncTile(index: number, tile: ITile, centre: { x: number; z: number }): void {
    const { x, z } = centre;
    if (tile.tilled) {
      place(tile.watered ? this.#wet : this.#soil, index, [x, 0, z], [1, 1, 1]);
      hide(tile.watered ? this.#soil : this.#wet, index);
    } else {
      hide(this.#soil, index);
      hide(this.#wet, index);
    }

    const crop = tile.crop;
    hide(this.#leaves, index);
    hide(this.#dead, index);
    for (const fruit of this.#fruit.values()) hide(fruit, index);
    if (crop !== undefined) {
      const spec = CROPS[crop.id];
      const grown = crop.stage / spec.days;
      const height = HEIGHT[crop.id];
      if (crop.dead) place(this.#dead, index, [x, SOIL_TOP + 0.1, z], [0.9, 0.2, 0.9]);
      else {
        // A seed is a small mound; the leaves swell to full height by the ripe day.
        const leaf = 0.18 + 0.82 * grown;
        place(
          this.#leaves,
          index,
          [x, SOIL_TOP + ((height * leaf) / 2) * 0.9, z],
          [0.5 + 0.5 * leaf, height * leaf, 0.5 + 0.5 * leaf],
        );
        if (isRipe(tile)) this.#placeFruit(crop.id, index, x, z);
      }
    }

    for (const [tuft, [dx, dz, size]] of TUFTS.entries()) {
      const slot = index * TUFTS.length + tuft;
      if (tile.obstacle === "weed")
        place(this.#weeds, slot, [x + dx, 0, z + dz], [size, size, size], tuft * 1.7);
      else hide(this.#weeds, slot);
    }
    if (tile.obstacle === "rock") {
      const left = 1 - (tile.hits / ROCK_HITS) * 0.35;
      place(this.#rocks, index, [x, 0.4 * left, z], [1.1 * left, 0.8 * left, 0.95 * left], index);
    } else hide(this.#rocks, index);
  }

  #placeFruit(id: CropId, index: number, x: number, z: number): void {
    const fruit = this.#fruit.get(id);
    if (fruit === undefined) return;
    if (id === "turnip") place(fruit, index, [x, SOIL_TOP + 0.18, z], [0.55, 0.5, 0.55]);
    else if (id === "tomato")
      place(fruit, index, [x + 0.22, SOIL_TOP + 0.9, z], [0.42, 0.42, 0.42]);
    else place(fruit, index, [x + 0.3, SOIL_TOP + 0.3, z + 0.1], [0.9, 0.6, 0.9]);
  }
}
