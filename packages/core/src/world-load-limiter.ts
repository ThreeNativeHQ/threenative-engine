import type { Object3D } from "three";
import type { IAdmissionBudget } from "./world-tiles.js";

interface IQueuedModelLoad {
  readonly run: () => Promise<Object3D>;
  readonly wanted: () => boolean;
  readonly resolve: (model: Object3D | undefined) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * One bounded lane for every model load a `WorldCells` starts. Assets and chunks share it, so the
 * number of `loadModel` calls in flight at once cannot grow with the number of admitted cells.
 * Queued loads keep admission order, which is nearest-cell first, and one whose cell left (or
 * whose asset was released) before its turn resolves `undefined` without touching the loader.
 */
export class ModelLoadLimiter {
  readonly #concurrency: number;
  readonly #queue: IQueuedModelLoad[] = [];
  #inFlight = 0;

  constructor(concurrency: number) {
    this.#concurrency = concurrency;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get queued(): number {
    return this.#queue.length;
  }

  load(run: () => Promise<Object3D>, wanted: () => boolean): Promise<Object3D | undefined> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ reject, resolve, run, wanted });
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#inFlight < this.#concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift() as IQueuedModelLoad;
      if (!job.wanted()) {
        job.resolve(undefined);
        continue;
      }
      this.#inFlight += 1;
      try {
        job.run().then(
          (model) => {
            this.#inFlight -= 1;
            job.resolve(model);
            this.#pump();
          },
          (error: unknown) => {
            this.#inFlight -= 1;
            job.reject(error);
            this.#pump();
          },
        );
      } catch (error) {
        // A loader that throws instead of rejecting must not strand its lane.
        this.#inFlight -= 1;
        job.reject(error);
        this.#pump();
      }
    }
  }
}

/**
 * One frame's admission allowance, shared by every path that puts streamed content on screen.
 *
 * A streaming world has no frame-time ceiling anywhere else: a cell row arriving builds a batch per
 * asset run over every placement in it, a terrain tile builds every LOD level, and the game's
 * `createCollider` runs for every resident tile — all in the one frame that discovers them. That is
 * the 100-330 ms hitch a 60 m/s camera feels every time the ring moves, and it is admission cost,
 * not streaming: the loads never fail.
 *
 * The budget is opened once per `update` and drawn down by the units it admits. A unit always
 * finishes, so a frame spends at most the limit plus the unit that crossed it, and the rest of the
 * backlog waits for the next frame rather than being dropped.
 */
export class AdmissionBudget implements IAdmissionBudget {
  readonly #limitMs: number;
  readonly #now: () => number;
  #spentMs = 0;

  constructor(limitMs: number, now: () => number) {
    this.#limitMs = limitMs;
    this.#now = now;
  }

  get spentMs(): number {
    return this.#spentMs;
  }

  admit(work: () => void): boolean {
    if (this.#spentMs >= this.#limitMs) return false;
    const startedAt = this.#now();
    work();
    this.#spentMs += this.#now() - startedAt;
    return true;
  }
}
