/// <reference path="../xatlasjs.d.ts" />

import { createRequire } from "node:module";
import { type Accessor, type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Api } from "xatlasjs/dist/node/api.mjs";
import createXAtlasModule from "xatlasjs/dist/node/xatlas.js";
import type { IAssetPass, IAssetPassOutput } from "../compile.js";
import { bakeStaticLightmap } from "./lightmap-bake.js";
import { encodeLinearRgbaKtx2 } from "./texture.js";

/**
 * Atlas integration follows the mesh → xatlas → remapped-attribute split documented by
 * xatlas-three 0.2.1 (MIT, copyright 2022 Palash Bansal). This implementation uses xatlasjs's
 * local Node/WASM API directly; it performs no CDN fetch and owns no runtime dependency.
 */

export interface ILightmapPassOptions {
  readonly atlasSize: number;
  readonly padding: number;
}

interface IPrimitiveRow {
  readonly key: string;
  readonly primitive: ReturnType<ReturnType<Document["getRoot"]>["listMeshes"]>[number] extends {
    listPrimitives(): infer T;
  }
    ? T extends readonly (infer P)[]
      ? P
      : never
    : never;
}

type AccessorArray = Exclude<ReturnType<Accessor["getArray"]>, null>;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TN_ASSETS_LIGHTMAP_CONFIG_INVALID: ${label} must be a positive integer.`);
  }
  return value;
}

function remapArray(
  source: AccessorArray,
  itemSize: number,
  oldIndexes: Uint16Array,
): AccessorArray {
  const Constructor = source.constructor as { new (length: number): AccessorArray };
  const target = new Constructor(oldIndexes.length * itemSize);
  for (let targetIndex = 0; targetIndex < oldIndexes.length; targetIndex += 1) {
    const sourceIndex = oldIndexes[targetIndex] ?? 0;
    for (let component = 0; component < itemSize; component += 1) {
      target[targetIndex * itemSize + component] = source[sourceIndex * itemSize + component] ?? 0;
    }
  }
  return target;
}

function replaceAccessor(
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  source: Accessor,
  array: AccessorArray,
): Accessor {
  return document
    .createAccessor(source.getName())
    .setType(source.getType())
    .setNormalized(source.getNormalized())
    .setArray(array)
    .setBuffer(buffer);
}

async function readDocument(input: Buffer, logicalPath: string): Promise<Document> {
  try {
    return await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TN_ASSETS_LIGHTMAP_UNREADABLE: could not parse '${logicalPath}' as a self-contained GLB: ${detail}`,
    );
  }
}

async function createAtlasApi(): Promise<InstanceType<ReturnType<typeof Api>>> {
  const XAtlas = Api(createXAtlasModule);
  const wasmPath = createRequire(import.meta.url).resolve("xatlasjs/dist/node/xatlas.wasm");
  let loaded = (): void => {};
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const api = new XAtlas(loaded, () => wasmPath);
  await ready;
  return api;
}

function primitivesOf(document: Document): IPrimitiveRow[] {
  const rows: IPrimitiveRow[] = [];
  for (const [meshIndex, mesh] of document.getRoot().listMeshes().entries()) {
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      rows.push({ key: `${String(meshIndex)}:${String(primitiveIndex)}`, primitive });
    }
  }
  return rows;
}

type AtlasApi = Awaited<ReturnType<typeof createAtlasApi>>;
type AtlasResult = ReturnType<AtlasApi["generateAtlas"]>;

function chartCount(atlas: AtlasResult): number {
  let charts = 0;
  for (const mesh of atlas.meshes) {
    const parent = new Map<number, number>();
    const rootOf = (value: number): number => {
      const parentValue = parent.get(value) ?? value;
      if (parentValue === value) return value;
      const root = rootOf(parentValue);
      parent.set(value, root);
      return root;
    };
    const join = (left: number, right: number): void => {
      const leftRoot = rootOf(left);
      const rightRoot = rootOf(right);
      parent.set(leftRoot, rightRoot);
    };
    for (let offset = 0; offset < mesh.index.length; offset += 3) {
      const first = mesh.index[offset];
      const second = mesh.index[offset + 1];
      const third = mesh.index[offset + 2];
      if (first === undefined || second === undefined || third === undefined) continue;
      parent.set(first, parent.get(first) ?? first);
      parent.set(second, parent.get(second) ?? second);
      parent.set(third, parent.get(third) ?? third);
      join(first, second);
      join(second, third);
    }
    charts += new Set([...parent.keys()].map(rootOf)).size;
  }
  return charts;
}

function assertStatic(document: Document, logicalPath: string): void {
  const hasMorphTargets = document
    .getRoot()
    .listMeshes()
    .some((mesh) => mesh.listPrimitives().some((primitive) => primitive.listTargets().length > 0));
  if (
    document.getRoot().listAnimations().length > 0 ||
    document.getRoot().listSkins().length > 0 ||
    hasMorphTargets
  ) {
    throw new Error(
      `TN_ASSETS_LIGHTMAP_UNSUPPORTED_ANIMATION: '${logicalPath}' contains animated, skinned, or morphed content.`,
    );
  }
}

