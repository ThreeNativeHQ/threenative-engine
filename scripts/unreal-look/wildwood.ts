/**
 * PRD-649 / PRD-651: the `shadow:wildwood` calibration scene places real vegetation in both engines.
 *
 * The vegetation is the Fab "Landscape Pro" GLBs of the sandbox wildwood game. They are licensed art
 * and this repository is public, so no model, texture or other Fab binary is committed. What is
 * committed is `tools/unreal-reference/shadow/wildwood/manifest.json`: each file with its sha256 and
 * each instance with its transform. The files are read from `TN_WILDWOOD_ASSETS` (default: the
 * sandbox wildwood game's Fab folder), and a missing root, a missing file or a changed file stops the
 * run before any engine starts.
 *
 * Both engines read the same decoded geometry. Unreal's glTF importer has no EXT_meshopt_compression,
 * and the files carry it, so `decodeForUnreal` writes a decoded copy of each GLB into the run's work
 * folder: the same triangles, UVs, textures and materials, with the node transform baked in. The
 * ThreeNative scene is one GLB composed from those decoded copies (`composeScene`): the floor box that
 * scene.json reports and one node per manifest instance, named after it, at its transform. The result
 * lives in the capture work folder and is never committed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, type Node as GltfNode, type Mesh, NodeIO } from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRMeshQuantization,
} from "@gltf-transform/extensions";
import {
  clearNodeTransform,
  dequantize,
  mergeDocuments,
  unpartition,
} from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";

export const ASSET_ROOT_ENV = "TN_WILDWOOD_ASSETS";

type Vec3 = [number, number, number];

export interface IWildwoodAsset {
  /** The name instances use. */
  name: string;
  /** The file under the asset root. */
  file: string;
  sha256: string;
}

export interface IWildwoodInstance {
  name: string;
  asset: string;
  /** Metres, three.js frame: Y up, the ground at y = 0. */
  position: Vec3;
  /** A turn about the vertical, degrees. */
  rotationYDeg: number;
  scale: number;
  /** The region-ID group; default: the instance's own name. */
  region?: string;
}

export interface IWildwoodManifest {
  note?: string;
  assets: IWildwoodAsset[];
  instances: IWildwoodInstance[];
}

/** The most region-ID colours export.py has, the floor included. */
const MAX_REGIONS = 18;

function fail(code: string, message: string): never {
  throw new Error(`TN_WILDWOOD_${code}: ${message}`);
}

/** The sandbox wildwood game's Fab folder on the owner's machine. */
export function defaultAssetRoot(): string {
  return path.join(
    os.homedir(),
    "projects/threenative/sandbox/wildwood/assets/fab/1ac647da-b1bc-4e72-a56d-60aaeb6918e1/Models",
  );
}

/** The asset root: `TN_WILDWOOD_ASSETS`, or the default. Fails closed when it is not a folder. */
export function assetRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env[ASSET_ROOT_ENV] || defaultAssetRoot();
  if (!existsSync(root) || !statSync(root).isDirectory())
    fail(
      "NO_ASSET_ROOT",
      `${root} is not a folder. Set ${ASSET_ROOT_ENV} to the folder that holds the wildwood GLBs (SM_green-tree01.glb and the others in manifest.json); they are licensed Fab files and are not in this repository.`,
    );
  return root;
}

