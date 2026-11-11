// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// What the fox collects: a spinning coin, a faceted gem, and the big gold star that ends the run.
// Each is a `Group` whose local origin is its own centre, so a pickup's world position is its
// rotation as well as its bob — and `coinArc` is how a line of coins becomes a jump arc.
import {
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  type Object3D,
  OctahedronGeometry,
  PointLight,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { flat, toon } from "./materials.js";
import { C } from "./palette.js";

const TAU = Math.PI * 2;

/** Spinning coin with an embossed star on both faces. */
export function coin(): Group {
  const group = new Group();
  const disc = new Mesh(new CylinderGeometry(0.42, 0.42, 0.1, 14), toon(C.gold));
  disc.rotation.x = Math.PI / 2;
  disc.castShadow = true;
  group.add(disc);
  group.add(new Mesh(new TorusGeometry(0.42, 0.07, 6, 16), toon(C.goldDark)));
  // One emboss, not two: the rim already reads as a coin from the side, and the sixty coins on
  // this route are the single biggest draw count in the game.
  const star = new Mesh(new CylinderGeometry(0.2, 0.2, 0.02, 5), toon(C.goldDark));
  star.rotation.x = Math.PI / 2;
  star.position.z = 0.07;
  group.add(star);
  return group;
}

/** Blue octahedral gem. */
export function gem(): Group {
  const group = new Group();
  const body = new Mesh(new OctahedronGeometry(0.45), toon(C.gem));
  body.castShadow = true;
  group.add(body);
  const shine = new Mesh(new OctahedronGeometry(0.46), flat(C.gemLight, { opacity: 0.45 }));
  shine.scale.set(0.5, 1, 0.5);
  group.add(shine);
  return group;
}

/** The big collectible star, with the light that makes it read as the goal from a distance. */
export function star(): Group {
  const group = new Group();
  const shape = new Shape();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? 0.62 : 0.27;
    const a = (i / 10) * TAU + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, {
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.07,
    bevelThickness: 0.07,
    depth: 0.18,
  });
  geometry.center();
  const body = new Mesh(geometry, toon(C.gold));
  body.castShadow = true;
  group.add(body);
  group.add(new PointLight(0xffe27a, 8, 6));
  return group;
}

/**
 * A short burst of unlit spheres for a pickup or a stomp.
 *
 * Returns the per-frame step and `true` once it is finished, so the scene owns one list of live
 * effects instead of a timer per particle. The geometry is disposed on the way out: a route with
 * two hundred pickups in it would otherwise hold two hundred dead geometries alive.
 */
export function burst(
  scene: Object3D,
  position: Vector3,
  color: number,
  count = 12,
): (dt: number) => boolean {
  const group = new Group();
  group.position.copy(position);
  const material = flat(color);
  const bits: Mesh[] = [];
  for (let i = 0; i < count; i += 1) {
    const bit = new Mesh(new SphereGeometry(0.09 + Math.random() * 0.07, 5, 4), material);
    const a = Math.random() * TAU;
    bit.userData.v = new Vector3(Math.cos(a) * 3.2, (0.4 + Math.random()) * 4.5, Math.sin(a) * 3.2);
    group.add(bit);
    bits.push(bit);
  }
  scene.add(group);
  let life = 0;
  return (dt: number): boolean => {
    life += dt;
    for (const bit of bits) {
      const v = bit.userData.v as Vector3;
      v.y -= 18 * dt;
      bit.position.addScaledVector(v, dt);
    }
    material.opacity = Math.max(0, 1 - life / 0.7);
    if (life <= 0.7) return false;
    scene.remove(group);
    for (const bit of bits) bit.geometry.dispose();
    material.dispose();
    return true;
  };
}

/** An arc of coin positions between two points, for a jump that needs a reward at its top. */
export function coinArc(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  count: number,
  height = 2.2,
): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    out.push(
      new Vector3(
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t + Math.sin(t * Math.PI) * height,
        from[2] + (to[2] - from[2]) * t,
      ),
    );
  }
  return out;
}
