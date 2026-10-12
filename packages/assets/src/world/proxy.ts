// PRD-473 AC-4, asset-cook half: turn supported world-cell chunks and static scatter into one
// merged, simplified, material-grouped proxy GLB and name it on the cell manifest.
//
// The cook owns only the *bytes*: it writes the proxy as an ordinary model input beside the
// world package and rewrites the world JSON with an optional `cell.proxy` record
// (`{ glb, error, triangles, materialGroups }`). The runtime half that swaps a chunk for its
// proxy is core's; this cook never selects a runtime representation.
//
// Everything a cell needs already ships in the repository — glTF-Transform for reading, merging,
// flattening, joining, un-instancing, welding and simplifying, with `meshoptimizer` as the
// simplifier it drives — so this file adds no dependency and no configuration. A cell it cannot
// reproduce faithfully is declined whole with a diagnostic; it never emits a partial proxy that
// would silently drop scenery.

import path from "node:path";
import {
  Document,
  type Mesh,
  type Node,
  NodeIO,
  PropertyType,
  type Scene,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, type InstancedMesh as GltfInstances } from "@gltf-transform/extensions";
import {
  dedup,
  flatten,
  getBounds,
  join,
  mergeDocuments,
  prune,
  simplifyPrimitive,
  uninstance,
  unpartition,
  weld,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { Matrix4, Quaternion, Vector3 } from "three";
import { createGltfReader, readGltfDocument } from "../gltf-io.js";
import { deforming, primitiveTriangleCount } from "../lod/eligibility.js";
import { TNDiscreteLod } from "../lod/extension.js";
import { TNVirtualGeometry } from "../virtual/extension.js";

/** Requested Meshopt local-space error ratio, lifted through each retained node's world scale.
 * MASK and BLEND primitives keep every triangle. Published error includes Float32 TRS roundoff,
 * and is a conservative requested bound, never a measured visual result.
 */
const HLOD_ERROR_RATIO = 0.01;

/** `Primitive.Mode.TRIANGLES`, without importing the static for one constant. */
const TRIANGLES = 4;
// Bound expansion before joining and the finished upload separately. Oversize cells keep detail.
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_PROXY_BYTES = 4 * 1024 * 1024;
const MAX_PROXY_NODES = 4096;

/** A parsed v1 world package, as this cook understands it; anything else is left untouched. */
export interface IWorldPackageSource {
  readonly json: Record<string, unknown>;
  readonly cellSize: number;
  readonly cells: readonly IWorldSourceCell[];
}

export interface IWorldSourceCell {
  /** Package-relative chunk GLB paths, exactly as authored; empty when the cell has none. */
  readonly chunks: readonly string[];
  readonly runs: readonly { asset: string; offset: number; count: number }[];
  /** The cell's own JSON node, so a proxy is attached in place without rebuilding the file. */
  readonly raw: Record<string, unknown>;
  readonly x: number;
  readonly z: number;
}

export interface IWorldProxy {
  readonly bounds?: { min: number[]; max: number[] };
  /** Absent on older records, which cover chunks only. */
  readonly scope?: "cell" | "chunks";
  readonly sourceTriangles?: number;
  /** Standalone cell primitives; shared-batch runtime draw savings must be measured separately. */
  readonly sourcePrimitives?: number;
  readonly buffer: Buffer;
  /**
   * Conservative requested bound in metres, using each primitive's local simplifier scale and
   * retained world transform, plus placement TRS roundoff. Never a measured visual result.
   */
  readonly error: number;
  readonly logical: string;
  /**
   * Draw primitives the proxy submits at runtime. It counts merged mesh primitives, which can
   * exceed the number of distinct material identities when vertex layouts keep primitives apart.
   */
  readonly materialGroups: number;
  readonly reference: string;
  readonly triangles: number;
  readonly x: number;
  readonly z: number;
}

export interface IWorldProxyDecline {
  readonly reason: string;
  readonly x: number;
  readonly z: number;
}

export interface IWorldProxyResult {
  readonly declined: readonly IWorldProxyDecline[];
  readonly proxies: readonly IWorldProxy[];
}

export interface IWorldProxyCookOptions {
  /**
   * Reads a chunk by its normalised package-relative logical path. The caller owns the source
   * root, the exclude globs and the collected input set, so it also owns `included` below.
   */
  readonly read: (logical: string) => Promise<Buffer>;
  /**
   * Whether a normalised chunk logical was collected into this bake. Absent means the reader
   * accepts any path; the compile always supplies it so an excluded or out-of-root chunk can
   * never be pulled back through a proxy.
   */
  readonly included?: (logical: string) => boolean;
  readonly world: IWorldPackageSource;
  readonly worldLogical: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict v1 detection. A JSON file that is not exactly a v1 world package returns `undefined`
 * and is left byte-identical by the caller; the checks mirror `validateWorldPackage`'s
 * structure without its error collection, because an unrelated document is not an error here.
 */
export function readWorldPackage(input: Buffer): IWorldPackageSource | undefined {
  let json: unknown;
  try {
    json = JSON.parse(input.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(json) || json.version !== 1) return undefined;
  if (typeof json.cellSize !== "number" || !Number.isFinite(json.cellSize) || json.cellSize <= 0)
    return undefined;
  if (!Array.isArray(json.cells)) return undefined;
  const cells: IWorldSourceCell[] = [];
  for (const cell of json.cells) {
    if (!isRecord(cell)) return undefined;
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.z)) return undefined;
    if (!Array.isArray(cell.runs)) return undefined;
    const runs: { asset: string; offset: number; count: number }[] = [];
    for (const run of cell.runs) {
      if (
        !isRecord(run) ||
        typeof run.asset !== "string" ||
        !Number.isSafeInteger(run.offset) ||
        !Number.isSafeInteger(run.count) ||
        (run.offset as number) < 0 ||
        (run.count as number) < 0
      )
        return undefined;
      runs.push({ asset: run.asset, offset: run.offset as number, count: run.count as number });
    }
    let chunks: string[] = [];
    if (cell.chunks !== undefined) {
      if (
        !Array.isArray(cell.chunks) ||
        cell.chunks.some((chunk) => typeof chunk !== "string" || chunk.length === 0)
      )
        return undefined;
      chunks = cell.chunks as string[];
    }
    cells.push({
      chunks,
      raw: cell,
      runs,
      x: cell.x as number,
      z: cell.z as number,
    });
  }
  return { cellSize: json.cellSize, cells, json };
}

/** The deterministic logical path of a cell's proxy, beside its world package. */
export function proxyLogicalFor(worldLogical: string, x: number, z: number): string {
  const directory = path.dirname(worldLogical);
  const stem = path.basename(worldLogical, path.extname(worldLogical));
  const name = `${stem}.cell_${x}_${z}.proxy.glb`;
  return directory === "." ? name : `${directory}/${name}`;
}

/** The proxy's path as the world JSON names it, relative to the world package's own directory. */
function proxyReferenceFor(worldLogical: string, x: number, z: number): string {
  return path.basename(proxyLogicalFor(worldLogical, x, z));
}

/**
 * Resolves an authored chunk reference against the world package's directory into a normalised,
 * package-relative logical path, or `undefined` when it escapes the package (`../../x.glb`, an
 * absolute path, or a bare Windows drive). A safe `../` reference that stays inside the package is
 * allowed; the caller then checks the result against the collected input set.
 */
export function resolveChunkLogical(worldLogical: string, chunk: string): string | undefined {
  if (chunk.length === 0 || chunk.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(chunk))
    return undefined;
  const directory = path.posix.dirname(worldLogical);
  const joined = directory === "." ? chunk : `${directory}/${chunk}`;
  const normalized = path.posix.normalize(joined);
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

/**
 * Why this document cannot be reproduced as a proxy, or `undefined` when it can.
 *
 * Skins, morph targets, animation and non-triangle topology change what a merged mesh would draw.
 * A node-, mesh- or primitive-level extension other than the GPU instancing this cook expands is
 * a visibility or geometry behaviour the merge cannot reproduce, so it too declines the cell
 * rather than approximating it.
 */
function unsupportedReason(document: Document): string | undefined {
  const root = document.getRoot();
  if (root.listAnimations().length > 0) return "animation";
  for (const node of root.listNodes()) {
    if (node.getSkin() !== null) return "skinned";
    const mesh = node.getMesh();
    if (mesh === null) continue;
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.listTargets().length > 0) return "morph";
      if (deforming(primitive, false)) return "skinned";
      if (primitive.getMode() !== TRIANGLES) return "topology";
    }
  }
  for (const node of root.listNodes())
    for (const extension of node.listExtensions())
      if (extension.extensionName !== "EXT_mesh_gpu_instancing") return "extension";
  for (const mesh of root.listMeshes()) {
    if (mesh.listExtensions().length > 0) return "extension";
    for (const primitive of mesh.listPrimitives())
      if (primitive.listExtensions().length > 0) return "extension";
  }
  return undefined;
}

