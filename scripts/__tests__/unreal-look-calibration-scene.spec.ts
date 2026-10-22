import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readScene, validateSceneExport } from "../unreal-look/gi.js";
import { SUN_ILLUMINANCE } from "../unreal-look/scaffold/render/atmosphere.js";
import {
  type MotionRun,
  candela,
  checkMapped,
  lightCandela,
  lightScale,
  lightUnsupported,
  motionPose,
} from "../unreal-look/scaffold/render/calibrationUnits.js";

const lamp = {
  name: "Lamp",
  class: "PointLight",
  intensity: 16000,
  units: "lumens",
  sourceRadiusM: 0.05,
};

describe("calibration scene units (PRD-646)", () => {
  it("spreads an unshaded point light's lumens over the sphere and keeps candela as it is", () => {
    expect(candela(4 * Math.PI, "lumens")).toBeCloseTo(1, 12);
    expect(candela(16000, "lumens")).toBeCloseTo(1273.239544735163, 9);
    expect(candela(500, "candelas")).toBe(500);
  });

  it("fails a unit it does not know, lux included: a sun is not a punctual light", () => {
    expect(() => candela(6, "lux")).toThrow("TN_CALIBRATION_SCENE_UNIT: lux");
    // The template scenes take their sun through one constant: Unreal's 6 lux is pi times that in three's Lambert.
    expect(SUN_ILLUMINANCE).toBeCloseTo(6 * Math.PI, 12);
  });

  it("fails a light class the loader does not build", () => {
    expect(lightCandela(lamp)).toBeCloseTo(1273.2395, 3);
    expect(() => lightCandela({ ...lamp, name: "Sun", class: "DirectionalLight" })).toThrow(
      "TN_CALIBRATION_SCENE_LIGHT: Sun DirectionalLight",
    );
    expect(() => lightCandela({ ...lamp, class: "RectLight" })).toThrow(
      "TN_CALIBRATION_SCENE_LIGHT",
    );
  });

  it("reports a light's source radius, which three's punctual light cannot carry", () => {
    expect(lightUnsupported(lamp)).toEqual([
      { actor: "Lamp", property: "sourceRadiusM", reason: expect.stringContaining("PRD-634") },
    ]);
    expect(lightUnsupported({ ...lamp, sourceRadiusM: 0 })).toEqual([]);
    expect(lightUnsupported({ ...lamp, sourceRadiusM: undefined })).toEqual([]);
    // The diagnosis knob ?sourceRadius=0 leaves the radius out on purpose, so nothing is reported.
    expect(lightUnsupported(lamp, true)).toEqual([]);
  });

  it("fails the load on a mesh that maps to no region, and names it", () => {
    const regions = new Map([["Floor", "Floor"]]);
    const of = (mesh: { name: string }) => regions.get(mesh.name);
    expect(() => checkMapped([{ name: "Floor" }], of)).not.toThrow();
    expect(() => checkMapped([{ name: "Floor" }, { name: "Stray" }], of)).toThrow(
      "TN_CALIBRATION_SCENE_UNMAPPED: Stray",
    );
  });

  it("reaches every light and mesh of every committed scene through the loader's rules", () => {
    for (const name of ["gi:cornell", "gi:neon-corridor", "shadow:lamp-room"]) {
      const { scene, gltf } = readScene(name);
      expect(() => validateSceneExport(scene, gltf)).not.toThrow();
      for (const light of scene.lights) expect(lightCandela(light)).toBeGreaterThan(0);
      const regions = new Set(Object.keys(scene.regions));
      expect(() =>
        checkMapped(scene.meshes, (mesh) =>
          regions.has(mesh.region ?? mesh.name) ? mesh.name : undefined,
        ),
      ).not.toThrow();
    }
  });

  it("stays in metres: the exporter converts Unreal's centimetres, and the loader never scales a place", () => {
    const { scene } = readScene("gi:cornell");
    const lampPlace = scene.lights[0]?.position ?? [];
    // Unreal (cm, Z-up) holds the lamp at (0, 275, 490); scene.json holds x, z, -y in metres.
    expect(lampPlace).toEqual([0, 4.9, -2.75]);
    const source = readFileSync("scripts/unreal-look/scaffold/CalibrationScene.ts.in", "utf8");
    expect(source).toContain("point.position.fromArray(light.position)");
  });
});

describe("calibration scene motion (PRD-646)", () => {
  const poses = [{ name: "window", position: [0, 1, 2], target: [0, 1, 0], hfovDeg: 60 }];
  const pan: MotionRun = {
    frames: 180,
    camera: {
      kind: "pan",
      position: [0, 1.6, 0],
      hfovDeg: 70,
      headingDeg: [0, 90],
      sweepFrames: 90,
    },
  };

  it("turns the heading across the sweep, then holds it", () => {
    expect(motionPose(pan, 0, poses).target).toEqual([0, 1.6, -1]);
    const half = motionPose(pan, 45, poses).target;
    expect(half[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(half[2]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(motionPose(pan, 179, poses).target[0]).toBeCloseTo(1, 12);
  });

  it("takes a named pose, and fails an unknown one", () => {
    expect(motionPose({ frames: 1, camera: { kind: "pose", pose: "window" } }, 0, poses)).toBe(
      poses[0],
    );
    expect(() => motionPose({ frames: 1, camera: { kind: "pose", pose: "x" } }, 0, poses)).toThrow(
      "TN_CALIBRATION_MOTION_POSE: x",
    );
  });

  it("holds a light key until the next key, as the Unreal track does", () => {
    const keys = [
      [0, 1],
      [60, 0],
      [120, 1],
    ];
    expect([0, 59, 60, 119, 120, 179].map((f) => lightScale(keys, f))).toEqual([1, 1, 0, 0, 1, 1]);
  });
});
