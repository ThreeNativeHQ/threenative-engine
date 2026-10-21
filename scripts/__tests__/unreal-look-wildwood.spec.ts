import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { captureGi, validateShadowRegistry } from "../unreal-look/gi.js";
import {
  ASSET_ROOT_ENV,
  type IWildwoodManifest,
  assetRoot,
  composeScene,
  floorBoxes,
  readManifest,
  validateManifest,
  validateWildwoodScene,
  verifyAssets,
} from "../unreal-look/wildwood.js";

// A 1 x 1 PNG: enough texture for a material to name one.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** A two-material GLB: opaque bark and a masked, double-sided leaf card, as the Fab trees have. */
async function writeTree(file: string, cutoff: number): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (type: "VEC3" | "SCALAR", array: Float32Array | Uint16Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const texture = document.createTexture("leaf").setImage(PNG).setMimeType("image/png");
  const bark = document.createMaterial("bark").setBaseColorFactor([0.3, 0.2, 0.1, 1]);
  const leaf = document
    .createMaterial("leaf")
    .setAlphaMode("MASK")
    .setAlphaCutoff(cutoff)
    .setDoubleSided(true)
    .setBaseColorTexture(texture);
  const quad = (material: typeof bark) =>
    document
      .createPrimitive()
      .setAttribute(
        "POSITION",
        accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0])),
      )
      .setIndices(accessor("SCALAR", new Uint16Array([0, 1, 2, 0, 2, 3])))
      .setMaterial(material);
  const mesh = document.createMesh("tree").addPrimitive(quad(bark)).addPrimitive(quad(leaf));
  document.createScene("tree").addChild(document.createNode("tree").setMesh(mesh));
  writeFileSync(file, await new NodeIO().writeBinary(document));
}

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** An asset root holding two trees and the manifest that names them. */
async function fixture(): Promise<{ root: string; manifest: IWildwoodManifest }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "tn-wildwood-"));
  await writeTree(path.join(root, "SM_oak.glb"), 0.333);
  await writeTree(path.join(root, "SM_fir.glb"), 0.4);
  const manifest: IWildwoodManifest = {
    assets: [
      { name: "oak", file: "SM_oak.glb", sha256: sha256(path.join(root, "SM_oak.glb")) },
      { name: "fir", file: "SM_fir.glb", sha256: sha256(path.join(root, "SM_fir.glb")) },
    ],
    instances: [
      { name: "Oak_1", asset: "oak", position: [1, 0, 2], rotationYDeg: 90, scale: 1 },
      { name: "Oak_2", asset: "oak", position: [-3, 0, 1], rotationYDeg: 0, scale: 2 },
      {
        name: "Fir_1",
        asset: "fir",
        position: [0, 0, -4],
        rotationYDeg: 35,
        scale: 1,
        region: "Firs",
      },
    ],
  };
  return { root, manifest };
}

describe("wildwood assets fail closed (PRD-651: no Fab binary is committed)", () => {
  it("stops when the asset root is not a folder, and names the variable", () => {
    expect(() => assetRoot({ [ASSET_ROOT_ENV]: "/nonexistent/wildwood" })).toThrow(
      /TN_WILDWOOD_NO_ASSET_ROOT.*TN_WILDWOOD_ASSETS/s,
    );
  });

  it("stops when a listed file is missing", async () => {
    const { root, manifest } = await fixture();
    const missing = {
      ...manifest,
      assets: [...manifest.assets, { name: "elm", file: "SM_elm.glb", sha256: "0".repeat(64) }],
    };
    expect(() => verifyAssets(missing, root)).toThrow(/TN_WILDWOOD_ASSET_MISSING: SM_elm\.glb/);
  });

  it("stops when a file has other bytes than the manifest names", async () => {
    const { root, manifest } = await fixture();
    writeFileSync(path.join(root, "SM_oak.glb"), "not the file that was calibrated");
    expect(() => verifyAssets(manifest, root)).toThrow(/TN_WILDWOOD_ASSET_CHANGED: SM_oak\.glb/);
  });

  it("returns each file by asset name when every hash matches", async () => {
    const { root, manifest } = await fixture();
    expect([...verifyAssets(manifest, root).keys()]).toEqual(["oak", "fir"]);
  });

  it("stops a capture before the editor starts when the root is missing", async () => {
    const before = process.env[ASSET_ROOT_ENV];
    process.env[ASSET_ROOT_ENV] = "/nonexistent/wildwood";
    let started = false;
    try {
      await expect(
        captureGi(
          ["--scene", "shadow:wildwood", "--rebuild", "--variants", "ID", "--out", os.tmpdir()],
          async () => {
            started = true;
            return 0;
          },
        ),
      ).rejects.toThrow(/TN_WILDWOOD_NO_ASSET_ROOT/);
    } finally {
      if (before === undefined) delete process.env[ASSET_ROOT_ENV];
      else process.env[ASSET_ROOT_ENV] = before;
    }
    expect(started).toBe(false);
  });
});

