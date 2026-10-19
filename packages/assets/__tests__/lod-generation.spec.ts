import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, type GLTF, type Node as GltfNode, Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { PlaneGeometry, TorusKnotGeometry } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { compileAssets } from "../src/index.js";
import { authoredLodName } from "../src/lod/eligibility.js";
import {
  type DiscreteLod,
  LOD_SCHEMA_VERSION,
  TNDiscreteLod,
  TN_DISCRETE_LOD,
} from "../src/lod/extension.js";
import {
  DEFAULT_LOD_MIN_TRIANGLES,
  type IModelLodOptions,
  type IModelLodSummary,
  LOD_ERROR_TARGETS,
  LOD_GENERATOR_VERSION,
  LOD_MIN_SAVING,
  LOD_TERMINAL_KEEP_RATIO,
  LOD_TERMINAL_MIN_TRIANGLES,
  resolveLodPolicy,
  selectDiscreteLevels,
  terminalLevelTriangles,
} from "../src/lod/generate.js";
import { modelPass } from "../src/passes/model.js";
import { TNVirtualGeometry } from "../src/virtual/extension.js";

// PRD-377 §4/§5 — generation through the real model pass. Every fixture is a self-contained GLB
// driven through `modelPass`, the same entry the compile step uses; nothing here reaches into a
// private simplifier helper except where the rule under test is that helper's own (the 20% rule).

const SILENT = new Logger(Logger.Verbosity.SILENT);

function accessor(
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  type: "SCALAR" | "VEC2" | "VEC3" | "VEC4",
  array: Float32Array | Uint16Array | Uint32Array,
) {
  return document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
}

/** A closed, indexed torus knot — every vertex referenced, so the pass self-verify has no pole drift. */
async function torusGlb(
  tubular: number,
  radial: number,
  options: {
    alpha?: "BLEND" | "MASK";
    custom?: boolean;
    customRange?: number;
    extraUv?: boolean;
    joints?: boolean;
    morph?: boolean;
    name?: string;
    /** One node and mesh per name, each with its own copy of the primitive. */
    names?: readonly string[];
    noIndices?: boolean;
  } = {},
): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const geometry = new TorusKnotGeometry(1, 0.4, tubular, radial);
  const position = accessor(
    document,
    buffer,
    "VEC3",
    Float32Array.from(geometry.attributes.position?.array ?? []),
  );
  const normal = accessor(
    document,
    buffer,
    "VEC3",
    Float32Array.from(geometry.attributes.normal?.array ?? []),
  );
  const material = document.createMaterial("rock");
  if (options.alpha !== undefined) material.setAlphaMode(options.alpha);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setMaterial(material);
  if (options.noIndices !== true)
    primitive.setIndices(
      accessor(document, buffer, "SCALAR", Uint32Array.from(geometry.index?.array ?? [])),
    );
  const count = position.getCount();
  if (options.joints === true) {
    const joints = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    for (let vertex = 0; vertex < count; vertex += 1) weights[vertex * 4] = 1;
    primitive.setAttribute("JOINTS_0", accessor(document, buffer, "VEC4", joints));
    primitive.setAttribute("WEIGHTS_0", accessor(document, buffer, "VEC4", weights));
  }
  if (options.custom === true)
    primitive.setAttribute(
      "_CUSTOM",
      accessor(
        document,
        buffer,
        "VEC2",
        Float32Array.from(
          { length: count * 2 },
          (_, i) => ((i * 97) % 1000) * (options.customRange ?? 0),
        ),
      ),
    );
  if (options.extraUv === true)
    primitive.setAttribute(
      "COLOR_1",
      accessor(document, buffer, "VEC4", new Float32Array(count * 4)),
    );
  if (options.morph === true) primitive.addTarget(document.createPrimitiveTarget());
  for (const [index, name] of (options.names ?? [options.name ?? "hull"]).entries())
    scene.addChild(
      document
        .createNode(name)
        .setMesh(
          document.createMesh(name).addPrimitive(index === 0 ? primitive : primitive.clone()),
        ),
    );
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

/** 8,192 triangles: eligible at the default floor, far below the virtual bake's 65,536 line. */
async function mediumGlb(options: Parameters<typeof torusGlb>[2] = {}): Promise<Buffer> {
  return torusGlb(256, 16, options);
}

/** 512 triangles: under the old per-primitive floor, so a chain here could only come from config. */
async function smallGlb(options: Parameters<typeof torusGlb>[2] = {}): Promise<Buffer> {
  return torusGlb(32, 8, options);
}

/** 32 triangles: below the new pre-filter floor as an asset, so it is skipped before any work. */
async function tinyGlb(options: Parameters<typeof torusGlb>[2] = {}): Promise<Buffer> {
  return torusGlb(4, 4, options);
}

/**
 * A shape like a shipped carrier: many primitives, each well under an absolute per-primitive
 * triangle floor, whose asset total is large. This is the case PRD-377's fixed per-primitive
 * `minTriangles: 5000` could never help — 8 primitives x 1,536 triangles = 12,288 total, every
 * primitive skipped. The floor's scope is what this fixture pins.
 */
async function carrierGlb(primitives: number, tubular = 96, radial = 8): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const mesh = document.createMesh("carrier");
  const material = document.createMaterial("hull");
  for (let index = 0; index < primitives; index += 1) {
    const geometry = new TorusKnotGeometry(1, 0.35, tubular, radial);
    mesh.addPrimitive(
      document
        .createPrimitive()
        .setAttribute(
          "POSITION",
          accessor(
            document,
            buffer,
            "VEC3",
            Float32Array.from(geometry.attributes.position?.array ?? []),
          ),
        )
        .setAttribute(
          "NORMAL",
          accessor(
            document,
            buffer,
            "VEC3",
            Float32Array.from(geometry.attributes.normal?.array ?? []),
          ),
        )
        .setIndices(
          accessor(document, buffer, "SCALAR", Uint32Array.from(geometry.index?.array ?? [])),
        )
        .setMaterial(material),
    );
  }
  scene.addChild(document.createNode("carrier").setMesh(mesh));
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

/**
 * A carrier shape with a chosen primitive/material split: `primitives` small same-attribute
 * primitives across `materials` materials — the Midway shape whose cost is the draw count, not the
 * per-primitive triangle density. Each primitive is ~1,200 triangles at the default tub/rad.
 */
