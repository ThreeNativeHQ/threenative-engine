// Every prop is a few boxes: no asset. The rifle and the grenade are boxes and a ball.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
} from "three";

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

/** Five boxes that read as a rifle at soldier distance. The grip is the origin, so the fist lands on it. */
export function createRifle(): Group {
  const rifle = new Group();
  rifle.name = "rifle";
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

/** The soldiers' uniform: an olive drab that separates them from the pale grid floor. */
export const soldierMaterial = new MeshStandardMaterial({ color: 0x5b6b4e, roughness: 0.6 });

/** A fragmentation grenade: one dark ball and a lever. */
export function createGrenade(): Group {
  const grenade = new Group();
  grenade.name = "grenade";
  const body = new Mesh(new SphereGeometry(0.06, 12, 8), gunmetal);
  body.castShadow = true;
  grenade.add(body);
  const lever = new Mesh(new BoxGeometry(0.02, 0.07, 0.03), gunmetal);
  lever.position.set(0.04, 0.05, 0);
  grenade.add(lever);
  return grenade;
}

/**
 * Swap the skin material on a cloned rig, so one asset dresses every soldier. Only
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

/** A rifle round's streak: one bright segment a soldier shows for a few frames per shot. */
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
