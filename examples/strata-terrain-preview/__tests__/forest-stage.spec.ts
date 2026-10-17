import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ICtx } from "@threenative/core";
import { TerrainTiles } from "@threenative/core/world";
import type { IPhysicsContext } from "@threenative/physics";
import { PNG } from "pngjs";
import {
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  RGBAFormat,
  Vector2,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { ScenePicker } from "../../../packages/core/src/picking.js";

// The game's own scene calls the stage loader; the kit's streaming is replaced so no GPU or server runs.
const kit = vi.hoisted(() => ({
  calls: [] as unknown[][],
  release: undefined as (() => void) | undefined,
}));
vi.mock("../src/world/forestStage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/world/forestStage.js")>()),
  addForestStage: async (...args: unknown[]) => {
    kit.calls.push(args);
    await new Promise<void>((resolve) => {
      kit.release = resolve;
    });
    const disposed: string[] = [];
    return {
      disposed,
      world: { dispose: () => disposed.push("world") },
      colliders: { detach: () => disposed.push("colliders") },
      ground: {
        dispose: () => disposed.push("ground"),
      },
    };
  },
}));
const { addForestStage, forestStageArm, forestStageTerrainTargets } = await vi.importActual<
  typeof import("../src/world/forestStage.js")
>("../src/world/forestStage.js");
const { terrainScene } = await import("../src/game.js");

const ctx = {} as ICtx<Record<string, unknown>, IPhysicsContext>;
const after = fileURLToPath(new URL("../local-assets/forest-stage/after/world/", import.meta.url));
const candidates = fileURLToPath(new URL("../local-assets/forest-candidates/", import.meta.url));

// Share of texels under the glTF 0.5 cutoff in each cut-out material's source alpha map: the red
// channel of Poly Haven's 1k pine_tree_01_twig_alpha, fir_tree_01_twig_alpha and
// fir_sapling_medium_twigs_alpha, and the
// starter's packages/terrain/starter-assets/fern_02/fern_02_alpha_512.png.
const SOURCE_CUT: Record<string, number> = {
  pine_tree_01_twig: 0.3211,
  fir_tree_01_twig: 0.7637729644775391,
  fir_sapling_medium_twigs: 0.7638,
  fern_02: 0.8238,
};

/** Per MASK material of one GLB: the share of its decoded base colour texels with alpha under 0.5. */
function exportedCut(file: string): Record<string, number> {
  const glb = readFileSync(file);
  const length = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + length).toString("utf8")) as {
    meshes: { primitives: { material: number }[] }[];
    materials: {
      name: string;
      alphaMode?: string;
      pbrMetallicRoughness: { baseColorTexture: { index: number } };
    }[];
    textures: { source: number }[];
    images: { mimeType: string; bufferView: number }[];
    bufferViews: { byteOffset?: number; byteLength: number }[];
  };
  const cut: Record<string, number> = {};
  const used = new Set(gltf.meshes.flatMap((mesh) => mesh.primitives.map((part) => part.material)));
  for (const index of used) {
    const material = gltf.materials[index];
    if (!material) throw new Error(`${file}: primitive has no material ${index}`);
    if (SOURCE_CUT[material.name] !== undefined && material.alphaMode !== "MASK")
      throw new Error(`${file}: attached cutout ${material.name} is not MASK`);
    if (material.alphaMode !== "MASK") continue;
    const texture = gltf.textures[material.pbrMetallicRoughness.baseColorTexture.index];
    const image = gltf.images[texture?.source ?? -1];
    const view = gltf.bufferViews[image?.bufferView ?? -1];
    if (!image || !view) throw new Error(`${file}: ${material.name} has no embedded base colour`);
    // A JPEG has no alpha channel, so it decodes opaque and the material cuts nothing.
    if (image.mimeType === "image/jpeg") {
      cut[material.name] = 0;
      continue;
    }
    const start = 28 + length + (view.byteOffset ?? 0);
    const { data } = PNG.sync.read(glb.subarray(start, start + view.byteLength));
    let under = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] as number) < 128) under++;
    cut[material.name] = under / (data.length / 4);
  }
  return cut;
}

