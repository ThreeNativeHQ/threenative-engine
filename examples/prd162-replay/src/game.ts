import {
  type IGamePluginHooks,
  type IGamePluginRuntime,
  type Recording,
  createReplayDriver,
  defineGame,
  replay,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { browserRecordingSha256 } from "./browser-recording.js";
import { browserRecording, recordingFingerprint } from "./recording.js";
import { ReplayScene } from "./scenes/Replay.js";
import type { ReplayState } from "./state.js";

const RECORDING_TICKS = 24;
const replayPlugin = replay<ReplayState>({ portable: true });
let activeRuntime: IGamePluginRuntime | undefined;
let capturedRecording: Recording | undefined =
  typeof navigator !== "undefined" && navigator.userAgent.includes("MystralNative")
    ? browserRecording
    : undefined;
let recordingWaiters: Array<(recording: Recording) => void> = [];
let playbackActive = false;
let playbackTriggered = false;
let playbackComplete = false;

function completedRecording(): Recording | undefined {
  const recording = replayPlugin.recording;
  if (recording === undefined || recording.ticks < RECORDING_TICKS) return undefined;
  return {
    ...recording,
    input: recording.input.filter((sample) => sample.tick < RECORDING_TICKS),
    ticks: RECORDING_TICKS,
  };
}

function captureBrowserRecording(): void {
  if (capturedRecording !== undefined) return;
  const recording = completedRecording();
  if (recording === undefined) return;
  capturedRecording = recording;
  for (const resolve of recordingWaiters) resolve(recording);
  recordingWaiters = [];
  console.info(
    `[PRD162] recording-source=browser fingerprint=${recordingFingerprint(recording)} ticks=${recording.ticks}`,
  );
}

const playback: IGamePluginHooks<ReplayState> = {
  setup: (_ctx, runtime) => {
    activeRuntime = runtime;
    playbackActive = false;
    playbackTriggered = false;
    playbackComplete = false;
    return undefined;
  },
  beforeUpdate: (ctx) => {
    captureBrowserRecording();
    if (!playbackTriggered) {
      if (!ctx.input.pressed("replay") || activeRuntime === undefined) return;
      playbackTriggered = true;
      const recording = capturedRecording;
      if (recording === undefined) {
        throw new Error(
          "TN_PRD162_RECORDING_MISSING: replay was requested before browser recording completed.",
        );
      }
      ctx.state.set(ReplayScene.initialState);
      setTimeout(() => {
        if (activeRuntime === undefined) return;
        playbackActive = true;
        try {
          const driver = createReplayDriver(recording, globalThis, ctx.renderer.domElement);
          driver.prepare(activeRuntime);
          const fingerprint = recordingFingerprint(recording);
          ctx.state.set({
            recordingHash: fingerprint,
            recordingRandomState: recording.randomState,
            recordingRuntimeAgent: recording.runtime.agent,
            recordingRuntimeCore: recording.runtime.core,
            recordingSeed: recording.seed,
            recordingSha256: browserRecordingSha256,
            recordingSource: "browser",
            recordingStep: recording.runtime.step,
            recordingValidated: true,
          });
          driver(activeRuntime);
          playbackComplete = true;
          ctx.state.set({ frozen: true, skipOuterTick: false });
          console.info(
            `[PRD162] replay-consumed source=browser fingerprint=${fingerprint} sha256=${browserRecordingSha256} seed=${recording.seed} randomState=${recording.randomState} stateHash=${ctx.state.getState().stateHash}`,
          );
        } finally {
          playbackActive = false;
        }
      }, 0);
    }
    if (!playbackComplete && !playbackActive) ctx.state.set({ skipOuterTick: true });
  },
};

export const game = defineGame<ReplayState>({
  input: { move: { right: ["KeyD"] }, replay: { keys: ["KeyP"] } },
  inputTarget: globalThis,
  plugins: [replayPlugin, playback, playtest()],
  renderer: { preferWebGPU: true },
  scenes: { replay: ReplayScene },
  seed: 90210,
  start: "replay",
  step: 1 / 60,
});

export default game;

export { replayPlugin };
export function replayRuntime(): IGamePluginRuntime {
  if (activeRuntime === undefined) throw new Error("The replay runtime is not ready.");
  return activeRuntime;
}

export async function recordBrowserRun(): Promise<Recording> {
  if (capturedRecording !== undefined) return Promise.resolve(capturedRecording);
  if (activeRuntime === undefined)
    throw new Error("TN_PRD162_RUNTIME_NOT_READY: the browser game has not started.");
  const runtime = activeRuntime;
  const recording = new Promise<Recording>((resolve) => recordingWaiters.push(resolve));
  const dispatchKey = (type: "keydown" | "keyup", code: string): void => {
    globalThis.dispatchEvent(Object.assign(new Event(type), { code }));
  };
  dispatchKey("keydown", "KeyD");
  runtime.fixedStep(12);
  dispatchKey("keyup", "KeyD");
  runtime.fixedStep(12);
  captureBrowserRecording();
  return recording;
}

export function recordingTicks(): number {
  return replayPlugin.recording?.ticks ?? 0;
}

export function runtimeReady(): boolean {
  return activeRuntime !== undefined;
}

export function resetReplayState(): void {
  game.state.set(ReplayScene.initialState);
}
