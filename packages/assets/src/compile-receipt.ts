import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MANIFEST_NAME,
  PENDING_RECEIPT_NAME,
  PIPELINE_VERSION,
  RECEIPT_NAME,
  isRecord,
} from "./compile-rows.js";
import { classify, messageOf } from "./compile-types.js";
import type {
  IAssetAuxiliaryOutput,
  IAssetManifest,
  IAssetManifestEntry,
  IBakeReceipt,
  IBakeReceiptOutput,
} from "./compile-types.js";
import { resolveLodPolicy } from "./lod/generate.js";
import type { IModelLodOptions } from "./lod/generate.js";
import {
  type INativePackageEntry,
  NATIVE_PACKAGE_NAME,
  NativeEntryKind,
  WGPU_TEXTURE_FORMAT_RGBA8_UNORM,
  writeNativePackage,
} from "./native-package.js";
import type { IPassTiming } from "./pass-chain.js";
import { decodeImageBytes } from "./passes/decode-image.js";
import { unpackGlb } from "./passes/shared-images.js";
import { parsePng } from "./png.js";
import type { IPassCostAssetRow, IPassCostRow, PassCostStatus } from "./report.js";

export function outputNameFor(logicalPath: string, digest: string, extension?: string): string {
  const sourceExtension = path.extname(logicalPath);
  const base = path.basename(logicalPath, sourceExtension);
  const directory = path.dirname(logicalPath);
  const name = `${base}.${digest}${extension ?? sourceExtension.toLowerCase()}`;
  return directory === "." ? name : `${directory}/${name}`;
}

export function sameTargets(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Refreshes an entry's `lod.runtime` from the current resolved policy before it is written.
 *
 * A compile cache hit reuses the whole previous entry without re-running the pass, which is correct
 * for geometry — a runtime-only edit must not rebake it — but would otherwise keep serving the old
 * pixel budget and hysteresis. Preset and runtime are policy, not bytes, so they are re-resolved
 * here for both the cache-hit and fresh paths (PRD-377 §3.2, §5).
 */
export function withFreshLodRuntime(
  entry: IAssetManifestEntry,
  logical: string,
  lod: boolean | IModelLodOptions | "none" | undefined,
  legacy: { readonly simplify: boolean; readonly virtualNone: boolean },
): IAssetManifestEntry {
  if (entry.lod === undefined || lod === undefined) return entry;
  const policy = resolveLodPolicy(lod, logical, legacy);
  return {
    ...entry,
    lod: { ...entry.lod, preset: policy.preset, runtime: { ...policy.runtime } },
  };
}

export function sameEntry(existing: IAssetManifestEntry, entry: IAssetManifestEntry): boolean {
  return (
    existing.output === entry.output &&
    existing.kind === entry.kind &&
    JSON.stringify(existing.audio) === JSON.stringify(entry.audio) &&
    existing.importedFrom === entry.importedFrom &&
    JSON.stringify(existing.lightmapAtlas) === JSON.stringify(entry.lightmapAtlas) &&
    JSON.stringify(existing.lightmaps) === JSON.stringify(entry.lightmaps) &&
    JSON.stringify(existing.embeddedTextures) === JSON.stringify(entry.embeddedTextures) &&
    JSON.stringify(existing.quality) === JSON.stringify(entry.quality) &&
    JSON.stringify(existing.simplify) === JSON.stringify(entry.simplify) &&
    JSON.stringify(existing.lod) === JSON.stringify(entry.lod) &&
    existing.bytes === entry.bytes &&
    existing.bytesBefore === entry.bytesBefore &&
    existing.bytesAfter === entry.bytesAfter &&
    existing.format === entry.format &&
    sameTargets(existing.transcodeTargets, entry.transcodeTargets) &&
    sameTargets(existing.extensions, entry.extensions) &&
    existing.triangles === entry.triangles &&
    existing.vertices === entry.vertices &&
    existing.passes.length === entry.passes.length &&
    existing.passes.every((name, index) => name === entry.passes[index])
  );
}

export interface IResolvedAuxiliaryOutput {
  readonly buffer: Buffer;
  readonly manifestField: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly output: string;
  /** Named by the pass and possibly referenced by several inputs. */
  readonly shared: boolean;
  /** The producer's own name for this output — `lightmap` for the lightmap pass's atlas. */
  readonly role: string;
}

export function resolveAuxiliaryOutputs(
  logical: string,
  outputs: readonly IAssetAuxiliaryOutput[],
): IResolvedAuxiliaryOutput[] {
  const sourceExtension = path.extname(logical);
  const stem = logical.slice(0, -sourceExtension.length);
  return outputs.map((auxiliary) => {
    const digest = createHash("sha256").update(auxiliary.buffer).digest("hex").slice(0, 8);
    const output =
      auxiliary.outputPath ??
      outputNameFor(`${stem}.${auxiliary.role}${auxiliary.extension}`, digest, auxiliary.extension);
    if (path.win32.isAbsolute(output) || output.split(/[\\/]/u).includes("..")) {
      throw new Error(
        `TN_ASSETS_OUTPUT_INVALID: auxiliary output '${output}' must stay relative to assets.output.`,
      );
    }
    return {
      buffer: auxiliary.buffer,
      manifestField: auxiliary.manifestField,
      metadata: {
        ...(auxiliary.metadata ?? {}),
        bytes: auxiliary.buffer.length,
        output,
      },
      output,
      role: auxiliary.role,
      shared: auxiliary.outputPath !== undefined,
    };
  });
}

export function auxiliaryManifestFields(
  outputs: readonly IResolvedAuxiliaryOutput[],
): Record<string, readonly Readonly<Record<string, unknown>>[]> {
  const fields: Record<string, Readonly<Record<string, unknown>>[]> = {};
  for (const output of outputs) {
    const field = fields[output.manifestField] ?? [];
    field.push(output.metadata);
    fields[output.manifestField] = field;
  }
  return fields;
}

/**
 * The files a manifest entry declares beyond its own output: every array field whose records
 * carry an `output` path (lightmaps, shared images), as the receipt records them.
 */
export function declaredAuxiliaryOutputs(
  entry: IAssetManifestEntry,
): { readonly bytes: number; readonly path: string; readonly producer: string }[] {
  const outputs: { bytes: number; path: string; producer: string }[] = [];
  for (const [field, value] of Object.entries(entry)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isRecord(item) || typeof item.output !== "string") continue;
      outputs.push({
        bytes: typeof item.bytes === "number" ? item.bytes : 0,
        path: item.output,
        producer: field === "lightmaps" ? "lightmap" : field === "sharedImages" ? "image" : field,
      });
    }
  }
  return outputs;
}

