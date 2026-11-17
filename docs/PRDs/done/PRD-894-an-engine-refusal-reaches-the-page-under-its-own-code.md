# PRD-894 — An engine refusal reaches the page under its own code

**Status:** DONE
**Priority:** P1 — a hosted Studio build reported three engine refusals as "WebGPU is not available on this device", and the agent could not act on them (AC-1 to AC-4)
**Complexity:** 3 (LOW) — 1–5 files (1), native engine rebuild and a release Studio consumes (+2); risk override: none
**Owner:** Claude Code / Codex
**Depends on:** None

## Context

Source: hosted Studio game `27dc1e15-6b14-4a60-8f4d-8f346fb48180`, 2026-11-16, on
`@threenative/core` 0.3.13 and `three` 0.187.0. The game page threw these, and an agent on DeepSeek
V4.1 Flash had to fix them from the text alone:

```
TN_NO_RENDERER: WebGPU is not available on this device and the WebGL fallback could not start, so the game cannot run. WebGPU failed: TN_WASM_PREPARE: TN_NATIVE_BACKGROUND_UNSUPPORTED: sharp EquirectangularReflectionMapping required
TN_NO_RENDERER: WebGPU is not available on this device and the WebGL fallback could not start, so the game cannot run. WebGPU failed: TN_WASM_RENDERER_SINGLE: the Wasm engine drives one renderer per page.
TN_ABI_6: new DataTexture: TN_NATIVE_UNSUPPORTED expected a number
```

The device had WebGPU. Each line is a refusal of the game's own code. Root causes, each read in the
code:

1. **A content refusal is reported as a missing renderer.** The `catch` in
   `packages/core/src/renderer.ts:2155` keeps every WebGPU failure except `TN_WASM_ABI_MISMATCH` as
   `webgpuFailure` and tries WebGL. The native engine refuses WebGL, so the page gets
   `TN_NO_RENDERER` with the real code at the end of the sentence.
2. **A failed start keeps the page's one renderer slot.** `browser-renderer.ts:406` claims the slot in
   the constructor, and only `dispose()` (`:1181`) releases it. The `catch` above does not dispose
   the instance. The next start in the same page (a hot reload) throws `TN_WASM_RENDERER_SINGLE` and
   hides the first error.
3. **One message for two different faults.** `render_database.cpp:1934` throws
   `TN_NATIVE_BACKGROUND_UNSUPPORTED: sharp EquirectangularReflectionMapping required` when
   `scene.background.mapping` is not 303 and also when `scene.backgroundBlurriness` is not 0. It
   names neither the property nor the value it received.
4. **An argument fault does not name the argument.** `abi/binding.h:399` throws
   `expected a number` with no parameter name or position, so `new DataTexture` gives no hint which
   argument is wrong.

The game source shows the cost: its `src/render/sky.ts` carries a comment that records the 64 px
rule the agent found by trial ("a 32 px bake is exactly the bug that shipped a black screen").

## Solution

Four small changes, no new capability.

1. In the `renderer.ts` catch, rethrow an error whose message starts with `TN_WASM_`, `TN_NATIVE_` or
   `TN_ABI_`, the same way `TN_WASM_ABI_MISMATCH` is rethrown. Dispose the instance first.
2. Release the slot when `init()` fails, so the next start reports its own result.
3. Split the background refusal into two messages. Each one names the property, the value it got and
   the value it accepts, for example
   `TN_NATIVE_BACKGROUND_UNSUPPORTED: scene.backgroundBlurriness is 0.4; the engine draws a sharp background only, set it to 0`.
4. `binding.h` takes the parameter position (and the name where the binding table has it) and puts it
   in the message: `new DataTexture: argument 6 (mapping) expected a number, got undefined`.

Studio consumes the result through a release of `@threenative/core`. Nothing here imports Studio.

## Acceptance Criteria

