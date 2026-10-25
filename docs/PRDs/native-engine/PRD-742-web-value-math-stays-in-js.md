# PRD-742 — Value math stays in JS on the web Wasm engine

**Status:** IN PROGRESS — engine implemented; AC-1 met, AC-2 improved 9.7x but above its target; visual judge and Midway open.
**Priority:** P1 — on the default web engine every `Color`, `Quaternion`, `Matrix4`, `Euler`, `Vector2` and `Box3` call crosses the Wasm facade, about 200x the cost in three.js; Hop Garden's sky alone spends 7.7 s of main thread in it at load.
**Complexity:** 5 (MEDIUM)
**Owner:** João
**Depends on:** none. Related: PRD-573 step 4a (the same split for the native V8 player, which ships it by default through `TN_NATIVE_JS_MATH`), PRD-612 (the web Wasm engine beats three.js on Midway).

## Context

On the web Wasm engine (the default since 2026-10-15), only `Vector3` and `MathUtils` are JS (`packages/three-native/src/browser-math.ts`). Every other three value class is a native wrapper, so each method call goes through the facade glue (`packages/three-native/src/browser-backend.ts`) into Wasm and back. The native V8 player already runs all ten value classes as JS (`math_bridge.cpp` `kNames`: Vector2, Vector3, Vector4, Quaternion, Euler, Matrix3, Matrix4, Color, Box3, Sphere). The web facade never got the same split.

### Profile: Hop Garden launch (2026-10-24)

One launch of a fresh collectathon scaffold (consumer tarballs of 15:59), RTX 2080, headed WebGPU on private Xvfb, CDP CPU profile at 1 ms sampling. `TN_FRAME_HITCH` gapMs was 9,733. The longest main-thread busy stretch was 12.9 s, from the start of `load()`.

| Inclusive share of the 12.9 s | Function |
| --- | --- |
| 71.5% | `Play.load` (`src/scenes/Play.ts:68`) |
| 59.9% (about 7.7 s) | `skyTexture` (`src/render/sky.ts:95`, called as `skyTexture()` at 2048x1024) |
| 56.5% | facade `value` (web-engine-runtime.js) |
| 47.7% | facade `scoped` |
| 41.4% | facade `invoke` |
| 12.2% | Wasm (`wasm-function[5164]`) |
| 11.0% | `buildCourse` (`Course.ts:240`) |

Top self time: facade `alloc` 6.7%, `toEngine` 5.5%, `countCall` 4.9%, `invoke` 4.8%, Wasm 4.6%, `wrap` 4.5%, `value` 3.0%, `writeValue` 2.5%. The cause is `texel.copy(base).lerp(...)` and the cloud lerps on three `Color` objects for each of the 2.1 M texels (`sky.ts:147-202`). Almost all of the cost is JS glue around the call, not the Wasm work. The startup warm-up took 15 ms, so shader compilation is not the cause.

### Micro-measure (2026-10-24)

1 M calls per row, in the page of a fresh racing scaffold, the same machine and the same pack, with the owned engine and then `engine: "threejs"`. Three runs each. Milliseconds per 1 M calls:

| Call | Owned web engine | three.js | Ratio |
| --- | --- | --- | --- |
| `Color.lerp` | 796-939 | 4 | about 200x |
| `Color.copy` | 768-1014 | 1 | about 800x |
| `Vector2.add` | 763-789 | 3 | about 260x |
| `Quaternion.multiply` | 765-787 | 6 | about 130x |
| `Matrix4.multiply` | 774-805 | 18-19 | about 42x |
| `Euler.set` | 827-924 | 3-6 | about 190x |
| `Box3.expandByPoint` | 1160-1215 | 17-28 | about 50x |
| `Vector3.add` (already JS) | 3 | 5-15 | 1x |

Each crossing costs about 0.8 µs, whatever the work. `Vector3` shows the fix works: it is as fast as three.js.

## Solution

Extend `browser-math.ts` to the nine remaining value classes the V8 player already runs as JS. Use the `Vector3` pattern that `browser-backend.ts` already has (`IValueClass`, the pooled loans):

- A `new Color()` is a plain JS value. Its arithmetic never calls the engine.
- An engine-owned value (`material.color`, `light.color`, `object.quaternion`, `object.matrixWorld`) is the same class over the engine's memory. So `copy`, `lerp` and the rest run the same code on both.
- A JS value crosses to the engine by value, and only when an engine call takes it. A method borrows a pooled engine object and copies the lanes back. A constructor or setter turns the value into an engine object in place, so identity survives.

Borrow three r185's classes (MIT), as `browser-math.ts` does for `Vector3`.

### Risks

- **Colour management.** `Color.setHex`, `setStyle` and `getHex` apply `ColorManagement` conversions. The JS class must give the same linear values the engine's C++ `Color` gives today, or every material colour shifts. The parity rows and a visual judge must hold this.
- **Euler and Quaternion sync.** `Object3D.rotation` and `quaternion` keep each other in step through `_onChange`. Over engine memory, a write must reach the engine's transform, like step 4b of PRD-573 does natively.
- **Matrix elements as views.** On the V8 player `Array.isArray(matrix.elements)` is false for engine matrices (PRD-573 4b). The same difference appears here, and game code that spreads or `concat`s `elements` sees it.
- **Aliasing.** A native object that keeps a JS math argument (curve points, a `Box3` stored on geometry) holds a copy and does not alias the caller's value. This is a known difference already on the V8 player.
- **Bundle size.** Nine more classes go into `web-engine-runtime.js`. The facade is about 1 MB now.

