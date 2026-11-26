# State and UI

Publish game values such as score and health, show them in a React HUD on web and native, and
send player actions back to the game.

## Game state

Gameplay writes state with `ctx.state.set(patch)`. The change is visible to `getState()` at once.

```ts
ctx.state.set((state) => ({ score: state.score + 1 }));
const score = ctx.state.getState().score;
```

Pass a function when the new value depends on the old one. Keep state to plain data, such as
numbers, strings and arrays, because it crosses to the UI as a snapshot.

ThreeNative publishes all changes from one frame as a single UI update when that frame draws.
`getPublishedState()` returns the last published snapshot. If you want fewer updates, set
`stateFlushMs` in `defineGame`. Do not add your own polling loop.

## Shared HUD for web and native

Wrap the UI in `UiLayer`. Inside it, `useUiState` reads published state and `useUiIntent` sends
actions. The same components then run in the browser and in the native runtime, where the UI can
live in another process.

```tsx
import { useUiIntent, useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

export function Hud() {
  const score = useUiState<GameState, number>((state) => state.score);
  const send = useUiIntent();
  return (
    <section aria-label="Game HUD">
      <output>{score ?? "Loading…"}</output>
      <button type="button" data-tn-interactive onClick={() => send("pause")}>
        Pause
      </button>
    </section>
  );
}
```

`useUiState` returns `undefined` until the game publishes its first state, so render a
placeholder. Mark every control the player touches with `data-tn-interactive`. The runtime uses
it to route pointer input to the UI instead of the game.

## Handle intents

An intent is a named request from the UI, such as `pause` or `restart`. The game decides what
each name means and can ignore any of them.

```ts
game.ui.onIntent((intent, payload) => {
  if (intent === "restart") void game.goto("play");
  if (intent === "pause") game.pause();
  if (intent === "resume") game.resume();
});
```

Validate the payload and check the current game state here. The same rules then apply whether an
action comes from a button, a key or a gamepad.

## Web-only components

On the web you can read state straight from the game object with `useGameState(game, selector)`.
Use it only from the web UI entry, never from shared UI code.

```tsx
import type { IGame } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import { useGameState } from "@threenative/ui";
import type { GameState } from "../state.js";

export function Score({ game }: { game: IGame<GameState, IPhysicsContext> }) {
  const score = useGameState(game, (state) => state.score);
  return <output aria-label="Score">{score}</output>;
}
```

`GameCanvas` mounts the game in a React page. Render it first so the UI paints on top. Let the
scene update 3D objects and let React update the interface.

## UI renderer

`ui.renderer` in `threenative.config.ts` picks how `src/ui/` draws.

| Value | What you get |
| --- | --- |
| `"web"` (default) | React DOM, CSS, SVG and fonts, on every target, drawn over the game surface by that platform's own browser-class renderer. What is guaranteed is source parity — one `src/ui/` — not browser-binary parity. |
| `"native"` | React mapped to `CanvasLayer` quads inside the rendered frame. No web view, no CSS, no second process. Choose it for a UI that is part of the frame; own the appearance difference. |
| `"native-css"` | The same React tree in the game's own JS realm — no web view, no second process — painted by a native CSS engine, from the same Vite + Tailwind build the web renderer uses. Desktop only, experimental, opt-in. |

The starter template uses `"web"` with a React HUD and menu. The minimal template uses `"native"`,
draws its HUD in the scene and has no `src/ui/`.

Each non-web value has its own entry, both subpaths of `@threenative/core`:

| Renderer | Imports | React vocabulary |
| --- | --- | --- |
| `"native"` | `@threenative/core/react` | `View` and `Text`, borrowed from React Native rather than invented. No DOM, no WebView, no stylesheet. |
| `"native-css"` | `@threenative/core/react-css` | The HTML you already write: `div`, `section`, `button`, `className`, `style`, `data-*`, `aria-*`. Same component on web and phone. |

Both are subpaths because `react` and `react-reconciler` are optional peers: a game with no React
overlay pays nothing, and core stays consumable from React Three Fiber.

`DebugOverlay` shows development diagnostics. Press backtick to open it. Generated projects include
its styles. If you add it to another project, supply CSS that positions it above the canvas.

On native builds, test pause and resume, keyboard focus, text size and touch in the packaged game.
See [Native runtime](native-runtime.md) for platform requirements.

## Source

- [state.ts](../../packages/core/src/state.ts)
- [UiLayer.tsx](../../packages/ui/src/UiLayer.tsx)
- [index.ts](../../packages/ui/src/index.ts)
