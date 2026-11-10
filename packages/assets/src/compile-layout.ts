import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { IAssetRuntimeDecoderCapabilities } from "./budget.js";
import { parseBudget } from "./budget.js";
import {
  embeddedTexturesFor,
  nonEmptyString,
  parseModelLod,
  parseModelsConfig,
  parseTexturesConfig,
  validateTargets,
} from "./compile-config.js";
import { DEFAULT_OUTPUT, DEFAULT_SOURCE, isRecord } from "./compile-rows.js";
import type {
  IAssetCompileOptions,
  IAssetPass,
  ICompileLayout,
  IDirectoryScan,
} from "./compile-types.js";
import { ASSETS_CONFIG_KEYS } from "./config-keys.js";
import { parseAudioConfig } from "./passes/audio-config.js";
import { audioPass } from "./passes/audio.js";
import { blenderImportPass } from "./passes/blender-import.js";
import { createLightmapPass } from "./passes/lightmap.js";
import type { ILightmapPassOptions } from "./passes/lightmap.js";
import { modelPass } from "./passes/model.js";
import type { IModelPassOptions } from "./passes/model.js";
import { createSharedImageStore } from "./passes/shared-images.js";
import { texturePass, textureResizePass } from "./passes/texture.js";
import type { PassSpec } from "./worker-protocol.js";

