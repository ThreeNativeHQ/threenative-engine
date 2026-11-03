// Harness overlay (PRD-646): the pure part of the calibration scene loader. scene.json is already in three's frame
// (Y-up, metres): the Unreal exporter converts the Z-up centimetres (tools/unreal-reference/gi/export.py), and
// `validateSceneExport` checks the result. What is left here is the light units, the motion keys and the
// rule that every actor maps or is reported. `CalibrationScene.ts` imports it.

export type Pose = { position: number[]; target: number[]; hfovDeg: number };

/** A scene.json light, as far as the loader reads it. */
export interface ICalibrationLight {
  name: string;
  class: string;
  intensity: number;
  units: string;
  sourceRadiusM?: number;
  /** A spot light's outer cone angle in degrees, from its axis (Unreal's `OuterConeAngle`). */
  outerConeDeg?: number;
}

/** Unreal's largest spot half cone angle, from `GetClampedConeAngles` (SpotLightComponent.cpp:33-38). */
export const SPOT_HALF_ANGLE_LIMIT_DEG = 88.9;

/**
 * Unreal light units to three's. three's punctual light intensity is candela, and its Lambert
 * BRDF carries the same 1 / pi as Unreal's (Engine/Shaders/Private/BRDF.ush, Diffuse_Lambert), so
 * the falloff and the window at the attenuation radius map one to one. A sun in lux is not a
 * punctual light: the template scenes take it through `SUN_ILLUMINANCE` (`atmosphere.ts`).
 *
 * Lumens divide by the solid angle the light fills, not by 4 pi always: Unreal's conversion is
 * `100^2 / (2 pi (1 - cos halfConeAngle))` in square centimetres (UE 5.8.3:
 * Engine/Source/Runtime/Engine/Private/Components/LocalLightComponent.cpp:180-214), so a point
 * light (no cone, cos = -1) spreads its lumens over the sphere and a spot light fills its cone
 * (UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/SpotLightComponent.cpp:54-98). A
 * spot's angle is the angle from its axis, which is three's `SpotLight.angle`, and Unreal clamps
 * it at 88.9 degrees. The same 600 lumens are 48 candela over the sphere and 3625 down a 10
 * degree cone; the conversion is the whole difference between a dim bulb and a torch.
 */
export function candela(intensity: number, units: string, outerConeDeg?: number): number {
  if (units === "candelas") return intensity;
  if (units === "lumens") {
    const halfAngleRad =
      outerConeDeg === undefined
        ? Math.PI // A point light fills the sphere: 2 pi (1 - cos pi) = 4 pi.
        : (Math.min(outerConeDeg, SPOT_HALF_ANGLE_LIMIT_DEG) * Math.PI) / 180;
    return intensity / (2 * Math.PI * (1 - Math.cos(halfAngleRad)));
  }
  throw new Error(`TN_CALIBRATION_SCENE_UNIT: ${units}`);
}

/** The candela of a light the loader builds; any other class fails the load. */
export function lightCandela(light: ICalibrationLight): number {
  if (light.class !== "PointLight" && light.class !== "SpotLight")
    throw new Error(`TN_CALIBRATION_SCENE_LIGHT: ${light.name} ${light.class}`);
  if (light.class === "SpotLight" && light.units === "lumens" && !light.outerConeDeg)
    throw new Error(`TN_CALIBRATION_SCENE_LIGHT: ${light.name} SpotLight has no outerConeDeg`);
  return candela(light.intensity, light.units, light.outerConeDeg);
}

/** What a light carries that three's punctual light has no field for. `sourceRadiusOff` is the diagnosis knob. */
export function lightUnsupported(
  light: ICalibrationLight,
  sourceRadiusOff = false,
): { actor: string; property: string; reason: string }[] {
  return (light.sourceRadiusM ?? 0) > 0 && !sourceRadiusOff
    ? [
        {
          actor: light.name,
          property: "sourceRadiusM",
          reason: "a punctual light has no area: highlights stay hard (PRD-634)",
        },
      ]
    : [];
}

/** Every mesh maps to a region of scene.json, or the load fails; the first mesh that does not is named. */
export function checkMapped<T extends { name: string }>(
  meshes: readonly T[],
  regionOf: (mesh: T) => string | undefined,
): void {
  for (const mesh of meshes)
    if (regionOf(mesh) === undefined)
      throw new Error(`TN_CALIBRATION_SCENE_UNMAPPED: ${mesh.name}`);
}

export type MotionCamera =
  | {
      kind: "pan";
      position: number[];
      hfovDeg: number;
      pitchDeg?: number;
      headingDeg: number[];
      sweepFrames: number;
    }
  | { kind: "pose"; pose: string };
export type MotionRun = {
  frames: number;
  camera: MotionCamera;
  light?: { name: string; keys: number[][] };
  actor?: { name: string; keys: number[][] };
};

/** The camera of a motion run at a frame, as scene.py keys it: heading 0 looks down -z, a positive heading turns toward +x. */
export function motionPose(
  run: MotionRun,
  frame: number,
  poses: (Pose & { name: string })[],
): Pose {
  const camera = run.camera;
  if (camera.kind === "pose") {
    const found = poses.find((pose) => pose.name === camera.pose);
    if (found === undefined) throw new Error(`TN_CALIBRATION_MOTION_POSE: ${camera.pose}`);
    return found;
  }
  const [first = 0, last = 0] = camera.headingDeg;
  const heading =
    ((first + (last - first) * Math.min(Math.max(frame / camera.sweepFrames, 0), 1)) * Math.PI) /
    180;
  const pitch = ((camera.pitchDeg ?? 0) * Math.PI) / 180;
  const [x = 0, y = 0, z = 0] = camera.position;
  return {
    position: camera.position,
    target: [
      x + Math.sin(heading) * Math.cos(pitch),
      y + Math.sin(pitch),
      z - Math.cos(heading) * Math.cos(pitch),
    ],
    hfovDeg: camera.hfovDeg,
  };
}

/** An actor's offset at a frame, from `[frame, dx, dy, dz]` keys: linear between keys, held outside them (PRD-650 swing). */
export function actorOffset(keys: number[][], frame: number): number[] {
  const first = keys[0] ?? [0, 0, 0, 0];
  if (frame <= (first[0] ?? 0)) return first.slice(1);
  for (let k = 1; k < keys.length; k++) {
    const [a = 0, ...from] = keys[k - 1] ?? [];
    const [b = 0, ...to] = keys[k] ?? [];
    if (frame <= b) return from.map((v, i) => v + ((to[i] ?? v) - v) * ((frame - a) / (b - a)));
  }
  return (keys.at(-1) ?? first).slice(1);
}

/** The scale of a keyed light at a frame: constant from each key to the next, as the Unreal track is. */
export function lightScale(keys: number[][], frame: number): number {
  let scale = keys[0]?.[1] ?? 1;
  for (const [at = 0, value = 1] of keys) if (at <= frame) scale = value;
  return scale;
}