## Acceptance Criteria

- [x] AC-1: on the owned web engine, each micro-measure row above is within 3x of three.js. proof: the micro-measure script on a fresh scaffold, both arms, 3 runs each — DONE 2026-10-24 (Node, real Wasm ABI module, 3 runs): Color.lerp 5/4 ms, copy 5/5, Vector2.add 5/4, Quaternion.multiply 9/9, Matrix4.multiply 36/37, Euler.set 4/4, Box3.expandByPoint 8/7, Vector3.add 4/4 (owned engine / three.js per 1 M calls); 0 crossings. Not the scaffold page: the ABI is the same module the page uses.
- [ ] AC-2: Hop Garden's original `sky.ts` (before the game-side plain-number fix) spends under 0.3 s in `skyTexture` at launch. proof: the CDP CPU profile recipe above — OPEN: the original sky on the old engine spends 6336.9 ms in skyTexture at launch; the new engine spends 653.5 ms (CDP 1 ms, RTX 2080, launch window), a 9.7x cut but above 0.3 s. The rest is per-texel JS math (convertLinearToSRGB, allocation), not crossings; the game-side plain-number fix is the hop-garden-look lane.

## Blocked on

Nothing.

## Decisions

- 2026-10-24, team lead: the game-side fix (plain-number lerps in Hop's `sky.ts`) goes to the hop-garden-look lane. This PRD fixes the engine, so that every game's CPU-side value math gets fast, not only Hop.

- 2026-10-24: browser-math.ts imports three's math modules, as the V8 player bundles them; the web-engine bundler permits three/src/math/* only from the runtime's own module and still refuses a game's deep import.

## Execution Phases

### Phase 1 — Colour and the call guard

- [x] `Color` is JS in `browser-math.ts`, and engine-owned colours (`material.color`, `light.color`, `scene.background`) are the same class over engine memory. proof: a `packages/three-native/__tests__` spec with a counting runtime stub: 10k `lerp`/`copy`/`setHex` calls on a JS colour make 0 engine calls (red first), and `vitest run packages/three-native` — DONE 2026-10-24: browser-value-math.spec.ts proves 0 engine calls over 10k Color lerp/copy/setHex; `vitest run packages/three-native` 349/349 pass.
- [ ] Colour management matches the engine: `setHex`, `setStyle`, `getHex` and `getStyle` give the same linear values as the C++ `Color` for the sRGB and linear working spaces. proof: the same spec against values read from the engine; `pnpm parity` colour rows unchanged — OPEN: the same spec matches three r185 setHex/setStyle/getHex/getStyle; `pnpm parity --target web --engine threenative --only-tests 63-color-management` fails at TN_NATIVE_UNCATALOGUED_COLORMANAGEMENT (the engine binds no ColorManagement), which predates this change. Colour rows 16-vertex-colors, 22-hemisphere-light and 71-tsl-color-node pass 3/3. Follow-up review found reversed Color and Vector4 constructor lanes during promotion; explicit constructor-order plans fix both (regression red: 2 failed; green: 12/12 focused, 357/357 package tests). Engine colour-space comparison remains open.
- [ ] No visual change on two kits. proof: Hop Garden and Clover Cup captures, BEFORE/AFTER, 2 runs per arm, fresh visual judge NEUTRAL or better — OPEN: two-kit BEFORE/AFTER captures and the fresh visual judge are not run.

### Phase 2 — The other value classes

- [x] `Quaternion` and `Euler` are JS, with three's `_onChange` sync over an engine-owned `Object3D`. proof: spec with a 0-call guard over 10k operations and a rotation-to-quaternion sync case; `pnpm parity` — DONE: the spec guards Quaternion/Euler over 10k ops with 0 calls; native_engine_wasm_browser_backend passes TN_BROWSER_BACKEND_OK, including the in-place rotation-to-quaternion sync. pnpm parity has no math rows.
- [x] `Matrix3` and `Matrix4` are JS, with engine-owned `matrix` and `matrixWorld` as views. proof: spec with a 0-call guard; `pnpm parity` — DONE: the spec guards Matrix3/Matrix4 over 10k ops with 0 calls; the real-Wasm smoke keeps Matrix4 copy and equals over memory.
- [x] `Vector2`, `Vector4`, `Box3` and `Sphere` are JS. proof: spec with a 0-call guard for each; `vitest run packages/three-native` — DONE: the spec guards Vector2, Vector4, Box3 and Sphere over 10k ops with 0 calls each.

### Phase 3 — Outcome

- [ ] The micro-measure and the Hop sky profile meet AC-1 and AC-2. proof: the micro-measure script and the CDP CPU profile, recorded beside AC-1 and AC-2 — PARTIAL: AC-1 met; AC-2 improved but above target (see AC rows).
- [ ] Midway frame CPU on the web Wasm arm stays the same or improves. proof: `flight.sh native` against the PRD-612 baseline, 3 pairs — OPEN: not measured.
