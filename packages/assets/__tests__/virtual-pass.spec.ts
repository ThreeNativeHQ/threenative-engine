import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { SphereGeometry, TorusKnotGeometry } from "three";
import { describe, expect, it } from "vitest";
import { modelPass } from "../src/passes/model.js";
import { formatModelSizes } from "../src/report.js";
import { bakeVirtualGeometry } from "../src/virtual/bake.js";
import {
  NO_GROUP,
  ROOT_PARENT_ERROR,
  TNVirtualGeometry,
  type VirtualGeometry,
} from "../src/virtual/extension.js";

// The payload's side of PRD-281: the bake reaches the `.glb` the pipeline already emits, the file
// is still a glTF, and a reader that has never heard of the extension gets the source mesh.

/**
 * A body dense enough to be worth clustering: 65,536 triangles, closed, indexed, every vertex used.
 *
 * A sphere is the obvious choice and the wrong one: three.js leaves two pole vertices no triangle
 * references, `reorder` drops them, and the pass's own self-verify then fails on a drift that has
 * nothing to do with this PRD.
 */
async function denseGlb(): Promise<Buffer> {
  return sourceGlb(new TorusKnotGeometry(1, 0.4, 512, 64));
}

async function sourceGlb(geometry: TorusKnotGeometry): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(Float32Array.from(geometry.attributes.position?.array ?? []))
    .setBuffer(buffer);
  const normal = document
    .createAccessor()
    .setType("VEC3")
    .setArray(Float32Array.from(geometry.attributes.normal?.array ?? []))
    .setBuffer(buffer);
  const indices = document
    .createAccessor()
    .setType("SCALAR")
    .setArray(Uint32Array.from(geometry.index?.array ?? []))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setIndices(indices)
    .setMaterial(document.createMaterial("rock"));
  const mesh = document.createMesh("quarry-face").addPrimitive(primitive);
  scene.addChild(document.createNode("quarry-face").setMesh(mesh));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return Buffer.from(await io.writeBinary(document));
}

/**
 * Twelve closed shells that touch nothing, in one primitive: the body whose DAG halves a dozen
 * times and then floors out above one cluster, which is the `stalled` the decline must not read as
 * "reduced nothing" (PRD-485).
 */
async function shellsGlb(shellCount: number): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const shell = new SphereGeometry(0.5, 32, 16);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const source = shell.attributes.position?.array ?? [];
  const sourceNormals = shell.attributes.normal?.array ?? [];
  const shellIndices = Array.from(shell.index?.array ?? []);
  // A three.js sphere leaves two pole vertices no triangle references, and the pass's self-verify
  // fails a cook that drops them — the same trap `denseGlb` avoids with a torus knot. Compacting to
  // the used vertices is the whole fix.
  const used = [...new Set(shellIndices)].sort((left, right) => left - right);
  const remap = new Map(used.map((vertex, slot) => [vertex, slot]));
  for (let count = 0; count < shellCount; count += 1) {
    const base = positions.length / 3;
    for (const vertex of used) {
      const slot = vertex * 3;
      positions.push(
        (source[slot] as number) + count * 40,
        source[slot + 1] as number,
        source[slot + 2] as number,
      );
      normals.push(
        sourceNormals[slot] as number,
        sourceNormals[slot + 1] as number,
        sourceNormals[slot + 2] as number,
      );
    }
    for (const vertex of shellIndices) indices.push(base + (remap.get(vertex) as number));
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
    .setMaterial(document.createMaterial("stone"));
  scene.addChild(
    document.createNode("cavern").setMesh(document.createMesh("cavern").addPrimitive(primitive)),
  );
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return Buffer.from(await io.writeBinary(document));
}

async function readBack(buffer: Buffer, registerVirtual: boolean): Promise<Document> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(registerVirtual ? [...ALL_EXTENSIONS, TNVirtualGeometry] : ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  return io.readJSON(await io.binaryToJSON(buffer));
}

