// What the pilot reads in the air: the rings, the thermal columns and the wind socks. All of it is
// procedural: tori, cylinders and cones on plain materials. Nothing here is solid for the camera
// (the transparent parts write no depth), so a column never hides the glider.
import {
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  TorusGeometry,
} from "three";
import type { RingMark } from "../sim/scoring.js";
import { type IRing, type IThermal, PAD, THERMALS, groundHeight } from "../sim/world.js";
import { palette } from "./palette.js";

const ringPaint: Readonly<Record<RingMark | "active", MeshStandardMaterial>> = {
  active: new MeshStandardMaterial({
    color: palette.accent,
    emissive: palette.accent,
    emissiveIntensity: 0.9,
    roughness: 0.4,
  }),
  missed: new MeshStandardMaterial({
    color: palette.missed,
    emissive: palette.missed,
    emissiveIntensity: 0.4,
    roughness: 0.5,
  }),
  passed: new MeshStandardMaterial({
    color: palette.passed,
    emissive: palette.passed,
    emissiveIntensity: 0.4,
    roughness: 0.5,
  }),
  pending: new MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.5 }),
};

export interface IRingSet {
  readonly root: Group;
  /** Paint each ring by its mark and the next open ring as active. */
  readonly paint: (marks: readonly RingMark[], active: number) => void;
}

/** One torus per ring, facing along the course, thick enough to read from a long way off. */
export function createRings(rings: readonly IRing[]): IRingSet {
  const root = new Group();
  root.name = "rings";
  const meshes = rings.map((ring, index) => {
    const mesh = new Mesh(
      new TorusGeometry(ring.radius, Math.max(0.5, ring.radius * 0.07), 10, 48),
      ringPaint.pending,
    );
    mesh.name = `ring-${index + 1}`;
    mesh.position.set(ring.x, ring.y, ring.z);
    mesh.rotation.y = ring.yaw;
    mesh.castShadow = true;
    root.add(mesh);
    return mesh;
  });
  // A pale shaft over the open ring, so it can be found against the sky from across the island.
  const shaft = new Mesh(
    new CylinderGeometry(0.5, 0.5, 90, 8, 1, true),
    new MeshBasicMaterial({
      color: palette.accent,
      depthWrite: false,
      opacity: 0.35,
      side: DoubleSide,
      transparent: true,
    }),
  );
  shaft.name = "ring-beacon";
  root.add(shaft);
  return {
    paint: (marks, active) => {
      meshes.forEach((mesh, index) => {
        const mark = marks[index] ?? "pending";
        mesh.material = index === active && mark === "pending" ? ringPaint.active : ringPaint[mark];
      });
      const ring = rings[active];
      shaft.visible = ring !== undefined;
      if (ring !== undefined) shaft.position.set(ring.x, ring.y + ring.radius + 45, ring.z);
    },
    root,
  };
}

const COLUMN_FRACTION = 0.7;
const PUFFS = 4;

export interface IThermalSet {
  readonly root: Group;
  readonly update: (time: number) => void;
}

/** A translucent column per thermal, with rings of air that climb it. */
export function createThermals(thermals: readonly IThermal[] = THERMALS): IThermalSet {
  const root = new Group();
  root.name = "thermals";
  const column = new MeshBasicMaterial({
    color: 0xffd6a0,
    depthWrite: false,
    opacity: 0.1,
    side: DoubleSide,
    transparent: true,
  });
  const puff = new MeshBasicMaterial({
    color: 0xfff1d6,
    depthWrite: false,
    opacity: 0.45,
    transparent: true,
  });
  const climbing: Array<{ mesh: Mesh; ground: number; height: number; phase: number }> = [];
  thermals.forEach((thermal, index) => {
    const ground = groundHeight(thermal.x, thermal.z);
    const height = thermal.top - ground;
    const radius = thermal.radius * COLUMN_FRACTION;
    const group = new Group();
    group.name = `thermal-${index + 1}`;
    const body = new Mesh(new CylinderGeometry(radius, radius * 1.15, height, 24, 1, true), column);
    body.position.y = ground + height / 2;
    group.add(body);
    for (let n = 0; n < PUFFS; n += 1) {
      const mesh = new Mesh(new TorusGeometry(radius, 0.35, 6, 32).rotateX(Math.PI / 2), puff);
      group.add(mesh);
      climbing.push({ ground, height, mesh, phase: n / PUFFS });
    }
    group.position.set(thermal.x, 0, thermal.z);
    root.add(group);
  });
  return {
    root,
    update: (time) => {
      for (const { mesh, ground, height, phase } of climbing)
        mesh.position.y = ground + ((time * 0.12 + phase) % 1) * height;
    },
  };
}

export interface IWindSock {
  readonly root: Group;
  /** Point the sock downwind and lift it by the speed of the wind, m/s. */
  readonly set: (windX: number, windZ: number) => void;
}

const sockPaint = [
  new MeshStandardMaterial({ color: palette.accent, roughness: 0.6, side: DoubleSide }),
  new MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.6, side: DoubleSide }),
];
const poleMaterial = new MeshStandardMaterial({ color: palette.structure, roughness: 0.6 });

/** A pole with a striped open cone that hangs at rest and stands out straight in a strong wind. */
export function createWindSock(x: number, z: number, height = 9): IWindSock {
  const root = new Group();
  root.name = "wind-sock";
  const pole = new Mesh(new CylinderGeometry(0.12, 0.16, height, 8), poleMaterial);
  pole.position.y = height / 2;
  pole.castShadow = true;
  root.add(pole);
  // The hinge turns with the wind; the cone lies along its +z axis and droops by pitching about x.
  const hinge = new Group();
  hinge.position.y = height;
  const segments = 4;
  for (let index = 0; index < segments; index += 1) {
    const top = 0.8 - index * 0.14;
    const length = 1.1;
    const segment = new Mesh(
      new CylinderGeometry(top - 0.14, top, length, 14, 1, true).rotateX(Math.PI / 2),
      sockPaint[index % 2],
    );
    segment.position.z = 0.55 + index * length;
    segment.castShadow = true;
    hinge.add(segment);
  }
  root.add(hinge);
  root.position.set(x, groundHeight(x, z), z);
  return {
    root,
    set: (windX, windZ) => {
      const speed = Math.hypot(windX, windZ);
      hinge.rotation.order = "YXZ";
      hinge.rotation.y = Math.atan2(windX, windZ);
      // At rest the cone hangs straight down (90 degrees); in a 7 m/s wind it is level.
      hinge.rotation.x = Math.max(0, 1 - speed / 7) * (Math.PI / 2);
    },
  };
}

/** The two socks of the course: one where the glider launches, one by the pad. */
export function createWindSocks(launch: { x: number; z: number }): readonly IWindSock[] {
  return [
    createWindSock(launch.x + 9, launch.z - 4),
    createWindSock(PAD.x + PAD.radius + 5, PAD.z + 4),
  ];
}