/** Compression declarations a decoder-free target must retain when it passes a GLB through. */
export function sourceModelExtensions(
  logicalPath: string,
  input: Buffer,
): readonly string[] | undefined {
  if (classify(logicalPath) !== "model" || path.extname(logicalPath).toLowerCase() !== ".glb")
    return undefined;
  try {
    const extensions = unpackGlb(input).json.extensionsUsed;
    return Array.isArray(extensions)
      ? extensions.filter((extension): extension is string => typeof extension === "string")
      : undefined;
  } catch {
    // The health reader owns the actionable malformed-model error. This helper only preserves
    // declarations from a readable pass-through GLB for the native compatibility backstop.
    return undefined;
  }
}

/**
 * The previous entry, when it is exactly what this build would produce and every file it
 * declares still exists — or `undefined`, in which case the passes run.
 */
export async function reusableEntry(
  outputRoot: string,
  logical: string,
  digest: string,
  existing: IAssetManifestEntry,
): Promise<
  { readonly bytes: number; readonly path: string; readonly producer: string }[] | undefined
> {
  const expected = outputNameFor(logical, digest, path.extname(existing.output));
  if (existing.output !== expected) return undefined;
  const auxiliary = declaredAuxiliaryOutputs(existing);
  const present = await Promise.all(
    [existing.output, ...auxiliary.map((output) => output.path)].map((relative) =>
      outputExists(path.join(outputRoot, relative)),
    ),
  );
  return present.every(Boolean) ? auxiliary : undefined;
}

/** The paths the previous bake's receipt declared, or none when there is no readable receipt. */
export async function readPreviousReceiptPaths(receiptPath: string): Promise<ReadonlySet<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.outputs)) return new Set();
    return new Set(
      parsed.outputs.flatMap((output) =>
        isRecord(output) && typeof output.path === "string" ? [output.path] : [],
      ),
    );
  } catch {
    return new Set();
  }
}