- [x] AC-1 [local]: A game whose start throws `TN_NATIVE_BACKGROUND_UNSUPPORTED` on a WebGPU device rejects with a message that starts with that code and does not contain `TN_NO_RENDERER`. proof: a new case in the `createRenderer` spec of `packages/core` — Evidence: `packages/core/__tests__/renderer.spec.ts` "reports the engine's own refusal, and releases the renderer it built, instead of a device without WebGPU (PRD-894)": `vitest run packages/core/__tests__/renderer.spec.ts` 68 passed; the same case fails on the base source (`TN_NO_RENDERER` in the message, `webgl2Factory` called). The companion case "keeps the named boot failure for a device that cannot start WebGPU" holds the other side: `TN_WASM_ADAPTER` still reads `TN_NO_RENDERER: … WebGPU failed: TN_WASM_ADAPTER: …`, and `TN_WASM_DEVICE_ERROR` is a validation fault that rethrows rather than reading as a device without WebGPU.
- [x] AC-2 [local]: After a start that failed in `init()`, a second start in the same page reports its own error or succeeds, and never `TN_WASM_RENDERER_SINGLE`. proof: a new case in the `browser-renderer` spec of `packages/three-native` — Evidence: `packages/three-native/__tests__/browser-renderer.spec.ts` "gives the page's slot back when a start fails, so the next start reports its own result (PRD-894)": `vitest run packages/three-native/__tests__/browser-renderer.spec.ts` 57 passed; the second `new Renderer({canvas})` throws `TN_WASM_RENDERER_SINGLE` on the base source. The real host's half is `tests/web-host-refusal.test.mjs` (`TN_WEB_HOST_REQUIRE=1`, Chromium under Xvfb): a refused scene leaves `tnw_web_poll` Ready and the same host prepares that scene once fixed — before the host change the same probe printed `stateAfterPrepare: 2` and `recovered: -1`.
- [x] AC-3 [local]: A background with `backgroundBlurriness = 0.4` and a background with `UVMapping` give two different messages, and each names its property and the received value. proof: the native renderer test that owns `render_database.cpp` — Evidence: `render_database_test.cpp` case `background_refusal`: `ctest -R native_engine_background_refusal` PASS (fails on the base source: no message names its property).
- [x] AC-4 [local]: `new DataTexture` with a non-number in a number position throws a message that names the argument position. proof: the ABI binding test that owns `binding.h` — Evidence: `abi_test.cpp` case `argument_position`: `ctest -R native_engine_abi_argument_position` PASS, message `argument 3 (height) expected a number, got a string` (fails on the base source: `expected a number` only).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Renderer start failure | `defineGame` → `createRenderer` → `WebGPURenderer.init()` | Replaces the catch-all fallback for engine codes. A device with no WebGPU keeps `TN_NO_RENDERER` | AC-1, AC-2 |
| Refusal messages | Game code → three-native facade → native ABI | Replaces two message strings | AC-3, AC-4 |

## Execution Phases

#### Phase 1: The page gets the engine's own error

**Status:** DONE
**Files:** `packages/core/src/renderer.ts`, `packages/three-native/src/browser-renderer.ts`, specs.
**Implementation:** Rethrow engine codes after `dispose()`. Keep the fallback for every other failure.
**Verification:** AC-1, AC-2.

- [x] `createRenderer` releases the instance a failed WebGPU start built and rethrows a `TN_WASM_`/`TN_NATIVE_`/`TN_ABI_` message instead of falling back to WebGL, which the engine refuses. proof: `vitest run packages/core/__tests__/renderer.spec.ts` — 68 passed, and the new case fails on the base source. Evidence: 68/68 passed.
- [x] A content refusal in the Wasm host (a refused prepare and a refused frame) fails its own call and leaves the host running, so a start after a refusal answers for itself instead of replaying a dead message; a surface that gives no texture still fails the host. proof: `TN_WEB_HOST_REQUIRE=1 vitest run --config vitest.config.ts tests/web-host-refusal.test.mjs` in `packages/runtime-native` — PASS; the same probe against the base host reports `stateAfterPrepare: 2` and `recovered: -1`. Evidence: 1/1 passed.
- [x] A start that failed in `init()` gives the page's one renderer slot back, so the next start in the same page reports its own result. proof: `vitest run packages/three-native/__tests__/browser-renderer.spec.ts` — 57 passed; the base source throws `TN_WASM_RENDERER_SINGLE` on the second start. Evidence: 57/57 passed.

