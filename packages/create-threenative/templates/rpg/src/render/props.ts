// Generated for you. Every prop in the camp is a few primitives on the grid materials: no asset.
import {
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  OctahedronGeometry,
  RingGeometry,
} from "three";
import { propMaterial, structureMaterial } from "./materials.js";

const steel = new MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.4 });

/**
 * A sword, a staff, an axe or a cleaver: a few boxes along the hand's +y, the way the
 * `Sword_Attack` clip carries a blade. The grip is the origin, so the fist lands on it.
 */
export function createWeapon(kind: string): Group {
  const weapon = new Group();
  weapon.name = `weapon-${kind}`;
  const part = (
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material = steel,
  ): void => {
    const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = true;
    weapon.add(mesh);
  };
  if (kind === "staff") part([0.05, 1.5, 0.05], [0, 0.45, 0], propMaterial);
  else if (kind === "axe") {
    part([0.05, 0.9, 0.05], [0, 0.3, 0], propMaterial);
    part([0.04, 0.2, 0.22], [0, 0.72, 0.08]);
  } else if (kind === "cleaver") {
    part([0.05, 0.25, 0.05], [0, 0.05, 0], propMaterial);
    part([0.03, 0.5, 0.16], [0, 0.38, 0.05]);
  } else {
    part([0.05, 0.2, 0.05], [0, 0, 0], propMaterial);
    part([0.24, 0.04, 0.05], [0, 0.12, 0]);
    part([0.04, 0.8, 0.09], [0, 0.55, 0]);
  }
  return weapon;
}

/** The tint a figure wears: a skinned mesh swaps its material, so the weapon keeps its own. */
export function dress(rig: Object3D, tint: number): void {
  const material = new MeshStandardMaterial({ color: tint, roughness: 0.6 });
  rig.traverse((object) => {
    const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
    if (mesh.isSkinnedMesh === true) mesh.material = material;
  });
}

/** A flat ring on the floor under a figure. Blue marks the leader, red the target. */
export function createRing(colour: number, inner: number, outer: number): Mesh {
  const ring = new Mesh(
    new RingGeometry(inner, outer, 32).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      color: colour,
      depthWrite: false,
      opacity: 0.85,
      side: DoubleSide,
      transparent: true,
    }),
  );
  ring.position.y = 0.04;
  ring.renderOrder = 1;
  return ring;
}

/** A floating diamond over a villager who has something to say. */
export function createTalkMarker(): Mesh {
  const marker = new Mesh(
    new OctahedronGeometry(0.16),
    new MeshStandardMaterial({ color: 0x2a6cf0, emissive: 0x1b4bb0 }),
  );
  marker.name = "talk-marker";
  marker.scale.y = 1.5;
  marker.position.y = 2.25;
  return marker;
}

/** The training post: a pole and a crossbar. A placeable, so it has no Dexterity and never strikes back. */
export function createPost(): Group {
  const post = new Group();
  post.name = "training-post";
  const pole = new Mesh(new CylinderGeometry(0.16, 0.2, 1.7, 12), propMaterial);
  pole.position.y = 0.85;
  const bar = new Mesh(new BoxGeometry(0.9, 0.14, 0.14), propMaterial);
  bar.position.y = 1.4;
  const base = new Mesh(new CylinderGeometry(0.5, 0.55, 0.12, 16), structureMaterial);
  base.position.y = 0.06;
  for (const part of [pole, bar, base]) {
    part.castShadow = true;
    part.receiveShadow = true;
    post.add(part);
  }
  return post;
}

/** A tent: a four-sided cone on a flat base. */
export function createTent(radius: number): Mesh {
  const tent = new Mesh(
    new ConeGeometry(radius, radius * 1.1, 4, 1, false, Math.PI / 4),
    structureMaterial,
  );
  tent.position.y = (radius * 1.1) / 2;
  tent.castShadow = true;
  tent.receiveShadow = true;
  return tent;
}

/** The camp fire: a stone ring and one emissive flame block. */
export function createFire(): Group {
  const fire = new Group();
  fire.name = "camp-fire";
  const stones = new Mesh(new CylinderGeometry(0.7, 0.8, 0.18, 14), structureMaterial);
  stones.position.y = 0.09;
  stones.receiveShadow = true;
  const flame = new Mesh(
    new ConeGeometry(0.35, 0.8, 8),
    new MeshStandardMaterial({ color: 0xe8b86a, emissive: 0xd0532a, emissiveIntensity: 1.4 }),
  );
  flame.position.y = 0.55;
  fire.add(stones, flame);
  return fire;
}

/** A disc on the floor that tells where the leader stands in the follow order. */
export function createShadowDisc(radius: number): Mesh {
  const disc = new Mesh(
    new CircleGeometry(radius, 20).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ color: 0x000000, depthWrite: false, opacity: 0.25, transparent: true }),
  );
  disc.position.y = 0.03;
  return disc;
}
