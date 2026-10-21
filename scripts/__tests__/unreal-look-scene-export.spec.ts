import { describe, expect, it } from "vitest";
import {
  type ISceneJson,
  checkReadback,
  folderName,
  readGlbJson,
  sceneNames,
  validateSceneExport,
} from "../unreal-look/gi.js";

function glb(json: unknown): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const out = new Uint8Array(20 + padded.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  return out;
}

function fixture(): { scene: ISceneJson; gltf: ReturnType<typeof readGlbJson> } {
  const material = {
    name: "MI_Red",
    baseColor: [0.63, 0.065, 0.05] as [number, number, number],
    roughness: 1,
    metallic: 0,
    emissive: [0, 0, 0] as [number, number, number],
    emissiveStrength: 1,
  };
  const scene: ISceneJson = {
    scene: "test",
    resolution: [1280, 720],
    meshes: [
      {
        name: "Wall_Red",
        class: "StaticMeshActor",
        position: [-2.85, 2.75, -2.85],
        rotationYDeg: 17,
        size: [0.2, 5.9, 5.7],
        material,
      },
    ],
    lights: [
      {
        name: "Lamp",
        class: "PointLight",
        position: [0, 4.9, -2.75],
        intensity: 16000,
        units: "lumens",
        attenuationRadiusM: 20,
        sourceRadiusM: 0.05,
      },
    ],
    exposure: { ev100: 3, exposureScale: 0.0225 },
    poses: [{ name: "cornell", position: [0, 2.75, 8], target: [0, 2.75, -2.75], hfovDeg: 70 }],
    regions: { Wall_Red: [255, 0, 0] },
  };
  const half = (17 * Math.PI) / 360;
  const gltf = readGlbJson(
    glb({
      asset: { version: "2.0" },
      nodes: [
        {
          name: "Wall_Red",
          translation: [-2.85, 2.75, -2.85],
          rotation: [0, Math.sin(half), 0, Math.cos(half)],
          children: [1],
        },
        { name: "StaticMeshComponent0", mesh: 0 },
      ],
      meshes: [{ primitives: [{ material: 0 }] }],
      materials: [
        {
          name: "MI_Red",
          pbrMetallicRoughness: {
            baseColorFactor: [0.63, 0.065, 0.05, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        },
      ],
    }),
  );
  return { scene, gltf };
}

describe("GI calibration scene export (PRD-638 AC-3)", () => {
  it("accepts a scene.json and scene.glb that describe the same actors", () => {
    const { scene, gltf } = fixture();
    expect(() => validateSceneExport(scene, gltf)).not.toThrow();
  });

  it("checks a tilt about +X against scene.glb (PRD-649 ramps)", () => {
    const { scene, gltf } = fixture();
    const half = (15 * Math.PI) / 360;
    Object.assign(scene.meshes[0] ?? {}, { rotationYDeg: 0, rotationXDeg: 15 });
    const node = gltf.nodes?.[0] ?? {};
    node.rotation = [Math.sin(half), 0, 0, Math.cos(half)];
    expect(() => validateSceneExport(scene, gltf)).not.toThrow();
    node.rotation = [-Math.sin(half), 0, 0, Math.cos(half)];
    expect(() => validateSceneExport(scene, gltf)).toThrow(/Wall_Red: rotation differs/);
  });

  it("fails on a mesh that scene.glb lacks, naming the actor", () => {
    const { scene, gltf } = fixture();
    gltf.nodes = [];
    expect(() => validateSceneExport(scene, gltf)).toThrow(
      /Wall_Red: in scene.json, missing in scene.glb/,
    );
  });

  it("fails on a mesh that scene.json lacks", () => {
    const { scene, gltf } = fixture();
    gltf.nodes?.push({ name: "Stray", mesh: 0 });
    gltf.nodes?.push({ name: "Stray2", mesh: 1 });
    expect(() => validateSceneExport(scene, gltf)).toThrow(
      /Stray2: in scene.glb, missing in scene.json/,
    );
  });

  it("fails on an unknown light class, naming the actor", () => {
    const { scene, gltf } = fixture();
    Object.assign(scene.lights[0] ?? {}, { class: "SkyLight" });
    expect(() => validateSceneExport(scene, gltf)).toThrow(/Lamp: unknown light class SkyLight/);
  });

  it("fails on an intensity without a unit", () => {
    const { scene, gltf } = fixture();
    Object.assign(scene.lights[0] ?? {}, { units: "unitless" });
    expect(() => validateSceneExport(scene, gltf)).toThrow(/Lamp: intensity has no unit/);
  });

  it("accepts a spot light with a target and cones, and fails on one without", () => {
    const { scene, gltf } = fixture();
    Object.assign(scene.lights[0] ?? {}, { class: "SpotLight" });
    expect(() => validateSceneExport(scene, gltf)).toThrow(/Lamp: a spot light needs a target/);
    Object.assign(scene.lights[0] ?? {}, { target: [0, 0, 0], innerConeDeg: 20, outerConeDeg: 35 });
    expect(() => validateSceneExport(scene, gltf)).not.toThrow();
    Object.assign(scene.lights[0] ?? {}, { innerConeDeg: 40 });
    expect(() => validateSceneExport(scene, gltf)).toThrow(/inner < outer cone/);
  });

  it("fails when a material or a transform differs", () => {
    const { scene, gltf } = fixture();
    Object.assign(scene.meshes[0]?.material ?? {}, { roughness: 0.5 });
    expect(() => validateSceneExport(scene, gltf)).toThrow(/Wall_Red: material MI_Red differs/);
    const second = fixture();
    Object.assign(second.scene.meshes[0] ?? {}, { position: [0, 0, 0] });
    expect(() => validateSceneExport(second.scene, second.gltf)).toThrow(
      /Wall_Red: position differs/,
    );
  });

  it("rejects a file that is not a binary glTF", () => {
    expect(() => readGlbJson(new Uint8Array(32))).toThrow(/not a binary glTF/);
  });
});

describe("GI capture plumbing", () => {
  it("reads the GI level of every job back from the log and fails closed", () => {
    const line = (v: number) =>
      `LogConsoleResponse: r.Lumen.FinalGatherMethod = "${v}"   LastSetBy: Scalability\n`;
    expect(checkReadback(line(1) + line(1), { "r.Lumen.FinalGatherMethod": 1 }, 2)).toEqual([]);
    expect(checkReadback(line(1), { "r.Lumen.FinalGatherMethod": 1 }, 2)).toEqual([
      "r.Lumen.FinalGatherMethod printed 1/2 times",
    ]);
    expect(checkReadback(line(1) + line(0), { "r.Lumen.FinalGatherMethod": 1 }, 2)).toEqual([
      "r.Lumen.FinalGatherMethod = 0 (expected 1)",
    ]);
  });

  it("selects scenes by name and rejects unknown ones", () => {
    expect(sceneNames("gi", ["cornell", "sunlit-room"])).toEqual(["cornell", "sunlit-room"]);
    expect(sceneNames("gi:cornell", ["cornell"])).toEqual(["cornell"]);
    expect(() => sceneNames("gi:nope", ["cornell"])).toThrow(/unknown GI scene nope/);
  });

  it("names run folders the way gi/export.py writes them", () => {
    expect(folderName("L7-Epic", 90, 1)).toBe("L7-Epic");
    expect(folderName("L7-Epic", 180, 2)).toBe("L7-Epic@180#2");
  });
});
