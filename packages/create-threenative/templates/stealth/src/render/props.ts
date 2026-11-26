// Generated for you. Every prop in the compound is a few boxes on the grid materials: no asset.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { propMaterial, structureMaterial } from "./materials.js";

/**
 * Rifle rotation in `hand_r` space, degrees XYZ, per rifle clip of the combat mannequin: the barrel
 * points at `hand_l` and the sights at the sky (measured off the clips, as the shooter kit does).
 * Clips not listed keep the last hold.
 */
export const RIFLE_HOLD: Readonly<Record<string, readonly [number, number, number]>> = {
  Rifle_Idle: [-80.1, -13.4, -148.4],
  Rifle_Walk: [-80.2, -21.4, -158.1],
  Rifle_Shoot: [-83.4, -20.1, -170],
  Rifle_Hit: [-70.4, -27.7, -113.4],
};

const gunmetal = new MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.55, metalness: 0.5 });

/** Five boxes that read as a rifle at guard distance. The grip is the origin, so the fist lands on it. */
export function createRifle(): Group {
  const rifle = new Group();
  rifle.name = "guard-rifle";
  const part = (
    size: readonly [number, number, number],
    at: readonly [number, number, number],
  ): void => {
    const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), gunmetal);
    mesh.position.set(at[0], at[1], at[2]);
    rifle.add(mesh);
  };
  part([0.05, 0.09, 0.42], [0, 0, 0.06]);
  part([0.03, 0.03, 0.3], [0, 0.01, 0.4]);
  part([0.04, 0.14, 0.06], [0, -0.1, 0.02]);
  part([0.04, 0.08, 0.24], [0, -0.01, -0.26]);
  part([0.04, 0.1, 0.05], [0, -0.08, -0.04]);
  return rifle;
}

/** The guards' uniform. A near-white mannequin next to a near-white player is one silhouette. */
export const guardMaterial = new MeshStandardMaterial({ color: 0x5b6b4e, roughness: 0.6 });
/** The player's sneaking suit: dark blue-grey, so a lit floor frames it. */
export const playerMaterial = new MeshStandardMaterial({ color: 0x3d4a5c, roughness: 0.5 });

/** The keycard on its table: the one blue thing in the records room. */
export function createKeycard(): Group {
  const group = new Group();
  group.name = "keycard";
  const table = new Mesh(new RoundedBoxGeometry(1.2, 0.9, 0.7, 2, 0.03), structureMaterial);
  table.position.y = 0.45;
  table.castShadow = true;
  table.receiveShadow = true;
  group.add(table);
  const card = new Mesh(new BoxGeometry(0.22, 0.03, 0.14), propMaterial);
  card.name = "keycard-card";
  card.position.y = 0.92;
  group.add(card);
  return group;
}

const doorMaterial = new MeshStandardMaterial({ color: 0x2a6cf0, roughness: 0.4, metalness: 0.3 });

/** The locked door: one slab that slides up into the lintel when opened. */
export function createDoor(width: number, height: number): Mesh {
  const door = new Mesh(new RoundedBoxGeometry(width, height, 0.3, 2, 0.03), doorMaterial);
  door.name = "locked-door";
  door.castShadow = true;
  door.receiveShadow = true;
  return door;
}

/** The extraction pad: a flat green ring the player walks onto. */
export function createExtractionPad(radius: number): Mesh {
  const pad = new Mesh(
    new CylinderGeometry(radius, radius, 0.04, 40),
    new MeshStandardMaterial({ color: 0x3fae5a, emissive: 0x1b5c2a, roughness: 0.5 }),
  );
  pad.name = "extraction-pad";
  pad.position.y = 0.02;
  pad.receiveShadow = true;
  return pad;
}

/** A wall-mounted camera: a body and a lens on a pivot. Rotate the returned pivot to sweep. */
export function createSecurityCamera(): { readonly root: Group; readonly pivot: Group } {
  const root = new Group();
  const bracket = new Mesh(new BoxGeometry(0.1, 0.1, 0.3), gunmetal);
  root.add(bracket);
  const pivot = new Group();
  const body = new Mesh(new BoxGeometry(0.22, 0.2, 0.45), structureMaterial);
  body.position.z = 0.25;
  pivot.add(body);
  const lens = new Mesh(
    new CylinderGeometry(0.06, 0.06, 0.06, 16).rotateX(Math.PI / 2),
    new MeshStandardMaterial({ color: 0xd0532a, emissive: 0x6a1a08 }),
  );
  lens.position.z = 0.5;
  pivot.add(lens);
  root.add(pivot);
  return { root, pivot };
}

