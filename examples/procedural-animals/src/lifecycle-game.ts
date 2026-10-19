import { Scene, counterDeviceOf, defineGame } from "@threenative/core";
import type { ICtx, IGamePluginRuntime, SceneFrame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { type IAnimalBake, loadAnimalBake } from "@threenative/procedural-animals";
import { releaseAll } from "./cleanup.js";
import { observeGPUResources } from "./gpu-resources.js";
import { takeLifecycleCensus } from "./lifecycle-census.js";
import { runAnimalLifetimes } from "./lifecycle-driver.js";
import { createLifecycleGeneration } from "./lifecycle-generation.js";
import { course } from "./render/course.js";

interface ILifetimeState extends Record<string, unknown> {
  cycles: number;
  done: boolean;
  error: string | null;
}
type Context = ICtx<ILifetimeState, IPhysicsContext>;
interface IObservation {
  readonly capture: NonNullable<IGamePluginRuntime["geometryCapture"]>;
  readonly gpu: ReturnType<typeof observeGPUResources>;
  readonly observerInstalledGPU: ReturnType<ReturnType<typeof observeGPUResources>["snapshot"]>;
  readonly acknowledge: () => Promise<void>;
}
let observation: IObservation | undefined;

class Lifetimes extends Scene<ILifetimeState, IPhysicsContext> {
  static override readonly initialState: ILifetimeState = { cycles: 0, done: false, error: null };
  #abort = new AbortController();
  #cleanup: (() => void)[] = [];
  #bake: IAnimalBake | undefined;
  #generation: ReturnType<typeof createLifecycleGeneration> | undefined;
  override async load(ctx: Context) {
    this.#abort = new AbortController();
    this.#bake = await loadAnimalBake(ctx.assets, "wolf-crowd.animal", {
      signal: this.#abort.signal,
    });
  }
  override enter(ctx: Context): SceneFrame<ILifetimeState, IPhysicsContext> {
    const bake = this.#bake;
    const observer = observation;
    if (!bake || !observer) throw new Error("TN_ANIMAL_LIFECYCLE_UNAVAILABLE");
    try {
      this.#cleanup.push(course(ctx, true));
      const waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
      this.#cleanup.push(
        ctx.afterPhysics(() => {
          for (const waiter of waiters) waiter.resolve();
          waiters.clear();
        }),
      );
      const aborted = () => {
        for (const waiter of waiters) waiter.reject(new Error("TN_ANIMAL_LIFECYCLE_ABORTED"));
        waiters.clear();
      };
      this.#abort.signal.addEventListener("abort", aborted, { once: true });
      this.#cleanup.push(() => this.#abort.signal.removeEventListener("abort", aborted));
      let started = false;
      const start = () => {
        void ctx.startup
          .whenReady()
          .then(async () => {
            if (this.#abort.signal.aborted) return;
            const cycles = await runAnimalLifetimes({
              signal: this.#abort.signal,
              observerInstalledGPU: observer.observerInstalledGPU,
              capture: async () => {
                // At least one real solved fixed step follows resume/disposal before inspection.
                await new Promise<void>((resolve, reject) => {
                  if (this.#abort.signal.aborted) reject(new Error("TN_ANIMAL_LIFECYCLE_ABORTED"));
                  else waiters.add({ resolve, reject });
                });
                const report = await observer.capture({ limit: 500 });
                const sample = takeLifecycleCensus(ctx, observer.gpu.snapshot(), report);
                await observer.acknowledge(); // Asynchronous queue completion, no synchronous readback.
                return sample;
              },
              create: (cycle) => {
                this.#generation = createLifecycleGeneration(ctx, bake, cycle);
                return this.#generation;
              },
              record: (row) => {
                console.log(`TN_ANIMAL_LIFECYCLE ${JSON.stringify(row)}`);
                if ("cycle" in row && typeof row.cycle === "number") {
                  ctx.state.set({ cycles: row.cycle });
                  this.#generation = undefined;
                }
              },
            });
            if (!this.#abort.signal.aborted) ctx.state.set({ cycles, done: true });
          })
          .catch((error: unknown) => {
            if (this.#abort.signal.aborted) return;
            ctx.state.set({ error: String(error) });
            console.error(error);
            this.#abort.abort();
          });
      };
      return (_ctx, dt) => {
        if (!started && ctx.startup.phase === "ready" && ctx.input.justPressed("lifetimes")) {
          started = true;
          start();
        }
        if (this.#generation?.ownership().actors) this.#generation.update(dt);
      };
    } catch (error) {
      try {
        this.exit();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "TN_ANIMAL_LIFECYCLE_ENTER_FAILED");
      }
      throw error;
    }
  }
  override exit() {
    releaseAll([
      () => this.#abort.abort(),
      () => this.#generation?.dispose(),
      ...this.#cleanup.splice(0).reverse(),
    ]);
  }
}

export default defineGame<ILifetimeState, IPhysicsContext>({
  assets: { basePath: "" },
  input: { lifetimes: { keys: ["KeyL"] } },
  plugins: [
    rapier(),
    playtest(),
    {
      setup(ctx, runtime) {
        if (!runtime?.geometryCapture) throw new Error("TN_ANIMAL_LIFECYCLE_CAPTURE_UNAVAILABLE");
        const device = counterDeviceOf(ctx.renderer.raw);
        if (typeof device !== "object" || device === null)
          throw new Error("TN_ANIMAL_LIFECYCLE_DEVICE_UNAVAILABLE");
        const queue: unknown = Reflect.get(device, "queue");
        if (typeof queue !== "object" || queue === null)
          throw new Error("TN_ANIMAL_LIFECYCLE_QUEUE_UNAVAILABLE");
        const acknowledge: unknown = Reflect.get(queue, "onSubmittedWorkDone");
        if (typeof acknowledge !== "function")
          throw new Error("TN_ANIMAL_LIFECYCLE_QUEUE_UNAVAILABLE");
        const gpu = observeGPUResources(device);
        observation = {
          capture: runtime.geometryCapture,
          gpu,
          observerInstalledGPU: gpu.snapshot(),
          acknowledge: () => {
            const completion: unknown = Reflect.apply(acknowledge, queue, []);
            if (!(completion instanceof Promise))
              throw new Error("TN_ANIMAL_LIFECYCLE_QUEUE_COMPLETION_UNAVAILABLE");
            return completion as Promise<void>;
          },
        };
        return () => {
          observation = undefined;
          gpu.dispose();
        };
      },
    },
  ],
  // Named override: stable resource baseline; public frame budgets still report this surface.
  renderer: { preferWebGPU: true, pixelRatio: 1, resolutionScale: 1 },
  frameBudget: { reportEvery: 300 },
  scenes: { lifetimes: Lifetimes },
  start: "lifetimes",
  seed: 7,
});
