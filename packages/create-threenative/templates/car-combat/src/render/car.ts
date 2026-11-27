// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A car is four body panels on a dark core, a glass cabin and four wheels: all procedural boxes
// and cylinders. The panels are separate meshes so damage can crumple the one that was hit
// (`systems/` calls `crumple`). Every number is in metres; the nose points down -z, which is the
// direction `VehicleBody3D` drives by default.
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import type { Region } from "../vehicle/damage.js";
import { burntPaint } from "./materials.js";

export const CAR_SIZE = { height: 0.7, length: 4.2, width: 1.85 } as const;
export const WHEEL_RADIUS = 0.36;
/** Wheel centres in the chassis frame, before suspension: front pair first. */
export const WHEEL_SPOTS = [
  [-0.82, -1.35],
  [0.82, -1.35],
  [-0.82, 1.35],
  [0.82, 1.35],
] as const;

/** Rival and player paints. A car's colour is what tells two of them apart: keep them far apart. */
export const PAINTS = [0xd8d6d0, 0xc23b2a, 0x3a7a4a, 0xe0a82e, 0x5b4a8a] as const;

const glass = new MeshStandardMaterial({ color: 0x1a2028, metalness: 0.2, roughness: 0.12 });
const core = new MeshStandardMaterial({ color: 0x232426, roughness: 0.8 });
const tyre = new MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.9 });

const END = 1.2;
const SIDE = 0.55;
const MID = CAR_SIZE.length - 2 * END;
const endGeometry = new BoxGeometry(CAR_SIZE.width, CAR_SIZE.height, END);
const sideGeometry = new BoxGeometry(SIDE, CAR_SIZE.height, MID);
const coreGeometry = new BoxGeometry(CAR_SIZE.width - 2 * SIDE, CAR_SIZE.height - 0.15, MID);
const cabinGeometry = new BoxGeometry(CAR_SIZE.width - 0.3, 0.5, 2.0);
const wheelGeometry = new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 18).rotateZ(
  Math.PI / 2,
);

export interface IPanel {
  readonly mesh: Mesh;
  readonly home: { x: number; y: number; z: number };
  /** The axis the panel shrinks along when it crumples, and which edge stays put. */
  readonly axis: "x" | "z";
  readonly edge: number;
}

export interface ICarVisual {
  readonly root: Group;
  readonly panels: Record<Region, IPanel>;
  /** Wheel groups, in `WHEEL_SPOTS` order. */
  readonly wheels: readonly Group[];
}

const paints = new Map<number, MeshStandardMaterial>();

/**
 * One material per colour, shared by every car wearing it: the engine re-reads each live material
 * every frame, so a material per car is a cost per car. A wreck swaps the panels' material;
 * nothing ever edits a shared paint.
 */
export function paintOf(colour: number): MeshStandardMaterial {
  let paint = paints.get(colour);
  if (paint === undefined) {
    paint = new MeshStandardMaterial({ color: colour, metalness: 0.35, roughness: 0.38 });
    paints.set(colour, paint);
  }
  return paint;
}

/** `rideHeight` is where the chassis origin sits above the road once the suspension has settled. */
export function carVisual(colour: number, rideHeight: number): ICarVisual {
  const root = new Group();
  root.name = "car";
  const paint = paintOf(colour);
  const y = 0.3 + CAR_SIZE.height / 2 - rideHeight;
  const make = (geometry: BoxGeometry, x: number, z: number, material = paint): Mesh => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };
  const edgeZ = CAR_SIZE.length / 2;
  const front = make(endGeometry, 0, -(edgeZ - END / 2));
  const rear = make(endGeometry, 0, edgeZ - END / 2);
  const left = make(sideGeometry, -(CAR_SIZE.width / 2 - SIDE / 2), 0);
  const right = make(sideGeometry, CAR_SIZE.width / 2 - SIDE / 2, 0);
  make(coreGeometry, 0, 0, core).position.y -= 0.05;
  const cabin = new Mesh(cabinGeometry, glass);
  cabin.position.set(0, y + CAR_SIZE.height / 2 + 0.25, 0.2);
  root.add(cabin);
  const panel = (mesh: Mesh, axis: "x" | "z", edge: number): IPanel => ({
    axis,
    edge,
    home: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
    mesh,
  });
  const panels = {
    front: panel(front, "z", -edgeZ),
    left: panel(left, "x", -CAR_SIZE.width / 2),
    rear: panel(rear, "z", edgeZ),
    right: panel(right, "x", CAR_SIZE.width / 2),
  };
  const wheels = WHEEL_SPOTS.map(([x, z], index) => {
    const wheel = new Group();
    wheel.name = `wheel-${index}`;
    wheel.position.set(x, WHEEL_RADIUS - rideHeight, z);
    wheel.add(new Mesh(wheelGeometry, tyre));
    root.add(wheel);
    return wheel;
  });
  root.traverse((object) => {
    object.castShadow = true;
  });
  return { panels, root, wheels };
}

/** Crumples one panel: it shrinks toward its outer edge and sags, `amount` 0 (new) to 1 (flat). */
export function crumple(visual: ICarVisual, region: Region, amount: number): void {
  const { mesh, home, axis, edge } = visual.panels[region];
  const scale = 1 - 0.55 * amount;
  const length = axis === "z" ? END : SIDE;
  mesh.scale[axis] = scale;
  // The inner face stays where it was, so the outer face moves in.
  mesh.position[axis] = home[axis] - Math.sign(edge) * ((length * (1 - scale)) / 2);
  mesh.position.y = home.y - 0.12 * amount;
  mesh.rotation.z = 0.12 * amount * (region === "left" ? 1 : -1);
}

/** A wreck: every body panel turns burnt. */
export function burn(visual: ICarVisual): void {
  for (const { mesh } of Object.values(visual.panels)) mesh.material = burntPaint;
}
