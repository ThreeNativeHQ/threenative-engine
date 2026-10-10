import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Document,
  type Buffer as GltfBuffer,
  type Mesh,
  type Node,
  NodeIO,
  type Scene,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from "@gltf-transform/extensions";
import {
  copyToDocument,
  createDefaultPropertyResolver,
  getBounds,
  prune,
  transformMesh,
  unpartition,
} from "@gltf-transform/functions";
import { bakeTerrain, bakeWorldPackage, decodeRAW16, sampleHeight } from "@threenative/terrain";
import type { IPlacement, ITerrainState } from "@threenative/terrain";
import { createGltfReader, readGltfDocument } from "../gltf-io.js";
import { modelPass } from "../passes/model.js";

/** The world.json contract, taken from the shared baker rather than restated here. */
export type IWorldPackageManifest = ReturnType<typeof bakeWorldPackage>["manifest"];
/** One streamed species entry, taken from the shared baker's own option type. */
export type IWorldPackageAsset = NonNullable<IWorldPackageManifest["assets"][string]>;

export interface ISpeciesLODSpec {
  readonly glb?: string | Uint8Array;
  readonly distance: number;
}

export interface ISpeciesSpec {
  readonly glb: string | Uint8Array;
  readonly bounds?: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly lods?: readonly ISpeciesLODSpec[];
  readonly maxDistance?: number;
}

export interface ICookTerrainWorldMaterialLayer {
  readonly id: string;
  readonly diff?: string | Uint8Array;
  readonly nrm?: string | Uint8Array;
  readonly diffBytes?: Uint8Array;
  readonly nrmBytes?: Uint8Array;
  readonly diffMimeType?: string;
  readonly nrmMimeType?: string;
}

export interface ICookTerrainWorldOptions {
  readonly state: ITerrainState;
  readonly species: Readonly<Record<string, ISpeciesSpec>>;
  readonly out: string;
  readonly materials?: {
    readonly layers?: readonly ICookTerrainWorldMaterialLayer[];
    readonly texturesDir?: string;
  };
  readonly cellSize?: number;
  readonly extraLayers?: Readonly<Record<string, string>>;
}

export interface ICookTerrainWorldResult {
  readonly worldGlb: Uint8Array;
  readonly manifest: IWorldPackageManifest;
  readonly placementCounts: Readonly<Record<string, number>>;
  /** Every node in the document, across the default and every alternate-LOD scene. */
  readonly nodeCount: number;
  /**
   * Instancing nodes in the default `TerrainWorld` scene only, so an existing consumer keeps
   * reading one node per species. Alternate LODs live in their own named scenes and are not
   * counted here; walk `getRoot().listScenes()` for the authoritative all-scene census.
   */
  readonly instancedMeshCount: number;
}

/** A placement as a world-package record: `item.transform` when authored, else the scatter pose. */
function poseOf(item: IPlacement): {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  grounding: boolean;
} {
  if (item.transform !== undefined) {
    const { position, quaternion, scale, grounding = true } = item.transform;
    return {
      position: [position[0], position[1], position[2]],
      quaternion: [quaternion[0], quaternion[1], quaternion[2], quaternion[3]],
      scale: [scale[0], scale[1], scale[2]],
      grounding,
    };
  }
  return {
    position: [item.position[0], item.position[1], item.position[2]],
    quaternion: [0, Math.sin(item.rotation / 2), 0, Math.cos(item.rotation / 2)],
    scale: [item.scale, item.scale, item.scale],
    grounding: true,
  };
}

async function resolveBytes(input: string | Uint8Array): Promise<Uint8Array> {
  if (typeof input === "string") {
    return new Uint8Array(await readFile(input));
  }
  return input;
}

/** A species id becomes an output filename, so refuse anything that is not a bare name. */
const SAFE_SPECIES_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Source world-space bounds when the species authors none: geometry plus its node world matrices. */
function sourceBounds(speciesDoc: Document): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const root = speciesDoc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  if (scene) {
    const { min, max } = getBounds(scene);
    if (min.every(Number.isFinite) && max.every(Number.isFinite)) {
      return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
    }
  }
  return { min: [0, 0, 0], max: [0, 0, 0] };
}

