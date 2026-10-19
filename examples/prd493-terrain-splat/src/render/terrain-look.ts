/**
 * The look of this example's world: the sky, the sun and where the camera stands. Everything about
 * how the terrain is textured comes from the package's own table and the recipe that wrote it.
 */
import {
  Color,
  type DirectionalLight,
  HemisphereLight,
  type PerspectiveCamera,
  Vector3,
} from "three";

export const SKY_COLOR = 0x0b1a2a;
export const START_POSITION: readonly [number, number, number] = [26, 9, 26];
export const LOOK_AT: readonly [number, number, number] = [-4, 0, -4];

/**
 * `?pose=close`: over the gradient where layer-14 gives way to layer-15, low sun from the
 * side, so the transition band and its relief fill the frame. Both arms of a capture share it.
 */
export const CLOSE_POSE = {
  position: new Vector3(-31.5, 1, 0.6),
  sun: new Vector3(-30, 6, -40),
  target: new Vector3(-31.5, -2.3, 0),
} as const;

/** A slow orbit, so a playtest capture and a judge's screenshot share one repeatable pose. */
export function orbitPose(seconds: number): {
  readonly position: Vector3;
  readonly target: Vector3;
} {
  const angle = 0.55 + seconds * 0.06;
  return {
    position: new Vector3(Math.cos(angle) * 34, 11, Math.sin(angle) * 34),
    target: new Vector3(...LOOK_AT),
  };
}

export function addDaylight(
  scene: { add: (node: HemisphereLight | DirectionalLight) => void },
  sun: DirectionalLight,
): HemisphereLight {
  const sky = new HemisphereLight(0xbfd8ff, 0x2a2f22, 2.4);
  sun.color = new Color(0xfff3e0);
  sun.intensity = 2.8;
  sun.position.set(-60, 90, 40);
  scene.add(sky);
  scene.add(sun);
  return sky;
}

/** Point the camera at the one pose both arms of a capture share. */
export function frameTerrain(camera: PerspectiveCamera): void {
  const pose = orbitPose(0);
  camera.position.copy(pose.position);
  camera.lookAt(pose.target);
}
