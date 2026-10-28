import { afterEach, describe, expect, it, vi } from "vitest";
import { type IGame, defineGame } from "../src/game.js";
import { acceptHotUpdate } from "../src/hot.js";
import { Scene } from "../src/scene.js";
import { UI_INTENT_MESSAGE, UI_READY_INTENT, connectUiBridge } from "../src/ui-bridge.js";
import { subscribeUiState } from "../src/ui-state.js";

type State = Record<string, unknown>;
type DisposeCallback = (data: Record<string, unknown>) => void;

function hotContext() {
  let disposeCallback: DisposeCallback | undefined;
  return {
    data: {} as Record<string, unknown>,
    accepted: 0,
    invalidated: [] as string[],
    accept() {
      this.accepted += 1;
    },
    dispose(callback: DisposeCallback) {
      disposeCallback = callback;
    },
    invalidate(message?: string) {
      this.invalidated.push(message ?? "");
    },
    triggerDispose() {
      if (disposeCallback === undefined)
        throw new Error("HMR dispose callback was not registered.");
      disposeCallback(this.data);
    },
  };
}

function game<TState extends State>(initialState: TState) {
  class TestScene extends Scene<TState> {}
  return defineGame<TState>({ initialState, scenes: { test: TestScene }, start: "test" });
}