/** The mesh-bearing nodes under a species' default scene, in traversal order. */
function meshNodesOf(speciesDoc: Document): { node: Node; mesh: Mesh }[] {
  const root = speciesDoc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  const meshNodes: { node: Node; mesh: Mesh }[] = [];
  scene?.traverse((node: Node) => {
    const mesh = node.getMesh();
    if (mesh) meshNodes.push({ node, mesh });
  });
  return meshNodes;
}

/**
 * Refuse a species that cannot instance, by name, before a byte is written: a deformer, an
 * animation replay, or an actually-empty draw (no mesh, no primitive, or no positioned vertices).
 * A positive placement count and zero source bounds must not hide a species with nothing to draw.
 */
function assertInstancable(speciesId: string, speciesDoc: Document): void {
  if (speciesDoc.getRoot().listSkins().length > 0) {
    throw new Error(
      `cookTerrainWorld: species '${speciesId}' declares a skin; only static species can be instanced.`,
    );
  }
  if (speciesDoc.getRoot().listAnimations().length > 0) {
    throw new Error(
      `cookTerrainWorld: species '${speciesId}' declares an animation; only static species can be instanced.`,
    );
  }
  const meshNodes = meshNodesOf(speciesDoc);
  const primitives = meshNodes.flatMap(({ mesh }) => mesh.listPrimitives());
  const positioned = primitives.some((primitive) => {
    const positions = primitive.getAttribute("POSITION")?.getArray();
    return positions !== undefined && positions !== null && positions.length > 0;
  });
  if (meshNodes.length === 0 || primitives.length === 0 || !positioned) {
    throw new Error(
      `cookTerrainWorld: species '${speciesId}' has no instancable mesh geometry (empty draw); a static species must ship a positioned primitive.`,
    );
  }
}

/** Parse one species or LOD GLB. The same bytes are parsed exactly once per level. */
async function parseSpecies(bytes: Uint8Array): Promise<Document> {
  const reader = await createGltfReader(Buffer.from(bytes));
  return readGltfDocument(reader, Buffer.from(bytes));
}

/**
 * Authored sibling LODs beside a path species: `<root>-mid.glb`, else `<root>-lod1.glb`, where
 * `<root>` drops one trailing detail marker (`-near`, `-lod1`, `-lod2`, …) from the file name.
 * Returns nothing when the caller authored `lods` explicitly or no sibling exists; the caller
 * then falls back to `modelPass({ simplify })`.
 */
async function authoredSiblingLods(glbPath: string): Promise<{ distance: number; glb: string }[]> {
  const dir = path.dirname(glbPath);
  const base = path.basename(glbPath).replace(/\.glb$/i, "");
  const root = base.replace(/-(near|hi|lod\d+)$/i, "");
  for (const candidate of [`${root}-mid.glb`, `${root}-lod1.glb`]) {
    const file = path.join(dir, candidate);
    if (file === glbPath) continue;
    try {
      await stat(file);
      return [{ distance: 40, glb: file }];
    } catch {
      // Absent sibling: try the next name.
    }
  }
  return [];
}

/**
 * One `EXT_mesh_gpu_instancing` node for one species-and-LOD pair, holding every logical
 * placement. Source meshes, materials, textures and each source node's world transform are
 * preserved by the fresh-copy-per-node path: one resolver per node keeps shared geometry private.
 */
