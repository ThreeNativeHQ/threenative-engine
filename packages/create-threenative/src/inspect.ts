import { readFile } from "node:fs/promises";
import path from "node:path";
import { Box3, LoadingManager, Vector3 } from "three";
import {
  type IFrameInspection,
  type IManifestAudit,
  auditAssetManifest,
  formatFrameInspection,
  formatManifestAudit,
  inspectFrame,
} from "./inspect-project.js";

export interface IAssetVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface IAssetBounds {
  readonly center: IAssetVector3;
  readonly size: IAssetVector3;
}

export interface IAssetUnits {
  readonly label: "ambiguous" | "likely centimetres" | "likely metres";
  readonly longestAxis: number;
}

export interface IAssetForwardAxis {
  readonly axis: "X" | "Y" | "Z" | "unknown";
  readonly basis: "longest geometry axis" | "none";
  readonly direction: "unknown";
}

export interface IAssetInspection {
  readonly file: string;
  readonly path: string;
  readonly bounds: IAssetBounds;
  readonly units: IAssetUnits;
  readonly forwardAxis: IAssetForwardAxis;
  readonly clips: readonly string[];
  readonly bones: readonly string[];
  readonly meshes: number;
  readonly materials: number;
  readonly textures: number;
  /** World-space lowest and highest point: a model that stands on the floor has `minY` 0. */
  readonly minY: number;
  readonly maxY: number;
  readonly triangles: number;
  readonly materialNames: readonly string[];
  /** The glTF `asset.extras` record, such as `{ tnOrigin: "procedural" }`; empty when none. */
  readonly assetExtras: Readonly<Record<string, unknown>>;
}

export interface IInspectOptions {
  readonly file?: string;
  readonly json: boolean;
  /** `--manifest [--project <dir>]`: audit the project's assets against its manifest. */
  readonly manifest?: { readonly project: string };
  /** `--frame <image> [--sample role:u,v ...]`: blank, luma and sampled-colour check of a screenshot. */
  readonly frame?: { readonly file: string; readonly samples: readonly string[] };
}

const SUPPORTED_EXTENSIONS = new Set([".glb", ".gltf"]);
/**
 * The longest axis alone cannot separate a large scene in metres from a prop in centimetres.
 *
 * One threshold at ten units meant a real Unreal level — a 31.9 x 56.3 x 31.9 m office, correct
 * in metres — was reported as centimetres, which tells an agent to divide a correct asset by a
 * hundred. Below the metre bound almost nothing centimetre-authored fits; above the centimetre
 * bound almost nothing metre-authored does; between them the measurement genuinely does not say,
 * and `ambiguous` is the true answer rather than a confident wrong one.
 */
const METRE_UPPER_BOUND = 10;
const CENTIMETRE_LOWER_BOUND = 100;
const RESOURCE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type ProgressEventConstructor = new (type: string, init?: unknown) => object;

interface INodeGltfGlobals {
  createImageBitmap?: (...args: unknown[]) => Promise<unknown>;
  self?: unknown;
}

interface INodeUrl {
  createObjectURL?: (object: Blob) => string;
}

function vector(value: Vector3): IAssetVector3 {
  return { x: value.x, y: value.y, z: value.z };
}

function emptyBounds(): IAssetBounds {
  return {
    center: { x: 0, y: 0, z: 0 },
    size: { x: 0, y: 0, z: 0 },
  };
}

function longestAxis(size: IAssetVector3): { axis: "X" | "Y" | "Z"; value: number } | undefined {
  const axes = [
    { axis: "X" as const, value: size.x },
    { axis: "Y" as const, value: size.y },
    { axis: "Z" as const, value: size.z },
  ];
  const result = axes.reduce((largest, current) =>
    current.value > largest.value ? current : largest,
  );
  return result.value > 0 ? result : undefined;
}

