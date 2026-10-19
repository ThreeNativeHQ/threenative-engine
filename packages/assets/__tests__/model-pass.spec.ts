import { readFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import type { Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { describe, expect, it, vi } from "vitest";
import {
  FIXTURE_PATH,
  type IFixtureOptions,
  buildFixtureDocument,
  buildFixtureGlb,
} from "../../../test-support/generate-fixture-model.js";
import {
  assertNoDrift,
  assertSimplifiedWithinBounds,
  modelPass,
  reachableStats,
} from "../src/passes/model.js";

/** Re-reads pass output exactly as self-verification does: codecs registered. */
async function readVerified(buffer: Buffer): Promise<ReturnType<Document["getRoot"]>> {
  const io = new NodeIO()
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder })
    .registerExtensions((await import("@gltf-transform/extensions")).ALL_EXTENSIONS);
  return (await io.readJSON(await io.binaryToJSON(buffer))).getRoot();
}

function countTriangles(document: ReturnType<Document["getRoot"]>): number {
  return (
    document
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .reduce((total, primitive) => total + (primitive.getIndices()?.getCount() ?? 0), 0) / 3
  );
}

describe("modelPass", () => {
  it("should not grow a 150-byte source image", async () => {
    const image = await readFile(
      new URL(
        "../../create-threenative/templates/starter/assets/native-proof.png",
        import.meta.url,
      ),
    );
    expect(image.byteLength).toBe(150);
    const document = buildFixtureDocument();
    for (const texture of document.getRoot().listTextures()) {
      texture.setImage(image).setMimeType("image/png");
    }
    const input = Buffer.from(await new NodeIO().writeBinary(document));
    const result = await modelPass().apply(input, "tiny.glb");
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
    const output = await readVerified(result.buffer);
    expect(output.listTextures().length).toBeGreaterThan(0);
    for (const texture of output.listTextures()) {
      expect(texture.getImage()?.byteLength).toBeLessThanOrEqual(image.byteLength);
      expect(Buffer.from(texture.getImage() ?? [])).toEqual(image);
    }
  });

  it("should preserve triangle and vertex counts through the full pass chain", async () => {
    const input = Buffer.from(await buildFixtureGlb());
    const result = await modelPass().apply(input, "character.glb");

    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
    const output = await readVerified(result.buffer);
    // The fixture carries one 12-triangle grid plus one 24-index (8-triangle) head.
    expect(countTriangles(output)).toBe(20);
    expect(result.entry?.triangles).toBe(20);
    expect(result.entry?.vertices).toBe(18);
    const extensions = (result.entry?.extensions as readonly string[] | undefined) ?? [];
    // The tiny fixture maps cost fewer bytes as PNG, so the default keeps them lossless.
    expect([...extensions]).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
  });

  it("should keep the bounding box within tolerance at default precision", async () => {
    const input = Buffer.from(await buildFixtureGlb());
    const result = await modelPass().apply(input, "character.glb");
    expect(Buffer.isBuffer(result)).toBe(false);
    if (!Buffer.isBuffer(result)) {
      // World-space bind-pose bounds, evaluated exactly as the pass's own self-verify
      // evaluates them (the GPU's reconstruction), source against output.
      const before = reachableStats(await readVerified(input));
      const after = reachableStats(await readVerified(result.buffer));
      const beforeBox = before.boundingBox;
      const afterBox = after.boundingBox;
      expect(beforeBox).toBeDefined();
      expect(afterBox).toBeDefined();
      if (beforeBox === undefined || afterBox === undefined) return;
      for (const axis of [0, 1, 2]) {
        expect(Math.abs((afterBox.min[axis] ?? 0) - (beforeBox.min[axis] ?? 0))).toBeLessThan(1e-3);
        expect(Math.abs((afterBox.max[axis] ?? 0) - (beforeBox.max[axis] ?? 0))).toBeLessThan(1e-3);
      }
    }
  });

  it("should leave deforming positions alone at a depth below the quantization floor", async () => {
    // Four bits is the destructive pre-round the library refuses to express: the pass snaps floats
    // onto a 15-level grid over each accessor's own bounds and lets the self-verify reject the
    // result. That request used to land on the fixture's skinned head — and used to trip the
    // self-verify at 0.167% drift. Deforming geometry is now held in source space at every depth,
    // so the request never reaches it and there is nothing left to reject; the fail-closed path
    // itself is covered by the drift-kind comparison further down. The static half of the document
    // still quantizes, which is what keeps the two halves of the rule honest.
    const document = buildFixtureDocument({ textured: false });
    const root = document.getRoot();
    const head = root.listMeshes()[0]?.listPrimitives()[1];
    const buffer = head?.getAttribute("POSITION")?.getBuffer() ?? null;
    if (head === undefined || buffer === null) throw new Error("Fixture lost its rig.");
    const prop = document
      .createPrimitive()
      .setIndices(
        document
          .createAccessor("prop-indices")
          .setBuffer(buffer)
          .setType("SCALAR")
          .setArray(
            Uint32Array.from([
              0, 10, 20, 1, 11, 21, 2, 12, 22, 3, 13, 23, 4, 14, 24, 5, 15, 25, 6, 16, 26, 7, 17, 8,
              18, 19, 9,
            ]),
          ),
      )
      .setAttribute(
        "POSITION",
        document
          .createAccessor("prop-positions")
          .setBuffer(buffer)
          .setType("VEC3")
          .setArray(new Float32Array(Array.from({ length: 81 }, (_, index) => index))),
      );
    root
      .listScenes()[0]
      ?.addChild(
        document.createNode("prop-root").setMesh(document.createMesh("prop").addPrimitive(prop)),
      );
    const positions = [...(head.getAttribute("POSITION")?.getArray() ?? [])];
    const result = await modelPass({
      compact: false,
      quantize: { normalBits: 16, positionBits: 4, uvBits: 12 },
      textures: "none",
      virtual: "none",
    }).apply(Buffer.from(await new NodeIO().writeBinary(document)), "character.glb");
    expect(Buffer.isBuffer(result)).toBe(false);
    if (Buffer.isBuffer(result)) return;
    const output = await readVerified(result.buffer);
    expect([
      ...(output.listMeshes()[0]?.listPrimitives()[1]?.getAttribute("POSITION")?.getArray() ?? []),
    ]).toEqual(positions);
    expect(
      output
        .listMeshes()
        .find((mesh) => mesh.getName() === "prop")
        ?.listPrimitives()[0]
        ?.getAttribute("POSITION")
        ?.getComponentSize(),
      // Eight bits is the floor the request resolves to, and it lands as normalized Int8.
    ).toBe(1);
  });

  it("should declare EXT_meshopt_compression and not Draco", async () => {
    const input = Buffer.from(await buildFixtureGlb());
    const result = await modelPass().apply(input, "character.glb");
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
    const output = await readVerified(result.buffer);
    const extensionsUsed = new Set(
      output.listExtensionsUsed().map((extension) => extension.extensionName),
    );
    expect(extensionsUsed.has("EXT_meshopt_compression")).toBe(true);
    expect(extensionsUsed.has("KHR_draco_mesh_compression")).toBe(false);

    // Control twin: switch meshopt off and the declaration disappears, so the assertion
    // above measures the pass rather than the fixture.
    const uncompressed = await modelPass({
      compact: false,
      passes: { dedup: false, meshopt: false, prune: false, quantize: false, reorder: false },
      textures: "none",
      virtual: "none",
    }).apply(Buffer.from(await buildFixtureGlb()), "character.glb");
    expect(Buffer.isBuffer(uncompressed)).toBe(true);
  });

  it("should leave the model byte-identical when every sub-pass is switched off", async () => {
    const input = Buffer.from(await buildFixtureGlb());
    // Texture compression, the cluster-DAG bake and lossless compaction are their own switches
    // and all default to on, so a complete opt-out names all four.
    const result = await modelPass({
      compact: false,
      passes: { dedup: false, meshopt: false, prune: false, quantize: false, reorder: false },
      textures: "none",
      virtual: "none",
    }).apply(input, "character.glb");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).equals(input)).toBe(true);
  });

  it("should keep joint weights at source float32 precision on a skinned mesh", async () => {
    const input = Buffer.from(await buildFixtureGlb());
    const result = await modelPass().apply(input, "character.glb");
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
    const output = await readVerified(result.buffer);
    const weights = output
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .map((primitive) => primitive.getAttribute("WEIGHTS_0"));
    expect(weights.length).toBeGreaterThan(0);
    for (const attribute of weights) {
      // FLOAT32, exactly as the generator declared — never narrowed by quantization.
      expect(attribute?.getComponentSize()).toBe(4);
    }
  });

  it("should keep a deforming primitive's vertex order and still reorder a static one", async () => {
    // A vertex index is an address, and something outside this cook may already hold one: a
    // MetaHuman sidecar records the head vertex each brow strand root rides, and reads the position
    // back at that index every frame. The cook cannot know who holds an index, so deforming
    // geometry — skinned, morph-targeted, or carrying joint data — keeps its exact vertex order and
    // count, and everything else is still reordered for transmission size.
    const document = buildFixtureDocument({ textured: false });
    const root = document.getRoot();
    const character = root.listMeshes()[0];
    const cloth = character?.listPrimitives()[0];
    const head = character?.listPrimitives()[1];
    if (cloth === undefined || head === undefined) throw new Error("Fixture lost a primitive.");
    // Both reasons in one cook: the cloth stays skinned-only, the head also gains a morph target.
    const buffer = head.getAttribute("POSITION")?.getBuffer() ?? null;
    head.addTarget(
      document.createPrimitiveTarget("head-jaw-open").setAttribute(
        "POSITION",
        document
          .createAccessor("head-jaw-open-deltas")
          .setBuffer(buffer)
          .setType("VEC3")
          .setArray(new Float32Array(Array.from({ length: 18 }, (_, index) => (index % 3) * 0.01))),
      ),
    );
    // A static mesh whose index buffer is not already in draw order, so the reorder has real work
    // to do on it: the jumbled order below is a non-identity meshoptimizer remap.
    const staticIndices = [6, 1, 8, 0, 7, 3, 2, 4, 5];
    const prop = document
      .createPrimitive()
      .setIndices(
        document
          .createAccessor("prop-indices")
          .setBuffer(buffer)
          .setType("SCALAR")
          .setArray(Uint32Array.from(staticIndices)),
      )
      .setAttribute(
        "POSITION",
        document
          .createAccessor("prop-positions")
          .setBuffer(buffer)
          .setType("VEC3")
          .setArray(new Float32Array(Array.from({ length: 27 }, (_, index) => index))),
      );
    root
      .listScenes()[0]
      ?.addChild(
        document.createNode("prop-root").setMesh(document.createMesh("prop").addPrimitive(prop)),
      );

    const source = (meshName: string, primitive: number): number[] => [
      ...(root
        .listMeshes()
        .find((mesh) => mesh.getName() === meshName)
        ?.listPrimitives()
        [primitive]?.getAttribute("POSITION")
        ?.getArray() ?? []),
    ];
    const before = {
      cloth: source("character", 0),
      head: source("character", 1),
      prop: source("prop", 0),
    };
    // Lossless options, so the only stage that can move a vertex is `reorder` itself.
    const result = await modelPass({
      compact: false,
      passes: { quantize: false },
      textures: "none",
      virtual: "none",
    }).apply(Buffer.from(await new NodeIO().writeBinary(document)), "character.glb");
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
    const output = await readVerified(result.buffer);
    const cooked = (meshName: string, primitive: number): number[] => [
      ...(output
        .listMeshes()
        .find((mesh) => mesh.getName() === meshName)
        ?.listPrimitives()
        [primitive]?.getAttribute("POSITION")
        ?.getArray() ?? []),
    ];

    expect(cooked("character", 0)).toEqual(before.cloth);
    expect(cooked("character", 1)).toEqual(before.head);
    // And the static half of the rule: reordered, and nothing but reordered.
    expect(cooked("prop", 0)).not.toEqual(before.prop);
    expect([...cooked("prop", 0)].sort((a, b) => a - b)).toEqual(
      [...before.prop].sort((a, b) => a - b),
    );
  });

  it("should keep a deforming primitive's positions in source metres and still quantize a static one", async () => {
    // One metre is one metre. `quantize` snaps POSITION onto a grid whose step is the mesh's own
    // volume over 2^bits, so a head cooked at 16 bits over half a metre lands within ~8 µm of
    // where the author put it — and the metahuman-lab sidecar, which names the head vertex each
    // brow strand root rides and reads that position back every frame, was prepared to 1e-5 m.
    // Quantization also compensates by folding a shift into the node, the skin's inverse bind
    // matrices and any volumetric material, so the whole mesh stays in source space instead:
    // deforming POSITION and its morph-target deltas keep float32, everything else still quantizes.
    const document = buildFixtureDocument({ textured: false });
    const root = document.getRoot();
    const character = root.listMeshes().find((mesh) => mesh.getName() === "character");
    const cloth = character?.listPrimitives()[0];
    const head = character?.listPrimitives()[1];
    const skin = root.listSkins()[0];
    const buffer = head?.getAttribute("POSITION")?.getBuffer() ?? null;
    if (cloth === undefined || head === undefined || skin === undefined || buffer === null)
      throw new Error("Fixture lost its rig.");
    // Both reasons in one cook, as in the vertex-order twin: the head is skinned and morph-targeted.
    const deltas = new Float32Array(Array.from({ length: 18 }, (_, index) => (index % 3) * 0.004));
    head.addTarget(
      document
        .createPrimitiveTarget("jaw-open")
        .setAttribute(
          "POSITION",
          document
            .createAccessor("jaw-open-deltas")
            .setBuffer(buffer)
            .setType("VEC3")
            .setArray(deltas),
        ),
    );
    // A static mesh in the same document, on its own node: the half of the rule that must not regress.
    const prop = document
      .createPrimitive()
      .setIndices(
        document
          .createAccessor("prop-indices")
          .setBuffer(buffer)
          .setType("SCALAR")
          .setArray(
            // Every vertex referenced exactly once, so the library's own vertex compaction inside
            // `quantize` has nothing to drop and the bbox the self-verify reads is the authored one.
            Uint32Array.from([
              0, 10, 20, 1, 11, 21, 2, 12, 22, 3, 13, 23, 4, 14, 24, 5, 15, 25, 6, 16, 26, 7, 17, 8,
              18, 19, 9,
            ]),
          ),
      )
      .setAttribute(
        "POSITION",
        document
          .createAccessor("prop-positions")
          .setBuffer(buffer)
          .setType("VEC3")
          // 27 vertices, every one of them referenced by the indices above.
          .setArray(new Float32Array(Array.from({ length: 81 }, (_, index) => index))),
      );
    root
      .listScenes()[0]
      ?.addChild(
        document.createNode("prop-root").setMesh(document.createMesh("prop").addPrimitive(prop)),
      );

    const positions = [...(head.getAttribute("POSITION")?.getArray() ?? [])];
    const binds = [...(skin.getInverseBindMatrices()?.getArray() ?? [])];
    const result = await modelPass({ compact: false, textures: "none", virtual: "none" }).apply(
      Buffer.from(await new NodeIO().writeBinary(document)),
      "character.glb",
    );
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
    const output = await readVerified(result.buffer);
    const cookedHead = output
      .listMeshes()
      .find((mesh) => mesh.getName() === "character")
      ?.listPrimitives()[1];
    const cookedCloth = output
      .listMeshes()
      .find((mesh) => mesh.getName() === "character")
      ?.listPrimitives()[0];
    const cookedProp = output
      .listMeshes()
      .find((mesh) => mesh.getName() === "prop")
      ?.listPrimitives()[0];

    const cookedPositions = cookedHead?.getAttribute("POSITION");
    expect(cookedPositions?.getComponentType()).toBe(5126);
    const after = [...(cookedPositions?.getArray() ?? [])];
    expect(after.length).toBe(positions.length);
    for (const [index, value] of after.entries())
      expect(Math.abs((value as number) - (positions[index] as number))).toBeLessThan(1e-6);
    // The deltas ride the same space, so they keep their float32 metres too.
    const cookedDeltas = cookedHead?.listTargets()[0]?.getAttribute("POSITION");
    expect(cookedDeltas?.getComponentType()).toBe(5126);
    expect([...(cookedDeltas?.getArray() ?? [])]).toEqual([...deltas]);
    // Nothing moved to compensate: the bind poses the deformation is measured against are the
    // authored ones, and the normals that do not address a vertex still quantized.
    const cookedBinds = [...(output.listSkins()[0]?.getInverseBindMatrices()?.getArray() ?? [])];
    expect(cookedBinds.length).toBe(binds.length);
    for (const [index, value] of cookedBinds.entries())
      expect(Math.abs((value as number) - (binds[index] as number))).toBeLessThan(1e-6);
    expect(cookedCloth?.getAttribute("POSITION")?.getComponentType()).toBe(5126);
    expect(cookedCloth?.getAttribute("NORMAL")?.getComponentSize()).toBeLessThan(4);
    // And the static half of the rule, unchanged: quantized, normalized, KHR_mesh_quantization on.
    expect(cookedProp?.getAttribute("POSITION")?.getComponentSize()).toBe(2);
    expect(cookedProp?.getAttribute("POSITION")?.getNormalized()).toBe(true);
    expect(
      output
        .listExtensionsUsed()
        .map((extension) => extension.extensionName)
        .includes("KHR_mesh_quantization"),
    ).toBe(true);
  });

  it("decodes normalized ushort joint weights by their own component type in reachableStats", async () => {
    // External exporters ship WEIGHTS_0 as normalized UNSIGNED_SHORT. reachableStats must
    // decode them /65535 like the GPU does; the hardcoded ubyte scale (/255) reads raw
    // integers ~257x heavy and reports a garbage bind-pose bounding box.
    const posed = (options: IFixtureOptions): Document => {
      const doc = buildFixtureDocument(options);
      // Pose the skeleton off its bind pose: at bind, joint matrices collapse to the rigid
      // fallback and every decoding evaluates identically, hiding a wrong scale.
      const torso = doc
        .getRoot()
        .listNodes()
        .find((node) => node.getName() === "torso");
      if (torso === undefined) throw new Error("Fixture lost its torso joint.");
      torso.setTranslation([0.25, 0.35, 0]);
      return doc;
    };
    const floatDoc = posed({ textured: false });
    const ushortDoc = posed({ textured: false });
    for (const mesh of ushortDoc.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        const weights = primitive.getAttribute("WEIGHTS_0");
        if (weights === null) continue;
        const source = weights.getArray();
        const quantized = new Uint16Array(source.length);
        for (let index = 0; index < source.length; index += 1)
          quantized[index] = Math.round((source[index] ?? 0) * 65535);
        const next = ushortDoc
          .createAccessor(`${weights.getName()}-ushort`)
          .setBuffer(weights.getBuffer())
          .setArray(quantized)
          .setType("VEC4")
          .setNormalized(true);
        primitive.setAttribute("WEIGHTS_0", next);
      }
    }

    const floatBox = reachableStats(floatDoc.getRoot()).boundingBox;
    const ushortBox = reachableStats(ushortDoc.getRoot()).boundingBox;
    expect(floatBox).toBeDefined();
    expect(ushortBox).toBeDefined();
    if (floatBox === undefined || ushortBox === undefined) return;
    for (const axis of [0, 1, 2]) {
      expect(Math.abs((ushortBox.min[axis] ?? 0) - (floatBox.min[axis] ?? 0))).toBeLessThan(1e-3);
      expect(Math.abs((ushortBox.max[axis] ?? 0) - (floatBox.max[axis] ?? 0))).toBeLessThan(1e-3);
    }
  });

  it("should reject a regression that narrows joint weights below source precision", async () => {
    const actual = await vi.importActual<typeof import("@gltf-transform/functions")>(
      "@gltf-transform/functions",
    );
    const input = Buffer.from(await buildFixtureGlb());
    // Simulate a future change that turns weight quantization on (the library's own
    // default): the floor must hold.
    vi.doMock("@gltf-transform/functions", () => ({
      ...actual,
      quantize: () => actual.quantize({ quantizeWeight: 8 }),
    }));
    try {
      vi.resetModules();
      const { modelPass: mockedModelPass } = await import("../src/passes/model.js");
      await expect(mockedModelPass().apply(input, "character.glb")).rejects.toThrow(
        /TN_ASSETS_MODEL_JOINT_QUANTIZED/u,
      );
    } finally {
      vi.doUnmock("@gltf-transform/functions");
    }
  });

  it("should throw naming lost geometry when prune drops a referenced primitive", async () => {
    const actual = await vi.importActual<typeof import("@gltf-transform/functions")>(
      "@gltf-transform/functions",
    );
    const input = Buffer.from(await buildFixtureGlb());
    // Simulate a buggy prune that eats referenced geometry: self-verify must catch it.
    vi.doMock("@gltf-transform/functions", () => ({
      ...actual,
      prune:
        () =>
        async (document: Document): Promise<void> => {
          await actual.prune()(document);
          const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[1];
          // dispose() detaches the primitive from its mesh — geometry the scene can no longer draw.
          primitive?.dispose();
        },
    }));
    try {
      vi.resetModules();
      const { modelPass: mockedModelPass } = await import("../src/passes/model.js");
      await expect(mockedModelPass().apply(input, "character.glb")).rejects.toThrow(
        /TN_ASSETS_MODEL_DRIFT.*triangles 20 -> 12/u,
      );
    } finally {
      vi.doUnmock("@gltf-transform/functions");
    }
  });

  it("should catch every drift kind through the exported comparison", async () => {
    const source = {
      boundingBox: { max: [1, 1, 1], min: [-1, -1, -1] },
      clips: 1,
      joints: 3,
      triangles: 14,
      vertices: 18,
    };
    expect(() => assertNoDrift(source, { ...source, triangles: 6 }, "x.glb")).toThrow(
      /triangles 14 -> 6/u,
    );
    expect(() => assertNoDrift(source, { ...source, vertices: 9 }, "x.glb")).toThrow(
      /vertices 18 -> 9/u,
    );
    expect(() => assertNoDrift(source, { ...source, joints: 0 }, "x.glb")).toThrow(
      /joints 3 -> 0/u,
    );
    expect(() => assertNoDrift(source, { ...source, clips: 0 }, "x.glb")).toThrow(
      /animation clips 1 -> 0/u,
    );
    expect(() =>
      assertNoDrift(
        source,
        { ...source, boundingBox: { max: [1, 1.5, 1], min: [-1, -1, -1] } },
        "x.glb",
      ),
    ).toThrow(/bounding box drifted/u);
    expect(() => assertNoDrift(source, { ...source, boundingBox: undefined }, "x.glb")).toThrow(
      /bounding box lost/u,
    );
  });

  it("should regenerate the committed fixture byte-for-byte (staleness guard)", async () => {
    const committed = await readFile(FIXTURE_PATH);
    expect(Buffer.from(await buildFixtureGlb()).equals(committed)).toBe(true);
  });
});