function addInstancedSpeciesNode(
  doc: Document,
  buffer: GltfBuffer,
  speciesDoc: Document,
  items: IPlacement[],
  targetScene: Scene,
  instancingExt: EXTMeshGPUInstancing,
  nodeName: string,
): void {
  const count = items.length;
  const translations = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const scales = new Float32Array(count * 3);
  for (const [i, item] of items.entries()) {
    const pose = poseOf(item);
    translations.set(pose.position, i * 3);
    rotations.set(pose.quaternion, i * 4);
    scales.set(pose.scale, i * 3);
  }

  const batch = instancingExt
    .createInstancedMesh()
    .setAttribute(
      "TRANSLATION",
      doc.createAccessor().setType("VEC3").setArray(translations).setBuffer(buffer),
    )
    .setAttribute(
      "ROTATION",
      doc.createAccessor().setType("VEC4").setArray(rotations).setBuffer(buffer),
    )
    .setAttribute("SCALE", doc.createAccessor().setType("VEC3").setArray(scales).setBuffer(buffer));

  // Any extension the source uses must exist on the target document before its properties copy.
  type ExtensionCtor = Parameters<Document["createExtension"]>[0];
  for (const sourceExtension of speciesDoc.getRoot().listExtensionsUsed()) {
    doc.createExtension(sourceExtension.constructor as unknown as ExtensionCtor);
  }

  const combined = doc.createMesh(`${nodeName}_mesh`);
  for (const { node, mesh } of meshNodesOf(speciesDoc)) {
    const resolve = createDefaultPropertyResolver(doc, speciesDoc);
    const targetMesh = copyToDocument(doc, speciesDoc, [mesh], resolve).get(mesh) as Mesh;
    transformMesh(targetMesh, node.getWorldMatrix());
    for (const primitive of targetMesh.listPrimitives()) {
      targetMesh.removePrimitive(primitive);
      combined.addPrimitive(primitive);
    }
  }

  const instancedNode = doc
    .createNode(nodeName)
    .setMesh(combined)
    .setExtension("EXT_mesh_gpu_instancing", batch);
  targetScene.addChild(instancedNode);
}