function jsonOf(buffer: Buffer): {
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  meshes: { primitives: { extensions?: Record<string, unknown>; indices?: number }[] }[];
} {
  return JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString("utf8")) as never;
}

async function compile(virtual: boolean): Promise<{ buffer: Buffer; entry: unknown }> {
  const input = await denseGlb();
  const result = await modelPass(
    virtual ? { virtual: { minSourceTriangles: 1024 } } : { virtual: "none" },
  ).apply(input, "quarry-face.glb");
  if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
  return { buffer: result.buffer, entry: result.entry };
}

/**
 * A canopy of disconnected alpha-cutout cards: what a Fab foliage primitive is, and what the
 * Hornbeam's two of them are (PRD-485).
 *
 * Every card is its own connected component with its own four vertices, so the whole rim is a
 * border edge and the cluster builder — which simplifies each group with the rim locked — has
 * nothing it is allowed to collapse. The card count is what puts the far level under a tenth of the
 * source: the ladder's terminal target is `max(1500, 5% of LOD0)`, and only above 30,000 triangles
 * is the ratio the binding half of that.
 */
async function foliageGlb(cardCount: number): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const perRow = Math.ceil(Math.sqrt(cardCount));
  for (let card = 0; card < cardCount; card += 1) {
    const base = positions.length / 3;
    const x = (card % perRow) * 2;
    const y = Math.floor(card / perRow) * 2;
    const height = 0.5 + ((card * 37) % 11) / 22;
    positions.push(x, y, 0, x + height, y, 0, x + height, y + height, 0, x, y + height, 0);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
    .setAttribute(
      "TEXCOORD_0",
      document.createAccessor().setType("VEC2").setArray(Float32Array.from(uvs)).setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setType("SCALAR")
        .setArray(Uint32Array.from(indices))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial("Foliage").setAlphaMode("MASK").setAlphaCutoff(0.5));
  scene.addChild(
    document.createNode("canopy").setMesh(document.createMesh("canopy").addPrimitive(primitive)),
  );
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return Buffer.from(await io.writeBinary(document));
}