async function joinCarrierGlb(
  primitives: number,
  materials: number,
  options: { joints?: boolean; animated?: boolean; tubular?: number; radial?: number } = {},
): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const tubular = options.tubular ?? 30;
  const radial = options.radial ?? 20;
  const mesh = document.createMesh("carrier");
  const palette = Array.from({ length: materials }, (_, index) =>
    document
      .createMaterial(`mat${index}`)
      // Distinct base colours keep `dedup` from merging them: the fixture must keep its materials.
      .setBaseColorFactor([(index + 1) / (materials + 1), 0.5, 0.25, 1]),
  );
  for (let index = 0; index < primitives; index += 1) {
    const geometry = new TorusKnotGeometry(1, 0.35, tubular, radial);
    // Offset each copy: coincident identical geometry is exactly the degenerate case the simplifier
    // refuses to touch, and a real carrier's primitives sit at distinct positions.
    const position = Float32Array.from(geometry.attributes.position?.array ?? []);
    const offsetX = (index % 20) * 0.02;
    const offsetY = Math.floor(index / 20) * 0.02;
    for (let vertex = 0; vertex + 2 < position.length; vertex += 3) {
      position[vertex] = (position[vertex] as number) + offsetX;
      position[vertex + 1] = (position[vertex + 1] as number) + offsetY;
    }
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", accessor(document, buffer, "VEC3", position))
      .setAttribute(
        "NORMAL",
        accessor(
          document,
          buffer,
          "VEC3",
          Float32Array.from(geometry.attributes.normal?.array ?? []),
        ),
      )
      .setIndices(
        accessor(document, buffer, "SCALAR", Uint32Array.from(geometry.index?.array ?? [])),
      )
      .setMaterial(palette[index % materials] ?? null);
    if (options.joints === true) {
      const count = primitive.getAttribute("POSITION")?.getCount() ?? 0;
      primitive.setAttribute(
        "JOINTS_0",
        accessor(document, buffer, "VEC4", new Uint16Array(count * 4)),
      );
      primitive.setAttribute(
        "WEIGHTS_0",
        accessor(document, buffer, "VEC4", new Float32Array(count * 4)),
      );
    }
    mesh.addPrimitive(primitive);
  }
  const node = document.createNode("carrier").setMesh(mesh);
  scene.addChild(node);
  if (options.animated === true) {
    const animation = document.createAnimation("spin");
    const input = accessor(document, buffer, "SCALAR", new Float32Array([0, 1]));
    const output = accessor(document, buffer, "VEC3", new Float32Array([0, 0, 0, 1, 0, 0]));
    const sampler = document
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation("LINEAR");
    const channel = document
      .createAnimationChannel()
      .setTargetPath("translation")
      .setTargetNode(node)
      .setSampler(sampler);
    animation.addSampler(sampler).addChannel(channel);
  }
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

/**
 * The real Midway shape: one primitive per mesh, one mesh per sibling node under a shared parent, a
 * handful of materials. There is no multi-primitive mesh, so the within-mesh join had nothing to
 * collapse. The node carries the offset, as a Blender export writes it, so a cross-sibling join must
 * bake that transform into the rung or the merged geometry lands on top of itself.
 */
async function siblingCarrierGlb(
  siblings: number,
  materials: number,
  options: { tubular?: number; radial?: number; animatedSiblings?: boolean } = {},
): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const root = document.createNode("carrier");
  scene.addChild(root);
  const tubular = options.tubular ?? 30;
  const radial = options.radial ?? 20;
  const geometry = new TorusKnotGeometry(1, 0.35, tubular, radial);
  const position = Float32Array.from(geometry.attributes.position?.array ?? []);
  const normal = Float32Array.from(geometry.attributes.normal?.array ?? []);
  const indices = Uint32Array.from(geometry.index?.array ?? []);
  const palette = Array.from({ length: materials }, (_, index) =>
    document
      .createMaterial(`mat${index}`)
      .setBaseColorFactor([(index + 1) / (materials + 1), 0.5, 0.25, 1]),
  );
  const children: GltfNode[] = [];
  for (let index = 0; index < siblings; index += 1) {
    // A hair of per-part geometry keeps `dedup` from collapsing the 146 meshes into one instanced
    // mesh: the real assets are distinct geometry, not one mesh placed 146 times.
    const partPosition = Float32Array.from(position);
    for (let vertex = 2; vertex < partPosition.length; vertex += 3)
      partPosition[vertex] = (partPosition[vertex] as number) + index * 0.001;
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", accessor(document, buffer, "VEC3", partPosition))
      .setAttribute("NORMAL", accessor(document, buffer, "VEC3", Float32Array.from(normal)))
      .setIndices(accessor(document, buffer, "SCALAR", Uint32Array.from(indices)))
      .setMaterial(palette[index % materials] ?? null);
    const node = document
      .createNode(`part${index}`)
      .setMesh(document.createMesh(`part${index}`).addPrimitive(primitive))
      .setTranslation([(index % 20) * 0.02, Math.floor(index / 20) * 0.02, 0]);
    root.addChild(node);
    children.push(node);
  }
  if (options.animatedSiblings === true) {
    const input = accessor(document, buffer, "SCALAR", new Float32Array([0, 1]));
    const output = accessor(document, buffer, "VEC3", new Float32Array([0, 0, 0, 1, 0, 0]));
    for (const [index, target] of children.entries()) {
      const animation = document.createAnimation(`spin${index}`);
      const sampler = document
        .createAnimationSampler()
        .setInput(input)
        .setOutput(output)
        .setInterpolation("LINEAR");
      const channel = document
        .createAnimationChannel()
        .setTargetPath("translation")
        .setTargetNode(target)
        .setSampler(sampler);
      animation.addSampler(sampler).addChannel(channel);
    }
  }
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

/** A raw primitive with explicit indices, for topology and boundary fixtures. */
async function rawGlb(spec: {
  indices: number[];
  mode?: GLTF.MeshPrimitiveMode;
  minVertices: number;
  name?: string;
}): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const positions = new Float32Array(spec.minVertices * 3);
  for (let vertex = 0; vertex < spec.minVertices; vertex += 1) positions[vertex * 3] = vertex * 0.1;
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", accessor(document, buffer, "VEC3", positions))
    .setIndices(accessor(document, buffer, "SCALAR", Uint32Array.from(spec.indices)))
    .setMaterial(document.createMaterial("rock"));
  if (spec.mode !== undefined) primitive.setMode(spec.mode);
  const name = spec.name ?? "raw";
  scene.addChild(
    document.createNode(name).setMesh(document.createMesh(name).addPrimitive(primitive)),
  );
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

/**
 * `patches` disconnected flat open grids in one primitive. LockBorder can only reduce each patch to
 * its boundary ring — the interior collapses to nothing — so the error ladder stalls at
 * `patches * 4 * segments` triangles and a terminal level is the only way below it. Coplanar, so no
 * geometric error, which is exactly the case the terminal level exists for.
 */
async function patchesGlb(patches: number, segments: number, size = 0.4): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const columns = Math.ceil(Math.sqrt(patches));
  for (let patch = 0; patch < patches; patch += 1) {
    const geometry = new PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate((patch % columns) * size * 1.2, 0, Math.floor(patch / columns) * size * 1.2);
    const offset = positions.length / 3;
    for (const value of geometry.attributes.position?.array ?? []) positions.push(value as number);
    for (const value of geometry.attributes.normal?.array ?? []) normals.push(value as number);
    for (const index of geometry.index?.array ?? []) indices.push((index as number) + offset);
  }
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor()
        .setType("VEC3")
        .setArray(Float32Array.from(positions))
        .setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      document
        .createAccessor()
        .setType("VEC3")
        .setArray(Float32Array.from(normals))
        .setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setType("SCALAR")
        .setArray(Uint32Array.from(indices))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial("rock"));
  scene.addChild(
    document.createNode("patches").setMesh(document.createMesh("patches").addPrimitive(primitive)),
  );
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

/** A hand-built one-level chain, the shape every chain had before the terminal level existed. */
async function oldChainGlb(): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array(4 * 3))
        .setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setType("SCALAR")
        .setArray(Uint32Array.from([0, 1, 2, 0, 2, 3]))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial("rock"));
  const extension = document.createExtension(TNDiscreteLod).setRequired(false);
  const property = extension
    .createDiscreteLod()
    .setStrategy("discrete")
    .setBaselineTriangles(2)
    .setLod0Triangles(2)
    .setErrorScale(1)
    .setCounts([1])
    .setErrors([0.1])
    .setAbsoluteErrors([0.1])
    .setSharedVertexBuffers(true);
  property.addIndices(
    document
      .createAccessor()
      .setType("SCALAR")
      .setArray(Uint32Array.from([0, 1, 2]))
      .setBuffer(buffer),
  );
  primitive.setExtension(TN_DISCRETE_LOD, property);
  extension.setMetadata({
    generator: "old",
    generationFingerprint: "old",
    schemaVersion: LOD_SCHEMA_VERSION,
    sourceDigest: "old",
    sourcePath: "old.glb",
    toolchain: "old",
  });
  scene.addChild(
    document.createNode("old").setMesh(document.createMesh("old").addPrimitive(primitive)),
  );
  return Buffer.from(
    await new NodeIO()
      .setLogger(SILENT)
      .registerExtensions([...ALL_EXTENSIONS, TNDiscreteLod])
      .writeBinary(document),
  );
}

