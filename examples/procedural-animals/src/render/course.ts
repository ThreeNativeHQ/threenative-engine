import type { ICtx } from "@threenative/core";
import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import type { IPhysicsContext } from "@threenative/physics";
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from "three";
import { WebGPURenderer } from "three/webgpu";
import { releaseAll } from "../cleanup.js";

export function slopedFloorGround(
  floor: Mesh,
  fallback: (x: number, z: number) => number,
): (x: number, z: number) => number {
  const geometry = floor.geometry;
  if (!(geometry instanceof BoxGeometry)) return fallback;
  floor.updateMatrixWorld(true);
  const inverse = floor.matrixWorld.clone().invert();
  const normal = new Vector3(0, 1, 0).transformDirection(floor.matrixWorld);
  const height = geometry.parameters.height / 2;
  const origin = new Vector3(0, height, 0).applyMatrix4(floor.matrixWorld);
  const sample = new Vector3();
  const local = new Vector3();
  return (x: number, z: number) => {
    if (!Number.isFinite(normal.y) || normal.y <= 1e-6) return fallback(x, z);
    const y = origin.y - (normal.x * (x - origin.x) + normal.z * (z - origin.z)) / normal.y;
    sample.set(x, y, z);
    local.copy(sample).applyMatrix4(inverse);
    if (
      ![sample.x, sample.y, sample.z, local.x, local.y, local.z].every(Number.isFinite) ||
      Math.abs(local.x) > geometry.parameters.width / 2 ||
      Math.abs(local.z) > geometry.parameters.depth / 2 ||
      Math.abs(local.y - height) > 1e-3
    )
      return fallback(x, z);
    return y;
  };
}

export function course<TState extends Record<string, unknown>>(
  ctx: ICtx<TState, IPhysicsContext>,
  warmShadow = false,
) {
  if (!(ctx.renderer.raw instanceof WebGPURenderer)) throw new Error("TN_ANIMAL_WEBGPU_REQUIRED");
  ctx.renderer.raw.shadowMap.enabled = true;
  ctx.scene.background = new Color(0xc7d4df);
  const camera = ctx.camera as PerspectiveCamera;
  camera.position.set(15, 13, 23);
  camera.lookAt(0, 0, -3);
  const ambient = new AmbientLight(0xffffff, 1.2);
  const sun = new DirectionalLight(0xffefd7, 3);
  sun.position.set(8, 15, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -24,
    right: 24,
    top: 24,
    bottom: -24,
    near: 0.1,
    far: 80,
  });
  // Game-authored metre squares keep the sloped course readable in the outside view.
  const floorGeometry = new BoxGeometry(40, 0.5, 40);
  const floorMap = new DataTexture(
    new Uint8Array([102, 116, 99, 255, 170, 181, 158, 255, 170, 181, 158, 255, 102, 116, 99, 255]),
    2,
    2,
  );
  floorMap.wrapS = floorMap.wrapT = RepeatWrapping;
  floorMap.repeat.set(floorGeometry.parameters.width / 2, floorGeometry.parameters.depth / 2);
  floorMap.magFilter = floorMap.minFilter = LinearFilter;
  floorMap.colorSpace = SRGBColorSpace;
  floorMap.needsUpdate = true;
  const floor = new Mesh(floorGeometry, new MeshStandardMaterial({ map: floorMap, roughness: 1 }));
  floor.name = "sloped-floor";
  floor.position.set(0, -0.25, -2);
  floor.rotation.z = Math.atan(0.1);
  floor.receiveShadow = true;
  const wall = new Mesh(
    new BoxGeometry(24, 3, 0.5),
    new MeshStandardMaterial({ color: 0x858d96, roughness: 0.9 }),
  );
  wall.name = "stop-wall";
  wall.position.set(0, 1.3, -10);
  wall.receiveShadow = true;
  wall.castShadow = warmShadow; // Lifecycle baseline draws the shared shadow target before animals exist.
  const releases = [
    () => ambient.removeFromParent(),
    () => sun.removeFromParent(),
    () => sun.target.removeFromParent(),
    () => floor.removeFromParent(),
    () => wall.removeFromParent(),
    () => floor.geometry.dispose(),
    () => floorMap.dispose(),
    () => wall.geometry.dispose(),
    () => (floor.material as MeshStandardMaterial).dispose(),
    () => (wall.material as MeshStandardMaterial).dispose(),
    () => sun.dispose(),
  ];
  const cleanup = () => releaseAll(releases.splice(0).reverse());
  try {
    for (const object of [ambient, sun, sun.target, floor, wall]) ctx.add(object);
    for (const [index, object] of [floor, wall].entries()) {
      const body = new RigidBody3D({
        object,
        physics: ctx.physics,
        shape: CollisionShape3D.fromMesh(object),
        type: "fixed",
        collisionLayer: index === 0 ? 1 : 4,
        collisionMask: 0xffff,
      });
      releases.push(() => body.dispose());
    }
  } catch (error) {
    try {
      cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "TN_ANIMAL_COURSE_FAILED");
    }
    throw error;
  }
  return cleanup;
}
