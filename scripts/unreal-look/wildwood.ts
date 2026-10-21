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
 * Unreal reads a plain copy of each GLB. Its glTF importer has no EXT_meshopt_compression, and the
 * files carry it, so `decodeForUnreal` writes a decoded copy into the run's work folder. The decoded
 * copy holds the same triangles, UVs, textures and materials, with the node transform baked in.
 * The ThreeNative scene loads the original file.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRMeshQuantization,
} from "@gltf-transform/extensions";
import { clearNodeTransform, dequantize } from "@gltf-transform/functions";
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
      `${root} is not a folder. Set ${ASSET_ROOT_ENV} to the folder that holds the wildwood GLBs (SM_pine01.glb and the others); they are licensed Fab files and are not in this repository.`,
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
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const document = await io.read(source);
  await document.transform(dequantize());
  for (const node of document.getRoot().listNodes()) if (node.getMesh()) clearNodeTransform(node);
  for (const extension of document.getRoot().listExtensionsUsed())
    if (extension instanceof EXTMeshoptCompression || extension instanceof KHRMeshQuantization)
      extension.dispose();
  await mkdir(outDir, { recursive: true });
  await writeFile(target, await io.writeBinary(document));
  return target;
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