#### Phase 2: The two refusals say what to change

**Status:** DONE
**Files:** `packages/runtime-native/src/engine/renderer/render_database.cpp`,
`packages/runtime-native/src/engine/abi/binding.h`, tests.
**Implementation:** Two messages for the background rule. The number check takes the parameter
position from its caller.
**Verification:** AC-3, AC-4, then the native and Wasm builds the repository requires for a
`runtime-native` change.

- [x] The background rule names the property, the value it got and the value it accepts, in two messages. proof: `ctest --test-dir build/tn-engine-render -R native_engine_background_refusal` — PASS, and the case fails on the base source. Evidence: 1/1 passed.
- [x] A number argument carries its 1-based position from the ABI and `new DataTexture` names its parameters, so a refusal reads `argument 3 (height) expected a number, got a string`. proof: `ctest --test-dir build/native-engine -R native_engine_abi_argument_position` — PASS, and the case fails on the base source. Evidence: 1/1 passed.
- [x] The native engine core builds and its tests pass on this change. proof: `cmake -S . -B build/native-engine -DTN_ENGINE_CORE_ONLY=ON && cmake --build build/native-engine --target all tn-native-engine-core-tests && ctest --test-dir build/native-engine -L native-engine`. Evidence: 307/307 passed.
- [x] The native coverage record is measured again from this source, so `pnpm budgets` reads a current digest. proof: `pnpm --filter @threenative/runtime-native native:coverage` — exit 0, then `pnpm budgets` exit 0. Evidence: `docs/verification/native-coverage-2026-08-28.md` digest `sha256:bc98e440…`, `src/engine/` 44989 instrumented / 37731 covered (83.87%); it needed `node scripts/download-deps.mjs` and `TN_ENABLE_UI_OVERLAY=0 node scripts/native-build.mjs` first, because the record's lane reads the desktop shipping cache and this machine has no `webkitgtk-6.0`.
- [x] The browser Wasm engine the default `engine: "threenative"` loads builds from this source. proof: `pnpm wasm:build`. Evidence: both presets linked (`build/web/tn-native-engine-web{,-threads}.{mjs,wasm}`), emcc 6.0.11, exit 0, rebuilt after the `web_host.cpp` change.

## Gate results

- `pnpm typecheck` — pass. `pnpm lint` — pass (warnings only, all pre-existing).
- `vitest run packages/core/__tests__/renderer.spec.ts packages/three-native/__tests__/browser-renderer.spec.ts` — 125 passed.
- `ctest --test-dir build/native-engine -L native-engine` (engine core lane, `TN_ENGINE_CORE_ONLY=ON`) — 307/307 passed.
- `ctest --test-dir build/tn-engine-render -R native_engine_background_refusal` (Dawn lane, engine-only configure) — 1/1 passed.
- `pnpm wasm:build` — both Wasm engines built (emcc 6.0.11).
- `TN_WEB_HOST_REQUIRE=1 vitest run --config vitest.config.ts tests/web-host-refusal.test.mjs` (real Wasm host in Chromium under Xvfb) — 1/1 passed; the same test fails against the base `web_host.cpp`. It drives a refused prepare, a refused frame, and the frame that draws once the scene is fixed.
- `pnpm check:docs` — pass. `pnpm budgets` — pass, after the coverage refresh.
- `pnpm --filter @threenative/core test` and `pnpm --filter @threenative/three-native test` (publint) — pass.
- Full `vitest run` — 6 failing files, all of which fail identically on the base tree in this checkout
  (`procedural-animals` needs Node 20.x, `mcp-install`, `doctor`, `generated-shooter-input`,
  `check-publish-state`, `verify-golden-path`). `scripts/__tests__/check-native-coverage.spec.ts` passes.

## Notes

- The native coverage lane needed the desktop shipping cache, which this machine could build with
  `TN_ENABLE_UI_OVERLAY=0` (no `webkitgtk-6.0`) once `node scripts/download-deps.mjs` had fetched V8.
