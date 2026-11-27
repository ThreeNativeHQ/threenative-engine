// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The mansion wing's look, built from the plan in `src/level.ts`: grid walls around each room, a
// blue panel for every door, the furniture, the lamps, and one small model per item. Nothing here
// decides gameplay; `scenes/Play.ts` hands `solid` to the physics and reads the rest by id.
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  type Object3D,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import {
  DOORS,
  FURNITURE,
  type IFurniture,
  type ItemId,
  PICKUPS,
  ROOMS,
  WALL_HEIGHT,
  WALL_THICKNESS,
} from "../level.js";
import {
  brassMaterial,
  floorMaterial,
  gunMaterial,
  herbMaterial,
  inkMaterial,
  lampMaterial,
  propMaterial,
  structureMaterial,
  worldGridUVs,
} from "./materials.js";

const BEVEL = 0.03;

export interface IMansion {
  /** Everything the survivor collides with: walls, door panels and furniture. */
  readonly solid: Group;
  readonly ground: Mesh;
  readonly doors: ReadonlyMap<string, Object3D>;
  readonly pickups: ReadonlyMap<string, Object3D>;
  readonly decor: Group;
}

function box(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  material: Material,
): Mesh {
  const geometry = new RoundedBoxGeometry(size[0], size[1], size[2], 2, BEVEL);
  geometry.translate(at[0], at[1] + size[1] / 2 - BEVEL, at[2]);
  const mesh = new Mesh(worldGridUVs(geometry), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function furniture(entry: IFurniture): Group {
  const group = new Group();
  group.name = entry.id;
  const [x0, z0] = entry.min;
  const [x1, z1] = entry.max;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const w = x1 - x0;
  const d = z1 - z0;
  if (entry.kind === "box") {
    // The item box: the one container every room with a typewriter shares.
    group.add(box([w, entry.height - 0.12, d], [cx, 0, cz], propMaterial));
    group.add(box([w + 0.04, 0.14, d + 0.04], [cx, entry.height - 0.14, cz], structureMaterial));
    return group;
  }
  group.add(box([w, entry.height, d], [cx, 0, cz], structureMaterial));
  if (entry.kind === "typewriter") {
    const body = box([0.42, 0.14, 0.34], [cx, entry.height, cz], inkMaterial);
    const roller = new Mesh(new CylinderGeometry(0.035, 0.035, 0.46, 12), brassMaterial);
    roller.rotation.z = Math.PI / 2;
    roller.position.set(cx, entry.height + 0.17, cz - 0.1);
    group.add(body, roller);
  }
  return group;
}

/** One model per item kind, small enough to sit on a table, centred on its floor point. */
export function itemModel(item: ItemId): Group {
  const group = new Group();
  switch (item) {
    case "ammo":
      group.add(box([0.2, 0.09, 0.13], [0, 0, 0], propMaterial));
      break;
    case "herb":
    case "mixed": {
      const pot = new Mesh(new CylinderGeometry(0.07, 0.055, 0.1, 12), structureMaterial);
      pot.position.y = 0.05;
      group.add(pot);
      for (let leaf = 0; leaf < 3; leaf += 1) {
        const cone = new Mesh(new ConeGeometry(0.035, 0.2, 6), herbMaterial);
        cone.position.set(Math.sin(leaf * 2.1) * 0.03, 0.18, Math.cos(leaf * 2.1) * 0.03);
        cone.rotation.set(Math.cos(leaf * 2.1) * 0.35, 0, -Math.sin(leaf * 2.1) * 0.35);
        group.add(cone);
      }
      break;
    }
    case "key": {
      const ring = new Mesh(new TorusGeometry(0.035, 0.01, 6, 16), brassMaterial);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(-0.06, 0.012, 0);
      const shaft = new Mesh(new BoxGeometry(0.12, 0.018, 0.02), brassMaterial);
      shaft.position.set(0.03, 0.012, 0);
      group.add(ring, shaft);
      break;
    }
    case "ribbon": {
      const spool = new Mesh(new CylinderGeometry(0.05, 0.05, 0.04, 16), inkMaterial);
      spool.position.y = 0.02;
      group.add(spool);
      break;
    }
    case "handgun":
      group.add(createHandgun());
      break;
  }
  for (const child of group.children) child.castShadow = true;
  return group;
}

/**
 * The handgun the survivor holds: grip down the hand's fingers, barrel out past the knuckles. It is
 * parented to `hand_r` by `attachToBone`, so these offsets are in the hand's own frame.
 */
export function createHandgun(): Group {
  const gun = new Group();
  gun.name = "handgun";
  const slide = new Mesh(new BoxGeometry(0.03, 0.2, 0.045), gunMaterial);
  slide.position.set(0, 0.09, 0.05);
  const grip = new Mesh(new BoxGeometry(0.028, 0.05, 0.11), gunMaterial);
  grip.position.set(0, 0.02, 0);
  gun.add(slide, grip);
  return gun;
}

export function createMansion(): IMansion {
  const solid = new Group();
  solid.name = "mansion";
  const decor = new Group();
  decor.name = "mansion-decor";
  const t = WALL_THICKNESS;
  for (const room of ROOMS) {
    const [x0, z0] = room.min;
    const [x1, z1] = room.max;
    const w = x1 - x0;
    const d = z1 - z0;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    solid.add(
      box([w + t * 2, WALL_HEIGHT, t], [cx, 0, z0 - t / 2], structureMaterial),
      box([w + t * 2, WALL_HEIGHT, t], [cx, 0, z1 + t / 2], structureMaterial),
      box([t, WALL_HEIGHT, d], [x0 - t / 2, 0, cz], structureMaterial),
      box([t, WALL_HEIGHT, d], [x1 + t / 2, 0, cz], structureMaterial),
    );
    // A ceiling: the sun reaches the rooms only through the doors' gaps, and the lamps light the rest.
    decor.add(box([w + t * 2, t, d + t * 2], [cx, WALL_HEIGHT, cz], structureMaterial));
    // A lamp per room: a warm pool on the floor is what makes a grey room read as a room at night.
    const lamp = new Mesh(new SphereGeometry(0.12, 16, 8), lampMaterial);
    lamp.position.set(cx, WALL_HEIGHT - 0.4, cz);
    const light = new PointLight(0xffc98a, 30, Math.max(w, d) * 1.2, 2);
    light.position.copy(lamp.position);
    decor.add(lamp, light);
  }
  const doors = new Map<string, Object3D>();
  for (const door of DOORS) {
    const across = door.inward[0] === 0;
    const panel = box(
      across ? [1.1, 2.2, 0.08] : [0.08, 2.2, 1.1],
      [door.at[0] + door.inward[0] * 0.04, 0, door.at[1] + door.inward[1] * 0.04],
      propMaterial,
    );
    panel.name = `door-${door.id}`;
    const knob = new Mesh(new SphereGeometry(0.05, 12, 8), brassMaterial);
    knob.position.set(
      door.at[0] + door.inward[0] * 0.12 + (across ? 0.4 : 0),
      1,
      door.at[1] + door.inward[1] * 0.12 + (across ? 0 : 0.4),
    );
    decor.add(knob);
    solid.add(panel);
    doors.set(door.id, panel);
  }
  for (const entry of FURNITURE) solid.add(furniture(entry));
  const pickups = new Map<string, Object3D>();
  for (const pickup of PICKUPS) {
    const model = itemModel(pickup.item);
    model.name = `pickup-${pickup.id}`;
    model.position.set(pickup.at[0], pickup.at[1], pickup.at[2]);
    decor.add(model);
    pickups.set(pickup.id, model);
  }
  // The floor runs out past the walls, so a high camera over a wall meets ground, not a void.
  const groundGeometry = new PlaneGeometry(400, 400).rotateX(-Math.PI / 2);
  const ground = new Mesh(worldGridUVs(groundGeometry), floorMaterial);
  ground.receiveShadow = true;
  return { decor, doors, ground, pickups, solid };
}
