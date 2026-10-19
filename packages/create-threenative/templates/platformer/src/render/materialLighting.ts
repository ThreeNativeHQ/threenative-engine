// Generated for you. Scene-owned material assignments; no engine appearance hooks.
import {
  type Camera,
  type DirectionalLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Scene,
  type Texture,
} from "three";
import { type IBacklightControls, backlightMaterial } from "./backlightMaterial.js";
import {
  type IEnvironmentMeasurement,
  measureEnvironment,
  reportEnvironmentContribution,
} from "./environmentContribution.js";
import {
  type IEnvironmentSourceSnapshot,
  captureEnvironmentSnapshot,
  environmentSnapshotCurrent,
} from "./environmentSnapshot.js";
import { type ILightingConvention, createLightingConvention } from "./lighting.js";
import { createMaterialAssignments } from "./materialAssignments.js";
import { type IMaterialLightingEnvironment, materialLightingEnabled } from "./quality.js";
interface IMaterialLightingOptions extends IMaterialLightingEnvironment {
  readonly enabled: boolean;
  readonly overrides?: Partial<ILightingConvention>;
}
/** Call once AFTER the scene's loaded character, arena and props are attached. */
export function createMaterialLighting(
  scene: Scene,
  camera: Camera,
  key: DirectionalLight,
  options: IMaterialLightingOptions,
) {
  const settings = createLightingConvention(options.overrides);
  let enabled = false;
  let disposed = false;
  let fillApproved = false;
  let measured = measureEnvironment(scene, settings.maxSourceTexels);
  let measurementSnapshot = captureEnvironmentSnapshot(scene);
  const controls: IBacklightControls = {
    key,
    scene,
    camera,
    get rimGain() {
      return settings.rimGain;
    },
    set rimGain(value) {
      settings.rimGain = value;
    },
    get fillGain() {
      return settings.fillGain;
    },
    set fillGain(value) {
      settings.fillGain = value;
    },
    fillColor: settings.fillColor,
    fillDirection: settings.fillDirection,
    get fillAngularSize() {
      return settings.fillAngularSize;
    },
    set fillAngularSize(value) {
      settings.fillAngularSize = value;
    },
    get fillAdmitted() {
      return enabled && fillApproved && environmentSnapshotCurrent(scene, measurementSnapshot);
    },
  };
  const assignments = createMaterialAssignments(scene, controls);
  function report() {
    if (!environmentSnapshotCurrent(scene, measurementSnapshot)) {
      measured = measureEnvironment(scene, settings.maxSourceTexels);
      measurementSnapshot = captureEnvironmentSnapshot(scene);
    }
    fillApproved =
      measured.status === "measured" &&
      measured.meanRadiance !== null &&
      measured.meanRadiance <= settings.darkThreshold;
    return reportEnvironmentContribution(
      scene,
      {
        ...settings,
        rimGain: controls.rimGain,
        fillGain: controls.fillGain,
        fillColor: controls.fillColor,
        fillAdmitted: controls.fillAdmitted,
      },
      measured,
    );
  }
  let observation: ReturnType<typeof report>;
  function setEnabled(requested: boolean): void {
    if (disposed) return;
    enabled = requested && materialLightingEnabled("high", options);
    assignments.setEnabled(enabled);
    observation = report();
  }
  setEnabled(options.enabled);
  return {
    controls,
    setEnabled,
    /** Enroll a newly attached game-owned subtree. */
    enroll(root: Object3D): void {
      if (!disposed) assignments.enroll(root);
    },
    /** Restore assignments before removing a subtree or disposing borrowed materials. */
    release(root: Object3D): void {
      if (!disposed) assignments.release(root);
    },
    report() {
      observation = report();
      return observation;
    },
    /** Root's later GPU sampler can provide a measured snapshot of the current environment. */
    setEnvironmentMeasurement(
      measurement: IEnvironmentMeasurement,
      source: Texture | null = scene.environment,
      intensity = scene.environmentIntensity,
      snapshot: IEnvironmentSourceSnapshot = captureEnvironmentSnapshot(scene),
    ): void {
      if (disposed) return;
      if (
        measurement.status === "measured" &&
        (measurement.meanRadiance === null ||
          !Number.isFinite(measurement.meanRadiance) ||
          measurement.meanRadiance < 0 ||
          measurement.meanRGB === null ||
          !measurement.meanRGB.every((value) => Number.isFinite(value) && value >= 0))
      )
        throw new Error("Measured environment radiance must be finite and nonnegative.");
      if (
        source !== snapshot.source ||
        intensity !== snapshot.intensity ||
        !environmentSnapshotCurrent(scene, snapshot)
      )
        return;
      measured = measurement;
      measurementSnapshot = snapshot;
      observation = report();
    },
    debug: () => ({
      ...observation,
      enabled,
      ...assignments.debug(),
    }),
    dispose(): void {
      if (disposed) return;
      enabled = false;
      disposed = true;
      assignments.dispose();
    },
  };
}