/** Copies one chunk into the target document and moves its nodes under the proxy scene. */
function mergeInto(target: Document, source: Document): void {
  const primary = target.getRoot().listScenes()[0] ?? target.createScene("proxy");
  mergeDocuments(target, source);
  for (const scene of [...target.getRoot().listScenes()]) {
    if (scene === primary) continue;
    for (const node of [...scene.listChildren()]) primary.addChild(node);
    scene.dispose();
  }
  // A source whose nodes sit outside any scene copies them unattached; keep them in the proxy
  // rather than letting flatten's cleanup prune drop authored geometry.
  for (const node of [...target.getRoot().listNodes()])
    if (node.listParents().length === 0) primary.addChild(node);
}

/** The largest world-space axis span of the merged scene, the metre scale of the error bound. */
function sceneExtent(scene: Scene): number {
  const { max, min } = getBounds(scene);
  const span = (low: number, high: number): number => Math.max(0, high - low);
  return Math.max(span(min[0], max[0]), span(min[1], max[1]), span(min[2], max[2]));
}

/**
 * Whether every drawn vertex and every transform above it is finite.
 *
 * `getBounds` composes each mesh node's world matrix with its POSITION accessor, so one NaN or
 * Infinity — an authored transform, a vertex, or a `min`/`max` — flows into the published world
 * error. It is the acceptance boundary for the "finite, conservative error" claim: the bound the
 * simplifier is handed and the metres reported back are only meaningful when the input is finite.
 * A cell that fails is declined whole, so no proxy is emitted with non-finite geometry or an error
 * that `JSON.stringify` would silently turn into `null`.
 */
