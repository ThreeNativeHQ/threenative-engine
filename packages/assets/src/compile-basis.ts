import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { type IBasisTranscoder, messageOf } from "./compile-types.js";

/** Folder name, inside the compiled assets, that holds the copied Basis transcoder files. */
export const BASIS_DIRECTORY = "basis";

/**
 * Resolves three's Basis transcoder through the project's own `three` install so a path that
 * moved between three versions fails the build here, as a named error, instead of 404ing at
 * runtime inside the KTX2 loader.
 */
export function resolveBasisTranscoder(cwd: string): IBasisTranscoder {
  try {
    const javascriptPath = createRequire(path.join(cwd, "package.json")).resolve(
      "three/examples/jsm/libs/basis/basis_transcoder.js",
    );
    return { javascriptPath, wasmPath: javascriptPath.replace(/\.js$/u, ".wasm") };
  } catch (error) {
    throw new Error(
      `TN_ASSETS_TRANSCODER_MISSING: could not resolve three's Basis transcoder from '${cwd}': ${messageOf(error)}. The runtime KTX2 loader needs it copied next to the compiled assets.`,
    );
  }
}

export async function copyBasisTranscoder(
  outputRoot: string,
  transcoder: IBasisTranscoder,
): Promise<void> {
  const target = path.join(outputRoot, BASIS_DIRECTORY);
  try {
    await mkdir(target, { recursive: true });
    await copyFile(transcoder.javascriptPath, path.join(target, "basis_transcoder.js"));
    await copyFile(transcoder.wasmPath, path.join(target, "basis_transcoder.wasm"));
  } catch (error) {
    throw new Error(
      `TN_ASSETS_TRANSCODER_MISSING: could not copy the Basis transcoder into '${target}': ${messageOf(error)}`,
    );
  }
}
