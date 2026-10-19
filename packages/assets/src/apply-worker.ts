import { parentPort } from "node:worker_threads";

import type { IAssetPass } from "./compile.js";
import { applyPasses } from "./pass-chain.js";
import { audioPass } from "./passes/audio.js";
import { blenderImportPass } from "./passes/blender-import.js";
import { createLightmapPass } from "./passes/lightmap.js";
import { modelPass } from "./passes/model.js";
import { createSharedImageStore } from "./passes/shared-images.js";
import { texturePass, textureResizePass } from "./passes/texture.js";
import type { IWorkerBootstrap, IWorkerJob, IWorkerReply, PassSpec } from "./worker-protocol.js";

/**
 * The worker entry for the bounded compile pool. It runs the same pass chain a sequential bake
 * runs (`applyPasses`, extracted verbatim), rebuilt from the driver's serialisable specs, and
 * reports per-pass timings back so the cost instrument stays driver-owned across the boundary.
 *
 * The chain is built once per worker from the bootstrap message; each job afterwards carries
 * only the input. A shared-image store is created here against the job's output root, so an
 * encoded image a worker produced is written into the same content-addressed tree a sequential
 * build writes — the same bytes, by the determinism gate.
 */

let passes: readonly IAssetPass[] | undefined;

function buildInstances(specs: readonly PassSpec[], root: string): readonly IAssetPass[] {
  return specs.map((spec) => {
    switch (spec.kind) {
      case "audio":
        return audioPass(spec.options);
      case "blender-import":
        return blenderImportPass();
      case "lightmap":
        return createLightmapPass(spec.options, spec.astc);
      case "model":
        return modelPass({
          ...spec.options,
          // The store is per-worker state against the same output root: content-addressed
          // writes make identical results idempotent, and the receipt's stable merge keeps
          // provenance arrival-independent.
          // Public emission stays driver-owned so a pass failure cannot leave an unjournalled
          // shared file behind. This store still deduplicates later jobs on the same worker and
          // reads outputs from successful earlier builds.
          sharedImages: spec.options.sharedImages
            ? createSharedImageStore(root, { writeThrough: false })
            : undefined,
        });
      case "texture":
        return texturePass(spec.options);
      case "texture-resize":
        return textureResizePass(spec.options);
    }
  });
}

const port = parentPort;
if (port === null) {
  throw new Error("TN_ASSETS_WORKER_ORPHAN: apply-worker started outside a worker thread.");
}

port.on("message", (message: IWorkerBootstrap | IWorkerJob) => {
  void (async () => {
    if ("specs" in message) {
      const bootstrap = message as IWorkerBootstrap;
      passes = buildInstances(bootstrap.specs, bootstrap.outputRoot);
      return;
    }
    const job = message as IWorkerJob;
    try {
      if (passes === undefined) {
        throw new Error("TN_ASSETS_WORKER_UNBOOTSTRAPPED: a job arrived before the pass specs.");
      }
      // Structured clone hands the job's input over as a plain view; the pass chain needs
      // Buffer semantics (subarray, equals), so the worker rewraps without copying.
      const input = Buffer.from(job.input.buffer, job.input.byteOffset, job.input.byteLength);
      const applied = await applyPasses(passes, input, job.logical);
      const reply: IWorkerReply = { applied, id: job.id };
      port.postMessage(reply);
    } catch (error) {
      const reply: IWorkerReply = {
        error: error instanceof Error ? error.message : String(error),
        id: job.id,
      };
      port.postMessage(reply);
    }
  })();
});