async function readWithLod(root: Buffer): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .setLogger(SILENT)
    .registerExtensions([...ALL_EXTENSIONS, TNVirtualGeometry, TNDiscreteLod])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  return io.readJSON(await io.binaryToJSON(root));
}

/** A reader that has never heard of the extension, exactly like a stock `GLTFLoader`. */
async function readGeneric(root: Buffer): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .setLogger(SILENT)
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  return io.readJSON(await io.binaryToJSON(root));
}

async function cook(
  input: Buffer,
  options: Parameters<typeof modelPass>[0],
  logicalPath = "hull.glb",
): Promise<IModelLodSummary> {
  // Isolate the LOD generator from scene-graph compaction, which has its own spec.
  const result = await modelPass({ compact: false, ...options }).apply(input, logicalPath);
  if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
  if (result.entry?.lod === undefined) throw new Error("the pass produced no lod summary");
  return result.entry.lod as IModelLodSummary;
}

const GENERATE = { generation: { maxLevels: 4, minTriangles: 1_000 } } as const;

describe("automatic discrete LOD generation", () => {
  it("generates a monotonic, bounded chain on an eligible dense primitive", async () => {
    const input = await mediumGlb();
    const summary = await cook(input, { lod: GENERATE, virtual: "none" });

    expect(summary.enabled).toBe(true);
    expect(summary.generated).toBe(1);
    expect(summary.levels).toBeGreaterThanOrEqual(1);
    expect(summary.levels).toBeLessThanOrEqual(GENERATE.generation.maxLevels - 1);
    const levels = summary.primitives[0]?.levels ?? [];
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]?.triangles).toBeLessThan(levels[index - 1]?.triangles ?? 0);
      expect(levels[index]?.error).toBeGreaterThanOrEqual(levels[index - 1]?.error ?? 0);
    }
    expect(levels.at(-1)?.triangles ?? Number.POSITIVE_INFINITY).toBeLessThan(
      summary.trianglesBefore,
    );
    expect(summary.trianglesAfter).toBeLessThan(summary.trianglesBefore);
    expect(LOD_ERROR_TARGETS.length).toBeGreaterThanOrEqual(summary.levels);
    expect(summary.reasons).not.toContain("too-small");
  }, 120_000);

  it("bakes a chain over an application attribute and keeps sharing it", async () => {
    // glTF reserves the `_` prefix for application data — a per-vertex wind weight, say. A level
    // only swaps the index buffer over the base vertices, so the attribute is shared exactly the
    // way COLOR_0 is; refusing it cost the grove's tree bark every level.
    const input = await mediumGlb({ custom: true });
    const result = await modelPass({ compact: false, lod: GENERATE, virtual: "none" }).apply(
      input,
      "hull.glb",
    );
    if (Buffer.isBuffer(result)) throw new Error("unchanged");
    const summary = result.entry?.lod as IModelLodSummary;
    expect(summary.reasons).not.toContain("unsupported-attributes");
    expect(summary.generated).toBe(1);
    const document = await readWithLod(result.buffer);
    const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
    expect(primitive?.getAttribute("_CUSTOM")).not.toBeNull();
  }, 120_000);

  it("keeps application data out of the simplifier's error", async () => {
    // Its range is the application's: raw ids in the hundreds would outweigh every geometric term
    // and inflate the error, while a level shares the data unchanged whatever the simplifier does.
    const plain = await cook(await mediumGlb(), { lod: GENERATE, virtual: "none" });
    const tagged = await cook(await mediumGlb({ custom: true, customRange: 1 }), {
      lod: GENERATE,
      virtual: "none",
    });
    expect(tagged.primitives[0]?.levels).toEqual(plain.primitives[0]?.levels);
  }, 120_000);

  it("records the chain in the artifact and round-trips it", async () => {
    const input = await mediumGlb();
    const result = await modelPass({ lod: GENERATE, virtual: "none" }).apply(input, "hull.glb");
    if (Buffer.isBuffer(result)) throw new Error("unchanged");

    const read = await readWithLod(result.buffer);
    // The document-level extension carries the identity once; the primitive carries the chain.
    const json = JSON.parse(
      result.buffer.subarray(20, 20 + result.buffer.readUInt32LE(12)).toString("utf8"),
    ) as { extensions?: Record<string, { generationFingerprint?: string }> };
    expect(json.extensions?.[TN_DISCRETE_LOD]?.generationFingerprint).toBe(
      (result.entry?.lod as IModelLodSummary).fingerprint,
    );
    const root = read.getRoot();
    const primitives = root
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .filter((primitive) => primitive.getExtension(TN_DISCRETE_LOD) !== null);
    expect(primitives).toHaveLength(1);
    const property = primitives[0]?.getExtension(TN_DISCRETE_LOD) as DiscreteLod | null;
    expect(property).not.toBeNull();
    expect(property?.getStrategy()).toBe("discrete");
    expect(property?.getSharedVertexBuffers()).toBe(true);
    expect(property?.getLod0Triangles()).toBe(8192);
    expect(property?.getCounts()).toHaveLength(property?.getIndices().length ?? 0);
    expect(property?.getErrors()).toHaveLength(property?.getCounts().length ?? 0);
    expect(property?.getErrorScale()).toBeGreaterThan(0);
  }, 120_000);

  it("leaves a primitive under minTriangles untouched and says why", async () => {
    const input = await smallGlb();
    const summary = await cook(input, {
      lod: { generation: { minTriangles: 5_000 } },
      virtual: "none",
    });
    expect(summary.generated).toBe(0);
    expect(summary.reasons).toContain("too-small");
  }, 60_000);

  it("generates levels for a many-small-primitive asset whose total is large", async () => {
    // The Midway shape: 8 primitives of 1,536 triangles each. Every primitive is far under a
    // 5,000-triangle floor, but the asset is 12,288 triangles. The old per-primitive floor
    // produced nothing here; the benefit test now decides, primitive by primitive.
    const summary = await cook(await carrierGlb(8), {
      lod: { generation: { maxLevels: 4 } },
      virtual: "none",
    });
    expect(summary.generated).toBeGreaterThan(0);
    expect(summary.reasons).not.toContain("too-small");
    expect(summary.trianglesAfter).toBeLessThan(summary.trianglesBefore);
  }, 120_000);

  it("still skips a genuinely tiny asset, with its reason", async () => {
    const summary = await cook(await tinyGlb(), {
      lod: { generation: { maxLevels: 4 } },
      virtual: "none",
    });
    expect(summary.generated).toBe(0);
    expect(summary.reasons).toContain("too-small");
  }, 60_000);

  it("measures the floor against the asset by default and against a primitive when asked", async () => {
    // Scope is the switch: the same floor passes the 12,288-triangle asset as a whole and fails
    // every 1,536-triangle primitive.
    const asset = await cook(await carrierGlb(8), {
      lod: { generation: { maxLevels: 4, minTriangles: 5_000, minTrianglesScope: "asset" } },
      virtual: "none",
    });
    expect(asset.generated).toBeGreaterThan(0);

    const primitive = await cook(await carrierGlb(8), {
      lod: { generation: { maxLevels: 4, minTriangles: 5_000, minTrianglesScope: "primitive" } },
      virtual: "none",
    });
    expect(primitive.generated).toBe(0);
    expect(primitive.reasons).toContain("too-small");
  }, 180_000);

  it("moves the floor scope for one asset through the per-asset override map", async () => {
    const summary = await cook(
      await carrierGlb(8),
      {
        lod: {
          generation: { maxLevels: 4, minTriangles: 5_000, minTrianglesScope: "primitive" },
          overrides: { "carrier.glb": { generation: { minTrianglesScope: "asset" } } },
        },
        virtual: "none",
      },
      "carrier.glb",
    );
    expect(summary.generated).toBeGreaterThan(0);
    expect(summary.minTrianglesScope).toBe("asset");
  }, 120_000);

  it("drives the simplifier from the configured error targets and saving rule", async () => {
    const all = await cook(await mediumGlb(), {
      lod: { generation: { maxLevels: 4 } },
      virtual: "none",
    });
    // One target can only produce one candidate; the full ladder produces more.
    expect(all.primitives[0]?.levels.length ?? 0).toBeGreaterThan(1);

    const tight = await cook(await mediumGlb(), {
      lod: { generation: { maxLevels: 4, errorTargets: [0.02] } },
      virtual: "none",
    });
    const loose = await cook(await mediumGlb(), {
      lod: { generation: { maxLevels: 4, errorTargets: [0.06] } },
      virtual: "none",
    });
    expect(tight.primitives[0]?.levels).toHaveLength(1);
    expect(loose.primitives[0]?.levels).toHaveLength(1);
    // A looser error target must buy more reduction and report a larger error.
    expect(loose.primitives[0]?.levels[0]?.triangles ?? 0).toBeLessThanOrEqual(
      tight.primitives[0]?.levels[0]?.triangles ?? 0,
    );
    expect(loose.primitives[0]?.levels[0]?.error ?? 0).toBeGreaterThan(
      tight.primitives[0]?.levels[0]?.error ?? 0,
    );

    // A saving rule the error ladder cannot satisfy still leaves the primitive its one terminal
    // coarse level: the terminal is exempt from the saving gate by design (PRD-473), so it does not
    // strand a far instance at LOD0 just because no error-target level paid enough.
    const unsatisfiable = await cook(await mediumGlb(), {
      lod: { generation: { maxLevels: 4, errorTargets: [0.06], minSaving: 0.99 } },
      virtual: "none",
    });
    expect(unsatisfiable.generated).toBe(1);
    expect(unsatisfiable.reasons).not.toContain("insufficient-reduction");
    expect(unsatisfiable.primitives[0]?.levels).toHaveLength(1);
    const terminal = unsatisfiable.primitives[0]?.levels[0];
    expect(terminal?.triangles ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      Math.max(1_500, Math.ceil(0.05 * (unsatisfiable.primitives[0]?.trianglesBefore ?? 0))),
    );
  }, 240_000);

  it("does not generate when the policy is off", async () => {
    const summary = await cook(await mediumGlb(), { lod: { enabled: false }, virtual: "none" });
    expect(summary.enabled).toBe(false);
    expect(summary.generated).toBe(0);
    expect(summary.reasons).toContain("disabled");
  }, 60_000);

  it("skips a ClusteredMesh-owned primitive instead of stacking a discrete owner", async () => {
    // 65,536 triangles at a lowered virtual floor: the bake owns it, so discrete must not.
    const dense = await torusGlb(512, 64);
    const result = await modelPass({
      lod: { generation: { minTriangles: 1_000 } },
      virtual: { minSourceTriangles: 1024 },
    }).apply(dense, "hull.glb");
    if (Buffer.isBuffer(result)) throw new Error("unchanged");
    const summary = result.entry?.lod as IModelLodSummary;
    expect((result.entry?.virtual as { primitives: number }).primitives).toBe(1);
    expect(summary.generated).toBe(0);
    expect(summary.reasons).toContain("virtual-owned");
  }, 600_000);

  it("never turns virtual:none into default-on discrete", async () => {
    const summary = await cook(await mediumGlb(), { lod: {}, virtual: "none" });
    expect(summary.generated).toBe(0);
    expect(summary.reasons).toContain("virtual-none");
    expect(summary.enabled).toBe(false);
  }, 60_000);

  it("skips explicit legacy simplify with explicit-legacy-simplify", async () => {
    // Default virtual is fine here: 8,192 triangles is under its 65,536 floor, so the legacy
    // declaration under test is `simplify`, not `virtual: "none"`.
    const summary = await cook(await mediumGlb(), {
      lod: {},
      simplify: { ratio: 0.5 },
    });
    expect(summary.generated).toBe(0);
    expect(summary.reasons).toContain("explicit-legacy-simplify");
  }, 60_000);

  it("declines an already-cooked chain instead of reprocessing it", async () => {
    const input = await mediumGlb();
    const first = await modelPass({ lod: GENERATE, virtual: "none" }).apply(input, "hull.glb");
    if (Buffer.isBuffer(first)) throw new Error("unchanged");
    const second = await modelPass({ lod: GENERATE, virtual: "none" }).apply(
      first.buffer,
      "hull.glb",
    );
    if (Buffer.isBuffer(second)) throw new Error("unchanged");
    const summary = second.entry?.lod as IModelLodSummary;
    expect(summary.generated).toBe(0);
    expect(summary.reasons).toContain("already-cooked");
  }, 120_000);

  it("generates a chain for a lone LOD-named mesh, which no authored chain selects", async () => {
    // A pack's `_LOD2` scattered as a tree of its own: no sibling level exists in the asset, so
    // skipping it as authored left Machinefall's 545 nearest pines at 8,900 triangles each.
    const summary = await cook(await mediumGlb({ name: "pine_far_LOD2" }), {
      lod: GENERATE,
      virtual: "none",
    });
    expect(summary.reasons).not.toContain("authored-lod");
    expect(summary.generated).toBeGreaterThan(0);
  }, 120_000);

  it("reports each structural skip reason on a fixture that triggers it", async () => {
    const cases: readonly {
      reason: string;
      build: () => Promise<Buffer>;
      lod?: Parameters<typeof modelPass>[0];
    }[] = [
      {
        build: () => rawGlb({ indices: [0, 1, 2], minVertices: 3, mode: 1 }),
        reason: "unsupported-topology",
      },
      {
        build: () => rawGlb({ indices: [0, 1, 2], minVertices: 3, mode: 0 }),
        reason: "unsupported-topology",
      },
      {
        // The default prune drops an unused COLOR_1 before eligibility sees it; keep it to prove
        // a standard semantic the chain does not share is still declined by name.
        build: () => smallGlb({ extraUv: true }),
        lod: { lod: GENERATE, passes: { prune: false }, virtual: "none" },
        reason: "unsupported-attributes",
      },
      { build: () => smallGlb({ joints: true }), reason: "deforming" },
      { build: () => smallGlb({ morph: true }), reason: "deforming" },
      // `MASK` used to be declined here too, and no longer is: an alpha-tested card draws a subset
      // of LOD0's fragments, so a chain keeps its silhouette. `foliage-lod.spec.ts` proves the
      // foliage half; `BLEND` is still refused, because a simplified blended card is a hole.
      { build: () => smallGlb({ alpha: "BLEND" }), reason: "material-unsupported" },
      { build: () => smallGlb({ names: ["hull_LOD0", "hull_LOD1"] }), reason: "authored-lod" },
      {
        // Edge (0,1) is shared by three triangles: a non-manifold fan. A tiny floor is needed so
        // the fixture is not declined as too-small first.
        build: () => rawGlb({ indices: [0, 1, 2, 0, 1, 3, 0, 1, 4], minVertices: 5 }),
        lod: { lod: { generation: { minTriangles: 1 } }, virtual: "none" },
        reason: "boundary-unsafe",
      },
    ];
    for (const { reason, build, lod } of cases) {
      const summary = await cook(await build(), lod ?? { lod: GENERATE, virtual: "none" });
      expect(summary.generated, reason).toBe(0);
      expect(summary.reasons, reason).toContain(reason);
    }
  }, 120_000);
});

