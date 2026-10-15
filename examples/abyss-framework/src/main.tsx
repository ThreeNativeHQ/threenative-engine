import { defineGame, replay } from "@threenative/core";
import type { IGamePluginHooks, IGamePluginRuntime } from "@threenative/core";
import { acceptHotUpdate } from "@threenative/core/hot";
import { playtest } from "@threenative/core/playtest";
import "./style.css";
import { createRoot } from "react-dom/client";
import { installReplayProof } from "./replay-proof.js";
import { Abyss, type AbyssState } from "./scenes/Abyss.js";
import { ViewportProbe } from "./scenes/ViewportProbe.js";
import { App } from "./ui/App.js";

const viewportProbe = new URLSearchParams(globalThis.location.search).has("viewport");
const startupProofArm = new URLSearchParams(globalThis.location.search).get("startupProof");
const startupProof =
  startupProofArm === "before" || startupProofArm === "after" ? startupProofArm : undefined;
const replayPlugin = replay<AbyssState>();
let gameRuntime: IGamePluginRuntime | undefined;
const replayRuntime: IGamePluginHooks<AbyssState> = {
  setup: (ctx, runtime) => {
    gameRuntime = runtime;
    if (startupProof === undefined) return undefined;
    if (runtime === undefined) return undefined;
    const label = document.createElement("div");
    label.dataset.tnStartupProof = startupProof;
    label.style.cssText =
      "position:fixed;z-index:2147483647;left:0;bottom:0;padding:8px 16px;background:#000;color:#fff;font:700 32px monospace;line-height:1;pointer-events:none";
    document.body.append(label);
    let visibleWorldFrame = 0;
    const unregister = ctx.beforeRender(() => {
      const proofHost = globalThis as Record<string, unknown>;
      if (
        proofHost.__TN_STARTUP_READY__ !== true ||
        proofHost.__TN_STARTUP_PROOF_REQUEST__ !== true ||
        visibleWorldFrame >= 5
      )
        return;
      proofHost.__TN_STARTUP_PROOF_REQUEST__ = false;
      visibleWorldFrame += 1;
      label.textContent = `${startupProof.toUpperCase()} FIRST-VISIBLE-WORLD FRAME ${String(visibleWorldFrame)}`;
      console.log(
        `TN_STARTUP_VISIBLE_WORLD:${JSON.stringify({
          arm: startupProof,
          frame: visibleWorldFrame,
          tick: runtime.tick(),
          readyMs: runtime.startupTimeline?.().readyMs,
        })}`,
      );
    });
    return () => {
      unregister();
      label.remove();
    };
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
