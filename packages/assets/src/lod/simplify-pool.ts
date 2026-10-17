import { Worker } from "node:worker_threads";
import type { MeshoptSimplifier } from "meshoptimizer";
import { defaultConcurrency } from "../worker-pool.js";

type SimplifyArgs = Parameters<typeof MeshoptSimplifier.simplifyWithAttributes>;
type SimplifyResult = ReturnType<typeof MeshoptSimplifier.simplifyWithAttributes>;
export type Simplify = (...args: SimplifyArgs) => Promise<SimplifyResult>;

/** Independent error targets use identical inputs; merge in target order, never arrival order. */
export function createSimplifyPool(targets: number): {
  simplify: Simplify;
  dispose: () => Promise<void>;
} {
  const workers = Array.from({ length: Math.min(targets, defaultConcurrency()) }, () => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
      import(workerData).then(async ({ MeshoptSimplifier }) => {
        await MeshoptSimplifier.ready;
        parentPort.on('message', (args) => {
          try {
            const result = MeshoptSimplifier.simplifyWithAttributes(...args);
            parentPort.postMessage({ result }, [result[0].buffer]);
          } catch (error) {
            parentPort.postMessage({ error: error.message });
          }
        });
      }).catch(error => { throw error; });`,
      { eval: true, workerData: import.meta.resolve("meshoptimizer/simplifier") },
    );
    let failure: Error | undefined;
    let rejectPending: ((error: Error) => void) | undefined;
    worker.on("error", (error) => {
      failure = error;
      rejectPending?.(error);
    });
    worker.on("exit", () => {
      failure ??= new Error("Terrain LOD worker exited before replying");
      rejectPending?.(failure);
    });
    let tail: Promise<unknown> = Promise.resolve();
    const run = (args: SimplifyArgs): Promise<SimplifyResult> => {
      const job = tail.then(
        () =>
          new Promise<SimplifyResult>((resolve, reject) => {
            if (failure) return reject(failure);
            const onMessage = (reply: { result?: SimplifyResult; error?: string }) => {
              rejectPending = undefined;
              if (reply.result) resolve(reply.result);
              else reject(new Error(reply.error ?? "Terrain LOD worker returned no result"));
            };
            rejectPending = (error) => {
              worker.off("message", onMessage);
              rejectPending = undefined;
              reject(error);
            };
            worker.once("message", onMessage);
            worker.postMessage(args);
          }),
      );
      tail = job.catch(() => {});
      return job;
    };
    return { worker, run };
  });
  const available = [...workers];
  const queued: {
    args: SimplifyArgs;
    resolve: (result: SimplifyResult) => void;
    reject: (error: Error) => void;
  }[] = [];
  let disposed = false;
  const dispatch = () => {
    while (available.length && queued.length) {
      const slot = available.shift();
      const job = queued.shift();
      if (!slot || !job) break;
      void slot
        .run(job.args)
        .then(job.resolve, job.reject)
        .finally(() => {
          if (disposed) return;
          available.push(slot);
          dispatch();
        });
    }
  };
  return {
    // Give the next target to a free worker; slow targets must not hold a private queue.
    simplify: (...args) =>
      new Promise<SimplifyResult>((resolve, reject) => {
        if (disposed) return reject(new Error("Terrain LOD worker exited before replying"));
        if (!workers.length) return reject(new Error("No terrain LOD workers"));
        queued.push({ args, resolve, reject });
        dispatch();
      }),
    dispose: async () => {
      disposed = true;
      for (const job of queued.splice(0))
        job.reject(new Error("Terrain LOD worker exited before replying"));
      await Promise.all(workers.map(({ worker }) => worker.terminate()));
    },
  };
}