function finite(values: readonly number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

function checkAssets(assets: readonly IWildwoodAsset[]): Set<string> {
  const names = new Set<string>();
  for (const asset of assets) {
    if (!/^[A-Za-z0-9._-]+\.glb$/.test(asset.file))
      fail("MANIFEST", `asset ${asset.name}: file ${asset.file} is not a plain .glb file name`);
    if (!/^[0-9a-f]{64}$/.test(asset.sha256))
      fail("MANIFEST", `asset ${asset.name}: sha256 is not 64 hex digits`);
    if (names.has(asset.name)) fail("MANIFEST", `asset ${asset.name} is listed twice`);
    names.add(asset.name);
  }
  return names;
}

function checkInstance(instance: IWildwoodInstance, assets: ReadonlySet<string>): void {
  if (!assets.has(instance.asset))
    fail("MANIFEST", `instance ${instance.name}: asset ${instance.asset} is not listed`);
  if (
    instance.position.length !== 3 ||
    !finite([...instance.position, instance.rotationYDeg, instance.scale]) ||
    !(instance.scale > 0)
  )
    fail("MANIFEST", `instance ${instance.name}: position, turn and scale must be finite numbers`);
}

/** The manifest, checked: every instance names a listed asset, and the regions fit the ID colours. */
export function validateManifest(manifest: IWildwoodManifest): IWildwoodManifest {
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0)
    fail("MANIFEST", "the manifest lists no assets");
  if (!Array.isArray(manifest.instances) || manifest.instances.length === 0)
    fail("MANIFEST", "the manifest lists no instances");
  const assets = checkAssets(manifest.assets);
  const names = new Set<string>();
  const regions = new Set<string>(["Floor"]);
  for (const instance of manifest.instances) {
    if (names.has(instance.name)) fail("MANIFEST", `instance ${instance.name} is listed twice`);
    names.add(instance.name);
    checkInstance(instance, assets);
    regions.add(instance.region ?? instance.name);
  }
  if (regions.size > MAX_REGIONS)
    fail("MANIFEST", `${regions.size} regions, but only ${MAX_REGIONS} region-ID colours exist`);
  return manifest;
}

export function readManifest(sceneDir: string): IWildwoodManifest {
  const file = path.join(sceneDir, "manifest.json");
  if (!existsSync(file)) fail("MANIFEST", `${file} does not exist`);
  return validateManifest(JSON.parse(readFileSync(file, "utf8")) as IWildwoodManifest);
}

/**
 * Every listed file under the root, with its sha256 checked. Returns the absolute path per asset name.
 * A file that is missing or has other bytes than the manifest names stops the run.
 */
export function verifyAssets(manifest: IWildwoodManifest, root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const asset of manifest.assets) {
    const file = path.join(root, asset.file);
    if (!existsSync(file))
      fail(
        "ASSET_MISSING",
        `${asset.file} is not in ${root}. Set ${ASSET_ROOT_ENV} to the folder that holds the wildwood GLBs.`,
      );
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (sha256 !== asset.sha256)
      fail(
        "ASSET_CHANGED",
        `${asset.file} has sha256 ${sha256}, the manifest names ${asset.sha256}. The scene would not be the one that was calibrated.`,
      );
    files.set(asset.name, file);
  }
  return files;
}

