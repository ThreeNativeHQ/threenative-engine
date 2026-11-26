/**
 * PRD-120 extension: bakes and exports every asset in `@threenative/procedural-environment`'s
 * Asset Library (all 14 bakeable kits + all 4 runtime kits: `stylized`, `dungeon`, `village`,
 * `toybox`) into self-contained GLB bytes ready for `POST /ops/asset-cache/public`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, quantize } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { proceduralEnvironmentSource } from "../packages/procedural-environment/dist/asset-library.js";
import {
  type IEnvironmentBake,
  bakeCity,
  bakeFrontier,
  bakeLogistics,
  bakeMechanism,
  bakePickup,
  bakeRail,
  bakeRock,
  bakeSports,
  bakeStation,
  bakeTavern,
  bakeVegetation,
  bakeWorkshop,
} from "../packages/procedural-environment/dist/index.js";
import { createStylizedAsset } from "../packages/procedural-environment/dist/stylized.js";

export const PUBLIC_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const COMPRESS_THRESHOLD_BYTES = 20 * 1024 * 1024;
const ASSET_LIBRARY_LICENSE = "MIT";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const CUSTOM_SHADER_ATTRIBUTES = [
  "surf",
  "cap",
  "edge",
  "tint",
  "mask",
  "depth",
  "flow",
  "sway",
  "pulse",
  "dungeonFlame",
] as const;

export interface ISeedEntry {
  readonly slug: string;
  readonly prompt: string;
  readonly tags: string;
  readonly bytes: Uint8Array;
  readonly license?: string;
}

interface IRawCatalogElement {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly category?: string;
  readonly biomes?: readonly string[];
  readonly latin?: string;
  readonly styleTags?: readonly string[];
  readonly settingTags?: readonly string[];
}

export interface IAssetLibraryDescriptor {
  readonly slug: string;
  readonly kind: string;
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly tags: string;
  readonly license: string;
  readonly biomes: readonly string[];
  readonly runtime: boolean;
}

interface IThreeModule {
  Color: new (
    hex?: number,
  ) => {
    clone: () => unknown;
    lerp: (other: unknown, alpha: number) => unknown;
  };
  MeshStandardMaterial: new (params: Record<string, unknown>) => unknown;
  FrontSide: number;
}

interface IExporter {
  new (): {
    parseAsync: (input: unknown, options: Record<string, unknown>) => Promise<ArrayBuffer>;
  };
}

interface IThreeRuntime {
  THREE: IThreeModule;
  GLTFExporter: IExporter;
}

let cachedThree: Promise<IThreeRuntime> | undefined;
let cachedIo: Promise<NodeIO> | undefined;

function installFileReaderPolyfill(): void {
  if (typeof globalThis.FileReader !== "undefined") return;
  class NodeFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    async readAsArrayBuffer(blob: Blob): Promise<void> {
      this.result = await blob.arrayBuffer();
      this.onloadend?.();
    }
  }
  Object.defineProperty(globalThis, "FileReader", {
    configurable: true,
    value: NodeFileReader,
    writable: true,
  });
}

async function getThree(): Promise<IThreeRuntime> {
  cachedThree ??= (async () => {
    installFileReaderPolyfill();
    const pkgJson = path.join(REPO_ROOT, "packages/procedural-environment/package.json");
    const req = createRequire(pkgJson);
    const threeUrl = pathToFileURL(req.resolve("three").replace(/three\.cjs$/u, "three.module.js"));
    const exporterUrl = pathToFileURL(req.resolve("three/addons/exporters/GLTFExporter.js"));
    const [THREE, exporterMod] = await Promise.all([
      import(threeUrl.href) as Promise<IThreeModule>,
      import(exporterUrl.href) as Promise<{ GLTFExporter: IExporter }>,
    ]);
    return { GLTFExporter: exporterMod.GLTFExporter, THREE };
  })();
  return await cachedThree;
}

async function getCompressorIo(): Promise<NodeIO> {
  cachedIo ??= (async () => {
    await MeshoptEncoder.ready;
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
    io.setLogger({ debug: () => {}, error: console.error, info: () => {}, warn: () => {} });
    return io;
  })();
  return await cachedIo;
}

/** Validates glTF 2.0 binary header, 25 MB limit, >= 1 mesh, and zero external buffer/image URIs. */
export function assertValidSelfContainedGlb(slug: string, bytes: Uint8Array): void {
  if (bytes.byteLength < 20)
    throw new Error(`${slug}: empty or truncated GLB (${bytes.byteLength} B)`);
  if (bytes.byteLength > PUBLIC_ASSET_MAX_BYTES) {
    throw new Error(`${slug}: GLB size ${bytes.byteLength} exceeds 25 MB limit`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a
  ) {
    throw new Error(`${slug}: invalid GLB header`);
  }
  const jsonLength = view.getUint32(12, true);
  const jsonText = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength));
  const gltf = JSON.parse(jsonText) as {
    meshes?: unknown[];
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
  };
  if ((gltf.meshes?.length ?? 0) === 0) throw new Error(`${slug}: GLB contains zero meshes`);
  for (const entry of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
    if (entry.uri !== undefined && !entry.uri.startsWith("data:")) {
      throw new Error(`${slug}: non-self-contained external URI "${entry.uri}"`);
    }
  }
}

