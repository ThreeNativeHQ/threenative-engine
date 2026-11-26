// The two craft, built from boxes, tubes and one triangle on the grid materials, and the pilot who
// hangs under the glider or stands in the rocket belt's straps. The pilot is the combat mannequin,
// the one rigged asset in the kit; everything else is generated.
import { SkeletalMesh3D } from "@threenative/core";
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from "three";
import type { AnimationClip } from "three";
import { preparePilot } from "../conventions.js";
import { propMaterial, structureMaterial } from "./materials.js";

/** What `ctx.assets.model("mannequin-combat.glb")` hands back. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

const suit = new MeshStandardMaterial({ color: 0x3d4a5c, roughness: 0.5 });
const sail = new MeshStandardMaterial({ color: 0x2a6cf0, roughness: 0.55, side: DoubleSide });
const gunmetal = new MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.5, metalness: 0.5 });

/** Swap the skin on the cloned rig so the pilot reads against the sky and the sail. */
function dress(rig: Object3D, material: MeshStandardMaterial): void {
  rig.traverse((object) => {
    const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}

function tube(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  radius = 0.05,
): Mesh {
  const from = new Vector3(...a);
  const to = new Vector3(...b);
  const length = from.distanceTo(to);
  const mesh = new Mesh(new CylinderGeometry(radius, radius, length, 6), structureMaterial);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), to.sub(from).normalize());
  mesh.castShadow = true;
  return mesh;
}

/** The sail: two triangles that meet along the keel, the tips a little below the nose. */
function createSail(): Mesh {
  const nose: readonly number[] = [0, 0.3, 2.9];
  const tipLeft: readonly number[] = [-5.4, -0.1, -1.6];
  const tipRight: readonly number[] = [5.4, -0.1, -1.6];
  const tail: readonly number[] = [0, 0, -0.5];
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute([...nose, ...tipLeft, ...tail, ...nose, ...tail, ...tipRight], 3),
  );
  geometry.computeVertexNormals();
  const mesh = new Mesh(geometry, sail);
  mesh.name = "sail";
  mesh.castShadow = true;
  return mesh;
}

export interface IPilot {
  /** The rig, scaled to metres and ready to be placed in a craft. */
  readonly root: Object3D;
  readonly update: (dt: number) => void;
}

/** The mannequin on a looping clip, scaled to a 1.8 m person. */
export function createPilot(model: IMannequin, clip: string): IPilot {
  const character = new SkeletalMesh3D({
    clips: model.animations,
    requiredClips: [clip],
    source: model.scene,
  });
  preparePilot(character.root);
  dress(character.root, suit);
  character.root.traverse((object) => {
    object.castShadow = true;
  });
  character.play(clip, { fade: 0, mode: "loop" });
  return { root: character.root, update: (dt) => character.update(dt) };
}

export interface ICraft {
  readonly root: Group;
  /** The flame under the rocket belt, scaled by the lever; absent on the glider. */
  readonly flame?: Mesh;
  readonly pilot: IPilot;
}

/**
 * The hang glider: a delta sail on a keel with an A-frame control bar. The pilot hangs prone below
 * it, head forward, in a harness slung from the keel.
 */
export function createGliderCraft(model: IMannequin): ICraft {
  const root = new Group();
  root.name = "glider";
  root.add(createSail());
  root.add(
    tube([0, 0.3, 2.9], [0, 0, -0.5]),
    tube([0, 0.3, 2.9], [-5.4, -0.1, -1.6]),
    tube([0, 0.3, 2.9], [5.4, -0.1, -1.6]),
  );
  // The A-frame: two down tubes from the keel to the base bar, and a king post up to the sail.
  root.add(
    tube([0, 0, 0.4], [-0.8, -1.55, 0.5]),
    tube([0, 0, 0.4], [0.8, -1.55, 0.5]),
    tube([-0.8, -1.55, 0.5], [0.8, -1.55, 0.5]),
  );
  root.add(tube([0, 0, 0.4], [0, 0.9, 0.3]));
  root.add(tube([0, 0.9, 0.3], [-3, 0, -1], 0.02), tube([0, 0.9, 0.3], [3, 0, -1], 0.02));
  const pilot = createPilot(model, "Idle_Loop");
  // Prone: the figure lies on its chest, head toward the nose, hung 1.2 m under the keel.
  const harness = new Group();
  harness.name = "harness";
  harness.rotation.x = Math.PI / 2;
  harness.position.set(0, -1.25, -1.3);
  harness.add(pilot.root);
  root.add(harness);
  root.add(tube([0, 0, -0.1], [0, -1.1, -0.1], 0.03), tube([0, 0, 0.7], [0, -1.1, 0.7], 0.03));
  return { pilot, root };
}

/** The rocket belt: twin tanks and a nozzle on the pilot's back, a flame under them. */
export function createBeltCraft(model: IMannequin): ICraft {
  const root = new Group();
  root.name = "rocket-belt";
  const pilot = createPilot(model, "Idle_Loop");
  root.add(pilot.root);
  const back = new Group();
  for (const side of [-0.17, 0.17]) {
    const tank = new Mesh(new CylinderGeometry(0.11, 0.11, 0.7, 12), gunmetal);
    tank.position.set(side, 1.2, -0.3);
    tank.castShadow = true;
    back.add(tank);
  }
  const strap = new Mesh(new BoxGeometry(0.5, 0.5, 0.12), propMaterial);
  strap.position.set(0, 1.15, -0.2);
  back.add(strap);
  const nozzle = new Mesh(new CylinderGeometry(0.1, 0.18, 0.25, 12), gunmetal);
  nozzle.position.set(0, 0.78, -0.3);
  back.add(nozzle);
  root.add(back);
  const flame = new Mesh(
    new ConeGeometry(0.16, 1, 10).translate(0, -0.5, 0),
    new MeshBasicMaterial({ color: 0xffb347 }),
  );
  flame.name = "flame";
  flame.position.set(0, 0.66, -0.3);
  flame.visible = false;
  root.add(flame);
  return { flame, pilot, root };
}