/** The glTF JSON chunk of a GLB file. */
function readGltfJson(file: string): { materials?: IGltfMaterial[] } {
  const bytes = readFileSync(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    fail("ASSET_CHANGED", `${file} is not a binary glTF`);
  return JSON.parse(bytes.subarray(20, 20 + view.getUint32(12, true)).toString("utf8"));
}

interface IGltfMaterial {
  name?: string;
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
}

/** What Unreal's level reports for one instance (gi/export.py, describe_glb). */
export interface IReadBackMesh {
  name: string;
  asset?: string;
  region?: string;
  position: number[];
  rotationYDeg: number;
  scale?: number;
  slots?: { slot: string; alphaMode: string; alphaCutoff?: number; doubleSided: boolean }[];
}

const near = (a: number, b: number, tolerance = 1e-3): boolean => Math.abs(a - b) <= tolerance;
/** Turns compare modulo a full circle: the level may report 200 degrees as -160. */
const sameTurn = (a: number, b: number): boolean => near(((((a - b) % 360) + 540) % 360) - 180, 0);

/** One instance: the level placed the manifest's asset where the manifest says. */
function checkPlacement(mesh: IReadBackMesh, want: IWildwoodInstance): void {
  const where = `${want.name}: scene.json differs from the manifest`;
  if (mesh.asset !== want.asset) fail("SCENE_EXPORT", `${where} (asset ${mesh.asset})`);
  if (mesh.region !== (want.region ?? want.name)) fail("SCENE_EXPORT", `${where} (region)`);
  if (
    mesh.position.length !== 3 ||
    !mesh.position.every((v, i) => near(v, want.position[i] ?? Number.NaN))
  )
    fail("SCENE_EXPORT", `${where} (position ${mesh.position} against ${want.position})`);
  if (!sameTurn(mesh.rotationYDeg, want.rotationYDeg)) fail("SCENE_EXPORT", `${where} (turn)`);
  if (!near(mesh.scale ?? Number.NaN, want.scale)) fail("SCENE_EXPORT", `${where} (scale)`);
}

/** One slot: the level draws the material the glTF file describes (masked, cutoff, sides). */
function checkSlot(
  mesh: IReadBackMesh,
  slot: NonNullable<IReadBackMesh["slots"]>[number],
  materials: readonly IGltfMaterial[],
): void {
  const source = materials.find((m) => m.name === slot.slot);
  if (source === undefined)
    fail("SCENE_EXPORT", `${mesh.name}: slot ${slot.slot} is not a material of ${mesh.asset}`);
  const alphaMode = source.alphaMode ?? "OPAQUE";
  const sides = source.doubleSided ?? false;
  if (slot.alphaMode !== alphaMode || slot.doubleSided !== sides)
    fail(
      "SCENE_EXPORT",
      `${mesh.name}: slot ${slot.slot} is ${slot.alphaMode} double sided ${slot.doubleSided}, the glTF says ${alphaMode} double sided ${sides}`,
    );
  if (alphaMode === "MASK" && !near(slot.alphaCutoff ?? Number.NaN, source.alphaCutoff ?? 0.5))
    fail(
      "SCENE_EXPORT",
      `${mesh.name}: slot ${slot.slot} cuts at ${slot.alphaCutoff}, the glTF says ${source.alphaCutoff ?? 0.5}`,
    );
}

/**
 * scene.json is what Unreal's level reports; the manifest and the GLB files are what both engines are
 * meant to place. Every instance must be there with its asset, region, place, turn and scale, and every
 * material slot must be masked, cut and sided as its glTF says. Anything else in the level besides the
 * floor is a scene the ThreeNative recreation would not draw.
 */
export function validateWildwoodScene(
  scene: { meshes: IReadBackMesh[]; regions: Record<string, number[]> },
  manifest: IWildwoodManifest,
  files: ReadonlyMap<string, string>,
): void {
  const byName = new Map(scene.meshes.map((m) => [m.name, m]));
  for (const want of manifest.instances) {
    const mesh = byName.get(want.name);
    if (mesh === undefined)
      fail("SCENE_EXPORT", `${want.name}: in the manifest, missing in scene.json`);
    checkPlacement(mesh, want);
    const file = files.get(want.asset) ?? fail("ASSET_MISSING", want.asset);
    const materials = readGltfJson(file).materials ?? [];
    if (!mesh.slots?.length)
      fail("SCENE_EXPORT", `${want.name}: scene.json reports no material slots`);
    for (const slot of mesh.slots) checkSlot(mesh, slot, materials);
  }
  const listed = new Set(manifest.instances.map((i) => i.name));
  for (const mesh of scene.meshes)
    if (!listed.has(mesh.name) && mesh.name !== "Floor")
      fail("SCENE_EXPORT", `${mesh.name}: in scene.json, missing in the manifest`);
  const regions = new Set(manifest.instances.map((i) => i.region ?? i.name));
  regions.add("Floor");
  if ([...regions].sort().join() !== Object.keys(scene.regions).sort().join())
    fail("SCENE_EXPORT", "scene.json regions are not the manifest's regions and the floor");
}

function meshoptIO(): NodeIO {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
}

/** One GLB as plain data: no meshopt, no quantization, and the node transform baked into the vertices. */
async function readDecoded(source: string): Promise<{ io: NodeIO; document: Document }> {
  await MeshoptDecoder.ready;
  const io = meshoptIO();
  const document = await io.read(source);
  await document.transform(dequantize());
  for (const node of document.getRoot().listNodes()) if (node.getMesh()) clearNodeTransform(node);
  for (const extension of document.getRoot().listExtensionsUsed())
    if (extension instanceof EXTMeshoptCompression || extension instanceof KHRMeshQuantization)
      extension.dispose();
  return { io, document };
}

/**
 * A plain copy of one GLB for Unreal's importer: no meshopt, no quantization, and the node transform
 * baked into the vertices, so the mesh sits at its own origin in metres. Returns the written path.
 */
export async function decodeForUnreal(
  source: string,
  sha256: string,
  outDir: string,
): Promise<string> {
  const target = path.join(outDir, `${path.basename(source, ".glb")}-${sha256.slice(0, 12)}.glb`);
  if (existsSync(target)) return target;
  const { io, document } = await readDecoded(source);
  await mkdir(outDir, { recursive: true });
  await writeFile(target, await io.writeBinary(document));
  return target;
}

/** A plain box the floor of scene.json names: no turn, no texture. */
export interface IFloorBox {
  name: string;
  position: Vec3;
  size: Vec3;
  material: { baseColor: Vec3; roughness: number; metallic: number };
}

/** The boxes scene.json reports besides the manifest's instances: the floor. Anything but a plain box fails. */
export function floorBoxes(scene: { meshes: Record<string, unknown>[] }): IFloorBox[] {
  const boxes = scene.meshes.filter((m) => m.asset === undefined) as unknown as (IFloorBox & {
    rotationYDeg?: number;
    rotationXDeg?: number;
    material?: IFloorBox["material"] & { alphaMode?: string; baseColorTexture?: string };
  })[];
  if (boxes.length === 0) fail("SCENE_EXPORT", "scene.json holds no floor box");
  for (const box of boxes) {
    if (box.rotationYDeg || box.rotationXDeg)
      fail("SCENE_EXPORT", `${box.name}: a turned box is not composed`);
    if (box.material?.baseColorTexture !== undefined || box.material?.alphaMode !== undefined)
      fail("SCENE_EXPORT", `${box.name}: a textured or masked box is not composed`);
  }
  return boxes;
}

/** Six faces, each a quad whose axes u x v = the face normal, so the winding faces outwards. */
const FACES: { n: Vec3; u: Vec3; v: Vec3 }[] = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

function addBox(document: Document, floor: IFloorBox): GltfNode {
  const half = floor.size.map((v) => v / 2);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const { n, u, v } of FACES) {
    const base = positions.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let axis = 0; axis < 3; axis++)
        positions.push(
          ((n[axis] ?? 0) + a * (u[axis] ?? 0) + b * (v[axis] ?? 0)) * (half[axis] ?? 0),
        );
      normals.push(...n);
      uvs.push((a + 1) / 2, (b + 1) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const accessor = (type: "VEC3" | "VEC2" | "SCALAR", array: Float32Array | Uint16Array) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const [r, g, b] = floor.material.baseColor;
  const material = document
    .createMaterial(`MI_${floor.name}`)
    .setBaseColorFactor([r, g, b, 1])
    .setMetallicFactor(floor.material.metallic)
    .setRoughnessFactor(floor.material.roughness);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", new Float32Array(positions)))
    .setAttribute("NORMAL", accessor("VEC3", new Float32Array(normals)))
    .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array(uvs)))
    .setIndices(accessor("SCALAR", new Uint16Array(indices)))
    .setMaterial(material);
  return document
    .createNode(floor.name)
    .setTranslation(floor.position)
    .setMesh(document.createMesh(`SM_${floor.name}`).addPrimitive(primitive));
}