const CONE_COLOURS = {
  patrol: 0xe6e4e1,
  suspicious: 0xe8b86a,
  alert: 0xd0532a,
} as const;

/**
 * A flat fan on the floor showing what a viewer can see: its reach and its half angle. Faint while
 * the viewer is calm, amber while suspicious, red on alert. A teaching aid as much as a look —
 * set `visible = false` on it for the classic radar-only read.
 */
export function createViewCone(range: number, halfAngle: number): Mesh {
  // CircleGeometry sweeps counter-clockwise from +x; rotated flat and turned so the fan's centre
  // faces +z (yaw 0) once it is a child of the viewer.
  const geometry = new CircleGeometry(range, 24, Math.PI / 2 - halfAngle, halfAngle * 2);
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.PI);
  const cone = new Mesh(
    geometry,
    new MeshBasicMaterial({
      color: CONE_COLOURS.patrol,
      depthWrite: false,
      opacity: 0.12,
      side: DoubleSide,
      transparent: true,
    }),
  );
  cone.name = "view-cone";
  cone.position.y = 0.03;
  cone.renderOrder = 1;
  return cone;
}

export function tintViewCone(cone: Mesh, mood: keyof typeof CONE_COLOURS): void {
  const material = cone.material as MeshBasicMaterial;
  material.color.setHex(CONE_COLOURS[mood]);
  material.opacity = mood === "patrol" ? 0.12 : 0.22;
}

/**
 * The mark over a guard's head: "!" (a bar over a dot) when it has seen the player, "?" (drawn as a
 * hook of two bars over a dot) while it is unsure. Hidden while calm.
 */
export function createMoodMarker(): {
  readonly root: Group;
  readonly set: (mood: "none" | "suspicious" | "alert") => void;
} {
  const root = new Group();
  root.name = "mood-marker";
  const red = new MeshBasicMaterial({ color: 0xd0532a });
  const amber = new MeshBasicMaterial({ color: 0xe8b86a });
  const bar = new Mesh(new BoxGeometry(0.09, 0.32, 0.09), red);
  bar.position.y = 0.24;
  const dot = new Mesh(new BoxGeometry(0.09, 0.09, 0.09), red);
  const hookTop = new Mesh(new BoxGeometry(0.26, 0.08, 0.08), amber);
  hookTop.position.set(0.04, 0.4, 0);
  const hookSide = new Mesh(new BoxGeometry(0.08, 0.18, 0.08), amber);
  hookSide.position.set(0.14, 0.3, 0);
  const hookStem = new Mesh(new BoxGeometry(0.08, 0.12, 0.08), amber);
  hookStem.position.set(0.02, 0.16, 0);
  root.add(bar, dot, hookTop, hookSide, hookStem);
  const set = (mood: "none" | "suspicious" | "alert"): void => {
    root.visible = mood !== "none";
    bar.visible = mood === "alert";
    hookTop.visible = hookSide.visible = hookStem.visible = mood === "suspicious";
    dot.material = mood === "alert" ? red : amber;
  };
  set("none");
  return { root, set };
}

/**
 * Swap the skin material on a cloned rig, so one asset dresses guards and the player apart. Only
 * skinned meshes change: a prop already held in a hand keeps its own material.
 */
export function dress(rig: Object3D, material: MeshStandardMaterial): void {
  rig.traverse((object) => {
    const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}

export interface ITracer {
  readonly line: Line;
  /** Stretch the tracer from the muzzle to where the round went, world space. */
  readonly aim: (
    fromX: number,
    fromY: number,
    fromZ: number,
    toX: number,
    toY: number,
    toZ: number,
  ) => void;
}

/** A rifle round's streak: one bright segment the guard shows for a few frames per shot. */
export function createTracer(): ITracer {
  const positions = new Float32Array(6);
  const geometry = new BufferGeometry();
  const attribute = new BufferAttribute(positions, 3);
  geometry.setAttribute("position", attribute);
  const line = new Line(geometry, new LineBasicMaterial({ color: 0xffd27a }));
  line.name = "tracer";
  line.frustumCulled = false;
  line.visible = false;
  return {
    aim: (fromX, fromY, fromZ, toX, toY, toZ) => {
      positions.set([fromX, fromY, fromZ, toX, toY, toZ]);
      attribute.needsUpdate = true;
    },
    line,
  };
}