export function slugForElement(kind: string, id: string): string {
  const prefix = `${kind.toLowerCase()}-`;
  const normalizedId = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const combined = normalizedId.startsWith(prefix) ? normalizedId : `${prefix}${normalizedId}`;
  const trimmed = combined.slice(0, 64).replace(/-+$/gu, "");
  if (!SLUG_RE.test(trimmed)) {
    throw new Error(`Invalid Asset Library slug "${trimmed}" from (${kind}, ${id})`);
  }
  return trimmed;
}

function buildPrompt(element: IRawCatalogElement): string {
  const head = [element.name, element.latin ? `(${element.latin})` : ""].filter(Boolean).join(" ");
  const metaParts: string[] = [];
  if (element.category) metaParts.push(element.category);
  metaParts.push(element.kind);
  if (element.biomes && element.biomes.length > 0) metaParts.push(element.biomes.join(", "));
  const tags = [...(element.styleTags ?? []), ...(element.settingTags ?? [])];
  if (tags.length > 0) metaParts.push(tags.join(", "));
  const full = `${head} (${metaParts.join("; ")})`;
  return full.slice(0, 600);
}

function buildTags(element: IRawCatalogElement): string {
  const rawTokens = [
    element.kind,
    ...(element.category ?? "").toLowerCase().split(/[^a-z0-9]+/u),
    ...(element.styleTags ?? []),
    ...(element.settingTags ?? []),
    ...(element.biomes ?? []),
    ...element.id.toLowerCase().split(/[^a-z0-9]+/u),
    "procedural",
    "asset-library",
  ];
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const token of rawTokens) {
    const clean = token.trim().toLowerCase();
    if (clean.length < 2 || seen.has(clean)) continue;
    const nextLength = length === 0 ? clean.length : length + 1 + clean.length;
    if (nextLength > 200) break;
    seen.add(clean);
    kept.push(clean);
    length = nextLength;
  }
  return kept.join(" ");
}

/** Returns deterministic descriptors for all bakeable and runtime elements in the Asset Library. */
export async function assetLibraryCatalog(): Promise<IAssetLibraryDescriptor[]> {
  const catalog = (await proceduralEnvironmentSource({ root: REPO_ROOT }).catalog()) as {
    elements: IRawCatalogElement[];
    kinds: Record<string, { runtime?: boolean }>;
  };
  const seen = new Set<string>();
  return catalog.elements.map((element) => {
    const slug = slugForElement(element.kind, element.id);
    if (seen.has(slug)) throw new Error(`Duplicate Asset Library slug "${slug}"`);
    seen.add(slug);
    const runtime = catalog.kinds[element.kind]?.runtime === true;
    return {
      biomes: element.biomes ?? [],
      id: element.id,
      kind: element.kind,
      license: ASSET_LIBRARY_LICENSE,
      name: element.name,
      prompt: buildPrompt(element),
      runtime,
      slug,
      tags: buildTags(element),
    };
  });
}