function finiteGeometry(document: Document): boolean {
  const root = document.getRoot();
  for (const node of root.listNodes()) {
    if (node.getMesh() === null) continue;
    if (!(node.getWorldMatrix() as number[]).every(Number.isFinite)) return false;
  }
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      if (position === null) return false;
      const array = position.getArray();
      if (array === null || array.length === 0) return false;
      for (let index = 0; index < array.length; index += 1)
        if (!Number.isFinite(array[index] as number)) return false;
      const min = position.getMin([0, 0, 0]);
      const max = position.getMax([0, 0, 0]);
      if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return false;
    }
  }
  return true;
}

/** Clears authored `extras` from every location a runtime import scans for entity metadata. */
function clearExtras(document: Document): void {
  const root = document.getRoot();
  for (const scene of root.listScenes()) scene.setExtras({});
  for (const node of root.listNodes()) node.setExtras({});
  for (const mesh of root.listMeshes()) {
    mesh.setExtras({});
    for (const primitive of mesh.listPrimitives()) primitive.setExtras({});
  }
}

/** Full-cell coverage must match GLTFLoader's default scene and preserve supported surfaces. */
function fullCellEligibility(document: Document): string | undefined {
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (scene === undefined) return "empty-cell";
  if (root.listScenes().length !== 1) return "scatter-scenes";
  const nodes = new Set<Node>();
  scene.traverse((node) => {
    if (node.getMesh() !== null) nodes.add(node);
  });
  if (nodes.size !== root.listNodes().filter((node) => node.getMesh() !== null).length)
    return "scatter-orphans";
  for (const mesh of root.listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      // Installed join's tangent transform mutates components in place. Retain source rather
      // than let differently rotated normal-map directions be baked incorrectly.
      if (primitive.getAttribute("TANGENT") !== null) return "scatter-tangents";
      const material = primitive.getMaterial();
      if (
        material?.getAlphaMode() === "BLEND" ||
        material
          ?.listExtensions()
          .some((extension) => extension.extensionName !== "KHR_materials_unlit")
      )
        return "scatter-material";
    }
  return undefined;
}

