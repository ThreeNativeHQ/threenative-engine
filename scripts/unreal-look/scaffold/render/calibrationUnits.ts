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
}

/**
 * Unreal light units to three's. three's punctual light intensity is candela, and its Lambert
 * BRDF carries the same 1 / pi as Unreal's (Engine/Shaders/Private/BRDF.ush, Diffuse_Lambert), so
 * the falloff and the window at the attenuation radius map one to one. A sun in lux is not a
 * punctual light: the template scenes take it through `SUN_ILLUMINANCE` (`atmosphere.ts`).
 */
export function candela(intensity: number, units: string): number {
  if (units === "candelas") return intensity;
  // An unshaded point light spreads its lumens over the whole sphere (PointLightComponent.cpp).
  if (units === "lumens") return intensity / (4 * Math.PI);
  throw new Error(`TN_CALIBRATION_SCENE_UNIT: ${units}`);
}

/** The candela of a light the loader builds; any other class fails the load. */
export function lightCandela(light: ICalibrationLight): number {
  if (light.class !== "PointLight" && light.class !== "SpotLight")
    throw new Error(`TN_CALIBRATION_SCENE_LIGHT: ${light.name} ${light.class}`);
  return candela(light.intensity, light.units);
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

/** The scale of a keyed light at a frame: constant from each key to the next, as the Unreal track is. */
export function lightScale(keys: number[][], frame: number): number {
  let scale = keys[0]?.[1] ?? 1;
  for (const [at = 0, value = 1] of keys) if (at <= frame) scale = value;
  return scale;
}