/** The meshes of one decoded asset, as they stand in the composed document. */
async function mergeAsset(document: Document, file: string): Promise<Mesh[]> {
  const { document: source } = await readDecoded(file);
  const merged = mergeDocuments(document, source);
  const meshes: Mesh[] = [];
  for (const node of source.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) meshes.push(merged.get(mesh) as Mesh);
    (merged.get(node) as GltfNode).dispose();
  }
  for (const scene of source.getRoot().listScenes())
    (merged.get(scene) as { dispose(): void }).dispose();
  if (meshes.length === 0) fail("ASSET_CHANGED", `${file} holds no mesh`);
  return meshes;
}

/**
 * The ThreeNative scene of a manifest: the floor box scene.json reports and one node per instance,
 * named after it, at its transform, holding one mesh (SM_<instance>) with every primitive of its asset.
 * Materials stay as the file has them: alpha mode, cutoff, sides and textures. Returns the GLB bytes.
 */
export async function composeScene(
  manifest: IWildwoodManifest,
  files: ReadonlyMap<string, string>,
  floors: readonly IFloorBox[],
  sceneName: string,
): Promise<Uint8Array> {
  const document = new Document();
  document.createBuffer();
  const scene = document.createScene(sceneName);
  for (const floor of floors) scene.addChild(addBox(document, floor));
  const assets = new Map<string, Mesh[]>();
  for (const instance of manifest.instances) {
    let meshes = assets.get(instance.asset);
    if (meshes === undefined) {
      const file = files.get(instance.asset) ?? fail("ASSET_MISSING", instance.asset);
      meshes = await mergeAsset(document, file);
      assets.set(instance.asset, meshes);
    }
    const mesh = document.createMesh(`SM_${instance.name}`);
    for (const source of meshes)
      for (const primitive of source.listPrimitives()) mesh.addPrimitive(primitive.clone());
    const half = (instance.rotationYDeg * Math.PI) / 360;
    scene.addChild(
      document
        .createNode(instance.name)
        .setTranslation(instance.position)
        .setRotation([0, Math.sin(half), 0, Math.cos(half)])
        .setScale([instance.scale, instance.scale, instance.scale])
        .setMesh(mesh),
    );
  }
  // The asset meshes were only the source of the clones.
  for (const meshes of assets.values()) for (const mesh of meshes) mesh.dispose();
  await document.transform(unpartition());
  return meshoptIO().writeBinary(document);
}

