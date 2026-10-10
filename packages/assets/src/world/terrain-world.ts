import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, type Mesh, type Node, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from "@gltf-transform/extensions";
import {
  copyToDocument,
  createDefaultPropertyResolver,
  getBounds,
  prune,
  transformMesh,
  unpartition,
} from "@gltf-transform/functions";
import { bakeTerrain, bakeWorldPackage, sampleHeight } from "@threenative/terrain";
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
  readonly nodeCount: number;
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

  // Contact check: a grounded placement must meet the sampled terrain surface, within the
  // quantisation the uint16 heightmap costs. A mirrored-Z placement reads the wrong row and misses.
  const spacing = state.size / (state.resolution - 1);
  let heightMin = Number.POSITIVE_INFINITY;
  let heightMax = Number.NEGATIVE_INFINITY;
  for (const height of state.height) {
    if (height < heightMin) heightMin = height;
    if (height > heightMax) heightMax = height;
  }
  const range = heightMax - heightMin;
  const tolerance = spacing + (Number.isFinite(range) ? range / 65_535 : 0);
  for (const item of state.instances) {
    const pose = poseOf(item);
    if (!pose.grounding) continue;
    const groundY = sampleHeight(state, pose.position[0], pose.position[2]);
    const difference = Math.abs(pose.position[1] - groundY);
    if (Number.isFinite(difference) && difference > tolerance) {
      throw new Error(
        `Placement '${item.id}' of species '${item.asset}' contact check failed: base Y=${pose.position[1]} misses terrain ground Y=${groundY} by ${difference.toFixed(3)}m (> tolerance ${tolerance.toFixed(3)}m). Check for mirrored-Z or invalid coordinates.`,
      );
    }
  }

  // Build every species' manifest entry (and its LOD bytes) before the shared bake. Each species
  // model is parsed exactly once here: the same document later flattens into its instancing node.
  const assets: Record<string, IWorldPackageAsset> = {};
  const speciesFiles: {
    speciesId: string;
    lod0: Uint8Array;
    speciesDoc: Document;
    lods: { distance: number; glb: Uint8Array; filename: string }[];
  }[] = [];

  for (const [speciesId, spec] of Object.entries(species)) {
    const lod0 = await resolveBytes(spec.glb);

    // Parse once, and refuse anything that deforms or replays before a single byte is written.
    const reader = await createGltfReader(Buffer.from(lod0));
    const speciesDoc = await readGltfDocument(reader, Buffer.from(lod0));
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

    const lods: { distance: number; glb: Uint8Array; filename: string }[] = [];
    if (spec.lods && spec.lods.length > 0) {
      for (const [i, level] of spec.lods.entries()) {
        if (level.glb === undefined) continue;
        const bytes = await resolveBytes(level.glb);
        lods.push({
          distance: level.distance,
          glb: bytes,
          filename: `${speciesId}_lod${i + 1}.glb`,
        });
      }
    } else {
      const pass = modelPass({
        simplify: { ratio: 0.5 },
        textures: "none",
        passes: { meshopt: false, prune: true, dedup: true },
      });
      const simplified = await pass.apply(Buffer.from(lod0), `${speciesId}_lod1.glb`);
      const bytes = Uint8Array.from(Buffer.isBuffer(simplified) ? simplified : simplified.buffer);
      lods.push({ distance: 40, glb: bytes, filename: `${speciesId}_lod1.glb` });
    }

    speciesFiles.push({ speciesId, lod0, speciesDoc, lods });

    assets[speciesId] = {
      glb: `models/${speciesId}.glb`,
      bounds: spec.bounds ?? sourceBounds(speciesDoc),
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

  // Setup glTF document
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

  // One EXT_mesh_gpu_instancing node per species: every logical placement is one instance, and the
  // species' source meshes flatten into a single mesh so the node count stays constant.
  for (const { speciesId, speciesDoc } of speciesFiles) {
    const items = placementsBySpecies.get(speciesId) ?? [];
    if (items.length === 0) continue;

    const count = items.length;
    const translations = new Float32Array(count * 3);
    const rotations = new Float32Array(count * 4);
    const scales = new Float32Array(count * 3);

    for (const [i, item] of items.entries()) {
      const pose = poseOf(item);
      translations[i * 3 + 0] = pose.position[0];
      translations[i * 3 + 1] = pose.position[1];
      translations[i * 3 + 2] = pose.position[2];

      rotations[i * 4 + 0] = pose.quaternion[0];
      rotations[i * 4 + 1] = pose.quaternion[1];
      rotations[i * 4 + 2] = pose.quaternion[2];
      rotations[i * 4 + 3] = pose.quaternion[3];

      scales[i * 3 + 0] = pose.scale[0];
      scales[i * 3 + 1] = pose.scale[1];
      scales[i * 3 + 2] = pose.scale[2];
    }

    const transAccessor = doc
      .createAccessor()
      .setType("VEC3")
      .setArray(translations)
      .setBuffer(buffer);
    const rotAccessor = doc.createAccessor().setType("VEC4").setArray(rotations).setBuffer(buffer);
    const scaleAccessor = doc.createAccessor().setType("VEC3").setArray(scales).setBuffer(buffer);

    const batch = instancingExt
      .createInstancedMesh()
      .setAttribute("TRANSLATION", transAccessor)
      .setAttribute("ROTATION", rotAccessor)
      .setAttribute("SCALE", scaleAccessor);

    // Any extension the source uses must exist on the target document before its properties copy.
    type ExtensionCtor = Parameters<Document["createExtension"]>[0];
    for (const sourceExtension of speciesDoc.getRoot().listExtensionsUsed()) {
      doc.createExtension(sourceExtension.constructor as unknown as ExtensionCtor);
    }

    // Bring meshes, materials, textures and accessors across, then bake each source node's world
    // matrix into its geometry. A fresh resolver per node keeps geometry and accessors private, so
    // one source mesh reused by several nodes keeps each node's own transform. `transformMesh`
    // keeps every attribute and material.
    const rootScene =
      speciesDoc.getRoot().getDefaultScene() ?? speciesDoc.getRoot().listScenes()[0] ?? null;
    const meshNodes: { node: Node; mesh: Mesh }[] = [];
    rootScene?.traverse((node: Node) => {
      const mesh = node.getMesh();
      if (mesh) meshNodes.push({ node, mesh });
    });

    const combined = doc.createMesh(`${speciesId}_mesh`);
    for (const { node, mesh } of meshNodes) {
      const resolve = createDefaultPropertyResolver(doc, speciesDoc);
      const targetMesh = copyToDocument(doc, speciesDoc, [mesh], resolve).get(mesh) as Mesh;
      transformMesh(targetMesh, node.getWorldMatrix());
      for (const primitive of targetMesh.listPrimitives()) {
        targetMesh.removePrimitive(primitive);
        combined.addPrimitive(primitive);
      }
    }

    const instancedNode = doc
      .createNode(`${speciesId}_instances`)
      .setMesh(combined)
      .setExtension("EXT_mesh_gpu_instancing", batch);
    scene.addChild(instancedNode);
  }

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
    const nearGlbName = `${speciesId}.glb`;
    await writeFile(path.join(out, "models", nearGlbName), lod0);
    for (const level of lods) {
      await writeFile(path.join(out, "models", level.filename), level.glb);
    }
  }

  await writeFile(path.join(out, "world.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const finalNodes = doc.getRoot().listNodes();
  let instancedMeshCount = 0;
  for (const n of finalNodes) {
    if (n.getExtension("EXT_mesh_gpu_instancing") !== null) instancedMeshCount++;
  }

  return {
    worldGlb,
    manifest,
    placementCounts,
    nodeCount: finalNodes.length,
    instancedMeshCount,
  };
}