describe("discrete LOD artifact rules", () => {
  it("keeps LOD0 byte-identical to the non-AutoLOD cook", async () => {
    const input = await mediumGlb();
    const plain = await modelPass({ virtual: "none" }).apply(input, "hull.glb");
    const generated = await modelPass({ lod: GENERATE, virtual: "none" }).apply(input, "hull.glb");
    if (Buffer.isBuffer(plain) || Buffer.isBuffer(generated)) throw new Error("unchanged");

    const plainRoot = (await readWithLod(plain.buffer)).getRoot();
    const generatedRoot = (await readWithLod(generated.buffer)).getRoot();
    const arrays = (root: ReturnType<Document["getRoot"]>): Uint8Array[] =>
      root
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives())
        .flatMap((primitive) => [
          ...(primitive.getIndices()?.getArray() ?? []),
          ...(primitive.getAttribute("POSITION")?.getArray() ?? []),
        ]);
    expect(arrays(generatedRoot)).toEqual(arrays(plainRoot));
  }, 120_000);

  it("shows a generic reader only LOD0", async () => {
    const input = await mediumGlb();
    const result = await modelPass({ lod: GENERATE, virtual: "none" }).apply(input, "hull.glb");
    if (Buffer.isBuffer(result)) throw new Error("unchanged");

    const generic = await readGeneric(result.buffer);
    const source = await readGeneric(input);
    const triangles = (root: ReturnType<Document["getRoot"]>) =>
      root
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives())
        .map((primitive) => primitive.getIndices()?.getCount() ?? 0);
    expect(triangles(generic.getRoot())).toEqual(triangles(source.getRoot()));
    expect(generic.getRoot().listMeshes()).toHaveLength(1);
    expect(generic.getRoot().listMeshes()[0]?.listPrimitives()).toHaveLength(1);
  }, 120_000);

  it("is deterministic and independent of runtime-only budget edits", async () => {
    const input = await mediumGlb();
    const base = {
      generation: { maxLevels: 4, minTriangles: 1_000 },
      runtime: { maxPixelError: 1 },
    };
    const first = await modelPass({ lod: base, virtual: "none" }).apply(input, "hull.glb");
    const second = await modelPass({ lod: base, virtual: "none" }).apply(input, "hull.glb");
    const retuned = await modelPass({
      lod: { ...base, runtime: { maxPixelError: 5, hysteresis: 0.3 } },
      virtual: "none",
    }).apply(input, "hull.glb");
    if (Buffer.isBuffer(first) || Buffer.isBuffer(second) || Buffer.isBuffer(retuned))
      throw new Error("unchanged");

    expect(first.buffer.equals(second.buffer)).toBe(true);
    // The runtime edit changes neither the bytes nor the pass's generation cache key.
    expect(first.buffer.equals(retuned.buffer)).toBe(true);
    expect(JSON.stringify(modelPass({ lod: base, virtual: "none" }).configuration)).toBe(
      JSON.stringify(
        modelPass({
          lod: { ...base, runtime: { maxPixelError: 5, hysteresis: 0.3 } },
          virtual: "none",
        }).configuration,
      ),
    );
  }, 120_000);

  it("drops a level that saves under 20% of its predecessor", () => {
    const kept = selectDiscreteLevels(
      [
        { error: 0.001, triangles: 850 }, // 15% off the 1,000 reference: dropped
        { error: 0.01, triangles: 700 }, // 30% off the reference: kept
        { error: 0.02, triangles: 640 }, // 8.5% off 700: dropped
        { error: 0.05, triangles: 500 }, // 28.5% off 700: kept
      ],
      4,
      1_000,
    );
    expect(kept.map((level) => level.triangles)).toEqual([700, 500]);
  });

  it("honours a configured saving rule instead of the built-in 20%", () => {
    const candidates = [
      { error: 0.01, triangles: 700 },
      { error: 0.02, triangles: 640 },
      { error: 0.05, triangles: 500 },
    ];
    // Default 20%: 700 saves 30%, then 500 saves 28.5% off 700.
    expect(selectDiscreteLevels(candidates, 4, 1_000).map((level) => level.triangles)).toEqual([
      700, 500,
    ]);
    // A 50% rule drops both partial reductions and keeps only the level that halves the count.
    expect(selectDiscreteLevels(candidates, 4, 1_000, 0.5).map((level) => level.triangles)).toEqual(
      [500],
    );
  });

  it("honours maxLevels as a ceiling, not a promise", () => {
    const kept = selectDiscreteLevels(
      [
        { error: 0.001, triangles: 800 },
        { error: 0.002, triangles: 600 },
        { error: 0.003, triangles: 400 },
        { error: 0.004, triangles: 200 },
      ],
      2,
      1_000,
    );
    expect(kept).toHaveLength(1);
  });

  it("resolves per-asset generation precedence and the absolute kill switch", () => {
    const project = {
      generation: { maxLevels: 6, minTriangles: 9_000 },
      overrides: { "hull.glb": { generation: { maxLevels: 2 } }, "off.glb": false },
    };
    expect(resolveLodPolicy(project, "hull.glb")).toMatchObject({
      enabled: true,
      generation: { maxLevels: 2, minTriangles: 9_000 },
    });
    expect(resolveLodPolicy(project, "off.glb")).toMatchObject({
      enabled: false,
      reasons: ["disabled"],
    });
    expect(resolveLodPolicy(false, "hull.glb", { virtualNone: true })).toMatchObject({
      enabled: false,
      reasons: ["disabled"],
    });
  });

  it("defaults every generation knob and lets project and asset move each one", () => {
    const base = resolveLodPolicy(undefined, "carrier.glb");
    expect(base.generation).toEqual({
      errorTargets: LOD_ERROR_TARGETS,
      join: false,
      maxLevels: 4,
      minSaving: LOD_MIN_SAVING,
      minTriangles: DEFAULT_LOD_MIN_TRIANGLES,
      minTrianglesScope: "asset",
    });
    // The default floors the asset, not the primitive: the case that made the old gate inert.
    expect(resolveLodPolicy({}, "carrier.glb").generation.minTrianglesScope).toBe("asset");
    // The join is opt-in: no option means no joined rung, byte-identical to today.
    expect(resolveLodPolicy({}, "carrier.glb").generation.join).toBe(false);

    const project = resolveLodPolicy(
      {
        generation: {
          errorTargets: [0.01, 0.1],
          join: true,
          maxLevels: 6,
          minSaving: 0.35,
          minTriangles: 4_000,
          minTrianglesScope: "primitive",
        },
      },
      "carrier.glb",
    );
    expect(project.generation).toEqual({
      errorTargets: [0.01, 0.1],
      join: true,
      maxLevels: 6,
      minSaving: 0.35,
      minTriangles: 4_000,
      minTrianglesScope: "primitive",
    });

    // A per-asset override moves one nested field without replacing the rest of the block.
    const asset = resolveLodPolicy(
      {
        generation: { maxLevels: 6, minTriangles: 4_000, minTrianglesScope: "primitive" },
        overrides: {
          "carrier.glb": { generation: { join: true, minSaving: 0.5, minTrianglesScope: "asset" } },
        },
      },
      "carrier.glb",
    );
    expect(asset.generation).toEqual({
      errorTargets: LOD_ERROR_TARGETS,
      join: true,
      maxLevels: 6,
      minSaving: 0.5,
      minTriangles: 4_000,
      minTrianglesScope: "asset",
    });

    // Every one of the new knobs is part of the generation cache identity.
    for (const generation of [
      { join: true },
      { minSaving: 0.3 },
      { minTrianglesScope: "primitive" as const },
      { errorTargets: [0.02] },
      { minTriangles: 64 },
    ]) {
      expect(resolveLodPolicy({ generation }, "carrier.glb").fingerprint.generation).not.toBe(
        base.fingerprint.generation,
      );
    }
  });

  it("keeps the runtime budget out of the generation fingerprint", () => {
    const base = resolveLodPolicy(undefined, "hull.glb");
    const budget = resolveLodPolicy({ runtime: { hysteresis: 0.3, maxPixelError: 2 } }, "hull.glb");
    expect(budget.fingerprint.generation).toBe(base.fingerprint.generation);
    expect(budget.fingerprint.runtime).not.toBe(base.fingerprint.runtime);
    expect(budget.runtime).toEqual({ hysteresis: 0.3, maxPixelError: 2 });
  });

  it("matches authored LOD names", () => {
    expect(authoredLodName("hull_LOD1")).toBe(true);
    expect(authoredLodName("hull-lod2")).toBe(true);
    expect(authoredLodName("hull")).toBe(false);
    expect(authoredLodName("lodestone")).toBe(false);
  });
});