describe("the virtual-geometry pass", () => {
  it('bakes nothing when the config says "none"', async () => {
    const { buffer, entry } = await compile(false);

    expect(jsonOf(buffer).extensionsUsed ?? []).not.toContain("TN_virtual_geometry");
    expect((entry as { virtual?: unknown }).virtual).toBeUndefined();
  }, 300_000);

  it("bakes by default, without the config asking for it", async () => {
    // The whole point of shipping this on: a game that imports a body too dense for the screen
    // gets the cut without knowing the key exists.
    const result = await modelPass().apply(await denseGlb(), "quarry-face.glb");
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");

    expect(jsonOf(result.buffer).extensionsUsed ?? []).toContain("TN_virtual_geometry");
    const summary = (result.entry as { virtual: { clusters: number; primitives: number } }).virtual;
    expect(summary.primitives).toBe(1);
    expect(summary.clusters).toBeGreaterThan(100);
  }, 600_000);

  it("leaves an ordinary prop byte-identical to the unbaked build", async () => {
    // 65,536 triangles is where the cut starts earning its ~3-4x payload back. Below it a model is
    // untouched, so turning this convention on costs an ordinary game exactly nothing.
    const prop = await sourceGlb(new TorusKnotGeometry(1, 0.4, 64, 16));
    const baked = await modelPass().apply(prop, "prop.glb");
    const plain = await modelPass({ virtual: "none" }).apply(prop, "prop.glb");
    if (Buffer.isBuffer(baked) || Buffer.isBuffer(plain))
      throw new Error("model pass returned an unchanged buffer");

    expect(
      (baked.entry as { virtual: { primitives: number; skipped: number } }).virtual,
    ).toMatchObject({ primitives: 0, skipped: 1 });
    expect(baked.buffer.equals(plain.buffer)).toBe(true);
  }, 300_000);

  it("writes the DAG into the .glb the pipeline already emits", async () => {
    const { buffer, entry } = await compile(true);
    const json = jsonOf(buffer);

    expect(json.extensionsUsed ?? []).toContain("TN_virtual_geometry");
    // Optional, never required: a reader that ignores it must still be allowed to open the file.
    expect(json.extensionsRequired ?? []).not.toContain("TN_virtual_geometry");
    const summary = (
      entry as {
        virtual: { clusters: number; levels: number; primitives: number; stopReason: string };
      }
    ).virtual;
    expect(summary.primitives).toBe(1);
    expect(summary.clusters).toBeGreaterThan(100);
    expect(summary.levels).toBeGreaterThan(3);
    expect(summary.stopReason).toBe("root");
  }, 300_000);

  it("addresses the same triangles the primitive ships, after quantization", async () => {
    const { buffer } = await compile(true);
    const document = await readBack(buffer, true);
    const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
    const virtual = primitive?.getExtension<VirtualGeometry>("TN_virtual_geometry");
    if (primitive === undefined || virtual == null) throw new Error("no virtual geometry attached");

    const source = primitive.getIndices()?.getArray() as ArrayLike<number>;
    const dagIndices = virtual.getIndices()?.getArray() as ArrayLike<number>;
    const ranges = virtual.getClusterRanges()?.getArray() as ArrayLike<number>;
    const errors = virtual.getClusterErrors()?.getArray() as ArrayLike<number>;

    // Level 0 is every cluster whose own error is zero. Together they must be exactly the
    // primitive's own triangles — if `quantize` had reordered a vertex behind the bake's back, the
    // two sets would differ and this is where it would show.
    const triangleKey = (a: number, b: number, c: number): string =>
      [a, b, c].sort((left, right) => left - right).join(",");
    const expected = new Set<string>();
    for (let slot = 0; slot < source.length; slot += 3)
      expected.add(
        triangleKey(source[slot] as number, source[slot + 1] as number, source[slot + 2] as number),
      );
    const found = new Set<string>();
    for (let cluster = 0; cluster * 2 < ranges.length; cluster += 1) {
      if ((errors[cluster * 2] as number) !== 0) continue;
      const start = ranges[cluster * 2] as number;
      const count = ranges[cluster * 2 + 1] as number;
      for (let slot = start; slot < start + count; slot += 3)
        found.add(
          triangleKey(
            dagIndices[slot] as number,
            dagIndices[slot + 1] as number,
            dagIndices[slot + 2] as number,
          ),
        );
    }
    expect(found.size).toBe(expected.size);
    expect([...expected].every((key) => found.has(key))).toBe(true);
  }, 300_000);

  it("marks its roots with a finite parent error and its level-0 clusters with no source group", async () => {
    const { buffer } = await compile(true);
    const document = await readBack(buffer, true);
    const virtual = document
      .getRoot()
      .listMeshes()[0]
      ?.listPrimitives()[0]
      ?.getExtension<VirtualGeometry>("TN_virtual_geometry");
    if (virtual == null) throw new Error("no virtual geometry attached");

    const errors = virtual.getClusterErrors()?.getArray() as ArrayLike<number>;
    const groups = virtual.getClusterGroups()?.getArray() as ArrayLike<number>;
    let roots = 0;
    let level0 = 0;
    for (let cluster = 0; cluster * 2 < groups.length; cluster += 1) {
      if ((groups[cluster * 2] as number) === NO_GROUP) {
        roots += 1;
        expect(errors[cluster * 2 + 1]).toBe(ROOT_PARENT_ERROR);
      }
      if ((groups[cluster * 2 + 1] as number) === NO_GROUP) level0 += 1;
    }
    expect(roots).toBe(1);
    expect(level0).toBeGreaterThan(100);
  }, 300_000);

  it("leaves a skinned primitive whole: a cluster cut cannot be skinned", async () => {
    // The loader swaps a baked primitive for a `ClusteredMesh`, which is a plain `Mesh`: the skin
    // is gone and cloning the rig throws. Skinned bodies ship as authored.
    const document = await readBack(await denseGlb(), false);
    const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
    const count = primitive?.getAttribute("POSITION")?.getCount() ?? 0;
    primitive?.setAttribute(
      "JOINTS_0",
      document
        .createAccessor()
        .setType("VEC4")
        .setArray(new Uint8Array(count * 4)),
    );
    const summary = await bakeVirtualGeometry(document, {});
    expect(summary.primitives).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("hands cards it cannot reduce to the discrete ladder, which does reduce them", async () => {
    // PRD-485. A body of disconnected alpha-cutout cards is the one shape the cluster builder
    // refuses: every edge of every card is a border, `LockBorder` holds all of it, and the first
    // fold simplifies nothing — so a stalled DAG reports 100% of the triangles at every level and
    // owns 745,328 Hornbeam foliage triangles with no coarse representation at all. The bake hands
    // that primitive back and the ladder gives it the far level the DAG could not.
    const result = await modelPass({
      lod: true,
      virtual: { minSourceTriangles: 1024 },
    }).apply(await foliageGlb(16384), "canopy.glb");
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");

    expect(jsonOf(result.buffer).extensionsUsed ?? []).not.toContain("TN_virtual_geometry");
    const virtual = (
      result.entry as {
        virtual: { clusters: number; declined: number; payloadBytes: number; primitives: number };
      }
    ).virtual;
    expect(virtual).toMatchObject({ clusters: 0, declined: 1, payloadBytes: 0, primitives: 0 });

    const lod = (
      result.entry as {
        lod: {
          primitives: {
            cardLevels: { cellCoverage: number }[];
            levels: { absoluteError: number; triangles: number }[];
            strategy: string;
            trianglesBefore: number;
          }[];
          reasons: string[];
          skipped: number;
        };
      }
    ).lod;
    // Not `virtual-owned` any more, and not skipped for anything else either.
    expect(lod.reasons).not.toContain("virtual-owned");
    expect(lod.skipped).toBe(0);
    const chain = lod.primitives[0];
    if (chain === undefined) throw new Error("the declined cards got no chain at all");
    expect(chain.strategy).toBe("cards");

    const far = chain.levels[chain.levels.length - 1]?.triangles ?? 0;
    expect(far).toBeGreaterThan(0);
    expect(far / chain.trianglesBefore).toBeLessThanOrEqual(0.1);
    // The crown keeps a card in every occupied cell at every level, and each level's error is
    // wider than the one before it — the two properties the runtime's distance switch reads.
    for (const level of chain.cardLevels ?? []) expect(level.cellCoverage).toBe(1);
    for (let level = 1; level < chain.levels.length; level += 1)
      expect(chain.levels[level]?.absoluteError).toBeGreaterThanOrEqual(
        chain.levels[level - 1]?.absoluteError ?? 0,
      );

    // And the cook still decides nothing about how it looks: the alpha cutoff the asset was
    // authored with is the one that ships.
    const material = (
      JSON.parse(
        result.buffer.subarray(20, 20 + result.buffer.readUInt32LE(12)).toString("utf8"),
      ) as { materials?: { alphaCutoff?: number; alphaMode?: string }[] }
    ).materials?.[0];
    expect(material).toMatchObject({ alphaCutoff: 0.5, alphaMode: "MASK" });
  }, 300_000);

  it("keeps a DAG that stalled only after it had already shed its triangles", async () => {
    // The decline is measured, not `stalled => gone`: twelve closed shells cannot become one
    // cluster — meshoptimizer will not take a shell below about 64 triangles — but the DAG has
    // halved several times before it floors out, and that payload is worth keeping.
    const result = await modelPass({ virtual: { minSourceTriangles: 1024 } }).apply(
      await shellsGlb(12),
      "cavern.glb",
    );
    if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");

    expect(
      (result.entry as { virtual: { declined: number; primitives: number; stopReason: string } })
        .virtual,
    ).toMatchObject({ declined: 0, primitives: 1, stopReason: "stalled" });
  }, 600_000);

  it("AC8 — a reader that has never heard of the extension gets the source mesh", async () => {
    const { buffer } = await compile(true);
    const stock = await readBack(buffer, false);
    const primitive = stock.getRoot().listMeshes()[0]?.listPrimitives()[0];

    expect(
      stock
        .getRoot()
        .listExtensionsUsed()
        .map((one) => one.extensionName),
    ).not.toContain("TN_virtual_geometry");
    expect((primitive?.getIndices()?.getCount() ?? 0) / 3).toBe(512 * 64 * 2);
    expect(primitive?.getAttribute("POSITION")?.getCount()).toBeGreaterThan(0);
  }, 300_000);

  it("AC5 — the payload stays a bounded multiple of the geometry it describes", async () => {
    const withVirtual = await compile(true);
    const without = await compile(false);
    const summary = (withVirtual.entry as { virtual: { payloadBytes: number } }).virtual;
    const sourceIndexBytes = 512 * 64 * 2 * 3 * 4;

    // Fixed at first measurement, as AC5 requires. Measured on this body: the payload is 2.08x the
    // source index buffer — every level's triangles sum to about twice level 0's, which is the
    // technique, not an encoding choice — and the compiled file grows 3.41x once meshopt has
    // compressed both. A regression past these is a payload the batch has to justify.
    expect(summary.payloadBytes / sourceIndexBytes).toBeLessThan(2.5);
    expect(withVirtual.buffer.byteLength / without.buffer.byteLength).toBeLessThan(4);
  }, 600_000);

  it("AC4 — two compiles of the same bytes produce the same file", async () => {
    const first = await compile(true);
    const second = await compile(true);

    expect(second.buffer.equals(first.buffer)).toBe(true);
  }, 600_000);

  it("AC7 — the report names the clusters, the levels, the bytes and the seconds", () => {
    const lines = formatModelSizes([
      {
        after: 900,
        before: 1000,
        logicalPath: "quarry-face.glb",
        virtual: {
          bakeSeconds: 12.34,
          clusters: 512,
          declined: 0,
          levels: 6,
          payloadBytes: 4096,
          primitives: 1,
          skipped: 2,
          stopReason: "root",
        },
      },
    ]);

    expect(lines).toContain(
      "virtual quarry-face.glb: 512 cluster(s) over 6 level(s) on 1 primitive(s), 2 skipped, 4096 payload bytes, bake 12.3 s, stopped at root",
    );
  });

  it("AC7 — the report calls out a DAG that ran out of levels", () => {
    const lines = formatModelSizes([
      {
        after: 900,
        before: 1000,
        logicalPath: "quarry-face.glb",
        virtual: {
          bakeSeconds: 1,
          clusters: 8,
          declined: 0,
          levels: 2,
          payloadBytes: 64,
          primitives: 1,
          skipped: 0,
          stopReason: "cap",
        },
      },
    ]);

    expect(lines.join("\n")).toContain("a DAG hit the level cap and is unfinished");
  });

  it("AC7 — the report names the primitives it handed to the LOD ladder", () => {
    const lines = formatModelSizes([
      {
        after: 900,
        before: 1000,
        logicalPath: "canopy.glb",
        virtual: {
          bakeSeconds: 0.1,
          clusters: 0,
          declined: 2,
          levels: 0,
          payloadBytes: 0,
          primitives: 0,
          skipped: 1,
          stopReason: "root",
        },
      },
    ]);

    // "no primitive was dense enough" would be the wrong reason for a body whose cards were dense
    // enough and whose DAG reduced nothing.
    expect(lines.join("\n")).toContain("1 skipped, 2 declined to the LOD ladder");
  });
});