export async function cookTerrainWorld(
  options: ICookTerrainWorldOptions,
): Promise<ICookTerrainWorldResult> {
  const { state, species, out } = options;
  if (!state || typeof state.size !== "number" || typeof state.resolution !== "number") {
    throw new Error("cookTerrainWorld: state with size and resolution is required");
  }
  if (!state.height || state.height.length !== state.resolution * state.resolution) {
    throw new Error("cookTerrainWorld: state.height length does not match resolution * resolution");
  }

  // A species id becomes an output filename, so every key must be a safe bare name.
  for (const speciesId of Object.keys(species)) {
    if (!SAFE_SPECIES_ID.test(speciesId)) {
      throw new Error(
        `cookTerrainWorld: species id '${speciesId}' is not a safe output filename; use letters, digits, '.', '_' or '-'.`,
      );
    }
  }

  // Every placement must name a species the caller supplied, before anything is read or written.
  for (const item of state.instances) {
    if (species[item.asset] === undefined) {
      throw new Error(
        `cookTerrainWorld: placement '${item.id}' names species '${item.asset}', which is not in the species map.`,
      );
    }
  }

  // Build every species' manifest entry (and its LOD bytes) before the shared bake. Each species
  // model and each of its LODs is parsed exactly once here: the same documents later flatten into
  // their instancing nodes, and every level is refused by name if it cannot instance.
  const assets: Record<string, IWorldPackageAsset> = {};
  const speciesFiles: {
    speciesId: string;
    lod0: Uint8Array;
    nearDoc: Document;
    lods: { distance: number; glb: Uint8Array; filename: string; doc: Document }[];
  }[] = [];

  for (const [speciesId, spec] of Object.entries(species)) {
    const lod0 = await resolveBytes(spec.glb);
    const nearDoc = await parseSpecies(lod0);
    assertInstancable(speciesId, nearDoc);

    // Authored LODs first: explicit `spec.lods`, then a sibling `-mid`/`-lod1` file beside a path
    // species. Only when neither exists does simplification invent a level.
    const authored =
      spec.lods && spec.lods.length > 0
        ? spec.lods
        : typeof spec.glb === "string"
          ? await authoredSiblingLods(spec.glb)
          : [];

    const lods: { distance: number; glb: Uint8Array; filename: string; doc: Document }[] = [];
    for (const [i, level] of authored.entries()) {
      if (level.glb === undefined) continue;
      const bytes = await resolveBytes(level.glb);
      const doc = await parseSpecies(bytes);
      assertInstancable(speciesId, doc);
      lods.push({
        distance: level.distance,
        glb: bytes,
        filename: `${speciesId}_lod${i + 1}.glb`,
        doc,
      });
    }

    if (lods.length === 0) {
      const pass = modelPass({
        simplify: { ratio: 0.5 },
        textures: "none",
        passes: { meshopt: false, prune: true, dedup: true },
      });
      const simplified = await pass.apply(Buffer.from(lod0), `${speciesId}_lod1.glb`);
      const bytes = Uint8Array.from(Buffer.isBuffer(simplified) ? simplified : simplified.buffer);
      const doc = await parseSpecies(bytes);
      assertInstancable(speciesId, doc);
      lods.push({ distance: 40, glb: bytes, filename: `${speciesId}_lod1.glb`, doc });
    }

    speciesFiles.push({ speciesId, lod0, nearDoc, lods });

    assets[speciesId] = {
      glb: `models/${speciesId}.glb`,
      bounds: spec.bounds ?? sourceBounds(nearDoc),
      lods: lods.map((level) => ({ distance: level.distance, glb: `models/${level.filename}` })),
      ...(spec.maxDistance === undefined ? {} : { maxDistance: spec.maxDistance }),
    };
  }

  // Fail closed before any glTF work or output write: the shared baker validates finite heights,
  // known assets and uniform poses, and hands back the exact binary files this cook writes.
  const { manifest, files } = bakeWorldPackage(state, {
    assets,
    ...(options.cellSize === undefined ? {} : { cellSize: options.cellSize }),
    ...(options.extraLayers === undefined ? {} : { layers: options.extraLayers }),
  });

  // Contact check against the bytes the bake actually wrote, not the float grid: decode the
  // quantized uint16 heightmap back to metres and sample that. Tolerance is one uint16 step of the
  // written range plus float32 rounding — a sub-texel hop passes; a real offset above one step,
  // and a mirrored-Z placement that reads the wrong row, both fail. `grounding: false` is an
  // authored override and is skipped honestly.
  const heightmapBytes = files[manifest.terrain.heightmap];
  if (heightmapBytes === undefined) {
    throw new Error("cookTerrainWorld: the world package wrote no heightmap to sample.");
  }
  const decoded = decodeRAW16(heightmapBytes, {
    width: manifest.terrain.columns,
    height: manifest.terrain.rows,
    min: manifest.terrain.heightMin,
    max: manifest.terrain.heightMax,
  });
  const decodedGrid = {
    height: decoded.values,
    resolution: manifest.terrain.columns,
    size: state.size,
  };
  const terrainRange = manifest.terrain.heightMax - manifest.terrain.heightMin;
  const heightQuantStep = terrainRange / 65_535;
  // 2^-23 is float32's machine epsilon; the sampled and decoded values share that rounding.
  const tolerance = heightQuantStep + terrainRange * 1.2e-7;
  for (const item of state.instances) {
    const pose = poseOf(item);
    if (!pose.grounding) continue;
    const groundY = sampleHeight(decodedGrid, pose.position[0], pose.position[2]);
    const difference = Math.abs(pose.position[1] - groundY);
    if (Number.isFinite(difference) && difference > tolerance) {
      throw new Error(
        `Placement '${item.id}' of species '${item.asset}' contact check failed: base Y=${pose.position[1]} misses terrain ground Y=${groundY} by ${difference.toFixed(4)}m (> tolerance ${tolerance.toFixed(4)}m). Check for mirrored-Z or invalid coordinates.`,
      );
    }
  }

  // Setup glTF document. The default scene holds only the near LOD of every species; each
  // alternate LOD gets its own named scene, so no two LODs render at once.
  const doc = new Document();
  const scene = doc.createScene("TerrainWorld");
  const buffer = doc.createBuffer();
  const instancingExt = doc.createExtension(EXTMeshGPUInstancing);

  // Terrain mesh chunks, always from the shared baker's LOD0.
  const chunks = bakeTerrain(state).lods[0]?.chunks ?? [];

  // Material for terrain with PBR layer maps if provided
  const terrainMaterial = doc.createMaterial("TerrainMaterial");
  if (options.materials?.layers && options.materials.layers.length > 0) {
    const baseLayer = options.materials.layers[0];
    if (baseLayer) {
      let diffBytes = baseLayer.diffBytes;
      if (!diffBytes && baseLayer.diff) {
        diffBytes = await resolveBytes(baseLayer.diff);
      }
      if (diffBytes) {
        const texture = doc
          .createTexture("TerrainBaseDiff")
          .setImage(diffBytes)
          .setMimeType(baseLayer.diffMimeType ?? "image/jpeg");
        terrainMaterial.setBaseColorTexture(texture);
      }
      let nrmBytes = baseLayer.nrmBytes;
      if (!nrmBytes && baseLayer.nrm) {
        nrmBytes = await resolveBytes(baseLayer.nrm);
      }
      if (nrmBytes) {
        const nrmTexture = doc
          .createTexture("TerrainBaseNrm")
          .setImage(nrmBytes)
          .setMimeType(baseLayer.nrmMimeType ?? "image/jpeg");
        terrainMaterial.setNormalTexture(nrmTexture);
      }
    }
  }

  // Add chunk meshes
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (!chunk) continue;
    const mesh = doc.createMesh(chunk.name ?? `terrain_chunk_${c}`);
    const prim = doc.createPrimitive();
    prim.setMaterial(terrainMaterial);
    prim.setAttribute(
      "POSITION",
      doc.createAccessor().setType("VEC3").setArray(chunk.positions).setBuffer(buffer),
    );
    prim.setAttribute(
      "NORMAL",
      doc.createAccessor().setType("VEC3").setArray(chunk.normals).setBuffer(buffer),
    );
    prim.setAttribute(
      "TEXCOORD_0",
      doc.createAccessor().setType("VEC2").setArray(chunk.uvs).setBuffer(buffer),
    );
    prim.setIndices(
      doc.createAccessor().setType("SCALAR").setArray(chunk.indices).setBuffer(buffer),
    );
    mesh.addPrimitive(prim);
    const node = doc.createNode(chunk.name ?? `terrain_node_${c}`).setMesh(mesh);
    scene.addChild(node);
  }

  // Group placements by species
  const placementsBySpecies = new Map<string, IPlacement[]>();
  const placementCounts: Record<string, number> = {};
  for (const item of state.instances) {
    let list = placementsBySpecies.get(item.asset);
    if (!list) {
      list = [];
      placementsBySpecies.set(item.asset, list);
    }
    list.push(item);
    placementCounts[item.asset] = (placementCounts[item.asset] ?? 0) + 1;
  }

  // Near LOD: one instancing node per species in the default scene, every logical placement one
  // instance, so the node count stays constant while the instance count grows.
  for (const { speciesId, nearDoc } of speciesFiles) {
    const items = placementsBySpecies.get(speciesId) ?? [];
    if (items.length === 0) continue;
    addInstancedSpeciesNode(
      doc,
      buffer,
      nearDoc,
      items,
      scene,
      instancingExt,
      `${speciesId}_instances`,
    );
  }

  // Alternate LODs: one instancing node per species-and-LOD pair, each in its own named scene,
  // with the same placements as the near node. glTF renders only the default scene, so no two
  // LODs draw at once.
  for (const { speciesId, lods } of speciesFiles) {
    const items = placementsBySpecies.get(speciesId) ?? [];
    if (items.length === 0) continue;
    for (const [i, level] of lods.entries()) {
      const lodScene = doc.createScene(`${speciesId}_lod${i + 1}`);
      addInstancedSpeciesNode(
        doc,
        buffer,
        level.doc,
        items,
        lodScene,
        instancingExt,
        `${speciesId}_lod${i + 1}_instances`,
      );
    }
  }

  doc.getRoot().setDefaultScene(scene);

  await doc.transform(unpartition());
  // Keep solid-texture removal off: species materials are authored, and a flat image is not ours to drop.
  await doc.transform(prune({ keepSolidTextures: true }));

  const writer = new NodeIO().registerExtensions([...ALL_EXTENSIONS]);
  const worldGlb = await writer.writeBinary(doc);

  // Write files to out directory
  await mkdir(out, { recursive: true });
  await mkdir(path.join(out, "models"), { recursive: true });
  await writeFile(path.join(out, "world.glb"), worldGlb);

  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(out, name), bytes);
  }

  for (const { speciesId, lod0, lods } of speciesFiles) {
    await writeFile(path.join(out, "models", `${speciesId}.glb`), lod0);
    for (const level of lods) {
      await writeFile(path.join(out, "models", level.filename), level.glb);
    }
  }

  await writeFile(path.join(out, "world.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const finalNodes = doc.getRoot().listNodes();
  let instancedMeshCount = 0;
  for (const child of scene.listChildren()) {
    if (child.getExtension("EXT_mesh_gpu_instancing") !== null) instancedMeshCount++;
  }

  return {
    worldGlb,
    manifest,
    placementCounts,
    nodeCount: finalNodes.length,
    instancedMeshCount,
  };
}