describe("terminal coarse level (PRD-473)", () => {
  /**
   * A realistic tree-soup fixture: `cards` separate open quads (two triangles each), every triangle
   * carrying its own three vertices and a duplicated UV seam on the shared edge. This is how a
   * machinefall trunk exports — no shared vertices, so LockBorder refuses every error collapse and
   * the simplifier sees no component to spend — and it is opaque, so the needle-card reducer
   * declines it too. Before this fix it shipped no chain at all and every runtime level drew LOD0.
   */
  async function seamCardSoupGlb(cards: number): Promise<Buffer> {
    const document = new Document();
    const buffer = document.createBuffer();
    const scene = document.createScene();
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let seed = 987_654_321;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed / 0x7f_ff_ff_ff;
    };
    for (let card = 0; card < cards; card += 1) {
      const cx = (random() * 2 - 1) * 20;
      const cy = (random() * 2 - 1) * 20;
      const cz = (random() * 2 - 1) * 20;
      const half = 0.05;
      // Two triangles as a quad, with the diagonal corners duplicated: triangle soup, and the
      // shared edge appears twice with different UVs (the seam the simplifier must ignore here).
      const corners = [
        [cx - half, cy - half, cz, 0, 0],
        [cx + half, cy - half, cz, 1, 0],
        [cx + half, cy + half, cz, 1, 1],
        [cx - half, cy - half, cz, 0, 0],
        [cx + half, cy + half, cz, 1, 1],
        [cx - half, cy + half, cz, 0, 1],
      ];
      for (const corner of corners) {
        positions.push(corner[0] as number, corner[1] as number, corner[2] as number);
        uvs.push(corner[3] as number, corner[4] as number);
      }
      const base = card * 6;
      indices.push(base, base + 1, base + 2, base + 3, base + 4, base + 5);
    }
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", accessor(document, buffer, "VEC3", Float32Array.from(positions)))
      .setAttribute("TEXCOORD_0", accessor(document, buffer, "VEC2", Float32Array.from(uvs)))
      .setIndices(accessor(document, buffer, "SCALAR", Uint32Array.from(indices)))
      .setMaterial(document.createMaterial("trunk").setAlphaMode("OPAQUE"));
    scene.addChild(
      document.createNode("trunk").setMesh(document.createMesh("trunk").addPrimitive(primitive)),
    );
    return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
  }

  it("gives an opaque card soup a terminal level the error ladder and card reducer both decline", async () => {
    // 8,000 quads = 16,000 triangles, matching the real machinefall trees. The error ladder keeps
    // nothing (LockBorder on an all-border soup) and the card reducer refuses OPAQUE, so only the
    // welded terminal pass can bring the last level to the target.
    const input = await seamCardSoupGlb(8_000);
    const summary = await cook(input, { lod: GENERATE, virtual: "none" });
    expect(summary.generated).toBe(1);
    const entry = summary.primitives[0];
    if (entry === undefined) throw new Error("no primitive");
    expect(entry.trianglesBefore).toBe(16_000);
    expect(entry.strategy).toBe("discrete");
    const target = Math.max(
      LOD_TERMINAL_MIN_TRIANGLES,
      Math.ceil(LOD_TERMINAL_KEEP_RATIO * 16_000),
    );
    const terminal = entry.levels.at(-1);
    expect(entry.levels.length).toBeGreaterThanOrEqual(1);
    expect(terminal?.triangles ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(target);
    expect(terminal?.triangles ?? 0).toBeGreaterThan(0);
    // The terminal's error is still recorded, so the runtime can place its switch from it.
    expect(terminal?.error ?? 0).toBeGreaterThan(0);
    expect(terminal?.absoluteError ?? 0).toBeGreaterThan(0);

    // The welded terminal is deterministic: the same bytes bake the same chain.
    const again = await cook(input, { lod: GENERATE, virtual: "none" });
    expect(again.primitives[0]?.levels).toEqual(entry.levels);
  }, 240_000);

  it("ends an open mesh's chain at max(1500, 5%) and leaves the error levels alone", async () => {
    // 16 patches x 24 segments: 18,432 triangles, and LockBorder can only reach the 1,536-triangle
    // boundary ring. The target of 1,500 is below that, so this is exactly the chain that used to
    // stall at 8% saved.
    const input = await patchesGlb(16, 24);
    const summary = await cook(input, { lod: GENERATE, virtual: "none" });
    expect(summary.generated).toBe(1);
    const entry = summary.primitives[0];
    if (entry === undefined) throw new Error("no primitive");
    const lod0 = entry.trianglesBefore;
    expect(lod0).toBe(18_432);
    const target = Math.max(LOD_TERMINAL_MIN_TRIANGLES, Math.ceil(LOD_TERMINAL_KEEP_RATIO * lod0));
    expect(target).toBe(1_500);

    const levels = entry.levels;
    const terminal = levels.at(-1);
    expect(levels.length).toBeGreaterThanOrEqual(2);
    expect(terminal?.triangles ?? 0).toBeLessThanOrEqual(target);
    expect(terminal?.triangles ?? 0).toBeGreaterThan(0);
    expect(levels[0]?.triangles).toBe(16 * 4 * 24);
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]?.triangles).toBeLessThan(levels[index - 1]?.triangles ?? 0);
      expect(levels[index]?.error).toBeGreaterThanOrEqual(levels[index - 1]?.error ?? 0);
    }
    // The one error level the ladder reached is byte-identical to what a terminal-less cook of the
    // same mesh produced: adding the terminal did not recalculate it.
    const ladder = await cook(input, {
      lod: { generation: { maxLevels: 2, errorTargets: [0.06] } },
      virtual: "none",
    });
    expect(ladder.primitives[0]?.levels[0]?.triangles).toBe(levels[0]?.triangles);
    expect(ladder.primitives[0]?.levels[0]?.error).toBe(levels[0]?.error);
  }, 240_000);

  it("gives a mesh already under the terminal floor no terminal level", async () => {
    // 1,024 triangles: under the 1,500 floor, so `max(1500, 5%)` exceeds LOD0 and there is nothing
    // to gain. Only the error level ships, exactly one of them.
    const summary = await cook(await patchesGlb(8, 8), { lod: GENERATE, virtual: "none" });
    const levels = summary.primitives[0]?.levels ?? [];
    expect(summary.trianglesBefore).toBe(1_024);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.triangles ?? 0).toBeGreaterThan(0);
    expect(levels[0]?.triangles ?? 0).toBeLessThan(1_024);
  }, 120_000);

  it("bakes the terminal level deterministically", async () => {
    const input = await patchesGlb(16, 24);
    const first = await modelPass({ lod: GENERATE, virtual: "none" }).apply(input, "patches.glb");
    const second = await modelPass({ lod: GENERATE, virtual: "none" }).apply(input, "patches.glb");
    if (Buffer.isBuffer(first) || Buffer.isBuffer(second)) throw new Error("unchanged");
    expect(first.buffer.equals(second.buffer)).toBe(true);
  }, 240_000);

  it("loads an old chain that has no terminal level", async () => {
    // The chain layout did not change, so a file cooked before this feature still reads. The cache
    // identity moved instead, which is what makes a re-cook pick the terminal level up.
    expect(LOD_SCHEMA_VERSION).toBe(1);
    expect(LOD_GENERATOR_VERSION).toBe(4);
    const document = await readWithLod(await oldChainGlb());
    const primitive = document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .find((entry) => entry.getExtension(TN_DISCRETE_LOD) !== null);
    const property = primitive?.getExtension<DiscreteLod>(TN_DISCRETE_LOD);
    expect(property).not.toBeUndefined();
    expect(property?.getCounts()).toEqual([1]);
    expect(property?.getIndices()).toHaveLength(1);
  }, 60_000);
});

