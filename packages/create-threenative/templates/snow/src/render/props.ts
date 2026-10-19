// Generated for you. How the test bodies look. Their size comes from their collision shapes in
// `src/scenes/Snow.ts`; change the look here without touching the physics.
import { BoxGeometry, CapsuleGeometry, Group, Mesh, SphereGeometry, TorusGeometry } from "three";
import type { SnowMaterials } from "./materials.js";

function shadowed<T extends Mesh>(mesh: T): T {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A dark ball with a pale band, so its roll is visible as it carves. */
export function createBall(materials: SnowMaterials, radius: number): Group {
  const ball = new Group();
  ball.add(shadowed(new Mesh(new SphereGeometry(radius, 32, 20), materials.ball)));
  ball.add(
    shadowed(new Mesh(new TorusGeometry(radius * 0.995, radius * 0.08, 8, 48), materials.bough)),
  );
  return ball;
}

export function createCrate(
  materials: SnowMaterials,
  size: { readonly x: number; readonly y: number; readonly z: number },
): Group {
  const crate = new Group();
  crate.add(shadowed(new Mesh(new BoxGeometry(size.x, size.y, size.z), materials.crate)));
  // A drift of snow on the lid.
  const lid = shadowed(
    new Mesh(new BoxGeometry(size.x * 0.92, 0.03, size.z * 0.9), materials.bough),
  );
  lid.position.y = size.y / 2 + 0.012;
  crate.add(lid);
  return crate;
}

/** A felled log: a capsule lying along its spine. */
export function createLog(materials: SnowMaterials, halfHeight: number, radius: number): Group {
  const log = new Group();
  log.add(shadowed(new Mesh(new CapsuleGeometry(radius, halfHeight * 2, 6, 16), materials.log)));
  return log;
}