/** Conservative positional roundoff bound; a genuine shear is not representable by glTF TRS. */
function placementRoundoff(node: Node, matrix: Matrix4): number | undefined {
  const stored = node.getMatrix();
  if (
    !stored.every(
      (value, axis) =>
        Math.abs(value - (matrix.elements[axis] as number)) <=
        1e-6 * Math.max(1, Math.abs(value), Math.abs(matrix.elements[axis] as number)),
    )
  )
    return undefined;
  let error = 0;
  for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    const position = primitive.getAttribute("POSITION");
    if (position === null) continue;
    const low = position.getMinNormalized([0, 0, 0]);
    const high = position.getMaxNormalized([0, 0, 0]);
    const extent = low.map((value, axis) =>
      Math.max(Math.abs(value), Math.abs(high[axis] as number)),
    );
    const errors = [0, 1, 2].map(
      (row) =>
        Math.abs((stored[12 + row] as number) - (matrix.elements[12 + row] as number)) +
        extent.reduce(
          (sum, value, axis) =>
            sum +
            value *
              Math.abs(
                (stored[axis * 4 + row] as number) - (matrix.elements[axis * 4 + row] as number),
              ),
          0,
        ),
    );
    error = Math.max(error, Math.hypot(...errors));
  }
  return error;
}

interface ICellBuild {
  readonly bounds: { min: number[]; max: number[] };
  readonly sourceTriangles: number;
  readonly sourcePrimitives: number;
  readonly buffer: Buffer;
  readonly error: number;
  readonly materialGroups: number;
  readonly triangles: number;
}

/**
 * Merges one cell's chunk GLBs into one proxy GLB. Returns a decline reason instead of throwing
 * for anything the merge cannot reproduce faithfully.
 */
