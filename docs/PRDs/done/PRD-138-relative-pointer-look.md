---
prd_contract: v1
---

# PRD-138 — `InputMap` has no relative pointer delta, so a first-person camera cannot be written portably

**Status: DONE, 2026-08-18.** Web and desktop playtests, focused input tests, native build and
the no-browser-global source check pass. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** a game reads mouse look through `ctx.input`, on web and on native, and the
`document`-reaching `MouseLook` class every first-person build has to write disappears.

**Depends on:** nothing.

**Blocks:** nothing formally. It is the highest-severity row in the PRD-137 ledger and the
repository's own analysis names it "the most serious", so it goes first in this batch.

**Complexity: 5 → MEDIUM mode.** One new field on the raw input state, one action kind, one
pointer-lock request path, and a native binding that already has the data.

**Blast radius: 6 files.** `packages/core/src/input.ts`, `packages/core/src/game.ts`,
`packages/runtime-native/src/platform/input.cpp` (read only — verify), `packages/runtime-native/src/runtime.cpp`,
one new `packages/core/__tests__/*.spec.ts`, one conformance playtest.

---

## 1. The defect

`packages/core/src/input.ts:80-93` is the whole raw input surface:

```ts
export interface IRawInputState {
  readonly keys: ReadonlySet<string>;
  readonly pointer: {
    buttons: number;
    down: boolean;
    readonly position: Vector2;   // absolute, in canvas pixels
  };
  readonly pointers: ReadonlyMap<number, IRawInputPointer>;
  readonly gamepad: { axes: readonly number[]; buttons: readonly boolean[] };
}
```

`position` is an absolute canvas point. A look axis is a **delta**, and the two are not derivable
from one another once the pointer is locked, because a locked pointer stops producing positions
at all. There is no pointer-lock request anywhere in `@threenative/core` either — `grep -rn
"pointerLock" packages/core/src/` returns nothing.

The PRD-137 framework arm therefore wrote this, and said so in its ledger
(`sandbox/fps-framework/src/entities/FpsPlayer.ts:22-72`):

```ts
class MouseLook {
  attach(): void {
    if (typeof document === "undefined") return;          // <- the tell
    document.addEventListener("mousemove", (e) => { this.#dx += e.movementX; ... });
    document.addEventListener("click", () => void canvas.requestPointerLock());
  }
}
```

**Name the layer. This is an engine bug.** The workaround is a browser global reached from game
code, which the framework's own rules forbid, and the guard on line 36 means the shipped build's
look control is **web-only by construction** — the native bundle silently never looks around. A
game cannot write this portably, so by question (a) the framework owns it, at any size. It decides
nothing about how anything looks, so question (b) does not veto.

## 2. The seam already exists on native

This is not a native bring-up task. The C++ host already produces relative motion from SDL and
already puts it on the event object:

- `packages/runtime-native/src/platform/input.cpp:367` — `data.movementX = event.xrel;`
- `packages/runtime-native/src/runtime.cpp:4195` — `setProperty(event, "movementX", ...)`

So the delta exists on both platforms and neither is reachable through `InputMap`. What is missing
is the portable API, not the plumbing under it.

**Confirm before building:** whether native exposes a pointer-lock equivalent.
`grep -n "requestPointerLock\|SetWindowRelativeMouseMode\|SDL_SetRelativeMouseMode"
packages/runtime-native/src/runtime.cpp packages/runtime-native/src/**/*.cpp` returns **nothing** on
2026-08-17. If that is still true, §3's `lock()` needs an SDL relative-mouse-mode binding on the
native side; the delta half does not.

## 3. The API

Godot is the vocabulary source. Godot's equivalents are `Input.mouse_mode =
MOUSE_MODE_CAPTURED` and `InputEventMouseMotion.relative`, so:

```ts
// raw, always available
readonly pointer: {
  buttons: number;
  down: boolean;
  readonly position: Vector2;
  /** Accumulated relative motion since the last `tick`, in canvas pixels. Zeroed each tick. */
  readonly relative: Vector2;
  /** True while the pointer is captured and only `relative` is meaningful. */
  readonly captured: boolean;
};
```

```ts
// on ICtx.input
captureMouse(): void;    // Godot MOUSE_MODE_CAPTURED
releaseMouse(): void;    // Godot MOUSE_MODE_VISIBLE
```

`relative` accumulates between ticks the same way `#latchedKeys` already does
(`input.ts:114-125`) — a motion event that arrives between two frames must not be dropped, for the
same reason a short click must not be.

Two decisions are the owner's, and both belong in the commit message rather than being made
silently:

1. **Whether `IInputAction` gains a look-axis binding** (`look: { pointerRelative: true }`, read
   through `vector("look")`) or whether games read `raw.pointer.relative` directly. The binding is
   more Godot-shaped and lets a gamepad right stick and a mouse feed one action; the raw field is
   smaller. Sensitivity, inversion and clamping stay in the game either way — they are feel, and
   feel is the game's.
2. **Whether `captureMouse()` may be called outside a user gesture.** The browser refuses, so the
   framework either documents "call it from an input handler" or swallows the rejection. Swallowing
   it silently is the wrong answer; a rejected capture must be observable.

## 3.1 Shape constraints

Read the batch README's shape rules first; they bind every PRD here. The specific risks for this
one:

- **SRP.** `InputMap` reports device state. It does not own sensitivity, inversion, clamping,
  smoothing or a camera. `relative` is raw pixels; the moment a `lookSensitivity` option appears on
  the framework side, this has grown a second job and is decided in the wrong place.
- **DRY.** `relative` accumulates through the **existing** latch mechanism (`input.ts:114-125`), not
  a second parallel one. If the latch cannot carry a vector, widen it — do not add a sibling.
- **KISS.** Two fields and two methods. No `mouseMode` enum with five members because Godot has
  five, no capture state machine, no `onPointerLockChange` callback surface. Add the fourth thing
  when a second game needs it.

## 4. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | the greps in §2 | output pasted into the evidence file, including whether native pointer lock exists |
| 2 | `pnpm vitest run packages/core/__tests__/<new>.spec.ts` | pass — synthetic `mousemove` with `movementX/Y` accumulates into `relative`, `tick()` zeroes it, two events between ticks sum rather than overwrite |
| 3 | `pnpm typecheck && pnpm lint && pnpm test` | exit `0` |
| 4 | a playtest scenario driving look through the new API on web | pass, with a `camera` assertion showing yaw changed |
| 5 | **the same scenario with `--target desktop`** | pass |
| 6 | `grep -rn "typeof document" <a rebuilt fps game's src/>` | no hits in look code |

**Row 5 is not optional.** A helper admitted because the game cannot write it portably, then
shipped web-only, is the exact regression this rule causes. If native pointer lock turns out to
need work this PRD did not budget, the PRD goes to `BLOCKED/` — it does not ship half.

## 5. What this does not claim

Not that first-person feel is solved. Sensitivity curves, acceleration, invert-Y and per-platform
tuning stay in game code, and nobody has played a ThreeNative first-person game for five minutes.
Not that touch look works — a drag-to-look mapping on a phone is a separate question this PRD does
not open. Not that the gamepad right stick is wired to anything.