/** A game with somewhere else to be, so a resume has something to resume to. */
function twoSceneGame<TState extends State>(initialState: TState) {
  class MenuScene extends Scene<TState> {}
  class PlayScene extends Scene<TState> {}
  return defineGame<TState>({
    initialState,
    scenes: { menu: MenuScene, play: PlayScene },
    start: "menu",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("acceptHotUpdate", () => {
  it("should resume the scene the session was in, not the start scene", () => {
    // Measured on a real starter before this existed: one hot update took a playing session to
    // `entities: 0, physics: 0, sceneObjects: 11` — the menu — while the restored state still
    // said the screen was "playing". State alone was never enough to make a reload transparent.
    const hot = hotContext();
    const current = twoSceneGame({ screen: "playing" });
    // `sceneName` is a getter on the prototype; an own property shadows it, which is how a
    // running session's scene is simulated without booting a renderer.
    Object.defineProperty(current, "sceneName", { get: () => "play" });
    acceptHotUpdate(current, hot);
    hot.triggerDispose();

    const rebuilt = twoSceneGame({ screen: "menu" });
    const resumed: string[] = [];
    rebuilt.resumeScene = (name: string) => resumed.push(name);
    acceptHotUpdate(rebuilt, hot);

    expect(resumed).toEqual(["play"]);
    expect(rebuilt.state.getState().screen).toBe("playing");
  });

  it("should still restore state when the carried scene is gone from the updated module", () => {
    const hot = hotContext();
    const current = twoSceneGame({ screen: "playing" });
    // `sceneName` is a getter on the prototype; an own property shadows it, which is how a
    // running session's scene is simulated without booting a renderer.
    Object.defineProperty(current, "sceneName", { get: () => "play" });
    acceptHotUpdate(current, hot);
    hot.triggerDispose();

    // The updated module no longer declares `play`. Losing the scene must not lose the reload.
    const rebuilt = game({ screen: "menu" });
    expect(() => acceptHotUpdate(rebuilt, hot)).not.toThrow();
    expect(rebuilt.state.getState().screen).toBe("playing");
  });

  it.each([
    ["ready", false],
    ["collapsing", true],
  ] as const)(
    "a session whose startup phase was %s comes back with its HUD covered: %s",
    (phase, covered) => {
      // An edit restarts the game, and the restarted game covered its HUD again until its own
      // startup lifted the cover: seconds of blank HUD after every save on a slow GPU, 35 s on
      // SwiftShader. A session that already showed its HUD keeps showing it.
      const hot = hotContext();
      const current = twoSceneGame({ screen: "playing" });
      Object.defineProperty(current, "sceneName", { get: () => "play" });
      Object.defineProperty(current, "ctx", { get: () => ({ startup: { phase } }) });
      acceptHotUpdate(current, hot);
      hot.triggerDispose();

      // The page's UI layer stays mounted across the update and announced itself once, to the
      // old game. The updated module connects its game's UI before acceptHotUpdate runs, as a
      // game that registers intents at module load does, and meets that UI already waiting.
      const ui = connectUiBridge({ end: "ui" });
      const mirror = subscribeUiState(ui);
      ui.post({ type: UI_INTENT_MESSAGE, intent: UI_READY_INTENT });
      const rebuilt = twoSceneGame({ screen: "menu" });
      try {
        void rebuilt.ui;
        acceptHotUpdate(rebuilt, hot);
        expect(mirror.covered()).toBe(covered);
      } finally {
        rebuilt.stop();
        ui.close();
      }
    },
  );

  it("keeps the HUD through a second update that lands before the restarted startup is ready", () => {
    // One save, two rebuilds: vite updated the module again 0.1 s after the first restart, whose
    // own startup was still collapsing, and that restart covered the HUD for 15 s on SwiftShader.
    const hot = hotContext();
    const first = twoSceneGame({ screen: "playing" });
    Object.defineProperty(first, "sceneName", { get: () => "play" });
    Object.defineProperty(first, "ctx", { get: () => ({ startup: { phase: "ready" } }) });
    acceptHotUpdate(first, hot);
    hot.triggerDispose();
    const second = twoSceneGame({ screen: "menu" });
    Object.defineProperty(second, "sceneName", { get: () => "play" });
    Object.defineProperty(second, "ctx", { get: () => ({ startup: { phase: "collapsing" } }) });
    acceptHotUpdate(second, hot);
    hot.triggerDispose();

    const ui = connectUiBridge({ end: "ui" });
    const mirror = subscribeUiState(ui);
    ui.post({ type: UI_INTENT_MESSAGE, intent: UI_READY_INTENT });
    const third = twoSceneGame({ screen: "menu" });
    try {
      void third.ui;
      acceptHotUpdate(third, hot);
      expect(mirror.covered()).toBe(false);
    } finally {
      third.stop();
      ui.close();
    }
  });

  it("should do nothing when import.meta.hot is undefined", () => {
    const hot = hotContext();
    const current = game({ score: 0 });
    const stop = vi.spyOn(current, "stop");

    acceptHotUpdate(current, undefined);

    expect(hot.accepted).toBe(0);
    expect(hot.invalidated).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("should reinstate the carried store into the rebuilt game", () => {
    const hot = hotContext();
    const current = game({ score: 0 });
    acceptHotUpdate(current, hot);
    current.state.set({ score: 7 });
    hot.triggerDispose();

    const rebuilt = game({ score: 0 });
    acceptHotUpdate(rebuilt, hot);

    expect(rebuilt.state.getState().score).toBe(7);
    expect(hot.accepted).toBe(2);
  });

  it("should drop keys the new state no longer declares", () => {
    const hot = hotContext();
    const current = game({ a: 1, b: 2 });
    acceptHotUpdate(current, hot);
    hot.triggerDispose();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const rebuilt = game({ a: 0 });
    acceptHotUpdate(rebuilt, hot);

    expect(rebuilt.state.getState()).toEqual({ a: 1 });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("b"));
  });

  it("should keep the declared default for a newly added key", () => {
    const hot = hotContext();
    const current = game({ a: 1 });
    acceptHotUpdate(current, hot);
    hot.triggerDispose();

    const rebuilt = game({ a: 0, c: 3 });
    acceptHotUpdate(rebuilt, hot);

    expect(rebuilt.state.getState()).toEqual({ a: 1, c: 3 });
  });

  it("should throw and invalidate when the store holds a class instance", () => {
    class Player {}
    const hot = hotContext();
    const current = game<{ player: unknown }>({ player: null });
    const stop = vi.spyOn(current, "stop");
    acceptHotUpdate(current, hot);
    current.state.set({ player: new Player() });

    expect(() => hot.triggerDispose()).toThrow(/state\.player/u);
    expect(hot.invalidated[0]).toContain("state.player");
    expect(hot.data.threenative).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("should stop the old game even when capture throws", () => {
    const hot = hotContext();
    const current = game<{ value: unknown }>({ value: undefined });
    const stop = vi.spyOn(current, "stop");
    acceptHotUpdate(current, hot);

    expect(() => hot.triggerDispose()).toThrow(/state\.value/u);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("should serialise overlapping reloads", () => {
    const hot = hotContext();
    const current = game({ score: 4 });
    const stop = vi.spyOn(current, "stop");
    acceptHotUpdate(current, hot);

    hot.triggerDispose();
    hot.triggerDispose();

    expect(stop).toHaveBeenCalledTimes(1);
    expect((hot.data.threenative as { reloads: number }).reloads).toBe(1);
  });

  it("should report null physics when no physics plugin is installed", () => {
    const host = {} as { __THREENATIVE__?: { hot?: () => { physics: number | null } } };
    vi.stubGlobal("window", host);
    const current = {
      ctx: {
        entities: { snapshot: () => ({}) },
        physics: undefined,
        scene: { traverse: () => undefined },
      },
      state: {},
      stop: () => undefined,
    } as unknown as IGame<State, undefined>;

    acceptHotUpdate(current, hotContext());

    expect(host.__THREENATIVE__?.hot?.().physics).toBe(null);
  });

  it("should report physics body counts through the duck-typed probe", () => {
    const host = {} as { __THREENATIVE__?: { hot?: () => { physics: number | null } } };
    vi.stubGlobal("window", host);
    const current = {
      ctx: {
        entities: { snapshot: () => ({}) },
        physics: { numBodies: () => 3 },
        scene: { traverse: () => undefined },
      },
      state: {},
      stop: () => undefined,
    } as unknown as IGame<State, { numBodies: () => number }>;

    acceptHotUpdate(current, hotContext());

    expect(host.__THREENATIVE__?.hot?.().physics).toBe(3);
  });
});