async function compressGlb(bytes: Uint8Array): Promise<Uint8Array> {
  const io = await getCompressorIo();
  const doc = await io.readBinary(bytes);
  await doc.transform(dedup(), quantize(), meshopt({ encoder: MeshoptEncoder }));
  return await io.writeBinary(doc);
}

const RUNTIME_KINDS = new Set(["stylized", "dungeon", "village", "toybox"]);

type UniformColorMap = Record<
  string,
  { value?: { clone: () => { lerp: (o: unknown, t: number) => unknown } } }
>;

interface IMaterialLike {
  name?: string;
  isMeshStandardMaterial?: boolean;
  onBeforeCompile?: unknown;
  uniforms?: UniformColorMap;
  color?: { clone: () => unknown };
  emissive?: { clone: () => unknown };
  emissiveIntensity?: number;
  side?: number;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  flatShading?: boolean;
  roughness?: number;
  metalness?: number;
}

function resolveMaterialColor(m: IMaterialLike, THREE: IThreeModule): unknown {
  if (m.color) return m.color.clone();
  const u = m.uniforms ?? {};
  const shallow = u.uShallow?.value;
  const deep = u.uDeep?.value;
  if (shallow && deep) return shallow.clone().lerp(deep, 0.5);
  const top = u.uTop?.value;
  const horizon = u.uHorizon?.value;
  if (top && horizon) return top.clone().lerp(horizon, 0.5);
  return (u.uColor?.value ?? top ?? u.uFoam?.value)?.clone() ?? new THREE.Color(0xcccccc);
}

function toStandardMaterial(
  m: IMaterialLike | undefined,
  hasColors: boolean,
  THREE: IThreeModule,
): unknown {
  if (!m) return new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: hasColors });
  if (m.isMeshStandardMaterial && m.onBeforeCompile === undefined) return m;
  return new THREE.MeshStandardMaterial({
    ...(m.name ? { name: m.name } : {}),
    color: resolveMaterialColor(m, THREE),
    depthWrite: m.depthWrite ?? true,
    emissive: m.emissive?.clone() ?? new THREE.Color(0x000000),
    emissiveIntensity: m.emissiveIntensity ?? 1,
    flatShading: Boolean(m.flatShading),
    metalness: m.metalness ?? 0,
    opacity: m.opacity ?? 1,
    roughness: m.roughness ?? 0.85,
    side: m.side ?? THREE.FrontSide,
    transparent: Boolean(m.transparent),
    vertexColors: hasColors,
  });
}

interface ISceneNodeLike {
  isPoints?: boolean;
  isLight?: boolean;
  isLine?: boolean;
  isMesh?: boolean;
  isInstancedMesh?: boolean;
  geometry?: {
    getAttribute?: (name: string) => unknown;
    deleteAttribute?: (name: string) => void;
  };
  material?: IMaterialLike | IMaterialLike[];
  removeFromParent: () => void;
  traverse: (cb: (node: ISceneNodeLike) => void) => void;
}

function sanitizeRuntimeGroup(root: ISceneNodeLike, THREE: IThreeModule): void {
  const nonMeshes: ISceneNodeLike[] = [];
  root.traverse((node) => {
    if (node.isPoints || node.isLight || node.isLine) nonMeshes.push(node);
  });
  for (const node of nonMeshes) node.removeFromParent();

  root.traverse((node) => {
    if (!node.isMesh && !node.isInstancedMesh) return;
    for (const attr of CUSTOM_SHADER_ATTRIBUTES) node.geometry?.deleteAttribute?.(attr);
    const hasColors = Boolean(node.geometry?.getAttribute?.("color"));
    const mat = node.material;
    node.material = Array.isArray(mat)
      ? (mat.map((item) => toStandardMaterial(item, hasColors, THREE)) as IMaterialLike[])
      : (toStandardMaterial(mat, hasColors, THREE) as IMaterialLike);
  });
}

async function exportRuntimeDescriptor(item: IAssetLibraryDescriptor): Promise<Uint8Array> {
  const { THREE, GLTFExporter } = await getThree();
  const { group } = createStylizedAsset(item.id, { seed: 1, variant: 0 });
  sanitizeRuntimeGroup(group as unknown as ISceneNodeLike, THREE);
  const raw = new Uint8Array(await new GLTFExporter().parseAsync(group, { binary: true }));
  return await compressGlb(raw);
}

