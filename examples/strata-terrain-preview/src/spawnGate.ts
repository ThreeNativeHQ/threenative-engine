import type { TerrainCtx } from "./sceneState.js";

/** How much of the spawn's own region landed: the two counts the run report publishes. */
export interface ISpawnRegion {
  readonly required: number;
  readonly loaded: number;
}

/**
 * The one deadline a scene allows its spawn to land, taken at entry and not extended.
 *
 * A scene destroys and rebuilds its world on every `ctx.goto`, so the gate is scene-local: the
 * promise it settles is that scene's loading screen, and a scene that was left behind settles it
 * rather than leaving the next world's loader waiting on a world that will not arrive.
 */
const SPAWN_BUDGET_MS = 120_000;
const EXPIRED = `Strata spawn admission exceeded ${SPAWN_BUDGET_MS} ms`;

/** Where the scene's own preparation stands, for the failure report. */
export interface ISpawnWitness {
  /** The preparation phase the scene is in, when it has one. */
  readonly phase: string | undefined;
  /** The streamed or staged build's own stage name. */
  readonly stage: string;
  readonly bucket: string | null;
  readonly added: number | null;
  readonly total: number | null;
  readonly buildStartedAt: number | undefined;
  readonly phaseStartedAt: number | undefined;
  readonly lastProgressAt: number | undefined;
}

export interface ISpawnGateOptions {
  readonly world: string;
  /** Completed work units, so the loading screen's percentage cannot claim progress a stall did not make. */
  readonly progress: () => number;
  /**
   * Where preparation stands when the spawn fails, so the failure names the phase it died in.
   * Absent until the scene's own build exists: a failure before that reports nulls, not a guess.
   */
  readonly witness: () => ISpawnWitness | undefined;
  /** True once the scene tore its world down: a join that lands afterwards must not revive it. */
  readonly released: () => boolean;
}

export interface ISpawnGate {
  readonly deadlineAt: number;
  /** Settles when the spawn's data and draws both landed; rejects when it failed or was cancelled. */
  readonly promise: Promise<void>;
  readonly ready: boolean;
  readonly error: string;
  readonly cells: ISpawnRegion;
  /** Keeps the loading screen up until the spawn promise settles. */
  readonly hold: () => void;
  /** Await one readiness join under the gate's deadline. */
  readonly watch: (
    join: (remainingMs: number) => Promise<{ requiredCells: number; loadedCells: number }>,
  ) => void;
  /** The join landed: publish the cells it covers and release the gate. */
  readonly land: (region: { requiredCells: number; loadedCells: number }) => void;
  /** Release the gate without a failure receipt: the spawn landed, or the scene left. */
  readonly settle: (error?: Error) => void;
  /** Kill the gate with a receipt: the spawn failed. */
  readonly fail: (reason?: unknown) => void;
}

/**
 * The spawn gate: one deadline, one settlement, one failure report.
 *
 * `WorldCells.whenSpawnReady` is the data authority and each streamed world's `prewarmed` is the
 * draw gate; this gate turns their landing into the loading screen's release, and writes the one
 * console line a failed spawn leaves behind.
 */
export function createSpawnGate(ctx: TerrainCtx, options: ISpawnGateOptions): ISpawnGate {
  const { progress, released, witness, world } = options;
  const deadlineAt = performance.now() + SPAWN_BUDGET_MS;
  let spawnCells: ISpawnRegion = { loaded: 0, required: 0 };
  let spawnReady = false;
  let spawnError = "";
  let spawnSettled = false;
  let capturingSpawnFailure = false;
  let resolveSpawn: () => void = () => undefined;
  let rejectSpawn: (reason: Error) => void = () => undefined;
  const spawnPromise = new Promise<void>((done, failed) => {
    resolveSpawn = done;
    rejectSpawn = failed;
  });

  function settleSpawn(error?: Error): void {
    if (spawnSettled || capturingSpawnFailure) return;
    spawnSettled = true;
    clearTimeout(spawnTimer);
    if (error === undefined) {
      spawnReady = true;
      resolveSpawn();
    } else {
      rejectSpawn(error);
    }
  }

  function failSpawn(reason?: unknown): void {
    if (spawnSettled || capturingSpawnFailure) return;
    const message =
      (reason instanceof Error ? reason.message : String(reason ?? "")) || "Strata spawn failed";
    capturingSpawnFailure = true;
    try {
      captureSpawnFailure(message);
    } catch {
      // A diagnostic must never replace the admission failure or leave its promise pending.
    }
    capturingSpawnFailure = false;
    spawnError = message;
    settleSpawn(new Error(message));
    ctx.state.set({ worldReady: spawnReady, loadingError: spawnError });
  }

  const spawnTimer: ReturnType<typeof setTimeout> = setTimeout(() => failSpawn(EXPIRED), 120_000);

  function captureSpawnFailure(reason: string): void {
    const failedAt = performance.now();
    const sceneStartedAt = deadlineAt - SPAWN_BUDGET_MS;
    const preparation = witness();
    const propsStage = preparation?.stage ?? "before-build";
    const since = (stamp: number | undefined): number | null =>
      stamp === undefined ? null : Math.max(0, Math.round(stamp - sceneStartedAt));
    console.error(
      `TN_STRATA_SPAWN_FAILURE ${JSON.stringify({
        reason: reason.slice(0, 256),
        world,
        stage: (preparation?.phase ?? propsStage).slice(0, 64),
        bucket: preparation?.bucket?.slice(0, 64) ?? null,
        added: preparation?.added ?? null,
        total: preparation?.total ?? null,
        deadlineElapsedMs: Math.max(0, Math.round(failedAt - sceneStartedAt)),
        buildStartedMs: since(preparation?.buildStartedAt),
        phaseStartedMs: since(preparation?.phaseStartedAt),
        lastProgressMs: since(preparation?.lastProgressAt),
      })}`,
    );
  }

  const hold = (): void => {
    if (ctx.startup.phase !== "ready")
      ctx.startup.hold("strata-spawn", spawnPromise, SPAWN_BUDGET_MS, progress);
  };

  const land = (region: { requiredCells: number; loadedCells: number }): void => {
    if (released() || spawnSettled) return;
    spawnCells = { loaded: region.loadedCells, required: region.requiredCells };
    settleSpawn();
  };

  const watch = (
    join: (remainingMs: number) => Promise<{ requiredCells: number; loadedCells: number }>,
  ): void => {
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) {
      failSpawn(EXPIRED);
      return;
    }
    void join(remaining).then(land, (reason) => failSpawn(reason));
  };

  return {
    deadlineAt,
    promise: spawnPromise,
    fail: failSpawn,
    hold,
    land,
    settle: settleSpawn,
    watch,
    // The frame report reads these every step, so they are live values, not a snapshot.
    get cells(): ISpawnRegion {
      return spawnCells;
    },
    get error(): string {
      return spawnError;
    },
    get ready(): boolean {
      return spawnReady;
    },
  };
}
