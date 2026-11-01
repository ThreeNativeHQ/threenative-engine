import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLENDER_SOURCE_EXTENSIONS,
  type BridgeResult,
  convertModel,
} from "@threenative/blender-bridge/bridge";
import type { IAssetPass, IAssetPassOutput } from "../compile.js";

/**
 * Turns a `.fbx`, `.blend`, `.obj` or `.dae` into a GLB before `modelPass` sees it, so a file an
 * agent downloaded compiles on `pnpm build` with no agent present.
 *
 * Before this pass, `compileAssets` classified those four extensions as `"other"`, copied them
 * through untouched, and reported success — the build shipped a file no runtime can load and said
 * nothing. That passthrough is deleted for these extensions.
 *
 * With no Blender the pass **fails the compile** and names the install command. An `.fbx` in the
 * assets directory is an explicit request; copying it through silently is the bug being removed,
 * and a warning is the same bug with better manners.
 *
 * It calls the same bridge module the `blender_convert` MCP tool calls. Two conversion
 * implementations would be two sets of counts to reconcile.
 */

export interface IBlenderImportOptions {
  /** Overrides the environment the bridge resolves Blender from; the compile's own by default. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** The pass's name, shared with the driver so the chain filter cannot drift from the pass. */
export const BLENDER_IMPORT_PASS = "blender-import";

const IMPORT_EXTENSIONS: ReadonlySet<string> = new Set(BLENDER_SOURCE_EXTENSIONS);

/**
 * Where this package's copy of the GPL Blender scripts lives.
 *
 * `dist/blender-gpl/` in a published install, written by `scripts/bundle-blender-gpl.mjs`; the
 * workspace `packages/blender-bridge/gpl/` when running from source. The bridge is inlined into this
 * package's bundle, so its own `import.meta.url` points here and cannot find them by itself — and
 * a `dependency` on the bridge package would make `@threenative/assets` uninstallable until that
 * package is published.
 */
function scriptsDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Built: `dist/index.js` sits beside `dist/blender-gpl/`.
    path.join(here, "blender-gpl"),
    // Source: `src/passes/` -> the workspace sibling.
    path.resolve(here, "..", "..", "..", "blender-bridge", "gpl"),
  ];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "convert.py")));
  if (found === undefined) {
    throw new Error(
      `TN_ASSETS_BLENDER_SCRIPTS_MISSING: no convert.py under ${candidates.join(" or ")}. This package's build copies them; run 'pnpm --filter @threenative/assets build'.`,
    );
  }
  return found;
}

/** Whether this logical path is a model the converter owns rather than one the runtime loads. */
export function needsBlenderImport(logicalPath: string): boolean {
  return IMPORT_EXTENSIONS.has(path.extname(logicalPath).slice(1).toLowerCase());
}

function messageFor(logicalPath: string, result: BridgeResult): string {
  if (result.ok) throw new Error("TN_ASSETS_BLENDER_IMPORT: called with a successful result.");
  const remedy =
    result.cause === "blender-missing" || result.cause === "blender-too-old"
      ? ` Install Blender and rebuild: ${result.installCommand}`
      : "";
  const stderr =
    result.stderr === undefined || result.stderr.trim().length === 0
      ? ""
      : `\n${result.stderr.trim().split("\n").slice(-12).join("\n")}`;
  return `TN_ASSETS_BLENDER_IMPORT_FAILED: '${logicalPath}' could not be converted to GLB (${result.cause}). ${result.detail}${remedy}${stderr}`;
}

export function blenderImportPass(options: IBlenderImportOptions = {}): IAssetPass {
  return {
    appliesTo: ["model"],
    configuration: { extensions: [...BLENDER_SOURCE_EXTENSIONS].sort() },
    name: BLENDER_IMPORT_PASS,
    async apply(input: Buffer, logicalPath: string): Promise<Buffer | IAssetPassOutput> {
      if (!needsBlenderImport(logicalPath)) return input;
      // Blender reads paths, not buffers, and the compile hands passes bytes. The staging
      // directory is this call's alone and is removed whether the conversion succeeds or not.
      const staging = await mkdtemp(path.join(tmpdir(), "tn-blender-import-"));
      const extension = path.extname(logicalPath).toLowerCase();
      const source = path.join(staging, `source${extension}`);
      const out = path.join(staging, "converted.glb");
      try {
        await writeFile(source, input);
        const result = await convertModel(source, out, {
          scriptsDirectory: scriptsDirectory(),
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        if (!result.ok) throw new Error(messageFor(logicalPath, result));
        const buffer = await readFile(out);
        if (buffer.length === 0) {
          throw new Error(
            `TN_ASSETS_BLENDER_IMPORT_EMPTY: '${logicalPath}' converted to a zero-byte GLB.`,
          );
        }
        return {
          buffer,
          // The manifest says a GLB was converted rather than authored, so a report can tell the
          // difference without re-reading the source tree.
          entry: { importedFrom: extension.slice(1) },
          outputExtension: ".glb",
        };
      } finally {
        await rm(staging, { force: true, recursive: true });
      }
    },
  };
}