async function buildCellProxy(
  sources: readonly { buffer: Buffer; records?: Float32Array }[],
): Promise<ICellBuild | { readonly decline: string }> {
  const writer = new NodeIO().registerExtensions([
    ...ALL_EXTENSIONS,
    TNVirtualGeometry,
    TNDiscreteLod,
  ]);
  const target = new Document();
  target.createScene("proxy");
  let sourceTriangles = 0;
  let sourcePrimitives = 0;
  let expandedBytes = 0;
  let inputBytes = 0;
  let expandedNodes = 0;
  let transformError = 0;
  const coversScatter = sources.some((source) => source.records !== undefined);
  for (const { buffer: bytes, records } of sources) {
    inputBytes += bytes.length;
    if (inputBytes > MAX_EXPANDED_BYTES) return { decline: "source-budget" };
    let document: Document;
    try {
      const io = await createGltfReader(bytes);
      document = await readGltfDocument(io, bytes);
    } catch {
      return { decline: "unreadable-chunk" };
    }
    const reason = unsupportedReason(document);
    if (reason !== undefined) return { decline: reason };
    const fullCellReason = coversScatter ? fullCellEligibility(document) : undefined;
    if (fullCellReason !== undefined) return { decline: fullCellReason };
    if (!finiteGeometry(document)) return { decline: "malformed-geometry" };
    const repetitions = records === undefined ? 1 : records.length / 8;
    const chunkTransforms: { node: Node; matrix: Matrix4 }[] = [];
    for (const node of document.getRoot().listNodes()) {
      const instances = node.getExtension<GltfInstances>("EXT_mesh_gpu_instancing");
      // Current scatter adoption uses each loaded mesh's base shape, not its inner instance matrices.
      if (coversScatter && instances !== null) return { decline: "scatter-instancing" };
      if (coversScatter && records === undefined && node.getMesh() !== null) {
        // Flatten also decomposes inherited matrices. Check chunk world transforms before it,
        // just as placement transforms are checked below, without changing the source hierarchy.
        const matrix = new Matrix4().fromArray(node.getWorldMatrix());
        const probe = document.createNode().setMesh(node.getMesh()).setMatrix(matrix.toArray());
        const roundoff = placementRoundoff(probe, matrix);
        probe.dispose();
        if (roundoff === undefined) return { decline: "scatter-shear" };
        transformError = Math.max(transformError, roundoff);
        chunkTransforms.push({ node, matrix });
      }
      const copies = (instances?.listAttributes()[0]?.getCount() ?? 1) * repetitions;
      if (node.getMesh() !== null) expandedNodes += copies;
      if (expandedNodes > MAX_PROXY_NODES) return { decline: "node-budget" };
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        sourceTriangles += primitiveTriangleCount(primitive) * copies;
        sourcePrimitives += 1;
        for (const semantic of primitive.listSemantics())
          expandedBytes += (primitive.getAttribute(semantic)?.getArray()?.byteLength ?? 0) * copies;
        expandedBytes += (primitive.getIndices()?.getArray()?.byteLength ?? 0) * copies;
      }
    }
    if (expandedBytes > MAX_EXPANDED_BYTES) return { decline: "expansion-budget" };
    // Snapshot first, then root-attach: flatten must never decompose an intermediate ancestor
    // whose shear cancels out again at a drawn descendant.
    const chunkScene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
    for (const { node, matrix } of chunkTransforms) {
      node.setMatrix(matrix.toArray());
      chunkScene?.addChild(node);
    }
    // The cap above precedes both embedded GPU-instance expansion and outer placement expansion.
    try {
      await document.transform(uninstance());
    } catch {
      return { decline: "malformed-instancing" };
    }
    if (!finiteGeometry(document)) return { decline: "malformed-geometry" };
    if (records === undefined) mergeInto(target, document);
    else {
      const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
      if (scene === undefined) return { decline: "empty-cell" };
      const nodes: Node[] = [];
      scene.traverse((node) => {
        if (node.getMesh() !== null) nodes.push(node);
      });
      const mapped = mergeDocuments(target, document);
      const destination = target.getRoot().listScenes()[0] as Scene;
      const placement = new Matrix4();
      const position = new Vector3();
      const rotation = new Quaternion();
      const scale = new Vector3();
      for (let at = 0; at < records.length; at += 8) {
        placement.compose(
          position.fromArray(records, at),
          rotation.fromArray(records, at + 3),
          scale.setScalar(records[at + 7] as number),
        );
        for (const node of nodes) {
          const matrix = placement.clone().multiply(new Matrix4().fromArray(node.getWorldMatrix()));
          const placed = target
            .createNode()
            .setMesh(mapped.get(node.getMesh() as Mesh) as Mesh)
            .setMatrix(matrix.toArray());
          const roundoff = placementRoundoff(placed, matrix);
          if (roundoff === undefined) return { decline: "scatter-shear" };
          transformError = Math.max(transformError, roundoff);
          destination.addChild(placed);
        }
      }
      // Copied source nodes/scenes must not add another unplaced copy of the asset.
      for (const node of document.getRoot().listNodes()) mapped.get(node)?.dispose();
      for (const sourceScene of document.getRoot().listScenes()) mapped.get(sourceScene)?.dispose();
    }
  }
  try {
    // Geometry keeps its authored node matrices: join moves each primitive into the destination
    // node's space through glTF-Transform's `transformPrimitive`, which reverses winding for a
    // mirroring matrix and applies the normal matrix for a nonuniform scale. A mirrored or
    // nonuniform authored transform keeps its face winding, normal orientation and sidedness.
    // Full-cell tangent-bearing sources were declined before reaching this transform.
    await target.transform(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.TEXTURE] }));
    await target.transform(flatten());
    await target.transform(join());
    // Triangle-soup sources have no indices yet; welding gives the simplifier real topology.
    await target.transform(weld({ overwrite: false }));
  } catch {
    return { decline: "merge-failed" };
  }
  clearExtras(target);

  // The extent and every published error are read from this geometry, so malformed input is
  // refused here rather than simplified into a proxy that carries NaN or an error JSON nulls.
  if (!finiteGeometry(target)) return { decline: "malformed-geometry" };
  const scene = target.getRoot().listScenes()[0];
  const extent = scene === undefined ? 0 : sceneExtent(scene);
  if (!Number.isFinite(extent)) return { decline: "malformed-geometry" };

  await MeshoptSimplifier.ready;
  let error = transformError;
  for (const mesh of target.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const alphaMode = primitive.getMaterial()?.getAlphaMode();
      if (alphaMode === "MASK" || alphaMode === "BLEND") continue;
      const before =
        primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
      if (before < 3) return { decline: "degenerate-primitive" };
      const position = primitive.getAttribute("POSITION");
      if (position === null) return { decline: "malformed-geometry" };
      const low = position.getMinNormalized([0, 0, 0]);
      const high = position.getMaxNormalized([0, 0, 0]);
      // Meshopt normalizes by the largest local axis span. Frobenius norm bounds every retained
      // world transform's operator norm, including rotation and nonuniform/mirrored scale.
      const localScale = Math.max(...high.map((value, axis) => value - (low[axis] as number)));
      let worldScale = 0;
      for (const node of target.getRoot().listNodes()) {
        if (node.getMesh() !== mesh) continue;
        const matrix = node.getWorldMatrix();
        worldScale = Math.max(
          worldScale,
          Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((axis) => matrix[axis] as number)),
        );
      }
      simplifyPrimitive(primitive, {
        simplifier: MeshoptSimplifier,
        error: HLOD_ERROR_RATIO,
        lockBorder: true,
        ratio: 0,
      });
      const after = primitive.getIndices()?.getCount() ?? 0;
      // Never silently drop a primitive that was visible: a degenerate result declines the cell.
      if (after < 3) return { decline: "degenerate-primitive" };
      if (after < before)
        error = Math.max(error, transformError + HLOD_ERROR_RATIO * localScale * worldScale);
    }
  }
  await target.transform(prune());
  // Each merged chunk brings its own buffer; a GLB carries exactly one.
  await target.transform(unpartition());

  let triangles = 0;
  let materialGroups = 0;
  for (const mesh of target.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      materialGroups += 1;
      const position = primitive.getAttribute("POSITION");
      const indices = primitive.getIndices();
      triangles += Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3);
    }
  }
  if (materialGroups === 0) return { decline: "empty-cell" };
  return {
    buffer: Buffer.from(await writer.writeBinary(target)),
    bounds: getBounds(scene as Scene),
    sourceTriangles,
    sourcePrimitives,
    error,
    materialGroups,
    triangles,
  };
}

