---
prd_contract: v1
---

# PRD-239 — Camera intent is one portable gesture stream

**Status: DONE (web + native contract), 2026-08-29.** `scroll` and `pinch` bindings ship on
`IInputAction`, so one `axis()` reads wheel and pinch alike. Evidence:
[PRD-239.md](../../verification/PRD-239.md) and
[the callback continuation](../../verification/PRD-239-callback-continuation.md) — typecheck,
budgets and the native wheel/multitouch contract test PASS. **Native runtime execution is
UNVERIFIED**: the contract is proven, a running native host is not.

Source of the borrowed technique:
[`yomotsu/camera-controls`](https://github.com/yomotsu/camera-controls), MIT, cloned at depth 1 on
2026-08-28. **Only its gesture table is mined.** Its camera rig — the part everyone means when they
name it — is refused, for a reason this repository already wrote down.

Parent batch: feature-mining.

**Complexity:** +2 new input surface with a platform seam on four targets, +1 touches ≤5 files in
core, +1 native host work, +1 template edit = **5 → MEDIUM mode.**

## The question, and it is smaller and harder than "add camera controls"

**There is no zoom axis.** `IInputAction` (`packages/core/src/input.ts:21-47`) binds keyboard codes,
mouse buttons, gamepad buttons, "any pointer", and relative mouse motion. It does not bind scroll,
and `packages/core/src/input.ts` contains **zero** occurrences of `wheel`, `deltaY` or `scroll`.

So a game that wants the player to zoom does the only thing available:

```ts
window.addEventListener("wheel", (e) => { distance += e.deltaY * 0.01 })
```

…which is a browser global, reaching past the framework, and **it is dead on native**:
`packages/runtime-native/shim-manifest.json` installs `Event`, `KeyboardEvent`, `PointerEvent` and
`TouchEvent`, and no `WheelEvent`. The game runs on desktop and the zoom silently never fires.

Pinch is the same shape one level up. `IRawInputState.pointers` (`input.ts:82-95`) gives every live
pointer with an id and a position, so two-finger distance is *derivable* — and every game derives it
again, including the sign conventions, the dead zone, the "third finger arrived" case, and the
"one finger lifted, do not teleport" case.

Two questions, per the charter:

- **(a) Could the game write this portably itself?** No. Scroll input does not exist in the portable
  surface, and the only web way to get it is a global the native host does not install. This is a
  platform seam by the strict definition.
- **(b) Does it decide how anything looks?** No — **and this is the boundary the PRD is built
  around.** It delivers *intent*: "the player asked to dolly in by 0.4". Where the camera then goes,
  how fast it damps, what it collides with and what it frames stays in `src/render/camera.ts`.

## What is refused, and why it was already decided

`templates/starter/src/render/camera.ts:8-9`, generated into every scaffolded game:

> Camera framing is one of the loudest things in a screenshot, so it lives here in your repo rather
> than behind a framework option.

Seven templates own a rig each — 186 lines total, none of them the same, because a platformer, a
racer and a top-down RPG do not frame alike. Absorbing `camera-controls`' rig would replace seven
deliberate, editable, screenshot-defining files with one framework option, which is precisely what
rule 1(b) vetoes. **`CameraControls` the class is not coming here.** Its damping math is 12 lines a
template can hold and already does (`starter/src/render/camera.ts:53-56`).

## What the source actually contains, and what is taken

| Claim | Evidence |
| --- | --- |
| 3 707 lines in `src/`, of which the rig, the collision and the transition machinery are the bulk | `src/CameraControls.ts` |
| The mined part is a **table**: which physical gesture maps to which intent, per input device and per finger count | `src/CameraControls.ts:314-342` — `mouseButtons.wheel`, `touches.one`, `touches.two`, `touches.three`, each naming `ROTATE` / `TRUCK` / `DOLLY` / `ZOOM` / `OFFSET` / `NONE` |
| It distinguishes **dolly** (move the camera) from **zoom** (change the lens), which most hand-rolled code conflates and then cannot fix | same table; `ACTION.DOLLY` vs `ACTION.ZOOM` |
| 27 lines of `CameraControls.ts` touch `document` / `HTMLElement` / `PointerEvent` — the part this repository already owns through `InputMap` | `grep -c` over `src/CameraControls.ts` |

The taken idea is one sentence: **a gesture is not an event, it is an intent with a device-specific
source, and the mapping belongs in one table rather than in every game.**

## Design

```ts
// game.ts — bindings, beside the existing move/jump/fire
input: {
  bindings: {
    zoom:  { scroll: true, pinch: true, gamepadAxes: [3] },
    orbit: { pointerRelative: true, drag: 2, gamepadAxes: [2, 3] },
  },
}

// scenes/Play.ts — intent, per frame, same on every target
const dolly = ctx.input.axis("zoom");     // −1…1 this frame; 0 when nothing asked
rig.dolly(dolly, dt);                     // what that means is the template's, in src/render/
```

- `scroll: true` binds the wheel on web and **the platform's scroll gesture on native**, which is
  the part the host has to grow.
- `pinch: true` derives a signed scale delta from `IRawInputState.pointers` — two fingers only,
  ignoring a third, and never emitting a jump when a finger lifts.
- `axis(name)` joins `vector(name)` on `InputMap` as the scalar sibling it never had.
- **No camera object is touched by this PRD.** If nothing calls `rig.dolly`, nothing moves.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `InputMap.vector(name)` — `packages/core/src/input.ts:230` | Sibling. `axis()` is the 1-D case and reuses the same tick and dead-zone handling. |
| `pointerRelative` binding + `IRawInputState.pointer.relative` | **Already the orbit input on mouse**, used by `templates/shooter/src/scenes/Play.ts:129`. Unchanged; this PRD adds the touch and gamepad sources beside it. |
| Seven `templates/*/src/render/camera.ts` rigs | **Untouched by phases 1–2.** One template gains a zoom in Phase 3 because a feature no game uses is not proven. |
| `packages/runtime-native/shim-manifest.json` | **Edited** — a scroll/pinch source is a host contract change, and the manifest is the enforced list. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `InputMap.axis(name)` + `scroll` / `pinch` binding keys | `packages/core/src/game.ts:622` builds `InputMap` from config | `window.addEventListener("wheel", …)` in game code (unportable, undocumented) | n/a — nothing in-repo uses it; the template gains the supported path in Phase 3 | unbind `scroll` → the axis reads 0 and the zoom playtest reds |
| 2 | Web scroll source | `packages/core/src/input.ts` browser listener install | nothing | n/a | dispatch a wheel event with the listener removed → axis stays 0 |
| 3 | Native scroll/pinch source | `packages/runtime-native` input host → `IRawInputState` | nothing | n/a | native conformance case: host emits a scroll sample, `axis("zoom")` must read non-zero |
| 4 | Pinch derivation from two pointers | `packages/core/src/input.ts` `tick()` at `:327` | per-game two-finger math | n/a | feed a synthetic two-pointer sequence with the derivation disabled → axis stays 0 |
| 5 | A template that actually zooms | one `templates/*/src/scenes/*.ts` + its `src/render/camera.ts` | nothing | n/a | remove the `rig.dolly` call → the playtest's framing assertion reds |

## Execution Phases

### Phase 1 — `axis()` and the wheel, on web, proven by a scenario

**Files (4):** `packages/core/src/input.ts` (EDIT), `packages/core/src/index.ts` (EDIT — types),
`packages/core/__tests__/input.spec.ts` (EDIT), `examples/abyss-framework/playtests/*.json` (NEW).

- [ ] `axis(name)` returns a number in `[-1, 1]`, resets per tick, and is 0 with nothing bound —
      the same lifecycle `vector()` already has.
- [ ] `scroll: true` accumulates normalised wheel delta. Normalisation is stated: browsers report
      `deltaMode` in pixels, lines or pages, and a game must not have to know which.
- [ ] Sign convention is written into the doc comment and matched by a test, because a zoom that
      goes the wrong way is a bug report every single time.

| Test file | Test name | Assertion | Negative control |
| --- | --- | --- | --- |
| `input.spec.ts` | `should report a positive zoom axis when the wheel scrolls toward the user` | sign and magnitude | flip the sign in the source → reds |
| `input.spec.ts` | `should reset the axis to zero on the next tick with no further input` | 0 after tick | drop the reset → the camera drifts forever, reds |
| `input.spec.ts` | `should normalise line-mode and pixel-mode wheel deltas to the same axis value` | equal within tolerance | ignore `deltaMode` → 30× discrepancy, reds |

### Phase 2 — pinch, and the native source

**Files (5):** `packages/core/src/input.ts` (EDIT), `packages/runtime-native/src/…` input host
(EDIT), `packages/runtime-native/shim-manifest.json` (EDIT), a native conformance case
(`packages/runtime-native/conformance/registry.json`, EDIT), `input.spec.ts` (EDIT).

- [ ] Pinch: two-pointer signed scale delta, third pointer ignored, no discontinuity when a finger
      lifts, no emission from a single pointer.
- [ ] The native host delivers scroll and pinch into the same `IRawInputState` the web path fills,
      so `input.ts` has exactly one derivation and no `isNative` branch.
- [ ] **A conformance case proves it on native in this same phase**, per the native contract. Not a
      follow-up, not a promise.

| Test file | Test name | Assertion | Negative control |
| --- | --- | --- | --- |
| `input.spec.ts` | `should report zero pinch while only one pointer is down` | 0 | derive from `pointers.size >= 1` → non-zero, reds |
| `input.spec.ts` | `should not jump when the second finger lifts mid-pinch` | delta ≤ dead zone | drop the lift guard → a large spike, reds |
| conformance | `native host scroll reaches axis("zoom")` | non-zero on native | stub the host source out → 0, case reds |

### Phase 3 — one game zooms, on a phone

**Files (3):** one template's scene (EDIT — read the axis), that template's
`src/render/camera.ts` (EDIT — what dolly means there, because that is look and lives in generated
source), its playtest (NEW/EDIT).

- [ ] The chosen template zooms with the wheel on desktop and with a pinch on Android.
- [ ] The scenario asserts a framing change — a measured camera distance or a scene-scale
      observation — **not** that an input was received. "The axis read 0.4" is artifact-scoped and
      is satisfiable by a build the player cannot tell apart from the last one.
- [ ] Android run is a real device run, `--target android`, pasted.

## Acceptance criteria (consumer-scoped)

- [ ] A player scrolls the wheel on desktop and pinches on Android in the same shipped game, and the
      camera distance changes the same way on both — one binding, no `isNative` branch in the game.
- [ ] A game can bind zoom without writing `window.addEventListener`, and the capability manifest
      answers *"let the player zoom the camera"* with that binding.
- [ ] Zoom direction matches platform convention on both, stated in the docs and asserted in a test.
- [ ] Removing the scroll binding makes a pre-existing playtest fail — pasted.
- [ ] No template's camera rig moved into a package; `templates/*/src/render/camera.ts` still owns
      every framing decision, and the diff shows it.
- [ ] `pnpm budgets` passes, including the shim-manifest checker with the new host source recorded.

## Kill switch

`count-loc.ts` against the honest alternative: a game supporting wheel **and** pinch **and** a
gamepad stick, on web and native. If the framework version is not smaller than that — and it must
be compared against the portable requirement, not against the three-line web-only version that does
not ship — it is deleted.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`yomotsu/camera-controls` @ `c5160110`**.

| To implement | Read |
| --- | --- |
| the gesture table — which device gesture maps to which intent, per finger count | `src/CameraControls.ts:314-342` |
| the dolly-vs-zoom distinction most hand-rolled code conflates | the `ACTION` enum, same file |
| **do NOT borrow** — framing is the template's, already decided | the rig, damping, collision and transition machinery (the bulk of `src/CameraControls.ts`) |
