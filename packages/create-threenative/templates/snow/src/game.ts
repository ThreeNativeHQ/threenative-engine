import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import config from "../threenative.config.js";
import { type Command, commands } from "./commands.js";
import { Boot } from "./scenes/Boot.js";
import { Snow } from "./scenes/Snow.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState, IPhysicsContext>({
  input: {
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    run: { keys: ["ShiftLeft", "ShiftRight"] },
    auto: { keys: ["KeyP"] },
    blizzard: { keys: ["KeyB"] },
    compaction: { keys: ["KeyV"] },
    drop: { keys: ["KeyF"] },
    kick: { keys: ["KeyG"] },
    mute: { keys: ["KeyM"] },
    reset: { keys: ["KeyR"] },
    view: { keys: ["KeyC"] },
    zoom: { pinch: true, scroll: true },
  },
  plugins: [rapier({ gravity: { x: 0, y: -9.81, z: 0 } }), playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { boot: Boot, snow: Snow },
  seed: 2_024,
  start: "boot",
});

export default game;

/** Settings the panel may change directly. Anything else in a `set` intent is ignored. */
const SETTINGS = new Set<keyof GameState>([
  "snowfall",
  "depth",
  "fallSpeed",
  "hardness",
  "wind",
  "recovery",
  "compaction",
]);
const COMMANDS = new Set<Command>(["reset", "drop", "kick", "view", "auto", "blizzard", "mute"]);

game.ui.onIntent((intent, payload) => {
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
  if (intent === "set" && typeof payload === "object" && payload !== null) {
    const { key, value } = payload as { key?: string; value?: unknown };
    if (
      SETTINGS.has(key as keyof GameState) &&
      (typeof value === "number" || typeof value === "boolean")
    )
      game.state.set({ [key as string]: value } as Partial<GameState>);
  }
  if (COMMANDS.has(intent as Command)) commands.push(intent as Command);
  game.state.set({
    uiReady: game.ui.connected,
    ...(intent === "pause" || intent === "resume" ? { paused: intent === "pause" } : {}),
  } as Partial<GameState>);
  game.state.flush();
});
