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
      { eval: true, workerData: import.meta.resolve("meshoptimizer") },
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
  let next = 0;
  return {
    simplify: (...args) => {
      const slot = workers[next % workers.length];
      next++;
      return slot ? slot.run(args) : Promise.reject(new Error("No terrain LOD workers"));
    },
    dispose: async () => {
      await Promise.all(workers.map(({ worker }) => worker.terminate()));
    },
  };
}