async function runBakeDescriptor(
  item: IAssetLibraryDescriptor,
  out: string,
): Promise<IEnvironmentBake[]> {
  switch (item.kind) {
    case "tree":
    case "cover":
    case "debris":
      return await bakeVegetation({ lods: [0], out, preset: item.id, seed: 1 });
    case "rock":
      return await bakeRock({
        biome: item.biomes[0] ?? "hills",
        form: item.id,
        lods: [0],
        out,
        seed: 1,
      });
    case "city":
      return await bakeCity({ module: item.id, out, seed: 31082 });
    case "station":
      return await bakeStation({ module: item.id, out, seed: 1 });
    case "frontier":
      return await bakeFrontier({ module: item.id, out, seed: 1 });
    case "pickup":
      return await bakePickup({ module: item.id, out, seed: 1 });
    case "mechanism":
      return await bakeMechanism({ module: item.id, out, seed: 1 });
    case "rail":
      return await bakeRail({ module: item.id, out, seed: 1 });
    case "sports":
      return await bakeSports({ module: item.id, out, seed: 1 });
    case "logistics":
      return await bakeLogistics({ module: item.id, out, seed: 1 });
    case "workshop":
      return await bakeWorkshop({ module: item.id, out, seed: 1 });
    case "tavern":
      return await bakeTavern({ module: item.id, out, seed: 1 });
    default:
      throw new Error(`No baker registered for kind "${item.kind}" (${item.id})`);
  }
}

/** Bakes or exports a single Asset Library item to validated self-contained GLB bytes. */
export async function bakeDescriptorBytes(
  item: IAssetLibraryDescriptor,
  workDir?: string,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (item.runtime || RUNTIME_KINDS.has(item.kind)) {
    bytes = await exportRuntimeDescriptor(item);
  } else {
    const ownDir =
      workDir === undefined ? await mkdtemp(path.join(os.tmpdir(), "tn-lib-")) : undefined;
    const out = path.join(ownDir ?? workDir ?? os.tmpdir(), item.kind);
    try {
      const bakes = await runBakeDescriptor(item, out);
      const first = bakes[0];
      if (!first) throw new Error(`${item.slug}: bake returned no outputs`);
      const baked = new Uint8Array(await readFile(first.path));
      bytes = baked.byteLength > COMPRESS_THRESHOLD_BYTES ? await compressGlb(baked) : baked;
    } finally {
      if (ownDir !== undefined) await rm(ownDir, { force: true, recursive: true });
    }
  }
  assertValidSelfContainedGlb(item.slug, bytes);
  return bytes;
}

export interface IAssetLibrarySeedOptions {
  readonly only?: readonly string[];
}

/** Yields Asset Library seeds one at a time so batch dry-runs and uploads keep memory bounded. */
export async function* iterateAssetLibrarySeeds(
  options: IAssetLibrarySeedOptions = {},
): AsyncGenerator<{
  item: IAssetLibraryDescriptor;
  seed: ISeedEntry;
  index: number;
  total: number;
}> {
  const filter = options.only
    ? new Set(options.only.map((k) => k.trim().toLowerCase()))
    : undefined;
  const all = (await assetLibraryCatalog()).filter((item) => !filter || filter.has(item.kind));
  const workDir = await mkdtemp(path.join(os.tmpdir(), "tn-asset-library-seed-"));
  try {
    for (let i = 0; i < all.length; i += 1) {
      const item = all[i];
      if (!item) continue;
      const bytes = await bakeDescriptorBytes(item, workDir);
      yield {
        index: i + 1,
        item,
        seed: {
          bytes,
          license: item.license,
          prompt: item.prompt,
          slug: item.slug,
          tags: item.tags,
        },
        total: all.length,
      };
    }
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

/** Collects all selected Asset Library seeds into an array (prefer `iterateAssetLibrarySeeds` for full runs). */
export async function assetLibrarySeeds(
  options: IAssetLibrarySeedOptions = {},
): Promise<ISeedEntry[]> {
  const out: ISeedEntry[] = [];
  for await (const { seed } of iterateAssetLibrarySeeds(options)) out.push(seed);
  return out;
}