/** Resolve and validate every stale receipt target before any output is deleted or published. */
export async function resolveStaleReceiptOutputs(
  outputRoot: string,
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
): Promise<readonly string[]> {
  if (previous.size === 0) return [];
  const root = path.resolve(outputRoot);
  const realRoot = await realpath(root);
  const stale: string[] = [];
  for (const relative of previous) {
    if (current.has(relative)) continue;
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`TN_ASSETS_RECEIPT_INVALID: output '${relative}' is outside assets.output.`);
    }
    if (!(await outputExists(target))) continue;
    const actual = await realpath(target);
    if (!actual.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`TN_ASSETS_RECEIPT_INVALID: output '${relative}' escapes assets.output.`);
    }
    stale.push(target);
  }
  return stale;
}

/** Remove only files an earlier receipt/journal owned and the completed recook no longer owns. */
export async function removeStaleReceiptOutputs(
  outputRoot: string,
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
): Promise<void> {
  for (const target of await resolveStaleReceiptOutputs(outputRoot, previous, current))
    await rm(target, { force: true });
}

export async function writePendingOwnership(
  outputRoot: string,
  paths: ReadonlySet<string>,
): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    path.join(outputRoot, PENDING_RECEIPT_NAME),
    `${JSON.stringify({ outputs: [...paths].sort().map((outputPath) => ({ path: outputPath })) }, null, 2)}\n`,
    "utf8",
  );
}

