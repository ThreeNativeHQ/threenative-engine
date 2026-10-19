/**
 * The source study's `window.tempest`, rebuilt on this framework's own doors.
 *
 * The source was one HTML file with its own render loop, so `render()` drew a frame and `step(dt)`
 * advanced the simulation by hand. Here the engine owns the loop and draws every frame anyway, so
 * `render()` resolves once the scene has really drawn another one, and `step(dt)` hands the next
 * frame `dt` seconds of simulation through the same intent door the buttons use. `stop()` freezes
 * the simulation clock rather than the loop, so a stopped study can still be stepped and rendered,
 * which is what the source's `stop` + `step` pairing was for. Every value it reports is read back
 * from the store the simulation wrote.
 *
 * It lives in the UI realm because `window`, `document` and the UI end of the state bridge are
 * browser APIs. `src/game.ts` stays portable: this sends the same validated intents the buttons do.
 */

import type { IGame } from "@threenative/core";
import { connectUiBridge, sendUiIntent, subscribeUiState } from "@threenative/core/ui-layer";
import type { GameState, PresetName, WeatherKey } from "../state.js";
import type { ICaptureResult, ISceneSizes } from "./Hud.js";
import { captureScene, sceneCanvas } from "./Hud.js";
import { automationRequest, qualityTier } from "./automation.js";

/** One automation verb, mapped to the intent the interface already sends. */
type IntentName =
  | "setFrozen"
  | "setPreset"
  | "setQuality"
  | "setSafe"
  | "setWeather"
  | "step"
  | "strike";

export interface ITempestApi {
  /** Frames the scene has actually simulated and drawn, as it counted them. */
  readonly frames: number;
  /** The lightning envelope the last drawn frame carried, or 0 in photosensitivity mode. */
  readonly flash: number;
  /** The stage the renderer is really drawing, in device pixels. */
  readonly sizes: ISceneSizes;
  /** The live published state, so a script reads what the simulation is actually doing. */
  readonly state: GameState;
  readonly setPreset: (name: PresetName) => void;
  /** Accepts the source's `low`/`balanced`/`high`/`cinematic` and the engine's four names. */
  readonly setQuality: (name: string) => void;
  readonly setSafe: (on: boolean) => void;
  readonly setWeather: (values: Partial<Record<WeatherKey, number>>) => void;
  /** Freeze the simulation clock. Frames still draw; only `step` moves it on. */
  readonly stop: () => void;
  /** Advance the simulation by `dt` seconds (clamped to 0..60) and resolve on the frame that drew it. */
  readonly step: (dt: number) => Promise<number>;
  /** Resolve with the frame count once the scene has drawn at least one more frame. */
  readonly render: () => Promise<number>;
  readonly triggerLightning: () => void;
  /** Save the frame. Resolves with the image that was really encoded, or why there was none. */
  readonly capture: () => Promise<ICaptureResult>;
}

const say = (text: string): void => {
  console.info(`TN_TEMPEST ${text}`);
};

const canvasSize = (canvas: HTMLCanvasElement): ISceneSizes => ({
  height: canvas.height,
  width: canvas.width,
});

/**
 * Publish the facade and honour the query.
 *
 * `?still` waits for a real frame before it stops the loop. The source simply never started one,
 * which could leave a canvas that had never been presented; here the loop belongs to the engine,
 * so the only faithful still is the loop stopped after the first frame it actually drew, with the
 * simulation clock where the source started it.
 */
export function installTempest(game: IGame<GameState>): ITempestApi {
  const bridge = connectUiBridge({ end: "ui" });
  const mirror = subscribeUiState<GameState>(bridge);
  const send = (intent: IntentName, payload?: unknown): void => {
    sendUiIntent(bridge, intent, payload);
  };
  const query = new URLSearchParams(window.location.search);
  const request = automationRequest(window.location.search);
  if (request.rejectedQuality !== undefined) {
    say(
      `?quality=${request.rejectedQuality} is not a tier: expected low, balanced, high or cinematic`,
    );
  }
  if (request.quality !== undefined) send("setQuality", request.quality);
  if (query.has("offline")) {
    // The source's offline WebGL2 adapter stood in for a Three.js build it could not load from a
    // CDN. This build installs Three locally and never reaches for one, so there is no fallback
    // to select and nothing here pretends otherwise.
    say("?offline selects no adapter: this build loads Three from its own install");
  }

  /** Resolves once the simulation has counted a frame past the one this was called on. */
  const nextFrame = (): Promise<number> => {
    const from = game.state.getState().frame;
    return new Promise((resolve) => {
      const stop = mirror.subscribe(() => {
        const frame = mirror.get()?.frame ?? 0;
        if (frame <= from) return;
        stop();
        resolve(frame);
      });
    });
  };

  const api: ITempestApi = {
    get frames() {
      return game.state.getState().frame;
    },
    get flash() {
      return game.state.getState().flash;
    },
    get sizes() {
      const canvas = sceneCanvas();
      return canvas === null ? { height: 0, width: 0 } : canvasSize(canvas);
    },
    get state() {
      return game.state.getState();
    },
    setPreset: (name) => send("setPreset", name),
    setQuality: (name) => send("setQuality", qualityTier(name)),
    setSafe: (on) => send("setSafe", on),
    setWeather: (values) => send("setWeather", values),
    stop: () => send("setFrozen", true),
    step: (dt) => {
      const frame = nextFrame();
      send("step", dt);
      return frame;
    },
    render: nextFrame,
    triggerLightning: () => send("strike"),
    capture: () => captureScene(say),
  };
  if (request.still) {
    const stop = mirror.subscribe(() => {
      if ((mirror.get()?.frame ?? 0) < 1) return;
      stop();
      send("setFrozen", true);
      say(`still · loop stopped on frame ${api.frames} · t=${api.state.elapsed.toFixed(2)}s`);
    });
  }
  (window as unknown as { tempest?: ITempestApi }).tempest = api;
  const { width, height } = api.sizes;
  say(`ready · ${width}x${height} · ${request.still ? "still" : "running"}`);
  return api;
}
