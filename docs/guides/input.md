# Input and picking

Map keyboard, mouse, gamepad and touch to named actions, read them in your update, and pick 3D
objects under the pointer.

## Define actions

Add actions to the `input` field of `defineGame`. Each action lists the devices that drive it.
Keyboard values are physical key codes such as `KeyW`.

```ts
input: {
  move: {
    up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"],
    left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
  },
  jump: { keys: ["Space"], buttons: [0] },
  fire: { mouseButtons: [0] },
  aim: { mouseButtons: [2] },
  look: { pointerRelative: true },
  zoom: { scroll: true, pinch: true },
},
```

| Field | Drives |
| --- | --- |
| `up`, `down`, `left`, `right` | The four directions of `vector(name)`. Keys here never press a button action. |
| `keys` | A button action, such as jump or fire. |
| `buttons` | Gamepad button indices. |
| `gamepadAxes` | Gamepad axis indices added to `axis(name)`. |
| `mouseButtons` | Mouse buttons: 0 left, 1 middle, 2 right. |
| `pointer` | Pressed while any pointer or touch is down. |
| `pointerRelative` | Raw mouse movement added to `vector(name)`. |
| `scroll`, `pinch` | Wheel motion and two-finger pinch added to `axis(name)`. |

Binding mouse button 2 suppresses the browser context menu on the game surface. ThreeNative
always provides a `move` action on WASD and the arrow keys. Define your own `move` to replace it.

## Read actions

Read actions through `ctx.input` in the scene update.

| Method | Returns | Use for |
| --- | --- | --- |
| `pressed(name)` | `true` while held | Aim, fire, charge |
| `justPressed(name)` | `true` on the frame a press begins | Jump, interact, open a menu |
| `justReleased(name)` | `true` on the frame a press ends | Release a charged shot |
| `vector(name)` | A `Vector2` | Movement, mouse look |
| `axis(name)` | A number in `[-1, 1]` | Zoom from wheel, pinch or a gamepad axis |

```ts
const move = ctx.input.vector("move");
player.position.x += move.x * speed * dt;
player.position.z -= move.y * speed * dt;

if (ctx.input.justPressed("jump") && grounded) {
  // Ask your character controller to jump.
}
const zoom = ctx.input.axis("zoom");
```

Wheel and pinch report the change since the last tick. Apply cooldowns, stamina and pause rules
in your gameplay code.

## Let a player rebind, and rumble

`ctx.input.setBinding(action, binding)` replaces one declared action's binding, and
`ctx.input.bindings()` returns a JSON-safe copy to save and feed back. The action must already be
declared in `defineGame({ input })`: replacing an undeclared one throws `TN_BINDING_UNKNOWN`.

```ts
onRebind: (action, binding) => map.setBinding(action, binding)
```

Two haptics calls, both returning whether the platform took the request. A phone with no motor, or
a pad with no actuator, reports `TN_HAPTICS_UNSUPPORTED` once and returns `false`, so a game that
vibrates on every hit does not fill the console. A negative or non-finite duration throws
`TN_HAPTICS_INVALID`.

```ts
if (ctx.input.vibrateHandheld(80)) hud.flashHit();
ctx.input.startJoyVibration(0.4, 0.8, 250);
```

## Mouse look and touch

With `pointerRelative: true`, a click on the game requests pointer capture. If you want capture
to start from your own button instead, set `captureOnClick: false` and call
`ctx.input.captureMouse()` from that button's handler. Give players a clear way to resume mouse
control after a pause.

Most generated templates include touch controls in `src/render/touch-controls.ts`. Resize and
move them to fit your game. For custom multi-touch, read individual touches from
`ctx.input.raw.pointers`.

Test the edges: release outside the canvas, switch windows, pause and resume, and unplug a
gamepad mid-game.

## Picking

Picking finds the 3D object under the pointer or along a ray. `ctx.raycast()` returns the first
hit, or `undefined`. `ctx.raycastAll()` returns every hit and accepts an array to reuse.

```ts
const hit = ctx.raycast();
if (hit !== undefined) {
  // Read hit.object and apply your selection rules.
}
```

With no options, both use the current pointer position. Pass `screen`, or `origin` with
`direction`, to cast from somewhere else. `targets` and `exclude` narrow what the ray tests.

For per-object events, register a listener with `ctx.pointer`. The event types are
`pointerEntered`, `pointerExited`, `pointerPressed`, `pointerReleased`, `tapped`, `dragStarted`,
`dragged` and `dragEnded`.

```ts
const off = ctx.pointer.on(crate, "tapped", (event) => select(event.object));
```

Use visual picking to select a prop or character. If you need to know whether a wall blocks a
shot, use a [physics](physics.md) query against collision shapes instead.

## Source

- [input.ts](../../packages/core/src/input.ts)
- [picking.ts](../../packages/core/src/picking.ts)
- [pointer-events.ts](../../packages/core/src/pointer-events.ts)