export async function readExistingManifest(
  manifestPath: string,
): Promise<{ entries: Record<string, IAssetManifestEntry>; raw: string | undefined }> {
  let raw: string | undefined;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return { entries: {}, raw: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `TN_ASSETS_MANIFEST_INVALID: '${manifestPath}' is not valid JSON: ${messageOf(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) {
    throw new Error(`TN_ASSETS_MANIFEST_INVALID: '${manifestPath}' must hold version 1 entries.`);
  }
  return { entries: parsed.entries as Record<string, IAssetManifestEntry>, raw };
}

/**
 * A missing source directory is the documented pre-pipeline state — projects built before this
 * step existed have none — so it skips compilation instead of failing their builds. A path that
 * exists but is not a directory is malformed input and still throws.
 */
export async function hasSourceDirectory(sourceRoot: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(sourceRoot);
  } catch {
    return false;
  }
  if (!info.isDirectory()) {
    throw new Error(`TN_ASSETS_SOURCE_INVALID: asset source '${sourceRoot}' is not a directory.`);
  }
  return true;
}

export async function outputExists(outputAbsolute: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(outputAbsolute);
  } catch {
    return false;
  }
  return info.isFile();
}

export async function readInput(sourceRoot: string, logical: string): Promise<Buffer> {
  try {
    return await readFile(path.join(sourceRoot, logical));
  } catch (error) {
    throw new Error(
      `TN_ASSETS_INPUT_UNREADABLE: could not read '${logical}' under '${sourceRoot}': ${messageOf(error)}`,
    );
  }
}

/** The per-pass cost bookkeeping one bake accumulates, keyed in registry order. */
export interface IPassCostRecord {
  cachedInputs: number;
  ranInputs: number;
  timings: IPassCostAssetRow[];
}

/** Counts one compile-cache-served input for every pass: the cache decision is the source. */
export function recordCachedInputs(
  costInputs: Map<string, IPassCostRecord>,
  passNames: readonly string[],
): void {
  for (const name of passNames) {
    const record = costInputs.get(name);
    if (record !== undefined) record.cachedInputs += 1;
  }
}

export function recordRanTimings(
  costInputs: Map<string, IPassCostRecord>,
  logical: string,
  timings: readonly IPassTiming[],
): void {
  for (const timing of timings) {
    const record = costInputs.get(timing.name);
    if (record === undefined) continue;
    record.ranInputs += 1;
    record.timings.push({ durationMs: timing.durationMs, logicalPath: logical });
  }
}

/** Fails closed: every pass must account for every input, ran or cached, or nothing is emitted. */
export function assertCompletePassCosts(
  costInputs: ReadonlyMap<string, IPassCostRecord>,
  inputsForPass: (pass: string) => number,
): void {
  for (const [pass, record] of costInputs) {
    const inputCount = inputsForPass(pass);
    if (record.ranInputs + record.cachedInputs !== inputCount) {
      throw new Error(
        `TN_ASSETS_PASS_COST_INCOMPLETE: pass '${pass}' accounts for ${record.ranInputs} ran + ${record.cachedInputs} cached of ${inputCount} input(s); refusing to emit a cost report with a hole in it.`,
      );
    }
  }
}

/** Rows in registry order; per-asset rows sorted by logical path so two bakes diff cleanly. */
export function buildPassCostRows(
  costInputs: ReadonlyMap<string, IPassCostRecord>,
): readonly IPassCostRow[] {
  const rows: IPassCostRow[] = [];
  for (const [pass, record] of costInputs) {
    const status: PassCostStatus = record.ranInputs > 0 ? "ran" : "cached";
    rows.push({
      assets: [...record.timings].sort((left, right) =>
        left.logicalPath < right.logicalPath ? -1 : 1,
      ),
      cachedInputs: record.cachedInputs,
      durationMs: record.timings.reduce((total, timing) => total + timing.durationMs, 0),
      pass,
      ranInputs: record.ranInputs,
      status,
    });
  }
  return rows;
}

export async function writeOutput(
  outputRoot: string,
  entry: IAssetManifestEntry,
  buffer: Buffer,
): Promise<void> {
  const outputAbsolute = path.join(outputRoot, entry.output);
  await mkdir(path.dirname(outputAbsolute), { recursive: true });
  await writeFile(outputAbsolute, buffer);
}

/** A decoded PNG, JPEG or WebP as a TNPK v1 Texture entry, or undefined for any other container. */
export async function nativeTextureEntry(
  name: string,
  data: Buffer,
): Promise<INativePackageEntry | undefined> {
  // PNG, JPEG or WebP: decoded here to RGBA8. KTX2 and other containers need a runtime transcoder.
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp =
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP";
  if (!jpeg && !webp && parsePng(data) === undefined) return undefined;
  const image = await decodeImageBytes(data, name);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(image.width, 0);
  header.writeUInt32LE(image.height, 4);
  // WGPU_TEXTURE_FORMAT_RGBA8_UNORM, not _SRGB: the standalone texture pipeline decides
  // colour versus data only for codec choice (the `*_normal`/`*_nrm` basename convention in
  // passes/texture.ts) and records no colour space on the cooked PNG. Treating every other
  // PNG as sRGB would be a guess — masks, roughness, metallic and AO maps are data too — so
  // the writer keeps the format the header states and the C++ loader accepts (package.h v1).
  // sRGB ships once a pass records a colour space this can read.
  header.writeUInt32LE(WGPU_TEXTURE_FORMAT_RGBA8_UNORM, 8);
  return {
    data: Buffer.concat([header, Buffer.from(image.data)]),
    kind: NativeEntryKind.Texture,
    name,
    uploadSize: image.width * image.height * 4,
  };
}

/** Editor and VCS leftovers, by basename: the packaging selector's rule 1 (asset-manifest.mjs). */
export function isLeftover(relative: string): boolean {
  const name = path.posix.basename(relative);
  return (
    [".DS_Store", "Thumbs.db", ".gitkeep"].includes(name) ||
    [".orig", ".rej", ".bak", ".swp", "~"].some((suffix) => name.endsWith(suffix))
  );
}

/**
 * Gathers the native package's entries from the files already on disk.
 *
 * Cooked outputs enter under their logical path: one Buffer entry per cooked binary buffer
 * (audio/other), as CPU data at its exact length, and one Texture entry per cooked PNG, JPEG or WebP,
 * decoded to RGBA8, and one Scene entry per cooked model. A KTX2 texture is not a v1 entry.
 *
 * Every other file in the output root (the web root) enters under its web URL, `/` plus its path
 * there, because that is the URL a game requests it by on the web (`/assets/sky.hdr` is served
 * from `public/assets/sky.hdr`). PNG, JPEG and WebP become Texture entries, a binary glTF a Scene entry,
 * anything else a CPU Buffer. Cook outputs (this bake's or a previous one's), the manifest, the
 * receipts, the package itself and editor leftovers are not web-root files. An empty file is left
 * out and counted, never silently padded.
 */
export async function nativePackageEntries(
  outputRoot: string,
  entries: Readonly<Record<string, IAssetManifestEntry>>,
  cookOutputs: ReadonlySet<string>,
): Promise<{ entries: INativePackageEntry[]; skipped: number }> {
  const specs: INativePackageEntry[] = [];
  const shared = new Set<string>();
  let skipped = 0;
  for (const logical of Object.keys(entries).sort()) {
    const entry = entries[logical];
    if (entry === undefined) continue;
    const data = await readFile(path.join(outputRoot, entry.output));
    if (entry.kind === "model") {
      // The GLB bytes the native glTF loader reads; it refuses by name any extension it cannot decode.
      specs.push({ data, kind: NativeEntryKind.Scene, name: logical, uploadSize: 0 });
      // The images it names by uri sit beside it as raw bytes, which the loader decodes: the model
      // is a root file, so the uri is the entry name.
      for (const image of declaredAuxiliaryOutputs(entry))
        if (image.producer === "image" && !shared.has(image.path)) {
          shared.add(image.path);
          const bytes = await readFile(path.join(outputRoot, image.path));
          specs.push({
            data: bytes,
            kind: NativeEntryKind.Buffer,
            name: image.path,
            uploadSize: 0,
          });
        }
      continue;
    }
    const texture = entry.kind === "texture" ? await nativeTextureEntry(logical, data) : undefined;
    if (texture !== undefined) specs.push(texture);
    else if (entry.kind === "texture" || data.length === 0) skipped += 1;
    // Every Buffer the cook writes is CPU data a decoder reads (audio, an HDRLoader's .hdr, raw
    // bytes): uploadSize 0 says so, and it keeps its exact length. Only GPU buffers are aligned.
    else specs.push({ data, kind: NativeEntryKind.Buffer, name: logical, uploadSize: 0 });
  }
  const bookkeeping = new Set([
    MANIFEST_NAME,
    RECEIPT_NAME,
    PENDING_RECEIPT_NAME,
    NATIVE_PACKAGE_NAME,
  ]);
  for (const relative of (await walkOutputFiles(outputRoot)).sort()) {
    if (bookkeeping.has(relative) || cookOutputs.has(relative) || isLeftover(relative)) continue;
    const data = await readFile(path.join(outputRoot, relative));
    const name = `/${relative}`;
    // An empty web-root file stays: the web serves it as 0 bytes and the game fetches it (a world with no placements).
    const texture = data.length === 0 ? undefined : await nativeTextureEntry(name, data);
    const scene = data.length >= 4 && data.toString("latin1", 0, 4) === "glTF";
    specs.push(
      texture ?? {
        data,
        kind: scene ? NativeEntryKind.Scene : NativeEntryKind.Buffer,
        name,
        uploadSize: 0,
      },
    );
  }
  specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: specs, skipped };
}

/**
 * Writes `native/assets.tnpk` from the cook and the web root, and returns its receipt row; with no
 * v1 entry it removes a package an earlier run left there and returns undefined.
 */
export async function writeNativePackageOutput(
  outputRoot: string,
  entries: Readonly<Record<string, IAssetManifestEntry>>,
  cookOutputs: ReadonlySet<string>,
): Promise<IBakeReceiptOutput | undefined> {
  const native = await nativePackageEntries(outputRoot, entries, cookOutputs);
  const nativeAbsolute = path.join(outputRoot, NATIVE_PACKAGE_NAME);
  if (native.entries.length === 0) {
    // The bake owns this fixed path whenever the option is on. A package left by an earlier
    // run whose receipt is gone is pruned here, the way the empty-source branch removes its
    // stale manifest, rather than left to haunt a rebuilt project.
    await rm(nativeAbsolute, { force: true });
    console.log(
      "TN_ASSETS_NATIVE_PACKAGE_EMPTY: assets.nativePackage is on but no cooked output or web-root file is in scope for a v1 entry.",
    );
    return undefined;
  }
  const nativeBytes = writeNativePackage(native.entries);
  await mkdir(path.dirname(nativeAbsolute), { recursive: true });
  const existing = await readFile(nativeAbsolute).catch(() => undefined);
  if (existing === undefined || !Buffer.from(existing).equals(nativeBytes)) {
    await writeFile(nativeAbsolute, nativeBytes);
  }
  if (native.skipped > 0) {
    console.log(
      `TN_ASSETS_NATIVE_PACKAGE_SKIPPED: ${String(native.skipped)} file(s) are not a legal TNPK v1 entry (a KTX2 texture or an empty file) and are left out.`,
    );
  }
  console.log(
    `TN_ASSETS_NATIVE_PACKAGE: ${String(native.entries.length)} entry(ies), ${String(nativeBytes.length)} bytes at ${NATIVE_PACKAGE_NAME}.`,
  );
  return {
    bytes: nativeBytes.length,
    path: NATIVE_PACKAGE_NAME,
    producer: "native-package",
    source: null,
  };
}

export async function writeManifest(
  manifestPath: string,
  outputRoot: string,
  raw: string | undefined,
  entries: Record<string, IAssetManifestEntry>,
): Promise<void> {
  const manifest: IAssetManifest = { version: 1, entries: {} };
  for (const logical of Object.keys(entries).sort()) {
    const entry = entries[logical];
    if (entry !== undefined) manifest.entries[logical] = entry;
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (serialized === raw) return;
  await mkdir(outputRoot, { recursive: true });
  const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Every file under `root`, as paths relative to it with `/` separators on every platform. */
export async function walkOutputFiles(root: string, prefix = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walkOutputFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

/**
 * Fails the build when this run created a file under the output root that no pass declared.
 *
 * Without this, a pass that writes a file it does not report is invisible: the delete-test would
 * delete less than the bake produced, the second run would still find the undeleted file, and the
 * gate would pass while proving nothing. New paths are checked regardless of their timestamps;
 * existing paths are checked when touched during this run. An untouched hand-authored
 * `public/icon.png` is not a bake output and is left alone.
 */
export async function assertNoUndeclaredOutputs(
  outputRoot: string,
  declared: ReadonlySet<string>,
  since: number,
  writtenBefore: ReadonlySet<string>,
  existingBefore: ReadonlySet<string>,
): Promise<void> {
  const undeclared: string[] = [];
  for (const relative of await walkOutputFiles(outputRoot)) {
    if (
      relative === MANIFEST_NAME ||
      relative === RECEIPT_NAME ||
      relative === PENDING_RECEIPT_NAME
    )
      continue;
    if (declared.has(relative)) continue;
    // A file the previous receipt lists was written by an earlier bake, however close its mtime
    // is to this run's start: with the cache skipping unchanged inputs, two bakes can be one
    // millisecond apart, and the previous bake's now-stale output is not this bake's leak.
    if (writtenBefore.has(relative)) continue;
    const info = await stat(path.join(outputRoot, relative));
    if (!existingBefore.has(relative) || info.mtimeMs + 1 >= since) undeclared.push(relative);
  }
  if (undeclared.length > 0) {
    throw new Error(
      `TN_ASSETS_UNDECLARED_OUTPUT: this bake wrote ${undeclared.length} file(s) under '${outputRoot}' that no pass declared, so the delete-test cannot remove them: ${undeclared.sort().join(", ")}`,
    );
  }
}

/**
 * Writes the receipt, sorted by path so two builds of the same inputs are byte-identical.
 *
 * Throws rather than writing an empty list: a bake that produced nothing and said so in a green
 * receipt is exactly the shape of the v1 harness failure this repository already paid for — a
 * gate that reports success over an empty set.
 */
export async function writeReceipt(
  outputRoot: string,
  outputs: readonly IBakeReceiptOutput[],
): Promise<IBakeReceipt> {
  if (outputs.length === 0) {
    throw new Error(
      `TN_ASSETS_EMPTY_RECEIPT: the compile step produced no outputs for '${outputRoot}', so there is nothing a delete-test could remove.`,
    );
  }
  const seen = new Map<string, IBakeReceiptOutput>();
  for (const output of outputs) {
    // Several inputs can declare one shared output (an image two models embed). The survivor is
    // chosen by the lexicographically smallest source, not by arrival: under a scheduler whose
    // completion order is not input order, a last-writer-wins merge would make the receipt's
    // provenance depend on which worker finished first. The path, bytes and producer are
    // identical across the contenders; only this tie-break needs a stable rule.
    const existing = seen.get(output.path);
    if (existing === undefined || (output.source ?? "") < (existing.source ?? "")) {
      seen.set(output.path, output);
    }
  }
  const receipt: IBakeReceipt = {
    outputs: [...seen.values()].sort((left, right) => (left.path < right.path ? -1 : 1)),
    pipelineVersion: PIPELINE_VERSION,
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    path.join(outputRoot, RECEIPT_NAME),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return receipt;
}