describe("the committed manifest", () => {
  it("is valid: every instance names a listed asset and the regions fit the ID colours", () => {
    const manifest = readManifest(
      path.join(import.meta.dirname, "../../tools/unreal-reference/shadow/wildwood"),
    );
    expect(manifest.assets.map((a) => a.file)).toContain("SM_pine01.glb");
    expect(manifest.instances.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects an instance of an asset it does not list", async () => {
    const { manifest } = await fixture();
    const bad = {
      ...manifest,
      instances: [
        {
          name: "Elm_1",
          asset: "elm",
          position: [0, 0, 0] as [number, number, number],
          rotationYDeg: 0,
          scale: 1,
        },
      ],
    };
    expect(() => validateManifest(bad)).toThrow(/TN_WILDWOOD_MANIFEST.*elm/s);
  });

  it("rejects a hash that is not sha256, a path in a file name and a scale of zero", async () => {
    const { manifest } = await fixture();
    const asset = manifest.assets[0] as (typeof manifest.assets)[number];
    expect(() => validateManifest({ ...manifest, assets: [{ ...asset, sha256: "abc" }] })).toThrow(
      /sha256/,
    );
    expect(() =>
      validateManifest({ ...manifest, assets: [{ ...asset, file: "../SM_oak.glb" }] }),
    ).toThrow(/plain \.glb/);
    const instance = manifest.instances[0] as (typeof manifest.instances)[number];
    expect(() => validateManifest({ ...manifest, instances: [{ ...instance, scale: 0 }] })).toThrow(
      /finite/,
    );
  });

  it("rejects more regions than the ID frame has colours", async () => {
    const { manifest } = await fixture();
    const many = Array.from({ length: 18 }, (_, i) => ({
      name: `Oak_${i}`,
      asset: "oak",
      position: [i, 0, 0] as [number, number, number],
      rotationYDeg: 0,
      scale: 1,
    }));
    expect(() => validateManifest({ ...manifest, instances: many })).toThrow(
      /18 regions|19 regions/,
    );
  });
});

describe("the ThreeNative scene is composed from the manifest", () => {
  const floor = {
    name: "Floor",
    position: [-4, -0.1, 0] as [number, number, number],
    size: [40, 0.2, 40] as [number, number, number],
    material: { baseColor: [0.8, 0.8, 0.8] as [number, number, number], roughness: 1, metallic: 0 },
  };

  it("places each instance at its transform, named after it, with the materials as the file has them", async () => {
    const { root, manifest } = await fixture();
    const bytes = await composeScene(
      manifest,
      verifyAssets(manifest, root),
      [floor],
      "shadow/wildwood",
    );
    const composed = await new NodeIO().readBinary(bytes);
    const nodes = new Map(
      composed
        .getRoot()
        .listNodes()
        .map((n) => [n.getName(), n]),
    );
    expect([...nodes.keys()].sort()).toEqual(["Fir_1", "Floor", "Oak_1", "Oak_2"]);
    const oak = nodes.get("Oak_1");
    expect(oak?.getTranslation()).toEqual([1, 0, 2]);
    // 90 degrees about +Y: sin 45, cos 45.
    expect(oak?.getRotation()[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(nodes.get("Oak_2")?.getScale()).toEqual([2, 2, 2]);
    expect(nodes.get("Oak_2")?.getMesh()?.getName()).toBe("SM_Oak_2");
    const slots = nodes
      .get("Fir_1")
      ?.getMesh()
      ?.listPrimitives()
      .map((p) => p.getMaterial());
    expect(slots?.map((m) => m?.getAlphaMode())).toEqual(["OPAQUE", "MASK"]);
    expect(slots?.[1]?.getAlphaCutoff()).toBeCloseTo(0.4, 6);
    expect(slots?.[1]?.getDoubleSided()).toBe(true);
    expect(slots?.[1]?.getBaseColorTexture()).not.toBeNull();
    expect(
      nodes.get("Floor")?.getMesh()?.listPrimitives()[0]?.getAttribute("POSITION")?.getCount(),
    ).toBe(24);
  });

  it("holds exactly the instances and the floor: nothing of the source files stays behind", async () => {
    const { root, manifest } = await fixture();
    const composed = await new NodeIO().readBinary(
      await composeScene(manifest, verifyAssets(manifest, root), [floor], "s"),
    );
    expect(composed.getRoot().listScenes()).toHaveLength(1);
    expect(
      composed
        .getRoot()
        .listMeshes()
        .map((m) => m.getName())
        .sort(),
    ).toEqual(["SM_Floor", "SM_Fir_1", "SM_Oak_1", "SM_Oak_2"].sort());
  });

  it("takes the floor from scene.json and refuses anything but a plain box", () => {
    expect(floorBoxes({ meshes: [{ ...floor }, { name: "Oak_1", asset: "oak" }] })).toHaveLength(1);
    expect(() => floorBoxes({ meshes: [{ name: "Oak_1", asset: "oak" }] })).toThrow(/no floor box/);
    expect(() => floorBoxes({ meshes: [{ ...floor, rotationYDeg: 20 }] })).toThrow(/turned box/);
    expect(() =>
      floorBoxes({
        meshes: [{ ...floor, material: { ...floor.material, baseColorTexture: "T_x" } }],
      }),
    ).toThrow(/textured or masked/);
  });
});

describe("scene.json is held against the manifest and the files (Unreal's level, as it reports)", () => {
  const slot = (
    name: string,
    alphaMode: string,
    alphaCutoff: number | undefined,
    doubleSided: boolean,
  ) => ({
    slot: name,
    alphaMode,
    doubleSided,
    ...(alphaCutoff === undefined ? {} : { alphaCutoff }),
  });
  const reported = (manifest: IWildwoodManifest) => ({
    meshes: [
      { name: "Floor" },
      ...manifest.instances.map((i) => ({
        name: i.name,
        asset: i.asset,
        region: i.region ?? i.name,
        position: [...i.position],
        rotationYDeg: i.rotationYDeg,
        scale: i.scale,
        slots: [
          slot("bark", "OPAQUE", undefined, false),
          slot("leaf", "MASK", i.asset === "oak" ? 0.333 : 0.4, true),
        ],
      })),
    ] as never,
    regions: Object.fromEntries(["Floor", "Oak_1", "Oak_2", "Firs"].map((r) => [r, [0, 0, 0]])),
  });

  it("accepts the level that matches", async () => {
    const { root, manifest } = await fixture();
    expect(() =>
      validateWildwoodScene(reported(manifest), manifest, verifyAssets(manifest, root)),
    ).not.toThrow();
  });

  it("fails when an instance moved, a slot lost its cut or a mesh is not in the manifest", async () => {
    const { root, manifest } = await fixture();
    const files = verifyAssets(manifest, root);
    const moved = reported(manifest);
    (moved.meshes as { position: number[] }[])[1]?.position.splice(0, 1, 9);
    expect(() => validateWildwoodScene(moved, manifest, files)).toThrow(
      /Oak_1: scene\.json differs from the manifest \(position/,
    );
    const opaque = reported(manifest);
    (opaque.meshes as { slots: unknown[] }[])[3]?.slots.splice(
      1,
      1,
      slot("leaf", "OPAQUE", undefined, false),
    );
    expect(() => validateWildwoodScene(opaque, manifest, files)).toThrow(
      /slot leaf is OPAQUE double sided false, the glTF says MASK double sided true/,
    );
    const extra = reported(manifest);
    (extra.meshes as unknown[]).push({ name: "Rock_1" });
    expect(() => validateWildwoodScene(extra, manifest, files)).toThrow(
      /Rock_1: in scene\.json, missing in the manifest/,
    );
  });

  it("fails when a slot cuts at another value than the file's alpha cutoff", async () => {
    const { root, manifest } = await fixture();
    const wrong = reported(manifest);
    (wrong.meshes as { slots: unknown[] }[])[1]?.slots.splice(
      1,
      1,
      slot("leaf", "MASK", 0.5, true),
    );
    expect(() => validateWildwoodScene(wrong, manifest, verifyAssets(manifest, root))).toThrow(
      /cuts at 0\.5, the glTF says 0\.333/,
    );
  });
});

describe("a shadow variant limited to scenes", () => {
  const reg = (only: string[]) => ({
    resolution: [1280, 720] as [number, number],
    scenes: [{ name: "wildwood", owner: "PRD-649", poses: [] }],
    variants: [{ name: "L6", only, layer: "L6", cvars: {}, expect: {}, kinds: ["png" as const] }],
  });

  it("names a scene the registry has", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tn-shadow-"));
    mkdirSync(path.join(dir, "wildwood"));
    writeFileSync(path.join(dir, "wildwood/criteria.md"), "x");
    expect(() => validateShadowRegistry(reg(["wildwood"]), dir, [])).not.toThrow();
    expect(() => validateShadowRegistry(reg(["wildwod"]), dir, [])).toThrow(/limited to wildwod/);
  });
});