function installNodeGltfGlobals(): () => void {
  const globals = globalThis as unknown as INodeGltfGlobals;
  const nodeGlobals = globals as unknown as Record<string, unknown>;
  const previousSelf = globals.self;
  const previousCreateImageBitmap = globals.createImageBitmap;
  const previousProgressEvent = nodeGlobals.ProgressEvent as ProgressEventConstructor | undefined;
  const nodeUrl = URL as unknown as INodeUrl;
  const previousCreateObjectUrl = nodeUrl.createObjectURL;

  if (globals.self === undefined) globals.self = globalThis;
  if (globals.createImageBitmap === undefined) {
    globals.createImageBitmap = async () => ({ close() {}, height: 1, width: 1 });
  }
  if (previousProgressEvent === undefined) {
    nodeGlobals.ProgressEvent = class {
      constructor(
        readonly type: string,
        readonly init?: unknown,
      ) {}
    };
  }
  if (nodeUrl.createObjectURL === undefined) {
    nodeUrl.createObjectURL = () => "blob:threenative-inspect";
  }

  return () => {
    if (previousSelf === undefined) globals.self = undefined;
    else globals.self = previousSelf;
    if (previousCreateImageBitmap === undefined) globals.createImageBitmap = undefined;
    else globals.createImageBitmap = previousCreateImageBitmap;
    nodeGlobals.ProgressEvent = previousProgressEvent;
    if (previousCreateObjectUrl === undefined) nodeUrl.createObjectURL = undefined;
    else nodeUrl.createObjectURL = previousCreateObjectUrl;
  };
}

function localResourcePath(baseDirectory: string, uri: string): string | undefined {
  if (/^(?:blob|data):/i.test(uri) || /^(?:https?:)?\/\//i.test(uri)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch (error) {
    throw new Error(`Invalid glTF resource URI "${uri}": ${String(error)}`);
  }
  return path.resolve(baseDirectory, decoded);
}