/** Cooks eligible populated cells. Scatter scopes cover all runs and chunks or decline whole. */
export async function cookWorldProxies(
  options: IWorldProxyCookOptions,
): Promise<IWorldProxyResult> {
  const { included, read, world, worldLogical } = options;
  const proxies: IWorldProxy[] = [];
  const declined: IWorldProxyDecline[] = [];
  for (const cell of world.cells) {
    if (cell.chunks.length === 0 && cell.runs.every((run) => run.count === 0)) continue;
    const sources: { buffer: Buffer; records?: Float32Array }[] = [];
    if (cell.runs.reduce((bytes, run) => bytes + run.count * 32, 0) > MAX_EXPANDED_BYTES) {
      declined.push({ reason: "placement-budget", x: cell.x, z: cell.z });
      continue;
    }
    let stagedSourceBytes = 0;
    let reason: string | undefined;
    for (const chunk of cell.chunks) {
      const logical = resolveChunkLogical(worldLogical, chunk);
      if (logical === undefined) {
        reason = "outside-chunk";
        break;
      }
      if (included !== undefined && !included(logical)) {
        reason = "excluded-chunk";
        break;
      }
      try {
        const buffer = await read(logical);
        stagedSourceBytes += buffer.length;
        if (stagedSourceBytes > MAX_EXPANDED_BYTES) {
          reason = "source-budget";
          break;
        }
        sources.push({ buffer });
      } catch {
        reason = "missing-chunk";
        break;
      }
    }
    if (reason === undefined && cell.runs.some((run) => run.count > 0)) {
      const placementsLogical =
        typeof world.json.placements === "string"
          ? resolveChunkLogical(worldLogical, world.json.placements)
          : undefined;
      let placements: Buffer | undefined;
      if (
        placementsLogical === undefined ||
        (included !== undefined && !included(placementsLogical))
      )
        reason = "excluded-placements";
      else
        try {
          placements = await read(placementsLogical);
        } catch {
          reason = "missing-placements";
        }
      for (const run of cell.runs) {
        if (reason !== undefined) break;
        if (run.count === 0) continue;
        if (run.count > MAX_EXPANDED_BYTES / 64) {
          reason = "placement-budget";
          break;
        }
        const definition = isRecord(world.json.assets) ? world.json.assets[run.asset] : undefined;
        if (!isRecord(definition) || typeof definition.glb !== "string") {
          reason = "unknown-scatter-asset";
          break;
        }
        if (definition.maxDistance !== undefined) {
          reason = "scatter-distance-filter";
          break;
        }
        const logical = resolveChunkLogical(worldLogical, definition.glb);
        if (logical === undefined || (included !== undefined && !included(logical))) {
          reason = "excluded-scatter";
          break;
        }
        if (placements === undefined || (run.offset + run.count) * 32 > placements.length) {
          reason = "malformed-placements";
          break;
        }
        const records = new Float32Array(run.count * 8);
        for (let at = run.offset * 32; at < (run.offset + run.count) * 32; at += 32) {
          const record = Array.from({ length: 8 }, (_, index) =>
            (placements as Buffer).readFloatLE(at + index * 4),
          );
          if (
            !record.every(Number.isFinite) ||
            Math.abs(Math.hypot(...record.slice(3, 7)) - 1) > 0.0001 ||
            record[7] === 0
          ) {
            reason = "malformed-placements";
            break;
          }
          records.set(record, (at - run.offset * 32) / 4);
        }
        if (reason !== undefined) break;
        try {
          const buffer = await read(logical);
          stagedSourceBytes += buffer.length;
          if (stagedSourceBytes > MAX_EXPANDED_BYTES) {
            reason = "source-budget";
            break;
          }
          sources.push({ buffer, records });
        } catch {
          reason = "missing-scatter";
        }
      }
    }
    if (reason !== undefined) {
      declined.push({ reason, x: cell.x, z: cell.z });
      continue;
    }
    let built: Awaited<ReturnType<typeof buildCellProxy>>;
    try {
      built = await buildCellProxy(sources);
    } catch {
      built = { decline: "proxy-build-failed" };
    }
    if ("decline" in built) {
      declined.push({ reason: built.decline, x: cell.x, z: cell.z });
      continue;
    }
    const coversScatter = cell.runs.some((run) => run.count > 0);
    if (
      built.buffer.length > MAX_PROXY_BYTES ||
      (coversScatter && built.triangles >= built.sourceTriangles)
    ) {
      declined.push({
        reason: built.buffer.length > MAX_PROXY_BYTES ? "proxy-budget" : "no-triangle-reduction",
        x: cell.x,
        z: cell.z,
      });
      continue;
    }
    proxies.push({
      bounds: built.bounds,
      scope: coversScatter ? "cell" : "chunks",
      sourceTriangles: built.sourceTriangles,
      sourcePrimitives: built.sourcePrimitives,
      buffer: built.buffer,
      error: built.error,
      logical: proxyLogicalFor(worldLogical, cell.x, cell.z),
      materialGroups: built.materialGroups,
      reference: proxyReferenceFor(worldLogical, cell.x, cell.z),
      triangles: built.triangles,
      x: cell.x,
      z: cell.z,
    });
  }
  return { declined, proxies };
}