function addPrimitive(api: AtlasApi, row: IPrimitiveRow, logicalPath: string): void {
  const positions = row.primitive.getAttribute("POSITION")?.getArray();
  if (!(positions instanceof Float32Array)) {
    throw new Error(
      `TN_ASSETS_LIGHTMAP_GEOMETRY_UNSUPPORTED: '${logicalPath}' needs Float32 positions.`,
    );
  }
  const sourceIndices = row.primitive.getIndices()?.getArray();
  const vertexCount = positions.length / 3;
  if (vertexCount > 65_535) {
    throw new Error(
      `TN_ASSETS_LIGHTMAP_GEOMETRY_UNSUPPORTED: '${logicalPath}' exceeds xatlasjs's 65,535-vertex Uint16 limit.`,
    );
  }
  const indices =
    sourceIndices == null
      ? Uint16Array.from({ length: vertexCount }, (_, index) => index)
      : sourceIndices instanceof Uint16Array
        ? sourceIndices
        : Uint16Array.from(sourceIndices);
  const normals = row.primitive.getAttribute("NORMAL")?.getArray();
  const uv0 = row.primitive.getAttribute("TEXCOORD_0")?.getArray();
  api.addMesh(
    indices,
    positions,
    normals instanceof Float32Array ? normals : null,
    uv0 instanceof Float32Array ? uv0 : null,
    row.key,
    normals instanceof Float32Array,
    false,
  );
}

function remapAttributes(
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  row: IPrimitiveRow,
  result: AtlasResult["meshes"][number],
): void {
  for (const semantic of row.primitive.listSemantics()) {
    const source = row.primitive.getAttribute(semantic);
    const sourceArray = source?.getArray();
    if (source === null || sourceArray === null) continue;
    const remapped =
      semantic === "POSITION"
        ? result.vertex.vertices
        : remapArray(sourceArray, source.getElementSize(), result.oldIndexes);
    row.primitive.setAttribute(semantic, replaceAccessor(document, buffer, source, remapped));
  }
}

function writeAtlas(document: Document, rows: IPrimitiveRow[], atlas: AtlasResult): void {
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("lightmap");
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  for (const result of atlas.meshes) {
    const row = rowsByKey.get(result.mesh);
    if (row === undefined) {
      throw new Error(`TN_ASSETS_LIGHTMAP_ATLAS_INVALID: missing primitive '${result.mesh}'.`);
    }
    remapAttributes(document, buffer, row, result);
    row.primitive.setAttribute(
      "TEXCOORD_1",
      document
        .createAccessor("lightmap-uv")
        .setType("VEC2")
        .setArray(result.vertex.coords1)
        .setBuffer(buffer),
    );
    row.primitive.setIndices(
      document
        .createAccessor("lightmap-indices")
        .setType("SCALAR")
        .setArray(result.index)
        .setBuffer(buffer),
    );
  }
}

async function bakeUv2(
  document: Document,
  rows: IPrimitiveRow[],
  atlasSize: number,
  padding: number,
  logicalPath: string,
  astc: boolean,
): Promise<IAssetPassOutput> {
  const startedAt = performance.now();
  const api = await createAtlasApi();
  api.createAtlas();
  try {
    for (const row of rows) addPrimitive(api, row, logicalPath);
    const atlas = api.generateAtlas(
      {},
      { blockAlign: true, padding, resolution: atlasSize, texelsPerUnit: 0 },
    );
    writeAtlas(document, rows, atlas);
    const bake = bakeStaticLightmap(document, atlas.width, atlas.height, padding);
    const lightmap = await encodeLinearRgbaKtx2(bake.pixels, bake.width, bake.height, astc);
    return {
      auxiliaryOutputs: [
        {
          buffer: lightmap,
          extension: ".ktx2",
          manifestField: "lightmaps",
          metadata: {
            bytesBefore: bake.pixels.byteLength,
            dilatedTexels: bake.dilatedTexels,
            format: astc ? "astc4x4" : "etc1s",
            materialTargets: bake.materialTargets,
            occludedTexels: bake.occludedTexels,
            texCoord: 1,
            validTexels: bake.validTexels,
          },
          role: "lightmap",
        },
      ],
      buffer: Buffer.from(
        await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document),
      ),
      entry: {
        lightmapBakeMs: performance.now() - startedAt,
        lightmapAtlas: {
          atlasCount: atlas.atlasCount,
          chartCount: chartCount(atlas),
          height: atlas.height,
          padding,
          skippedMeshes: [],
          texelsPerUnit: atlas.texelsPerUnit,
          width: atlas.width,
        },
      },
    };
  } finally {
    api.destroyAtlas();
  }
}

export function lightmapPass(options: ILightmapPassOptions): IAssetPass {
  return createLightmapPass(options);
}

/** Compiler-only target selection; public lightmap options remain target-independent. */
export function createLightmapPass(options: ILightmapPassOptions, astc = false): IAssetPass {
  const atlasSize = positiveInteger(options.atlasSize, "atlasSize");
  const padding = positiveInteger(options.padding, "padding");
  // BC7 (and BC1/ETC2) compress in 4x4 blocks: an atlas edge that is not a multiple of four
  // produces a KTX2 the decoders reject or pad silently. Reject it here rather than shipping it.
  if (atlasSize % 4 !== 0) {
    throw new Error(
      `TN_ASSETS_LIGHTMAP_CONFIG_INVALID: atlasSize must be a multiple of 4; received ${String(atlasSize)}.`,
    );
  }
  return {
    appliesTo: ["model"],
    cacheKey: JSON.stringify({
      atlasSize,
      padding,
      ...(astc ? { gpuFormat: "astc4x4-linear-v1" } : {}),
    }),
    name: "lightmap-uv2",
    async apply(input: Buffer, logicalPath: string): Promise<Buffer | IAssetPassOutput> {
      if (!/\.glb$/iu.test(logicalPath)) return input;
      const document = await readDocument(input, logicalPath);
      assertStatic(document, logicalPath);
      const rows = primitivesOf(document);
      if (rows.length === 0) return input;
      return bakeUv2(document, rows, atlasSize, padding, logicalPath, astc);
    },
  };
}