function resourceMimeType(resourcePath: string, declared: string | undefined): string {
  return (
    declared ??
    RESOURCE_MIME_TYPES[path.extname(resourcePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

function gltfResourceReferences(document: Record<string, unknown>): IGltfResourceReference[] {
  const references: IGltfResourceReference[] = [];
  for (const section of ["buffers", "images"] as const) {
    const entries = document[section];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.uri !== "string") continue;
      references.push({
        ...(typeof entry.mimeType === "string" ? { declared: entry.mimeType } : {}),
        uri: entry.uri,
      });
    }
  }
  return references;
}

interface IGltfResourceReference {
  readonly declared?: string;
  readonly uri: string;
}

async function readLocalResources(
  baseDirectory: string,
  references: readonly IGltfResourceReference[],
): Promise<Map<string, string>> {
  const resources = new Map<string, string>();
  for (const reference of references) {
    const resourcePath = localResourcePath(baseDirectory, reference.uri);
    if (resourcePath === undefined || resources.has(resourcePath)) continue;
    const resource = await readFile(resourcePath);
    const mimeType = resourceMimeType(resourcePath, reference.declared);
    resources.set(resourcePath, `data:${mimeType};base64,${resource.toString("base64")}`);
  }
  return resources;
}

async function localResourceResolver(file: string, data: Buffer): Promise<(url: string) => string> {
  if (path.extname(file).toLowerCase() !== ".gltf") return (url) => url;

  const document = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
  const references = gltfResourceReferences(document);
  const baseDirectory = path.dirname(path.resolve(file));
  const resources = await readLocalResources(baseDirectory, references);

  return (url) => {
    const resourcePath = localResourcePath(baseDirectory, url);
    return resourcePath === undefined ? url : (resources.get(resourcePath) ?? url);
  };
}

/**
 * Parse a glTF/GLB into a scene and its clips, in node.
 *
 * Exported so a spec can hold a real shipped rig against the engine's own clip audit rather than
 * a synthetic one: `clipTrackBindings` and `clipBoneCoverage` answer "does this clip bind, and
 * which bones does it leave behind", and only a real asset has the real answer.
 */
export async function parseGltfAsset(
  file: string,
  data: Buffer,
): Promise<{
  scene: import("three").Object3D;
  animations: readonly import("three").AnimationClip[];
  resourceCounts: {
    meshes?: number;
    materials?: number;
    textures?: number;
  };
  assetExtras: Record<string, unknown>;
}> {
  const restoreGlobals = installNodeGltfGlobals();
  try {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const manager = new LoadingManager();
    manager.setURLModifier(await localResourceResolver(file, data));
    const loader = new GLTFLoader(manager);
    const extension = path.extname(file).toLowerCase();
    const payload =
      extension === ".gltf"
        ? data.toString("utf8")
        : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    const parsed = await loader.parseAsync(
      payload,
      `${path.dirname(path.resolve(file))}${path.sep}`,
    );
    const json = parsed.parser.json as {
      asset?: { extras?: unknown };
      meshes?: unknown;
      materials?: unknown;
      textures?: unknown;
    };
    return {
      animations: parsed.animations,
      assetExtras: isObject(json.asset?.extras) ? { ...json.asset.extras } : {},
      resourceCounts: {
        ...(Array.isArray(json.meshes) ? { meshes: json.meshes.length } : {}),
        ...(Array.isArray(json.materials) ? { materials: json.materials.length } : {}),
        ...(Array.isArray(json.textures) ? { textures: json.textures.length } : {}),
      },
      scene: parsed.scene,
    };
  } finally {
    restoreGlobals();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function countSceneResources(scene: import("three").Object3D): {
  bones: string[];
  materialNames: string[];
  materials: number;
  meshes: number;
  textures: number;
  triangles: number;
} {
  const materials = new Set<object>();
  const textures = new Set<object>();
  const visited = new WeakSet<object>();
  const collectTextures = (value: unknown): void => {
    if (!isObject(value)) return;
    if ((value as { isTexture?: boolean }).isTexture === true) {
      textures.add(value);
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);
    for (const child of Object.values(value)) collectTextures(child);
  };
  const bones: string[] = [];
  let meshes = 0;
  let triangles = 0;

  scene.traverse((object) => {
    const candidate = object as import("three").Object3D & {
      isBone?: boolean;
      isMesh?: boolean;
      material?: unknown;
    };
    if (candidate.isBone === true) bones.push(candidate.name || "(unnamed)");
    if (candidate.isMesh !== true) return;
    meshes += 1;
    const geometry = (candidate as import("three").Mesh).geometry;
    triangles += Math.floor(
      (geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3,
    );
    const material = candidate.material;
    for (const surface of Array.isArray(material) ? material : [material]) {
      if (isObject(surface)) {
        materials.add(surface);
        collectTextures(surface);
      }
    }
  });

  const materialNames = [...materials].map(
    (material) => (material as { name?: string }).name || "(unnamed)",
  );
  return {
    bones,
    materialNames,
    materials: materials.size,
    meshes,
    textures: textures.size,
    triangles,
  };
}

function inspectScene(
  file: string,
  scene: import("three").Object3D,
  animations: readonly import("three").AnimationClip[],
  resourceCounts: {
    meshes?: number;
    materials?: number;
    textures?: number;
  },
  assetExtras: Record<string, unknown>,
): IAssetInspection {
  scene.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(scene);
  const bounds = box.isEmpty()
    ? emptyBounds()
    : { center: vector(box.getCenter(new Vector3())), size: vector(box.getSize(new Vector3())) };
  const largest = longestAxis(bounds.size);
  const resources = countSceneResources(scene);
  return {
    assetExtras,
    bounds,
    bones: resources.bones,
    clips: animations.map((clip) => clip.name || "(unnamed)"),
    file: path.basename(file),
    forwardAxis:
      largest === undefined
        ? { axis: "unknown", basis: "none", direction: "unknown" }
        : { axis: largest.axis, basis: "longest geometry axis", direction: "unknown" },
    materialNames: resources.materialNames,
    materials: resourceCounts.materials ?? resources.materials,
    maxY: box.isEmpty() ? 0 : box.max.y,
    meshes: resourceCounts.meshes ?? resources.meshes,
    minY: box.isEmpty() ? 0 : box.min.y,
    path: path.resolve(file),
    textures: resourceCounts.textures ?? resources.textures,
    triangles: resources.triangles,
    units: {
      label: unitsLabel(largest?.value ?? 0),
      longestAxis: largest?.value ?? 0,
    },
  };
}

function unitsLabel(longestAxis: number): IAssetUnits["label"] {
  if (longestAxis <= METRE_UPPER_BOUND) return "likely metres";
  if (longestAxis >= CENTIMETRE_LOWER_BOUND) return "likely centimetres";
  return "ambiguous";
}

function inspectionFailure(file: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`TN_ASSET_INSPECT_FAILED: ${file}: ${detail}`);
}

const USAGE =
  "Usage: npx create-threenative inspect <file.glb> [--json]\n       npx create-threenative inspect --manifest [--project <dir>] [--json]\n       npx create-threenative inspect --frame <image.png> [--sample role:u,v ...] [--json]";

export function parseInspectArgs(argv: readonly string[]): IInspectOptions {
  const json = argv.includes("--json");
  const rest = argv.filter((argument) => argument !== "--json");
  const take = (flag: string): string | undefined => {
    const at = rest.indexOf(flag);
    if (at === -1) return undefined;
    const value = rest[at + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag} needs a value.\n${USAGE}`);
    rest.splice(at, 2);
    return value;
  };
  if (rest.includes("--manifest")) {
    rest.splice(rest.indexOf("--manifest"), 1);
    const project = take("--project") ?? ".";
    if (rest.length > 0) throw new Error(USAGE);
    return { json, manifest: { project } };
  }
  const frame = take("--frame");
  if (frame !== undefined) {
    const samples: string[] = [];
    for (let sample = take("--sample"); sample !== undefined; sample = take("--sample"))
      samples.push(sample);
    if (rest.length > 0) throw new Error(USAGE);
    return { frame: { file: frame, samples }, json };
  }
  const file = rest[0];
  if (rest.length !== 1 || file === undefined || file.startsWith("-")) throw new Error(USAGE);
  return { file, json };
}

export async function inspectAsset(file: string): Promise<IAssetInspection> {
  const extension = path.extname(file).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`TN_ASSET_INSPECT_UNSUPPORTED: ${file}: expected a .glb or .gltf file.`);
  }
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (error) {
    throw inspectionFailure(file, error);
  }
  try {
    const parsed = await parseGltfAsset(file, data);
    return inspectScene(
      file,
      parsed.scene,
      parsed.animations,
      parsed.resourceCounts,
      parsed.assetExtras,
    );
  } catch (error) {
    throw inspectionFailure(file, error);
  }
}

function formatVector(value: IAssetVector3, separator: string): string {
  return [value.x, value.y, value.z].map((component) => component.toFixed(3)).join(separator);
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

export function formatAssetInspection(result: IAssetInspection): string {
  const forward =
    result.forwardAxis.axis === "unknown"
      ? "unknown (glTF has no forward-axis metadata)"
      : `${result.forwardAxis.axis} (inferred from geometry; sign unknown)`;
  const bones =
    result.bones.length === 0 ? "(none)" : `${result.bones.join(", ")} (${result.bones.length})`;
  return `${[
    result.file,
    `  bounds     ${formatVector(result.bounds.size, " x ")}   (centre ${formatVector(result.bounds.center, ", ")})`,
    `  units      ${result.units.label} — longest axis ${result.units.longestAxis.toFixed(1)}`,
    `  forward    ${forward}`,
    `  clips      ${listOrNone(result.clips)}`,
    `  bones      ${bones}`,
    `  meshes     ${result.meshes}   materials ${result.materials}   textures ${result.textures}`,
    `  height     minY ${result.minY.toFixed(3)}   maxY ${result.maxY.toFixed(3)}   triangles ${result.triangles}`,
    `  materials  ${listOrNone(result.materialNames)}`,
    `  extras     ${Object.keys(result.assetExtras).length === 0 ? "(none)" : JSON.stringify(result.assetExtras)}`,
  ].join("\n")}\n`;
}

export function inspectHelp(): string {
  return `${[
    USAGE,
    "",
    "Read a glTF asset and report its bounds, minY/maxY, triangles, units heuristic, axis",
    "observation, clips, bones, meshes, materials (with names), textures and asset extras.",
    "The command never modifies the asset.",
    "",
    "Options:",
    "  --json                 Print the same report as machine-readable JSON.",
    "  --manifest             Audit assets/** against public/assets.manifest.json: files the",
    "                         manifest lacks, entries without a file, leftover .zip archives and",
    "                         duplicate downloads (identical bytes). Exits 1 on any finding.",
    "  --project <dir>        The project root for --manifest (default: the current directory).",
    "  --frame <image.png>    Check a screenshot: blank or near-black, mean luma, and colour at",
    "                         each --sample role:u,v (u,v in 0..1 from the top left).",
  ].join("\n")}\n`;
}

export async function inspectCommand(
  argv: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<unknown> {
  const options = parseInspectArgs(argv);
  const result = options.manifest
    ? await auditAssetManifest(options.manifest.project)
    : options.frame
      ? await inspectFrame(options.frame.file, options.frame.samples)
      : await inspectAsset(options.file as string);
  const text = options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : options.manifest
      ? formatManifestAudit(result as IManifestAudit)
      : options.frame
        ? formatFrameInspection(result as IFrameInspection)
        : formatAssetInspection(result as IAssetInspection);
  write(text);
  // A finding is a failed check, not a crash: the report is printed, then the process exits 1.
  if ((result as { pass?: boolean }).pass === false) process.exitCode = 1;
  return result;
}
