import { defineGame, replay } from "@threenative/core";
import type { IGamePluginHooks, IGamePluginRuntime } from "@threenative/core";
import { acceptHotUpdate } from "@threenative/core/hot";
import { playtest } from "@threenative/core/playtest";
import "./style.css";
import { createRoot } from "react-dom/client";
import { installReplayProof, installStartupProof } from "./replay-proof.js";
import { Abyss, type AbyssState } from "./scenes/Abyss.js";
import { ViewportProbe } from "./scenes/ViewportProbe.js";
import { App } from "./ui/App.js";

const viewportProbe = new URLSearchParams(globalThis.location.search).has("viewport");
const replayPlugin = replay<AbyssState>();
let gameRuntime: IGamePluginRuntime | undefined;
const replayRuntime: IGamePluginHooks<AbyssState> = {
  setup: (ctx, runtime) => {
    gameRuntime = runtime;
    return installStartupProof(ctx, runtime);
  },
};
const game = defineGame<AbyssState>({
  camera: { far: 7_000, near: 5_000, projection: "orthogonal", size: 520 },
  inputTarget: window,
  input: {
    move: {
      down: ["KeyS", "ArrowDown"],
      left: ["KeyA", "ArrowLeft"],
      right: ["KeyD", "ArrowRight"],
      up: ["KeyW", "ArrowUp"],
    },
    pulse: { keys: ["Space"], pointer: true },
    start: { keys: ["Enter"] },
    zoom: { gamepadAxes: [3], pinch: true, scroll: true },
  },
  plugins: [replayPlugin, replayRuntime, playtest()],
  renderer: { preferWebGPU: !viewportProbe },
  scenes: { play: viewportProbe ? ViewportProbe : Abyss },
  seed: 90210,
  start: "play",
  warmUp: {},
});

if (import.meta.env.DEV) {
  installReplayProof(game, replayPlugin, () => gameRuntime);
}

import.meta.hot?.accept();
acceptHotUpdate(game, import.meta.hot);
const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");
const appRoot = root as typeof root & { __threenativeRoot?: ReturnType<typeof createRoot> };
const reactRoot = appRoot.__threenativeRoot ?? createRoot(appRoot);
appRoot.__threenativeRoot = reactRoot;
reactRoot.render(<App game={game} />);
