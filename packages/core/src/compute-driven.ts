import type { Camera, Object3D } from "three";
import type { IRendererLike } from "./renderer.js";

/**
 * The lifecycle contract for a game-owned GPU simulation.
 *
 * A compute-driven object owns its kernels, buffers, and appearance. The framework only attaches
 * the active renderer, warms the kernels before the world is shown, dispatches process calls at
 * the object's declared cadence, and releases the object when its scene ends.
 */
export interface IComputeDriven {
  /** Kernels to compile before the world is shown. Read once, at attach. */
  readonly warmupNodes: readonly unknown[];
  attachRenderer(renderer: IRendererLike): void;
  /**
   * The loop phase that dispatches `process`. Defaults to fixed-step; render cadence preserves the
   * existing behavior of consumers whose simulation is intentionally tied to presentation.
   */
  readonly processCadence?: "fixed" | "render";
  /** Render admission needed to settle a startup hold, after initial compilation. */
  readonly processDuringStartup?: boolean;
  /**
   * Dispatched once per fixed step, in scene-add order unless render cadence is declared.
   *
   * `camera` is the frame's render camera, handed over at render cadence so a consumer that culls by
   * the view — a streamed world narrowing its instanced windows to what the frustum covers — can do
   * it from the driver that runs every frame rather than from a draw three will not submit. An
   * implementation that does not need it simply declares one parameter.
   *
   * `covered` is true while the startup cover hides the world and readiness is still pending, so
   * a streamed world may spend more of the frame admitting the spawn it is waiting on.
   */
  process(renderer: IRendererLike, camera?: Camera, covered?: boolean): void;
  detach(): void;
  readonly released: boolean;
}

interface IComputeDrivenEntry {
  readonly object: Object3D;
  readonly driven: IComputeDriven;
  readonly warmupNodes: readonly unknown[];
}

/** The ordered registry used by the game loop for all compute-driven scene objects. */
export class ComputeDrivenRegistry {
  #entries = new Map<IComputeDriven, IComputeDrivenEntry>();

  get size(): number {
    return this.#entries.size;
  }

  /** Attach and remember one object. Re-adding the same object is idempotent. */
  add(object: Object3D & IComputeDriven, renderer: IRendererLike): void {
    const driven = object;
    if (this.#entries.has(driven)) return;
    const warmupNodes = [...driven.warmupNodes];
    driven.attachRenderer(renderer);
    this.#entries.set(driven, { object, driven, warmupNodes });
  }

  /** Release one object without disturbing the order of the remaining objects. */
  remove(driven: IComputeDriven): void {
    const entry = this.#entries.get(driven);
    if (entry === undefined) return;
    this.#entries.delete(driven);
    if (!entry.driven.released) entry.driven.detach();
  }

  /** Kernels in the same order as their objects were added to the scene. */
  get warmupNodes(): readonly unknown[] {
    return [...this.#entries.values()].flatMap((entry) => entry.warmupNodes);
  }

  /** Dispatch fixed-step objects once; detached scene children are released before dispatch. */
  process(renderer: IRendererLike): void {
    this.#process(renderer, "fixed");
  }

  /**
   * Dispatch render-cadence objects once with the frame's render camera; detached scene children are
   * released before dispatch.
   */
  processRender(renderer: IRendererLike, camera?: Camera, startupOnly = false): void {
    this.#process(renderer, "render", camera, startupOnly);
  }

  #process(
    renderer: IRendererLike,
    cadence: "fixed" | "render",
    camera?: Camera,
    startupOnly = false,
  ): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.driven.released || entry.object.parent === null) {
        this.remove(entry.driven);
        continue;
      }
      if ((entry.driven.processCadence ?? "fixed") !== cadence) continue;
      if (startupOnly && entry.driven.processDuringStartup !== true) continue;
      entry.driven.process(renderer, camera, startupOnly);
    }
  }

  /** Release every registered object, continuing after a failure so no resource is stranded. */
  clear(): void {
    const failures: unknown[] = [];
    for (const driven of [...this.#entries.keys()]) {
      try {
        this.remove(driven);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }
}

export function isComputeDriven(value: unknown): value is IComputeDriven {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IComputeDriven>;
  return (
    Array.isArray(candidate.warmupNodes) &&
    typeof candidate.attachRenderer === "function" &&
    typeof candidate.process === "function" &&
    typeof candidate.detach === "function" &&
    typeof candidate.released === "boolean"
  );
}