/** The ThreeNative scene file for a manifest scene: verified files, composed. Fails closed like the Unreal build. */
export async function composeForThreeNative(
  sceneDir: string,
  scene: { meshes: Record<string, unknown>[] },
  sceneName: string,
): Promise<Uint8Array> {
  const manifest = readManifest(sceneDir);
  return composeScene(manifest, verifyAssets(manifest, assetRoot()), floorBoxes(scene), sceneName);
}

/**
 * The environment Unreal's build needs for a manifest scene: the verified asset root and a folder of
 * decoded copies (`TN_WILDWOOD_DECODED`), with one `<asset name>=<file>` line per asset in
 * `TN_WILDWOOD_FILES`.
 */
export async function prepareUnrealAssets(
  sceneDir: string,
  work: string,
): Promise<Record<string, string>> {
  const manifest = readManifest(sceneDir);
  const root = assetRoot();
  const files = verifyAssets(manifest, root);
  const decoded: string[] = [];
  for (const asset of manifest.assets) {
    const source = files.get(asset.name) ?? fail("ASSET_MISSING", asset.name);
    decoded.push(
      `${asset.name}=${await decodeForUnreal(source, asset.sha256, path.join(work, "decoded"))}`,
    );
  }
  return { [ASSET_ROOT_ENV]: root, TN_WILDWOOD_FILES: decoded.join("\n") };
}