describe("assertSimplifiedWithinBounds", () => {
  type IStats = Parameters<typeof assertSimplifiedWithinBounds>[0];
  // A 1000-triangle unit cube with one skeleton and one clip; each test moves one thing.
  const stats = (overrides: Partial<IStats> = {}): IStats => ({
    boundingBox: { max: [1, 1, 1], min: [0, 0, 0] },
    clips: 1,
    joints: 2,
    triangles: 1000,
    vertices: 600,
    ...overrides,
  });

  it("accepts a reduction that keeps the skeleton, clips and bounds", () => {
    expect(() =>
      assertSimplifiedWithinBounds(
        stats(),
        stats({ triangles: 600, vertices: 400 }),
        0.5,
        "tree.glb",
      ),
    ).not.toThrow();
  });

  it("rejects a skeleton or animation clip count that changed", () => {
    expect(() =>
      assertSimplifiedWithinBounds(stats(), stats({ joints: 1, triangles: 600 }), 0.5, "rig.glb"),
    ).toThrow("joints 2 -> 1");
    expect(() =>
      assertSimplifiedWithinBounds(stats(), stats({ clips: 0, triangles: 600 }), 0.5, "rig.glb"),
    ).toThrow("animation clips 1 -> 0");
  });

  it("rejects a result with more triangles than its source", () => {
    expect(() =>
      assertSimplifiedWithinBounds(stats(), stats({ triangles: 1001 }), 0.5, "tree.glb"),
    ).toThrow("triangles grew 1000 -> 1001");
  });

  it("rejects a reduction below the floor the requested ratio allows", () => {
    // The floor is 1000 * 0.5 * 0.5 = 250 triangles.
    expect(() =>
      assertSimplifiedWithinBounds(stats(), stats({ triangles: 249 }), 0.5, "tree.glb"),
    ).toThrow("below the 250 floor");
    expect(() =>
      assertSimplifiedWithinBounds(stats(), stats({ triangles: 250 }), 0.5, "tree.glb"),
    ).not.toThrow();
  });

  it("rejects a result that lost its bounding box", () => {
    expect(() =>
      assertSimplifiedWithinBounds(
        stats(),
        stats({ boundingBox: undefined, triangles: 600 }),
        0.5,
        "tree.glb",
      ),
    ).toThrow("bounding box lost");
  });

  it("rejects a bounding box that moved past the tolerance and accepts one inside it", () => {
    expect(() =>
      assertSimplifiedWithinBounds(
        stats(),
        stats({ boundingBox: { max: [1.05, 1, 1], min: [0, 0, 0] }, triangles: 600 }),
        0.5,
        "tree.glb",
      ),
    ).toThrow("bounding box drifted");
    expect(() =>
      assertSimplifiedWithinBounds(
        stats(),
        stats({ boundingBox: { max: [1.005, 1, 1], min: [0, 0, 0] }, triangles: 600 }),
        0.5,
        "tree.glb",
      ),
    ).not.toThrow();
  });
});
