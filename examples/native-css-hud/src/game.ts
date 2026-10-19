import { type ICtx, Scene, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { BoxGeometry, Color, Mesh, MeshStandardMaterial, PointLight } from "three";

/**
 * Everything the playtest and the HUD agree on.
 *
 * `closeClicks` is the only field the HUD writes: a button's `onClick` is a real intent reaching
 * the game's own store, so a click that never arrived cannot read as a click that did. `gameKeys`
 * counts presses of a key the HUD has no use for, which is how a scenario proves the UI did not
 * swallow every key on the way to it.
 */
export type GameState = {
  frames: number;
  closeClicks: number;
  gameKeys: number;
  uiReady: boolean;
};

declare global {
  var canvas: HTMLCanvasElement | undefined;
}

// The page sets `globalThis.canvas` (index.html); the native host provides the same global, so the
// portable game reads one name on both targets and never touches `document`.
const hostCanvas = globalThis.canvas;

class Cube extends Scene<GameState> {
  static override readonly initialState: GameState = {
    frames: 0,
    closeClicks: 0,
    gameKeys: 0,
    uiReady: false,
  };

  override enter(ctx: ICtx<GameState>) {
    // The dark clear colour the browser reference page paints, so both targets agree on "nothing here".
    ctx.scene.background = new Color(0x18181b);
    ctx.camera.position.set(2, 2, 3);
    ctx.camera.lookAt(0, 0, 0);
    const light = ctx.add(new PointLight(0xffffff, 40));
    light.position.set(4, 6, 8);
    const cube = ctx.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    return (frameCtx: ICtx<GameState>, dt: number) => {
      cube.rotation.x += dt * 0.6;
      cube.rotation.y += dt;
      // A game control the HUD never claims. The host gives the UI every key first and passes on
      // only what it did not take, so this counter is the other half of the keyboard contract: a
      // Tab that moved focus inside the HUD must not also arrive here. `justPressed` is the edge,
      // so one key press is one count rather than one per frame it is held for.
      if (frameCtx.input.justPressed("poke")) {
        const state = frameCtx.state.getState();
        frameCtx.state.set({ gameKeys: state.gameKeys + 1 });
      }
      frameCtx.state.set({ frames: frameCtx.state.getState().frames + 1 });
    };
  }
}

const game: ReturnType<typeof defineGame<GameState>> = defineGame<GameState>({
  canvas: hostCanvas,
  inputTarget: hostCanvas,
  // `KeyJ` is a game control, not a HUD one: nothing in the UI is bound to it, so the host must
  // pass it through even while the HUD holds the keyboard.
  input: { poke: { keys: ["KeyJ"] } },
  plugins: [playtest()],
  scenes: { cube: Cube },
  start: "cube",
});

/**
 * The HUD's one intent, wired in the game rather than in a package: the UI presents, the game decides.
 *
 * `uiReady` becomes true only after a click travelled from the React button into this store, which
 * is why a scenario can assert it as proof the native host dispatched activation at all.
 */
export function closeInventory(): void {
  game.state.set({ closeClicks: game.state.getState().closeClicks + 1, uiReady: true });
  game.state.flush();
}

export default game;
