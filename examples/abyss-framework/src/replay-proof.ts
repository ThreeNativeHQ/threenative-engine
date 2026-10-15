import { createReplayDriver } from "@threenative/core";
import type { ICtx, IGame, IGamePluginRuntime, Recording } from "@threenative/core";
import type { AbyssState } from "./scenes/Abyss.js";

type ReplayPlugin = { readonly recording: Recording | undefined };
type StartupProofArm = "before" | "after";
type StartupProofController = {
  holdCurrentCallback(): void;
  paint(callback: () => void): void;
};

type ReplayProofStep = {
  readonly holdTicks?: number;
  readonly press?: string | readonly string[];
  readonly release?: boolean;
  readonly waitTicks?: number;
};

type ReplayTrace = { position: [number, number, number]; score: number }[];

function parseStartupProof(value: string | null): StartupProofArm | undefined {
  return value === "before" || value === "after" ? value : undefined;
}

export function installStartupProof(
  ctx: Pick<ICtx<AbyssState>, "beforeRender">,
  runtime: IGamePluginRuntime | undefined,
): (() => void) | undefined {
  const startupProof = parseStartupProof(
    new URLSearchParams(globalThis.location.search).get("startupProof"),
  );
  if (startupProof === undefined || runtime === undefined) return undefined;
  const label = document.createElement("div");
  label.dataset.tnStartupProof = startupProof;
  label.style.cssText =
    "position:fixed;z-index:2147483647;left:0;bottom:0;padding:8px 16px;background:#000;color:#fff;font:700 32px monospace;line-height:1;pointer-events:none";
  document.body.append(label);
  let visibleWorldFrame = 0;
  const unregister = ctx.beforeRender(() => {
    const proofHost = globalThis as Record<string, unknown>;
    if (proofHost.__TN_STARTUP_READY__ !== true || visibleWorldFrame >= 5) return;
    const controller = proofHost.__TN_STARTUP_PROOF_CONTROLLER__ as
      | StartupProofController
      | undefined;
    if (controller === undefined) throw new Error("TN_STARTUP_PROOF_CONTROLLER_MISSING");
    const previousFrameBudget = runtime.runtimeDiagnosticsSeries?.().at(-1);
    const previousPhases = previousFrameBudget?.phases;
    visibleWorldFrame += 1;
    controller.holdCurrentCallback();
    label.textContent = `${startupProof.toUpperCase()} FIRST-VISIBLE-WORLD FRAME ${String(visibleWorldFrame)}`;
    const frame = visibleWorldFrame;
    queueMicrotask(() => {
      const series = runtime.runtimeDiagnosticsSeries?.() ?? [];
      const frameBudget = series.at(-1);
      const census = runtime.pipelineCensus?.();
      if (frameBudget === undefined)
        throw new Error(`TN_STARTUP_PROOF_FRAME_BUDGET_MISSING:${String(frame)}`);
      if (frameBudget.phases === undefined || frameBudget.phases === previousPhases)
        throw new Error(`TN_STARTUP_PROOF_FRAME_BUDGET_STALE:${String(frame)}`);
      if (census === undefined) throw new Error(`TN_STARTUP_PROOF_CENSUS_MISSING:${String(frame)}`);
      const record = {
        arm: startupProof,
        census,
        frame,
        frameBudget,
        readyMs: runtime.startupTimeline?.().readyMs,
        tick: runtime.tick(),
      };
      controller.paint(() => {
        Object.assign(proofHost, { __TN_STARTUP_PROOF_RECORD__: { ...record, painted: true } });
        console.log(`TN_STARTUP_VISIBLE_WORLD:${JSON.stringify({ ...record, painted: true })}`);
      });
    });
  });
  return () => {
    unregister();
    label.remove();
  };
}

function dispatchKey(target: EventTarget, type: "keydown" | "keyup", code: string): void {
  target.dispatchEvent(Object.assign(new Event(type), { code }));
}

function dispatchKeys(target: EventTarget, held: Set<string>, keys: readonly string[]): void {
  for (const key of held) if (!keys.includes(key)) dispatchKey(target, "keyup", key);
  for (const key of keys) if (!held.has(key)) dispatchKey(target, "keydown", key);
  held.clear();
  for (const key of keys) held.add(key);
}

function playerSnapshot(game: IGame<AbyssState>): ReplayTrace[number] {
  const player = game.ctx?.entities.snapshot().player;
  const position = player?.position;
  const score = player?.score;
  if (
    !Array.isArray(position) ||
    position.length !== 3 ||
    position.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
    typeof score !== "number" ||
    !Number.isFinite(score)
  ) {
    throw new Error("Replay proof could not observe the Abyss player position and score.");
  }
  return {
    position: [position[0] as number, position[1] as number, position[2] as number],
    score,
  };
}

function proofStepTicks(step: ReplayProofStep): number {
  const ticks = (step.holdTicks ?? 0) + (step.waitTicks ?? 0);
  if (!Number.isInteger(ticks) || ticks < 1)
    throw new Error("Replay proof steps must advance at least one fixed tick.");
  return ticks;
}

export function installReplayProof(
  game: IGame<AbyssState>,
  replayPlugin: ReplayPlugin,
  getRuntime: () => IGamePluginRuntime | undefined,
): void {
  Object.assign(globalThis, {
    __THREENATIVE_REPLAY__: {
      get recording() {
        return replayPlugin.recording;
      },
      export: () => JSON.stringify(replayPlugin.recording),
      replay: async () => {
        const recording = replayPlugin.recording;
        if (recording === undefined) throw new Error("No replay recording is available yet.");
        const runtime = getRuntime();
        if (runtime === undefined) throw new Error("The game runtime is not ready.");
        const pointerTarget = game.ctx?.renderer.domElement;
        if (pointerTarget === undefined) throw new Error("The game renderer is not ready.");
        const driver = createReplayDriver(recording, window, pointerTarget);
        driver.prepare(runtime);
        await game.goto("play");
        return driver(runtime);
      },
      recordAndReplay: async (steps: readonly ReplayProofStep[]) => {
        game.stop();
        await game.start();
        const runtime = getRuntime();
        if (runtime === undefined) throw new Error("The game runtime is not ready.");
        const held = new Set<string>();
        const recordTrace: ReplayTrace = [];
        for (const step of steps) {
          if (step.press !== undefined) {
            dispatchKeys(window, held, Array.isArray(step.press) ? step.press : [step.press]);
          }
          for (let tick = 0; tick < proofStepTicks(step); tick += 1) {
            runtime.fixedStep(1);
            recordTrace.push(playerSnapshot(game));
          }
          if (step.release && step.press !== undefined) dispatchKeys(window, held, []);
        }
        const recording = replayPlugin.recording;
        if (recording === undefined) throw new Error("Replay proof did not produce a recording.");

        const pointerTarget = game.ctx?.renderer.domElement;
        if (pointerTarget === undefined) throw new Error("The game renderer is not ready.");
        const driver = createReplayDriver(recording, window, pointerTarget);
        driver.prepare(runtime);
        await game.goto("play");
        const replayTrace: ReplayTrace = [];
        driver({
          ...runtime,
          fixedStep: (ticks) => {
            const result = runtime.fixedStep(ticks);
            for (let tick = 0; tick < ticks; tick += 1) {
              replayTrace.push(playerSnapshot(game));
            }
            return result;
          },
        });
        return { recording, recordTrace, replayTrace } satisfies {
          recording: Recording;
          recordTrace: ReplayTrace;
          replayTrace: ReplayTrace;
        };
      },
    },
  });
}
