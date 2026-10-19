import {
  BoxGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  type Texture,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  UNLIT_FOLIAGE_MARKER,
  formatUnlitFoliageWarning,
  unlitFoliageWarning,
} from "../src/profiling/unlit-foliage-warning.js";

/**
 * A leaf card as a GLB's `BLEND` material arrives, in the Node variant three's WebGPU path uses.
 * The scene only has a hemisphere fill behind it, which is the state that renders as paperboard.
 */
function needleCard(name: string, overrides: Partial<Material> = {}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ name, ...overrides });
  material.alphaTest = 0.5;
  material.side = DoubleSide;
  return material;
}

function leafMesh(name: string, material: Material): Mesh {
  const mesh = new Mesh(new BoxGeometry(), material);
  mesh.name = name;
  mesh.visible = true;
  return mesh;
}

function tree(meshes: readonly Object3D[]): Object3D & { environment?: unknown } {
  const root = new Object3D();
  const group = new Group();
  for (const mesh of meshes) group.add(mesh);
  root.add(group);
  return root;
}

describe("unlit foliage", () => {
  it("fires for cutout PBR with no image-based light anywhere in the scene", () => {
    const scene = tree([leafMesh("pine", needleCard("pine-needles"))]);
    expect(scene.environment).toBeUndefined();

    expect(unlitFoliageWarning(scene)).toEqual({
      examples: ["pine-needles"],
      materials: 1,
      meshes: 1,
    });
  });

  it("counts a physical material and the Node variant WebGPU draws with", () => {
    const bark = new MeshPhysicalMaterial({ name: "bark" });
    bark.alphaTest = 0.25;
    const needles = new MeshStandardNodeMaterial();
    needles.name = "shrub-needles";
    needles.alphaTest = 0.5;
    const scene = tree([leafMesh("trunk", bark), leafMesh("shrub", needles)]);

    expect(unlitFoliageWarning(scene)).toEqual({
      examples: ["bark", "shrub-needles"],
      materials: 2,
      meshes: 2,
    });
  });

  it("sees an InstancedMesh and a batched subtree as ordinary nodes", () => {
    const instanced = new InstancedMesh(new BoxGeometry(), needleCard("reeds"), 12);
    instanced.name = "reeds";
    const scene = tree([instanced]);

    expect(unlitFoliageWarning(scene)).toMatchObject({ materials: 1, meshes: 1 });
  });

  it("is silent once the scene carries an environment", () => {
    const scene = tree([leafMesh("pine", needleCard("pine-needles"))]);
    scene.environment = {} as Texture;

    expect(unlitFoliageWarning(scene)).toBeUndefined();
  });

  it("is silent when the material carries its own envMap", () => {
    const material = needleCard("pine-needles");
    material.envMap = {} as Texture;
    const scene = tree([leafMesh("pine", material)]);

    expect(unlitFoliageWarning(scene)).toBeUndefined();
  });

  it("is silent for opaque PBR, and for a cutout that is not PBR", () => {
    const opaque = new MeshStandardMaterial({ name: "rock" });
    const lambert = new MeshStandardMaterial({ name: "billboard" });
    lambert.alphaTest = 0.5;
    const notPbr = { alphaTest: 0.5, name: "unlit", type: "MeshBasicMaterial" } as Material;
    const scene = tree([
      leafMesh("rock", opaque),
      leafMesh("billboard", { ...lambert, type: "MeshLambertMaterial" } as unknown as Material),
      leafMesh("cutout-unlit", notPbr),
    ]);

    expect(unlitFoliageWarning(scene)).toBeUndefined();
  });

  it("ignores a hidden subtree, which nothing draws", () => {
    const mesh = leafMesh("pine", needleCard("pine-needles"));
    mesh.visible = false;

    expect(unlitFoliageWarning(tree([mesh]))).toBeUndefined();
    const hiddenGroup = new Group();
    hiddenGroup.visible = false;
    hiddenGroup.add(leafMesh("shrub", needleCard("shrub-needles")));
    expect(unlitFoliageWarning(tree([hiddenGroup]))).toBeUndefined();
  });

  it("dedupes one material shared by a hundred meshes", () => {
    const material = needleCard("pine-needles");
    const scene = tree(
      Array.from({ length: 100 }, (_, index) => leafMesh(`pine-${index}`, material)),
    );

    expect(unlitFoliageWarning(scene)).toMatchObject({ materials: 1, meshes: 100 });
  });

  it("respects a game that means to render unlit cutouts", () => {
    const material = needleCard("pine-needles");
    material.userData.tnUnlitOk = true;

    expect(unlitFoliageWarning(tree([leafMesh("pine", material)]))).toBeUndefined();
  });

  it("names the mesh when the material has no name", () => {
    const scene = tree([leafMesh("moss-card", needleCard(""))]);

    expect(unlitFoliageWarning(scene)?.examples).toEqual(["moss-card"]);
  });

  it("caps the examples at five so the line stays a line", () => {
    const scene = tree(
      Array.from({ length: 9 }, (_, index) =>
        leafMesh(`pine-${index}`, needleCard(`needles-${index}`)),
      ),
    );

    const warning = unlitFoliageWarning(scene);
    expect(warning?.materials).toBe(9);
    expect(warning?.examples).toHaveLength(5);
  });

  it("formats the marker line a log reader greps for", () => {
    const warning = unlitFoliageWarning(tree([leafMesh("pine", needleCard("pine-needles"))]));
    if (warning === undefined) throw new Error("expected a warning");

    expect(formatUnlitFoliageWarning(warning)).toBe(
      `${UNLIT_FOLIAGE_MARKER}:${JSON.stringify(warning)}`,
    );
  });

  it("reads nothing off a root that is not an object", () => {
    expect(unlitFoliageWarning(undefined as unknown as Object3D)).toBeUndefined();
  });
});