describe("forest stage arm", () => {
  it.skipIf(!existsSync(`${after}world.json`))(
    "keeps fern cutouts and authored normals while removing the HDR sun before lighting",
    async () => {
      const path = new URL("../local-assets/forest-stage/after/world.ts", import.meta.url).href;
      const { dressProp, PROP_SKY_LIGHT, SKY_LUMINANCE_CAP } = await import(path);
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute([1, 0, 0], 3));
      geometry.setAttribute("normal", new Float32BufferAttribute([0, 0, 1], 3));
      const material = new MeshStandardMaterial({
        alphaTest: 0.5,
        roughness: 0.94,
        metalness: 0.003,
      });
      const map = new DataTexture(new Float32Array([100, 50, 25, 1]), 1, 1, RGBAFormat, FloatType);
      dressProp(new Mesh(geometry, material), map, "fern", new Map());
      expect(Array.from(geometry.getAttribute("normal").array)).toEqual([0, 0, 1]);
      expect(material.alphaTest).toBe(0.5);
      expect(material.roughness).toBe(0.94);
      expect(material.metalness).toBe(0.003);
      expect(material.envMap).toBe(map);
      expect(material.envMapIntensity).toBe(PROP_SKY_LIGHT);
      const [r = Number.NaN, g = Number.NaN, b = Number.NaN] = map.image.data as Float32Array;
      expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(SKY_LUMINANCE_CAP);
      expect(r / g).toBeCloseTo(2);
      dressProp(new Mesh(geometry, material), map, "deadwood", new Map());
      expect(Array.from(map.image.data as Float32Array)).toEqual([r, g, b, 1]);
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  );
  it("observes visible streamed triangles at their morphed height, excluding hidden LODs and props", () => {
    const world = new Group();
    expect(() => forestStageTerrainTargets(world)).toThrow(/no streamed terrain/);
    const material = new MeshBasicMaterial({ side: DoubleSide });
    const terrain = new TerrainTiles({
      sampleHeight: () => 0,
      surface: material,
      tileSize: 2,
      tileResolution: 9,
      residentTileBudget: 1,
      residentByteBudget: 10000,
    });
    world.add(terrain);
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-2, 0, -2, 2, 0, -2, 0, 0, 2], 3),
    );
    geometry.morphAttributes.position = [
      new Float32BufferAttribute([0, 3, 0, 0, 3, 0, 0, 3, 0], 3),
    ];
    geometry.morphTargetsRelative = true;
    const drawn = new Mesh(geometry, material);
    drawn.morphTargetInfluences = [0.5];
    terrain.add(drawn);
    const hidden = new Mesh(geometry, material);
    hidden.position.y = 8;
    hidden.visible = false;
    terrain.add(hidden);
    const hiddenParent = new Group();
    hiddenParent.visible = false;
    hiddenParent.add(new Mesh(geometry, material));
    terrain.add(hiddenParent);
    const prop = new Mesh(geometry, material);
    prop.position.y = 12;
    world.add(prop);
    expect(forestStageTerrainTargets(world)).toEqual([drawn]);
    const picker = new ScenePicker({
      camera: new PerspectiveCamera(),
      pointer: () => new Vector2(),
      scene: world,
      viewport: {} as never,
    });
    expect(
      picker.raycast({
        origin: new Vector3(0, 20, 0),
        direction: new Vector3(0, -1, 0),
        targets: forestStageTerrainTargets(world),
      })?.point.y,
    ).toBeCloseTo(1.5);
    drawn.visible = false;
    expect(
      picker.raycast({
        origin: new Vector3(0, 20, 0),
        direction: new Vector3(0, -1, 0),
        targets: forestStageTerrainTargets(world),
      }),
    ).toBeUndefined();
    picker.dispose();
    terrain.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("reads ?stage= strictly", () => {
    expect(forestStageArm("?world=forest")).toBeUndefined();
    expect(forestStageArm("?stage=after")).toBe("after");
    expect(() => forestStageArm("?stage=")).toThrow(/not one of before, after/);
    expect(() => forestStageArm("?stage=candidates")).toThrow(/not one of before, after/);
  });

  it("fails closed when the requested arm is not staged", async () => {
    await expect(addForestStage(ctx, new Object3D(), "before", () => true, {})).rejects.toThrow(
      /forest-stage\/before\/world\.ts is not staged/,
    );
  });

  it("streams the arm's own baked world through the kit's addForest", async () => {
    const urls: string[] = [];
    const world = { field: {} };
    const kit = {
      addForest: async (_ctx: unknown, _follow: unknown, url: string) => {
        urls.push(url);
        return world as never;
      },
    };
    const loaded = await addForestStage(ctx, new Object3D(), "after", () => true, {
      "../../local-assets/forest-stage/after/world.ts": async () => kit,
    });
    expect(loaded).toBe(world);
    expect(urls).toEqual(["forest-stage/after/world/world.json"]);
  });

  it("routes the game's forest scene through the stage arm and drops a stale load", async () => {
    const Forest = terrainScene("forest");
    const camera = new PerspectiveCamera();
    const setState = vi.fn();
    const sceneCtx = { camera, state: { set: setState } } as never;
    vi.stubGlobal("location", { search: "?world=forest&stage=nope" });
    await expect(new Forest().load(sceneCtx)).rejects.toThrow(/not one of before, after/);
    expect(kit.calls).toHaveLength(0);

    vi.stubGlobal("location", { search: "?world=forest&stage=after" });
    const scene = new Forest();
    const loading = scene.load(sceneCtx);
    await vi.waitUntil(() => kit.calls.length === 1);
    const [passedCtx, follow, arm, whileCurrent] = kit.calls[0] as [
      unknown,
      unknown,
      string,
      () => boolean,
    ];
    expect([passedCtx, follow, arm, whileCurrent()]).toEqual([sceneCtx, camera, "after", true]);
    scene.exit(sceneCtx);
    expect(setState).toHaveBeenCalledWith({ currentViewWindows: 0 });
    expect(whileCurrent()).toBe(false);
    kit.release?.();
    await loading;
    vi.unstubAllGlobals();
  });

  // Local-only staging: the baked arm is gitignored like every licensed or downloaded asset here.
  it.skipIf(!existsSync(`${after}world.json`))(
    "bakes mature pines and an understory with their maps",
    () => {
      const manifest = JSON.parse(readFileSync(`${after}world.json`, "utf8")) as {
        assets: Record<string, { glb: string }>;
      };
      const placements = new Float32Array(readFileSync(`${after}placements.bin`).buffer.slice(0));
      expect(placements.length).toBeGreaterThan(0);
      for (const id of ["pine", "pine-b", "pine-c", "fern", "fern-small", "deadwood"]) {
        const asset = manifest.assets[id];
        if (!asset) throw new Error(`stage after: no ${id} asset`);
        const glb = readFileSync(`${after}${asset.glb}`);
        const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
          materials: { pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
          images?: unknown[];
        };
        expect(gltf.images?.length, id).toBeGreaterThan(0);
        expect(
          gltf.materials.every((material) => material.pbrMetallicRoughness?.baseColorTexture),
          id,
        ).toBe(true);
      }
    },
  );

  it.skipIf(!existsSync(`${after}world.json`) || !existsSync(candidates))(
    "cuts every needle and frond card where its source alpha map does, in the candidate and the cooked model",
    () => {
      const manifest = JSON.parse(readFileSync(`${after}world.json`, "utf8")) as {
        assets: Record<string, { glb: string; lods?: { glb: string }[] }>;
      };
      const files = [
        ...["a", "b", "c"].map((v) => `${candidates}pine_tree_01/pine-${v}-lod2.glb`),
        ...["a", "b", "c"].flatMap((v) =>
          [1, 2].map((l) => `${candidates}fir_sapling_medium/fir-young-${v}-lod${l}.glb`),
        ),
        ...["a", "c"].map((v) => `${candidates}fern_02/fern-${v}.glb`),
      ];
      for (const id of [
        "pine",
        "pine-b",
        "pine-c",
        "fir-young",
        "fir-young-b",
        "fir-young-c",
        "fern",
        "fern-small",
      ]) {
        const asset = manifest.assets[id];
        if (!asset) throw new Error(`stage after: no ${id} asset`);
        files.push(...[asset, ...(asset.lods ?? [])].map((model) => `${after}${model.glb}`));
      }
      const wrong: string[] = [];
      for (const file of files) {
        const cut = exportedCut(file);
        const shown = file.slice(file.indexOf("local-assets/"));
        if (Object.keys(cut).length === 0) wrong.push(`${shown} has no cut-out material`);
        for (const [name, share] of Object.entries(cut)) {
          const source = SOURCE_CUT[name];
          if (source === undefined) throw new Error(`${shown}: no source alpha map for ${name}`);
          if (!(Math.abs(share - source) < 0.005))
            wrong.push(`${shown} ${name} cuts ${share.toFixed(4)}, its source ${source}`);
        }
      }
      expect(wrong).toEqual([]);
    },
  );
});