/** Rewrites the world JSON with `cell.proxy` added to every cell that got one. */
export function applyProxiesToWorld(
  world: IWorldPackageSource,
  proxies: readonly IWorldProxy[],
): Buffer {
  const byCell = new Map(proxies.map((proxy) => [`${proxy.x}_${proxy.z}`, proxy]));
  for (const cell of world.cells) {
    const proxy = byCell.get(`${cell.x}_${cell.z}`);
    if (proxy === undefined) continue;
    cell.raw.proxy = {
      error: proxy.error,
      glb: proxy.reference,
      ...(proxy.bounds === undefined ? {} : { bounds: proxy.bounds }),
      ...(proxy.scope === undefined ? {} : { scope: proxy.scope }),
      ...(proxy.sourceTriangles === undefined ? {} : { sourceTriangles: proxy.sourceTriangles }),
      ...(proxy.sourcePrimitives === undefined ? {} : { sourcePrimitives: proxy.sourcePrimitives }),
      materialGroups: proxy.materialGroups,
      triangles: proxy.triangles,
    };
  }
  return Buffer.from(`${JSON.stringify(world.json, null, 2)}\n`, "utf8");
}

/** The build line the PRD names: cells considered, proxies written and declines, with reasons. */
export function formatWorldHlod(worldLogical: string, result: IWorldProxyResult): string {
  const maxError = result.proxies.reduce((worst, proxy) => Math.max(worst, proxy.error), 0);
  const declined =
    result.declined.length === 0
      ? ""
      : ` declined=${String(result.declined.length)}:${result.declined
          .map((entry) => `${String(entry.x)}_${String(entry.z)}@${entry.reason}`)
          .join(",")}`;
  return `TN_WORLD_HLOD world=${worldLogical} proxies=${String(result.proxies.length)} maxError=${String(maxError)}${declined}`;
}