export function resolveLayout(cwd: string, options: IAssetCompileOptions): ICompileLayout {
  const config: unknown = options.config ?? {};
  if (!isRecord(config)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets must be an object when declared.");
  }
  for (const key of Object.keys(config)) {
    // `assets.lod` is validated and resolved by the project config loader; this package accepts
    // it so the resolved config crosses the seam intact. Phase 2 consumes it for generation.
    if (!ASSETS_CONFIG_KEYS.includes(key)) {
      throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.${key} is not recognised.`);
    }
  }
  const source = options.source ?? config.source ?? DEFAULT_SOURCE;
  const exclude = config.exclude ?? [];
  if (
    !Array.isArray(exclude) ||
    exclude.some((glob) => typeof glob !== "string" || glob.trim() === "")
  ) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.exclude must be an array of non-empty glob strings.",
    );
  }
  const output = options.output ?? config.output ?? DEFAULT_OUTPUT;
  const sourceRoot = path.resolve(cwd, nonEmptyString(source, "assets.source"));
  const outputRoot = path.resolve(cwd, nonEmptyString(output, "assets.output"));
  const nested =
    sourceRoot === outputRoot ||
    sourceRoot.startsWith(`${outputRoot}${path.sep}`) ||
    outputRoot.startsWith(`${sourceRoot}${path.sep}`);
  if (nested) {
    throw new Error(
      `TN_ASSETS_OVERLAP: source '${sourceRoot}' and output '${outputRoot}' must be disjoint directories.`,
    );
  }
  // Mobile keeps the decoder-free policy until its packaged loaders are qualified.
  // Each pass declares its decoder dependency, so decoder-free model work survives.
  const runtimeDecoderCapabilities: IAssetRuntimeDecoderCapabilities = options.runtimeDecoders ?? {
    ktx2: options.platform !== "android" && options.platform !== "ios",
    meshopt: options.platform !== "android" && options.platform !== "ios",
  };
  const runtimeDecoderAvailable =
    runtimeDecoderCapabilities.ktx2 && runtimeDecoderCapabilities.meshopt;
  const mobileAstc = options.platform === "android" || options.platform === "ios";
  const audio = parseAudioConfig(config.audio);
  const configuredTextures = parseTexturesConfig(config.textures);
  const configuredModels = parseModelsConfig(config.models);
  // Absent means on with defaults (PRD-458 §4/AC-6): a game that streams a world gets foliage cutout
  // conversion, an automatic chain and a material merge without declaring anything. `false` /
  // `"none"` remain the absolute kill switch, and the legacy `models` declarations still translate
  // against the same policy, so an explicit `simplify` or `virtual: "none"` project is unaffected.
  const configuredLod = config.lod === undefined ? true : parseModelLod(config.lod);
  const nativePackage = config.nativePackage ?? false;
  if (typeof nativePackage !== "boolean") {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.nativePackage must be a boolean.");
  }
  const modelCompressionDecoders: readonly ("meshopt" | "KTX2")[] =
    configuredModels === undefined
      ? []
      : [
          (configuredModels.passes?.meshopt ?? true) ? "meshopt" : undefined,
          configuredModels.textures === "none" || mobileAstc ? undefined : "KTX2",
        ].filter((decoder): decoder is "meshopt" | "KTX2" => decoder !== undefined);
  const models =
    configuredModels === undefined
      ? undefined
      : {
          ...configuredModels,
          ...(runtimeDecoderCapabilities.meshopt
            ? {}
            : {
                passes: { ...(configuredModels.passes ?? {}), meshopt: false },
              }),
          ...embeddedTexturesFor(
            configuredModels.textures,
            runtimeDecoderCapabilities.ktx2,
            mobileAstc,
          ),
        };
  const textures =
    configuredTextures === undefined
      ? undefined
      : mobileAstc
        ? { ...configuredTextures, astc: true }
        : configuredTextures;
  const lightmap = (models as (IModelPassOptions & { lightmap?: ILightmapPassOptions }) | undefined)
    ?.lightmap;
  // The built-in registry runs only when the caller did not replace it wholesale; each
  // built-in pass drops out individually through its `"none"` shorthand. Its serialisable
  // mirror rides along so a bounded worker pool can rebuild the identical chain — custom
  // passes cannot cross a worker boundary, so a compile that supplies any runs sequential.
  const builtinPasses: IAssetPass[] = [];
  const passSpecs: PassSpec[] = [];
  const registerBuiltin = (pass: IAssetPass, spec: PassSpec): void => {
    if (
      spec.needsRuntimeDecoder === true &&
      !(spec.kind === "texture"
        ? runtimeDecoderCapabilities.ktx2
        : spec.kind === "model"
          ? (!(spec.options.passes?.meshopt ?? true) || runtimeDecoderCapabilities.meshopt) &&
            (spec.options.textures === "none" ||
              spec.options.textures?.decoderFree === true ||
              spec.options.textures?.astc === true ||
              runtimeDecoderCapabilities.ktx2)
          : runtimeDecoderAvailable)
    )
      return;
    builtinPasses.push(pass);
    passSpecs.push(spec);
  };
  if (options.passes === undefined) {
    if (audio !== undefined) {
      registerBuiltin(audioPass(audio), {
        kind: "audio",
        needsRuntimeDecoder: false,
        options: audio,
      });
    }
    if (textures !== undefined) {
      registerBuiltin(texturePass(textures), {
        kind: "texture",
        needsRuntimeDecoder: !mobileAstc,
        options: textures,
      });
    }
    if (
      textures !== undefined &&
      !runtimeDecoderCapabilities.ktx2 &&
      !mobileAstc &&
      textures.maxSize !== undefined
    ) {
      // The KTX2 pass dropped for this target, but the declared cap is still honoured: the
      // decoder-free resize pass needs no runtime decoder and runs in its place. The overrides
      // ride along so a `codec: "none"` glob keeps the authored bytes on this path too.
      const resize = { maxSize: textures.maxSize, overrides: textures.overrides };
      registerBuiltin(textureResizePass(resize), {
        kind: "texture-resize",
        needsRuntimeDecoder: false,
        options: resize,
      });
    }
    if (lightmap !== undefined) {
      registerBuiltin(createLightmapPass(lightmap, mobileAstc), {
        kind: "lightmap",
        ...(mobileAstc ? { astc: true } : {}),
        needsRuntimeDecoder: !mobileAstc,
        options: lightmap,
      });
    }
    // Ahead of `modelPass`: it converts the source into the GLB that pass then optimizes. A game
    // with no importable source pays one extension test per input.
    registerBuiltin(blenderImportPass(), {
      kind: "blender-import",
      needsRuntimeDecoder: false,
    });
    if (models !== undefined) {
      // Every native host uses WebGPU's stricter vertex-input path, including desktop where the
      // runtime does carry Meshopt. Keep the browser's interleaved default, but make every native
      // model pass emit separate attribute buffers before the packager's fail-closed preflight.
      const modelOptions =
        options.platform === undefined || options.platform === "web"
          ? models
          : { ...models, vertexLayout: "separate" as const };
      // `assets.lod` is top-level, not under `models`, but it drives the model pass. It rides in
      // the pass options (and its spec) so it is part of the compile cache key.
      const modelOptionsWithLod = {
        ...modelOptions,
        lod: configuredLod,
        ...(options.modelTranscoderBytes === undefined || modelOptions.textures === "none"
          ? {}
          : {
              textures: {
                ...(modelOptions.textures ?? {}),
                transcoderBytes: options.modelTranscoderBytes,
              },
            }),
      };
      const pass = modelPass({
        ...modelOptionsWithLod,
        preserveLightmapUv: lightmap !== undefined,
        // Bound to the output root so a second build finds last build's encodes on
        // disk instead of paying for them again.
        // The driver publishes every returned auxiliary output after journalling ownership.
        // The store still remembers within this pass chain and reads last build's public cache.
        sharedImages: models.sharedImages
          ? createSharedImageStore(outputRoot, { writeThrough: false })
          : undefined,
      });
      registerBuiltin(pass, {
        kind: "model",
        needsRuntimeDecoder: pass.needsRuntimeDecoder ?? false,
        options: {
          ...modelOptionsWithLod,
          preserveLightmapUv: lightmap !== undefined,
          sharedImages: modelOptions.sharedImages,
        },
      });
    }
  }
  const suppliedPasses = options.passes ?? [];
  const skippedPasses = suppliedPasses
    .filter((pass) => pass.needsRuntimeDecoder === true && !runtimeDecoderAvailable)
    .map((pass) => pass.name);
  const customPasses = suppliedPasses.filter(
    (pass) => pass.needsRuntimeDecoder !== true || runtimeDecoderAvailable,
  );
  return {
    builtinRegistry: options.passes === undefined,
    exclude,
    concurrency: config.concurrency as number | undefined,
    runtimeDecoderCapabilities,
    lod: configuredLod,
    lodLegacy: {
      simplify:
        typeof configuredModels === "object" &&
        configuredModels !== null &&
        configuredModels.simplify !== undefined,
      virtualNone:
        typeof configuredModels === "object" &&
        configuredModels !== null &&
        configuredModels.virtual === "none",
    },
    modelCompressionReason:
      options.passes !== undefined
        ? undefined
        : configuredModels === undefined
          ? "config"
          : modelCompressionDecoders.length === 0
            ? undefined
            : modelCompressionDecoders.every((decoder) =>
                  decoder === "KTX2"
                    ? runtimeDecoderCapabilities.ktx2
                    : runtimeDecoderCapabilities.meshopt,
                )
              ? undefined
              : "platform",
    modelCompressionDecoders,
    nativePackage,
    outputRoot,
    passSpecs,
    skippedPasses,
    passes: [...builtinPasses, ...customPasses],
    sourceRoot,
    targets: config.targets === undefined ? {} : validateTargets(config.targets),
    budget: parseBudget(config.budget),
    textureCompressionReason:
      options.passes !== undefined
        ? undefined
        : configuredTextures === undefined
          ? "config"
          : runtimeDecoderCapabilities.ktx2 || mobileAstc
            ? undefined
            : "platform",
    texturesActive:
      textures !== undefined &&
      options.passes === undefined &&
      runtimeDecoderCapabilities.ktx2 &&
      !mobileAstc,
  };
}

export async function scanDirectory(
  sourceRoot: string,
  directory: string,
): Promise<IDirectoryScan> {
  const entries = await readdir(path.join(sourceRoot, directory), { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  const files: string[] = [];
  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const logical = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      subdirectories.push(logical);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(
        `TN_ASSETS_INPUT_UNREADABLE: '${logical}' under '${sourceRoot}' is neither a file nor a directory.`,
      );
    }
    files.push(logical);
  }
  return { files, subdirectories };
}

export async function walkSources(sourceRoot: string): Promise<string[]> {
  const logicalPaths: string[] = [];
  const seenFiles = new Set<string>();
  const visitedDirectories = new Set<string>();
  const queue: string[] = [""];
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    const canonical = await realpath(path.join(sourceRoot, directory));
    if (visitedDirectories.has(canonical)) {
      throw new Error(
        `TN_ASSETS_DUPLICATE_LOGICAL_PATH: '${directory}' resolves to an already-visited directory; duplicate logical path under '${sourceRoot}'.`,
      );
    }
    visitedDirectories.add(canonical);
    const scanned = await scanDirectory(sourceRoot, directory);
    queue.push(...scanned.subdirectories);
    for (const logical of scanned.files) {
      if (seenFiles.has(logical)) {
        throw new Error(
          `TN_ASSETS_DUPLICATE_LOGICAL_PATH: '${logical}' was listed twice; duplicate logical path under '${sourceRoot}'.`,
        );
      }
      seenFiles.add(logical);
      logicalPaths.push(logical);
    }
  }
  return logicalPaths.sort();
}
