// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The cars are blocks on the same prototype look as the city: a rounded lower body in one paint,
// a glass cabin, a light bar on the police, and four wheels. Every number is in metres; the nose
// points down -z, which is the direction `VehicleBody3D` drives by default.
import { CylinderGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export const CAR_SIZE = { height: 0.7, length: 4.2, width: 1.85 } as const;
export const WHEEL_RADIUS = 0.36;
/** Wheel centres in the chassis frame, before suspension: front pair first. */
export const WHEEL_SPOTS = [
  [-0.82, -1.35],
  [0.82, -1.35],
  [-0.82, 1.35],
  [0.82, 1.35],
] as const;

/** Civilian paints. A car's colour is the only thing telling two of them apart, so keep them far apart. */
export const PAINTS = [0xc23b2a, 0xe0b040, 0x3a7a4a, 0x2f5fa8, 0xd8d6d0, 0x5b4a8a, 0x2b2b2e] as const;
export const POLICE_PAINT = 0x1d2a44;

const glass = new MeshStandardMaterial({ color: 0x1a2028, metalness: 0.2, roughness: 0.12 });
const tyre = new MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.9 });
const hub = new MeshStandardMaterial({ color: 0x9a9da2, metalness: 0.7, roughness: 0.35 });
const lightRed = new MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 3 });
const lightBlue = new MeshStandardMaterial({ color: 0x2050ff, emissive: 0x1040ff, emissiveIntensity: 3 });
const lowerGeometry = new RoundedBoxGeometry(CAR_SIZE.width, CAR_SIZE.height, CAR_SIZE.length, 2, 0.12);
const cabinGeometry = new RoundedBoxGeometry(CAR_SIZE.width - 0.2, 0.55, 2.1, 2, 0.12);
const wheelGeometry = new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 18).rotateZ(Math.PI / 2);
const hubGeometry = new CylinderGeometry(0.16, 0.16, 0.28, 10).rotateZ(Math.PI / 2);
const barGeometry = new RoundedBoxGeometry(0.5, 0.12, 0.25, 1, 0.04);

export interface ICarVisual {
  readonly root: Group;
  /** The lower body's own material, so one car can be repainted or burnt without the others. */
  readonly paint: MeshStandardMaterial;
  /** Wheel groups, in `WHEEL_SPOTS` order. */
  readonly wheels: readonly Group[];
}

/**
 * One car. `rideHeight` is where the chassis origin sits above the road once the suspension has
 * settled; the body is drawn relative to the road, not to the origin, so it always sits on its wheels.
 */
export function carVisual(colour: number, rideHeight: number, police = false): ICarVisual {
  const root = new Group();
  root.name = "car";
  const paint = new MeshStandardMaterial({ color: colour, metalness: 0.35, roughness: 0.38 });
  const lower = new Mesh(lowerGeometry, paint);
  lower.name = "body";
  lower.position.y = 0.3 + CAR_SIZE.height / 2 - rideHeight;
  const cabin = new Mesh(cabinGeometry, glass);
  cabin.position.set(0, lower.position.y + CAR_SIZE.height / 2 + 0.24, 0.25);
  root.add(lower, cabin);
  if (police) {
    const red = new Mesh(barGeometry, lightRed);
    red.position.set(-0.3, cabin.position.y + 0.33, 0.25);
    const blue = new Mesh(barGeometry, lightBlue);
    blue.position.set(0.3, cabin.position.y + 0.33, 0.25);
    root.add(red, blue);
  }
  const wheels = WHEEL_SPOTS.map(([x, z], index) => {
    const wheel = new Group();
    wheel.name = `wheel-${index}`;
    wheel.position.set(x, WHEEL_RADIUS - rideHeight, z);
    wheel.add(new Mesh(wheelGeometry, tyre), new Mesh(hubGeometry, hub));
    root.add(wheel);
    return wheel;
  });
  root.traverse((object) => {
    object.castShadow = true;
  });
  return { paint, root, wheels };
}
