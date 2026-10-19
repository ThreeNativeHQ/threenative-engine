import { availableParallelism, totalmem } from "node:os";
import { Worker } from "node:worker_threads";

import type { IAppliedPasses } from "./pass-chain.js";
import type { IWorkerReply, PassSpec, WorkerApplied } from "./worker-protocol.js";

/**
 * The bounded compile pool: worker threads running the built-in pass chain, one input per job.
 *
 * Bounded, never unbounded: the pool holds exactly `concurrency` workers, so a 6.8 GB pack
 * queues inputs through a fixed resident set instead of spawning a worker per asset. Every
 * merge the results feed — the manifest, the receipt, the cost rows — is keyed or
 * stable-merged, which is what the determinism gate proves; completion order must not be able
 * to move a byte.
 */

export interface IPassPool {
  /** Applies the pool's pass chain to one input. */
  run(logical: string, input: Buffer): Promise<IAppliedPasses>;
  /** Stops every worker. Idempotent; awaited so a caller can be sure nothing is left running. */
  dispose(): Promise<void>;
}

/** Resident memory one cook worker is budgeted: a 7 GB world pack measured ~1 GB per worker. */
const WORKER_MEMORY_BYTES = 2 * 1024 ** 3;
/** Past this, a bake is bound by disk and the encoder's own threads, not by more workers. */
const MAX_DEFAULT_CONCURRENCY = 12;

/**
 * The default bound: every core but one, as many as total memory affords at ~2 GB a worker, at
 * most 12. The old fixed ceiling of 4 turned a full world bake on a 24-core machine into a 70+
 * minute wait; a pack still queues through a fixed resident set, so a 6.8 GB pack cannot decide
 * the machine's fate on a small one either (8 cores / 16 GB -> 7 workers).
 */
export function defaultConcurrency(cores = availableParallelism(), memory = totalmem()): number {
  return Math.max(
    1,
    Math.min(cores - 1, Math.floor(memory / WORKER_MEMORY_BYTES), MAX_DEFAULT_CONCURRENCY),
  );
}

export const DEFAULT_CONCURRENCY = defaultConcurrency();

export function resolveConcurrency(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error(
      `TN_ASSETS_CONFIG_INVALID: assets.concurrency must be a positive integer; received ${String(requested)}.`,
    );
  }
  return requested;
}

/** structuredClone strips Buffer-ness across the boundary; these rehydrate the views. */
function toBuffer(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes as Buffer;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function rehydrate(applied: WorkerApplied): IAppliedPasses {
  return {
    auxiliaryOutputs: applied.auxiliaryOutputs.map((output) => ({
      ...output,
      buffer: toBuffer(output.buffer),
    })),
    buffer: toBuffer(applied.buffer),
    entry: applied.entry,
    extension: applied.extension,
    timings: applied.timings,
  };
}

export function createPassPool(
  concurrency: number,
  specs: readonly PassSpec[],
  outputRoot: string,
): IPassPool {
  // In src (tests, tsx) the worker enters through a plain-JS bridge that registers tsx and
  // imports the TypeScript chain; the built package points at the emitted neighbour file.
  const compiled = import.meta.url.endsWith(".js");
  const workerUrl = new URL(
    compiled ? "./apply-worker.js" : "./apply-worker-bridge.mjs",
    import.meta.url,
  );
  const bootstrap = { outputRoot, specs };
  const idle: Worker[] = [];
  const waiting: Array<{
    readonly input: Buffer;
    readonly logical: string;
    reject: (error: Error) => void;
    resolve: (reply: IWorkerReply) => void;
  }> = [];
  const pending = new Map<
    number,
    { owner: Worker; reject: (error: Error) => void; resolve: (reply: IWorkerReply) => void }
  >();
  const workers: Worker[] = [];
  let nextId = 0;
  let disposed = false;

  // Rejects only the job a worker owns, so one crash never fails a healthy worker's job.
  const settleOwned = (worker: Worker, error: Error): void => {
    for (const [id, waiter] of pending) {
      if (waiter.owner !== worker) continue;
      pending.delete(id);
      waiter.reject(error);
    }
  };

  const launch = (): Worker => {
    const worker = new Worker(workerUrl);
    workers.push(worker);
    worker.on("message", (reply: IWorkerReply) => {
      const waiter = pending.get(reply.id);
      if (waiter !== undefined) {
        pending.delete(reply.id);
        waiter.resolve(reply);
        idle.push(worker);
        dispatch();
      }
    });
    worker.on("error", (error) => settleOwned(worker, error));
    worker.on("exit", () => {
      const index = idle.indexOf(worker);
      if (index >= 0) idle.splice(index, 1);
      const workerIndex = workers.indexOf(worker);
      if (workerIndex >= 0) workers.splice(workerIndex, 1);
      // A worker that exits before it replies never answers its job. Settle that job here.
      settleOwned(
        worker,
        new Error("TN_ASSETS_POOL_WORKER_EXITED: a compile worker exited before it replied."),
      );
      dispatch();
    });
    worker.postMessage(bootstrap);
    idle.push(worker);
    return worker;
  };

  const dispatch = (): void => {
    // With no idle worker and room under the bound, replace a dead one so queued jobs still run.
    if (!disposed && idle.length === 0 && waiting.length > 0 && workers.length < concurrency) {
      launch();
    }
    while (idle.length > 0 && waiting.length > 0 && !disposed) {
      const job = waiting.shift();
      const worker = idle.pop();
      if (job === undefined || worker === undefined) return;
      const id = nextId;
      nextId += 1;
      pending.set(id, { owner: worker, reject: job.reject, resolve: job.resolve });
      worker.postMessage({ id, input: job.input, logical: job.logical });
    }
  };

  for (let index = 0; index < concurrency; index += 1) launch();

  return {
    run: (logical, input) =>
      new Promise((resolve, reject) => {
        if (disposed) {
          reject(new Error("TN_ASSETS_POOL_DISPOSED: the compile pool was stopped."));
          return;
        }
        waiting.push({
          input,
          logical,
          reject,
          resolve: (reply) => {
            if ("error" in reply) reject(new Error(reply.error));
            else resolve(rehydrate(reply.applied));
          },
        });
        dispatch();
      }),
    dispose: async () => {
      disposed = true;
      for (const job of waiting.splice(0)) {
        job.reject(
          new Error(
            "TN_ASSETS_POOL_DISPOSED: the compile pool was disposed before the job started.",
          ),
        );
      }
      for (const [, waiter] of pending) {
        waiter.reject(new Error("TN_ASSETS_POOL_DISPOSED: the compile pool was disposed mid-job."));
      }
      pending.clear();
      await Promise.all(workers.map((worker) => worker.terminate()));
      workers.length = 0;
      idle.length = 0;
    },
  };
}
