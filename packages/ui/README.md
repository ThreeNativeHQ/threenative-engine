# @threenative/ui

## What it is

`@threenative/ui` provides React bindings for a ThreeNative game: `UiLayer` renders a game's UI so
the same source runs on web and on every native target, `useUiState` reads the game's published
state and `useUiIntent` sends a named request back to the game. `GameCanvas` mounts a game surface
directly, `useGameState` reads its throttled store, and `DebugOverlay` exposes development
snapshots. It is not a scene-graph or visual-design layer; React renders HUDs, menus, and overlays,
while the game owns gameplay and the Three.js scene.

## Install

Install the package with its peer dependencies:

```sh
pnpm add @threenative/ui @threenative/core react react-dom three
```

## Example

A generated `starter` project renders one `<GameUi />` on both targets. `src/ui/GameUi.tsx` wraps
the HUD and menu in `UiLayer`, and two entries mount it: `src/main.ts` beside the canvas on the web,
and `src/ui/main.tsx` for the native web view. Mark every control the player touches with
`data-tn-interactive`, or the native web view will not forward its input.

```tsx
import { UiLayer } from "@threenative/ui";
import { Hud } from "./Hud.js";
import { Menu } from "./Menu.js";

export function GameUi() {
  return (
    <UiLayer>
      <Hud />
      <Menu />
    </UiLayer>
  );
}
```

`useUiState` reads the state the game publishes once per rendered frame, and is `undefined` until
the game publishes its first snapshot. `useUiIntent()` returns a `send` function for a named request
the game handles:

```tsx
const score = useUiState<GameState, number>((state) => state.score);
const send = useUiIntent();
send("restart");
```

`useUiStateDuringStartup` takes a required `reason` and is reported once as
`TN_UI_STARTUP_OVERRIDE`; every other HUD uses `useUiState`.

## Styling the debug overlay

`DebugOverlay` ships no presentation — it renders one `<aside data-threenative-debug-overlay="true">`
and leaves every pixel to you. Generated projects already carry a rule for it in their stylesheet;
a project that imports the package directly must write its own, or the overlay paints behind an
absolutely positioned `GameCanvas` and its diagnostics are invisible:

```css
[data-threenative-debug-overlay="true"] {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 50;
  pointer-events: none;
  background: rgb(2 6 23 / 90%);
  color: #cffafe;
}
```

## Links

- [Repository](https://github.com/ThreeNativeHQ/threenative)
- [MIT License](https://github.com/ThreeNativeHQ/threenative/blob/main/LICENSE)
- Start a project with `pnpm create threenative my-game`.
