// The ship, the enemies and the boss: boxes, cones and spheres on the two grid materials. No asset.
import {
  BoxGeometry,
  type BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { propMaterial, structureMaterial, worldGridUVs } from "./materials.js";
import { palette } from "./palette.js";

type Vec3 = readonly [number, number, number];
type Part = readonly [geometry: BufferGeometry, at: Vec3, turn?: Vec3];

/** Boxes and cones placed in the ship's own space, merged into one mesh and mapped to the metre grid. */
function hull(parts: readonly Part[], material: MeshStandardMaterial): Mesh {
  const placed = parts.map(([geometry, at, turn = [0, 0, 0] as const]) => {
    const copy = geometry
      .clone()
      .applyMatrix4(
        new Matrix4()
          .makeRotationFromEuler(new Euler(turn[0], turn[1], turn[2]))
          .setPosition(at[0], at[1], at[2]),
      );
    return copy.index === null ? copy : copy.toNonIndexed();
  });
  const mesh = new Mesh(worldGridUVs(mergeGeometries(placed, false)), material);
  mesh.castShadow = true;
  return mesh;
}

/** Hot exhaust and eyes: unlit, so bloom picks them up. */
export const glowMaterial = new MeshBasicMaterial({ color: 0x9fd8ff });
export const hostileGlowMaterial = new MeshBasicMaterial({ color: 0xff8a4d });
/** Enemy trim: the one warm colour. */
export const hostileMaterial = new MeshStandardMaterial({
  color: palette.hostile,
  roughness: 0.45,
});

const box = (x: number, y: number, z: number): BoxGeometry => new BoxGeometry(x, y, z);
/** A cone that points down -Z, the way every ship in this kit faces. */
const nose = (radius: number, length: number): ConeGeometry => new ConeGeometry(radius, length, 6);

/** The player's ship. It faces -Z; `Ship` rolls the whole group. */
export function createShipModel(): Group {
  const group = new Group();
  group.name = "ship-model";
  group.add(
    hull(
      [
        [box(0.7, 0.5, 3), [0, 0, 0.2]],
        [nose(0.36, 1.5), [0, 0, -2], [-Math.PI / 2, 0, 0]],
        [box(2.3, 0.1, 1.5), [1.5, -0.05, 0.6], [0, 0.45, 0.06]],
        [box(2.3, 0.1, 1.5), [-1.5, -0.05, 0.6], [0, -0.45, -0.06]],
        [box(0.1, 0.9, 0.9), [0, 0.6, 1.4], [0.3, 0, 0]],
      ],
      structureMaterial,
    ),
    hull(
      [
        [new SphereGeometry(0.36, 10, 8), [0, 0.32, -0.5]],
        [box(0.18, 0.18, 0.9), [2.55, -0.05, 1.05]],
        [box(0.18, 0.18, 0.9), [-2.55, -0.05, 1.05]],
      ],
      propMaterial,
    ),
  );
  for (const x of [-0.25, 0.25]) {
    const flame = new Mesh(new ConeGeometry(0.16, 0.9, 6), glowMaterial);
    flame.position.set(x, 0, 2.1);
    flame.rotation.x = Math.PI / 2;
    flame.name = "exhaust";
    group.add(flame);
  }
  return group;
}

/** A scout: a red-nosed dart that is small and quick. It faces -Z; the path turns it. */
export function createScoutModel(): Group {
  const group = new Group();
  group.name = "scout-model";
  group.add(
    hull(
      [
        [box(0.9, 0.45, 2.2), [0, 0, 0.2]],
        [box(2.6, 0.1, 1.1), [1.2, 0, 0.5], [0, 0.6, 0]],
        [box(2.6, 0.1, 1.1), [-1.2, 0, 0.5], [0, -0.6, 0]],
      ],
      structureMaterial,
    ),
    hull([[nose(0.4, 1.4), [0, 0, -1.7], [-Math.PI / 2, 0, 0]]], hostileMaterial),
  );
  const eye = new Mesh(new SphereGeometry(0.2, 8, 6), hostileGlowMaterial);
  eye.position.set(0, 0.3, -0.6);
  group.add(eye);
  return group;
}

/** A gunship: wide, slow, tough. */
export function createGunshipModel(): Group {
  const group = new Group();
  group.name = "gunship-model";
  group.add(
    hull(
      [
        [box(2.4, 1.1, 4.6), [0, 0, 0]],
        [box(5.6, 0.2, 2), [0, -0.1, 0.8]],
        [new CylinderGeometry(0.6, 0.6, 3.2, 8), [2.8, 0, -0.2], [Math.PI / 2, 0, 0]],
        [new CylinderGeometry(0.6, 0.6, 3.2, 8), [-2.8, 0, -0.2], [Math.PI / 2, 0, 0]],
      ],
      structureMaterial,
    ),
    hull(
      [
        [nose(0.9, 2), [0, 0, -3.2], [-Math.PI / 2, 0, 0]],
        [box(0.4, 0.4, 1.6), [2.8, 0.7, -1.4]],
        [box(0.4, 0.4, 1.6), [-2.8, 0.7, -1.4]],
      ],
      hostileMaterial,
    ),
  );
  const eye = new Mesh(new SphereGeometry(0.4, 8, 6), hostileGlowMaterial);
  eye.position.set(0, 0.7, -1.5);
  group.add(eye);
  return group;
}

export interface IBossModel {
  readonly group: Group;
  readonly pods: readonly [Group, Group];
  readonly core: Mesh;
  readonly plates: readonly [Mesh, Mesh];
}

/** The Warden: a slab with two gun pods, a core and two plates that cover the core until the pods fall. */
export function createBossModel(): IBossModel {
  const group = new Group();
  group.name = "boss-model";
  group.add(
    hull(
      [
        [box(11, 2.4, 6), [0, 0, 0]],
        [box(1.2, 5, 1.2), [-5.2, 0, 0.8]],
        [box(1.2, 5, 1.2), [5.2, 0, 0.8]],
        [new TorusGeometry(4.6, 0.35, 6, 20), [0, 0, -3.1]],
      ],
      structureMaterial,
    ),
  );
  const pod = (x: number): Group => {
    const pod = new Group();
    pod.position.set(x, 0, -1.6);
    pod.add(hull([[new OctahedronGeometry(2.2), [0, 0, 0]]], hostileMaterial));
    const barrel = hull([[box(0.5, 0.5, 3), [0, 0, -2.4]]], structureMaterial);
    pod.add(barrel);
    return pod;
  };
  const pods: [Group, Group] = [pod(-7), pod(7)];
  group.add(...pods);
  const core = new Mesh(new SphereGeometry(2.6, 16, 12), hostileGlowMaterial);
  core.position.set(0, 0, -3.1);
  group.add(core);
  const plate = (x: number): Mesh => {
    const mesh = hull([[box(2.7, 5.6, 0.7), [0, 0, 0]]], structureMaterial);
    mesh.position.set(x, 0, -4.4);
    return mesh;
  };
  const plates: [Mesh, Mesh] = [plate(-1.35), plate(1.35)];
  group.add(...plates);
  return { group, pods, core, plates };
}

const ringMaterial = new MeshStandardMaterial({
  color: palette.accent,
  emissive: palette.accent,
  emissiveIntensity: 1.4,
  roughness: 0.4,
});

/** A shield ring: fly through it to repair. */
export function createShieldRing(): Mesh {
  const ring = new Mesh(new TorusGeometry(2.4, 0.28, 8, 28), ringMaterial);
  ring.name = "shield-ring";
  return ring;
}
