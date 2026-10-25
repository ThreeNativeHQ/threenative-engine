import { type ICtx, type IGamePluginRuntime, defineGame, replay } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import type { IPhysicsContext } from "@threenative/physics";
import { rapier } from "@threenative/physics";
import { Object3D } from "three";
import config from "../threenative.config.js";
import { postPhysicsPlugin } from "./postPhysics.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

// Entity-derived component keys do not exist until Play.enter() finishes. Advertising the
// already-provided runtime observation here keeps the runner from rejecting a component scenario
// during the asset-loading window; the actual values still come from ctx.entities.snapshot().
const componentObservationCapability = {
  setup(_ctx: GameCtx, runtime?: IGamePluginRuntime) {
    return runtime?.observations.contribute({
      capabilities: ["runtime.components"],
      sample: () => ({}),
    });
  },
};

const scenarioSetupPlaceholders = {
  setup(ctx: GameCtx) {
    // Scenario setup is delivered before the async scene load finishes. These non-rendered
    // objects give the bridge a stable transform target; Play.enter() transfers the values to
    // the real entities and removes the placeholders before the first sample.
    // "enemy-frozen" is optional per scenario: placing it turns soldier 0 into a sentry at
    // that spot instead of a patroller (see Play.enter). It parks off-map so "the scenario
    // never placed him" stays distinguishable from "the scenario placed him at the origin".
    for (const id of ["player", "enemy", "enemy-frozen"] as const) {
      if (ctx.entities.get(id) !== undefined) continue;
      const placeholder = new Object3D();
      if (id === "enemy-frozen") placeholder.position.set(0, -1000, 0);
      ctx.entities.add(id, placeholder);
    }
    return undefined;
  },
};

// game.state is the single store: the fixed-step loop writes it, and React/playtests read it.
const game = defineGame<GameState, IPhysicsContext>({
  input: {
    // The four directions of `input.vector("move")`.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // Mouse look, as a relative axis. The framework owns the pointer lock and the
    // per-tick delta, so nothing in this game reads `movementX` or the DOM.
    look: { pointerRelative: true },
    // Playtests drive the keyboard: Space fires, KeyR reloads, Enter retries.
    fire: { keys: ["Space"], mouseButtons: [0] },
    reload: { keys: ["KeyR"] },
    sprint: { keys: ["ShiftLeft", "ShiftRight"] },
    // Ctrl used to be a second aim key, which is why crouch "did not work": the bind existed,
    // it just aimed. Aim keeps KeyF and the right mouse button; Ctrl belongs to crouch, and KeyC
    // is there for keyboards that hand Ctrl to the window manager.
    aim: { keys: ["KeyF"], mouseButtons: [2] },
    crouch: { keys: ["ControlLeft", "ControlRight", "KeyC"] },
    restart: { keys: ["Enter", "NumpadEnter"] },
  },
  // Order matters: `postPhysicsPlugin` must follow `rapier()` so the world has already stepped.
  plugins: [
    rapier(),
    postPhysicsPlugin,
    replay(),
    scenarioSetupPlaceholders,
    componentObservationCapability,
    playtest(),
  ],
  display: config.display,
  render: config.renderer,
  renderer: { antialias: true },
  // warmUp stays OFF here, measured on the Pixel 8 (PRD-327 device lane, 2026-09-03): the
  // whole-scene compileAsync walk is synchronous on the native host — ~33 s for this town —
  // and its per-item yield falls back to requestAnimationFrame, which cannot resolve while the
  // launch loop is held. Opting in added its 30 s budget to the existing 14.4 s launch. Filed
  // in docs/verification/runtime-perf-state.md §5a; the mechanism fix is engine work.
  scenes: { play: Play },
  seed: 90210,
  start: "play",
});

/**
 * What the UI layer is allowed to ask for.
 *
 * The HUD runs in the platform's web view on native, so it cannot write game state or change
 * scenes itself. `restart` is the same pair of steps the keyboard's Enter path runs in
 * `Play.update`, which is why a phone player — who has no Enter key — can now start another round.
 */
game.ui.onIntent((intent) => {
  if (intent !== "restart") return;
  game.state.set(Play.initialState);
  void game.goto("play");
});

export default game;