describe("assets.lod through the public compiler", () => {
  it("consumes the config, writes the extension and reports it in the manifest", async () => {
    const root = await makeTempDir("threenative-lod-");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets/hull.glb"), await mediumGlb());

    await compileAssets({
      concurrency: 1,
      config: {
        audio: "none",
        lod: { enabled: true, generation: { maxLevels: 4, minTriangles: 1_000 } },
        models: { virtual: "none", textures: "none" },
        textures: "none",
      },
      cwd: root,
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { lod?: IModelLodSummary; output: string }> };
    const entry = manifest.entries["hull.glb"];
    expect(entry?.lod?.generated).toBe(1);
    expect(entry?.lod?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // The runtime selection budget travels in the manifest, not in executable config (PRD-377 §5).
    expect(entry?.lod?.preset).toBe("balanced");
    expect(entry?.lod?.runtime).toEqual({ hysteresis: 0.15, maxPixelError: 1 });
    const output = await readFile(path.join(root, "public", entry?.output ?? ""));
    const json = JSON.parse(output.subarray(20, 20 + output.readUInt32LE(12)).toString("utf8")) as {
      extensionsUsed?: string[];
    };
    expect(json.extensionsUsed).toContain(TN_DISCRETE_LOD);
  }, 120_000);

  it("reports the opt-in joined rung in the compiler manifest when a game enables it", async () => {
    const root = await makeTempDir("threenative-lod-join-");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(
      path.join(root, "assets/carrier.glb"),
      await joinCarrierGlb(12, 3, { tubular: 8, radial: 6 }),
    );
    await compileAssets({
      concurrency: 1,
      config: {
        audio: "none",
        lod: { generation: { join: true, maxLevels: 1 } },
        models: { compact: false, virtual: "none", textures: "none" },
        textures: "none",
      },
      cwd: root,
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { lod?: IModelLodSummary }> };
    const lod = manifest.entries["carrier.glb"]?.lod;
    expect(lod?.join).toBe(true);
    // The cook report names the collapse: 12 authored primitives into 3 draws, one per material.
    expect(lod?.joined).toMatchObject({ draws: 3, primitives: 12 });
  }, 120_000);

  it("bakes nothing and installs nothing when the global switch is off", async () => {
    for (const lod of [false, { enabled: false }] as const) {
      const root = await makeTempDir("threenative-lod-off-");
      await mkdir(path.join(root, "assets"), { recursive: true });
      await writeFile(path.join(root, "assets/hull.glb"), await mediumGlb());
      await compileAssets({
        concurrency: 1,
        config: {
          audio: "none",
          lod,
          models: { virtual: "none", textures: "none" },
          textures: "none",
        },
        cwd: root,
      });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      ) as { entries: Record<string, { lod?: IModelLodSummary; output: string }> };
      const entry = manifest.entries["hull.glb"];
      // `false` emits no row; `{ enabled: false }` reports the disabled policy. Neither bakes.
      expect(entry?.lod?.generated ?? 0).toBe(0);
      const output = await readFile(path.join(root, "public", entry?.output ?? ""));
      const json = JSON.parse(
        output.subarray(20, 20 + output.readUInt32LE(12)).toString("utf8"),
      ) as { extensionsUsed?: string[] };
      expect(json.extensionsUsed ?? []).not.toContain(TN_DISCRETE_LOD);
    }
  }, 120_000);

  it("refreshes the manifest runtime budget on a cache hit without rebaking", async () => {
    const root = await makeTempDir("threenative-lod-cache-");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets/hull.glb"), await mediumGlb());
    const compile = (lod: IModelLodOptions) =>
      compileAssets({
        concurrency: 1,
        config: {
          audio: "none",
          lod,
          models: { virtual: "none", textures: "none" },
          textures: "none",
        },
        cwd: root,
      });
    const manifest = async (): Promise<{
      entries: Record<string, { bytes?: number; lod?: IModelLodSummary; output: string }>;
    }> =>
      JSON.parse(await readFile(path.join(root, "public/assets.manifest.json"), "utf8")) as never;

    await compile({ runtime: { maxPixelError: 1 } });
    const first = await manifest();
    await compile({ runtime: { maxPixelError: 5, hysteresis: 0.3 } });
    const second = await manifest();

    expect(second.entries["hull.glb"]?.lod?.runtime).toEqual({
      hysteresis: 0.3,
      maxPixelError: 5,
    });
    // The geometry is reused byte-for-byte: a runtime-only edit must not rebake.
    expect(second.entries["hull.glb"]?.output).toBe(first.entries["hull.glb"]?.output);
    expect(second.entries["hull.glb"]?.bytes).toBe(first.entries["hull.glb"]?.bytes);
  }, 120_000);
});

// PRD-377 §4.4 extension — the opt-in far rung that joins primitives. It is off unless the game
// asks, and its only effect is one draw per material group instead of one per authored primitive.
describe("opt-in join far rung (draw count, not triangle density)", () => {
  it("joins a 300-primitive carrier into one draw per material, leaving LOD0 authored", async () => {
    const input = await joinCarrierGlb(300, 3);
    const result = await modelPass({
      compact: false,
      lod: { generation: { maxLevels: 1, join: true } },
      virtual: "none",
    }).apply(input, "carrier.glb");
    if (Buffer.isBuffer(result)) throw new Error("unchanged");
    const summary = result.entry?.lod as IModelLodSummary;
    expect(summary.join).toBe(true);
    expect(summary.joined?.primitives).toBe(300);
    expect(summary.joined?.draws).toBe(3);
    expect(summary.joined?.groups.map((group) => group.primitives)).toEqual([100, 100, 100]);
    const root = (await readWithLod(result.buffer)).getRoot();
    const far = root.listMeshes().find((mesh) => mesh.getName().endsWith("__lod_join"));
    expect(far?.listPrimitives()).toHaveLength(3);
    // The authored LOD0 structure is untouched — all 300 primitives and their materials remain.
    const authored = root.listMeshes().find((mesh) => mesh.getName() === "carrier");
    expect(authored?.listPrimitives()).toHaveLength(300);
    // The artifact itself records which primitives the rung joined, not just the cookie summary.
    const extension = root
      .listExtensionsUsed()
      .find((entry) => entry.extensionName === TN_DISCRETE_LOD) as TNDiscreteLod | undefined;
    expect(extension?.getMetadata()?.joined?.[0]).toMatchObject({ draws: 3, primitives: 300 });
    expect(extension?.getMetadata()?.joined?.[0]?.sources).toHaveLength(300);
    // A generic reader's scene still holds only the authored mesh; the far rung is unreferenced.
    const generic = await readGeneric(result.buffer);
    expect(generic.getRoot().listScenes()[0]?.listChildren()).toHaveLength(1);
    expect(
      generic
        .getRoot()
        .listMeshes()
        .find((mesh) => mesh.getName() === "carrier")
        ?.listPrimitives(),
    ).toHaveLength(300);
  }, 300_000);

  it("changes neither bytes nor policy when join is absent or false", async () => {
    const input = await joinCarrierGlb(12, 3, { tubular: 8, radial: 6 });
    const absent = await modelPass({
      lod: { generation: { maxLevels: 1 } },
      virtual: "none",
    }).apply(input, "carrier.glb");
    const off = await modelPass({
      lod: { generation: { maxLevels: 1, join: false } },
      virtual: "none",
    }).apply(input, "carrier.glb");
    if (Buffer.isBuffer(absent) || Buffer.isBuffer(off)) throw new Error("unchanged");
    expect(absent.buffer.equals(off.buffer)).toBe(true);
    expect((absent.entry?.lod as IModelLodSummary).join).toBe(false);
    expect((absent.entry?.lod as IModelLodSummary).joined).toBeUndefined();
    expect(resolveLodPolicy(undefined, "carrier.glb").generation.join).toBe(false);
    // Turning join on changes the generation cache identity so a stale bake cannot be served.
    expect(
      resolveLodPolicy({ generation: { join: true } }, "carrier.glb").fingerprint.generation,
    ).not.toBe(resolveLodPolicy(undefined, "carrier.glb").fingerprint.generation);
  }, 120_000);

  it("never joins a skinned, morph-target or animated node", async () => {
    const cases: readonly { input: Buffer; reason: string }[] = [
      {
        input: await joinCarrierGlb(4, 1, { joints: true, tubular: 8, radial: 6 }),
        reason: "deforming",
      },
      {
        input: await joinCarrierGlb(4, 1, { animated: true, tubular: 8, radial: 6 }),
        reason: "animated",
      },
    ];
    for (const { input, reason } of cases) {
      const summary = await cook(input, {
        lod: { generation: { maxLevels: 1, join: true } },
        virtual: "none",
      });
      expect(summary.joined, reason).toBeUndefined();
      expect(summary.reasons, reason).toContain(reason);
    }
  }, 120_000);

  it("turns join on for one asset through the per-asset override map", async () => {
    const input = await joinCarrierGlb(12, 3, { tubular: 8, radial: 6 });
    const policy = {
      lod: {
        generation: { maxLevels: 1 },
        overrides: { "carrier.glb": { generation: { join: true } } },
      },
      virtual: "none",
    } as const;
    const on = await cook(input, policy, "carrier.glb");
    const off = await cook(input, policy, "other.glb");
    expect(on.joined?.draws).toBe(3);
    expect(off.joined).toBeUndefined();
  }, 180_000);

  it("simplifies the joined rung when a discrete chain is configured", async () => {
    const input = await joinCarrierGlb(12, 3);
    const result = await modelPass({
      compact: false,
      lod: { generation: { maxLevels: 4, join: true, errorTargets: [0.06] } },
      virtual: "none",
    }).apply(input, "hull.glb");
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
    const summary = result.entry?.lod as IModelLodSummary;
    expect(summary.joined?.draws).toBe(3);
    expect(summary.joined?.triangles ?? Number.POSITIVE_INFINITY).toBeLessThan(
      summary.joined?.trianglesBefore ?? 0,
    );
    // The runtime budgets the rung by its recorded absolute error, so the artifact must carry it.
    const error = summary.joined?.rungs[0]?.error ?? 0;
    expect(error).toBeGreaterThan(0);
    const json = JSON.parse(
      result.buffer.subarray(20, 20 + result.buffer.readUInt32LE(12)).toString("utf8"),
    ) as { extensions?: Record<string, { joined?: { error?: number }[] }> };
    expect(json.extensions?.[TN_DISCRETE_LOD]?.joined?.[0]?.error).toBeCloseTo(error, 10);
  }, 180_000);

  it("joins sibling meshes under a shared parent into one draw per material", async () => {
    // The measured Midway shape: 146 meshes, one primitive each, a handful of materials. There is
    // no multi-primitive mesh anywhere, so the within-mesh join produced nothing at all.
    const input = await siblingCarrierGlb(146, 3);
    const result = await modelPass({
      compact: false,
      lod: { generation: { maxLevels: 1, join: true } },
      virtual: "none",
    }).apply(input, "carrier.glb");
    if (Buffer.isBuffer(result)) throw new Error("unchanged");
    const summary = result.entry?.lod as IModelLodSummary;
    expect(summary.join).toBe(true);
    expect(summary.joined?.draws).toBe(3);
    expect(summary.joined?.primitives).toBe(146);
    expect(summary.joined?.groups.map((group) => group.primitives)).toEqual([49, 49, 48]);

    const root = (await readWithLod(result.buffer)).getRoot();
    const far = root.listMeshes().find((mesh) => mesh.getName() === "carrier__lod_join");
    expect(far?.listPrimitives()).toHaveLength(3);
    // Every authored sibling is still there and still LOD0: the far rung is an extra mesh.
    expect(root.listMeshes().filter((mesh) => mesh.getName().startsWith("part"))).toHaveLength(146);
    // The artifact records which source meshes the rung collapsed, not just a summary count.
    const extension = root
      .listExtensionsUsed()
      .find((entry) => entry.extensionName === TN_DISCRETE_LOD) as TNDiscreteLod | undefined;
    const record = extension?.getMetadata()?.joined?.[0];
    expect(record).toMatchObject({ draws: 3, primitives: 146 });
    expect(record?.sources).toHaveLength(146);
    expect(record?.meshes).toHaveLength(146);
  }, 300_000);

  it("refuses a sibling set whose meshes all move under animation", async () => {
    const summary = await cook(
      await siblingCarrierGlb(4, 1, { animatedSiblings: true, tubular: 8, radial: 6 }),
      { lod: { generation: { maxLevels: 1, join: true } }, virtual: "none" },
    );
    expect(summary.joined).toBeUndefined();
    expect(summary.reasons).toContain("animated");
  }, 120_000);

  it("keeps a multi-primitive mesh behaving exactly as before", async () => {
    // The within-mesh path is the subset of the sibling path: one mesh, many primitives, no node
    // transform between container and mesh. Its far mesh and draws must not move.
    const input = await joinCarrierGlb(12, 3, { tubular: 8, radial: 6 });
    const result = await modelPass({
      compact: false,
      lod: { generation: { maxLevels: 1, join: true } },
      virtual: "none",
    }).apply(input, "carrier.glb");
    if (Buffer.isBuffer(result)) throw new Error("unchanged");
    const summary = result.entry?.lod as IModelLodSummary;
    expect(summary.joined?.draws).toBe(3);
    expect(summary.joined?.primitives).toBe(12);
    const root = (await readWithLod(result.buffer)).getRoot();
    const far = root.listMeshes().find((mesh) => mesh.getName() === "carrier__lod_join");
    expect(far?.listPrimitives()).toHaveLength(3);
    expect(
      root
        .listMeshes()
        .find((mesh) => mesh.getName() === "carrier")
        ?.listPrimitives(),
    ).toHaveLength(12);
  }, 120_000);
});
