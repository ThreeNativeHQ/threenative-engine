# PRD-803 — `browser-backend.ts` splits by seam

**Status:** IN PROGRESS — five modules extracted, `browser-backend.ts` 3 405 → 1 810 lines, AC-1 and
AC-2 green; AC-3 and AC-4 were not run by this lane (no built ABI module in the tree, and
`pnpm test:templates` is outside its scoped commands), see below.
**Priority:** P2 — `defineBrowserClasses` is one 2 125-line closure, and the ABI paths `gltfOf` and `tslOf` have no unit spec (all phases open).
**Complexity:** 5 (MEDIUM); risk override: the web engine's bridge counters filter stack frames by file name
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [God files](README.md)

## Context

Read-only audit, 2026-11-04:

- `packages/three-native/src/browser-backend.ts` is 3 405 lines: public types (22–140), marshalling helpers (141–407), `defineBrowserClasses` (408–2 533: value plans and views 759–1 200, wrapper and GC bookkeeping, attribute sync 1 223–1 320, an 800-line per-class loop 1 495–2 290), ABI types with `gltfOf` and `tslOf` (2 534–2 876), `createWasmRuntime` (2 877–3 349).
- Hazards: `bridge-meter.ts:92` filters frames with the regex `browser-backend|debug-telemetry|bridge-meter`, and `debug-telemetry.ts:29` defaults its caller to `browser-backend.ts`; a new file must join both. `browser-entry.spec.ts` spies on `backend.createWasmRuntime`, which a re-export can break.
- The package ships `src/**/*.ts` and consumers deep-import it, including `packages/core/__tests__/softbody.spec.ts`.
- Pinned by about 18 specs (`browser-backend-coverage`, `browser-renderer`, `bridge-crossings`, `bridge-reads`, `browser-math`, `browser-value-math`, `flag-write-crossings`, and others). `gltfOf` and `tslOf` against the real ABI are covered only by `tests/browser-backend-smoke.ts`, which needs a built `tn-native-engine-abi-module`.

## Solution

Pin, then extract in order: `browser-abi-types.ts`, `browser-marshal.ts`,
`browser-wasm-runtime.ts`, `browser-value-views.ts`, `browser-attribute-sync.ts`. The new names join
the frame-filter regex before the runtime moves. The per-class loop stays in
`defineBrowserClasses`. `browser-backend.ts` re-exports every moved value, and the spy moves to the
module that defines `createWasmRuntime`.

## Acceptance Criteria

- [x] AC-1 [local]: Bridge crossing counts and the attributed caller file are unchanged after the split. proof: `pnpm exec vitest run packages/three-native/__tests__/bridge-crossings.spec.ts packages/three-native/__tests__/bridge-reads.spec.ts` — Evidence: exit 0, `Test Files 2 passed (2)`, `Tests 48 passed (48)` (bridge-crossings 27/27, bridge-reads 21/21), run after Phase 3 with not one assertion in either file touched. The same pair was 48/48 before the first move. Crossing counts are unchanged; the only recorded value that moved is `__tnDebugSources[name].caller`, for the five counters the runtime now adds itself (`wasmGrowthEvents`, `wasmGrowthBytes`, `bridgeScratchBytes`, `bridgeOverflowAllocations`, `bridgeOverflowBytes`), and the Phase 1 spec pins that name to a file that exists.
- [x] AC-2 [local]: `browser-backend.ts` is under 2 000 lines, no new file exceeds 1 000, and no existing spec assertion changes. proof: `wc -l` and `git diff packages/three-native/__tests__/` — Evidence: `browser-backend.ts` 3 405 → 1 810 lines. New files: `browser-abi-types.ts` 423, `browser-marshal.ts` 79, `browser-wasm-runtime.ts` 505, `browser-value-views.ts` 616, `browser-attribute-sync.ts` 180; the largest is 616. `git diff --stat packages/three-native/__tests__/` names exactly one file, `browser-entry.spec.ts`, `2 insertions(+), 1 deletion(-)`: the spy's target module and the import that names it, no assertion. `bridge-caller.spec.ts` is a new, untracked file.
- [ ] AC-3 [local]: The ABI smoke passes against a built module. proof: `tests/browser-backend-smoke.ts` with `tn-native-engine-abi-module` built — Evidence: NOT RUN. `packages/runtime-native/build/wasm/` holds static libraries only (`libtn_engine_*.a`); no `tn-native-engine-abi-module.js` exists anywhere in the tree, and building one is `pnpm native:build` (emcc, downloads its dependencies, writes a build directory shared with other lanes). What is proven instead: `pnpm --filter @threenative/three-native typecheck` compiles `tests/browser-backend-smoke.ts` against the moved exports, so every symbol it imports (`createWasmRuntime`, `defineBrowserClasses`, `engineRef`, `TSL_NODE`, `IEngineRef`, `IRegistryDump`, `TnAbiModule`) still resolves from `browser-backend.ts`.
- [ ] AC-4 [local]: A template runs on the default web engine. proof: `pnpm test:templates` for the starter kit — Evidence: NOT RUN, outside this lane's command scope (`pnpm test:templates` writes `dist/` and generated files into a worktree several agents share). Left to the parent.

## Integration Ledger

Integration: unchanged — `browser-entry.ts` and `browser-renderer.ts` stay the consumers, through the same exports. Evidence: neither file changed; `texture-sources.ts`, `browser-tsl.ts`, `temp-node.ts`, `tests/browser-backend-{smoke,gc,glue-bench}.ts` and the eleven specs that deep-import `browser-backend.js` all still compile and pass (AC-1), and `createWasmRuntime` is re-exported, so `browser-entry.ts:158`'s call site is the same line.

## Decisions

- **The two stateful modules declare what they captured.** `browser-value-views.ts` and
  `browser-attribute-sync.ts` were closures inside `defineBrowserClasses` (the audit's lines 759–1 200
  and 1 223–1 320), sharing `runtime`, `registry`, `refOf`, `adopt`, `wrap`, `hold`, `addressOf`,
  `rotations`, `quaternions` and `sharedTransformWrite` with it. A closure cannot cross a file boundary
  without its inputs, so each exports one `define…(host)` taking exactly those values and returning
  exactly the functions the per-class loop calls: the loop destructures them under the same names, so
  its call sites are untouched. No state is duplicated — the shadows, the loan pool and the value
  pools are still one set per `defineBrowserClasses` call, which two engines on one page need — and
  nothing is added beyond the seam: no option, no default, no new branch.
- **Which types went with the ABI.** `browser-abi-types.ts` owns `IEngineRef`, `EngineValue`,
  `IBrowserRuntime`, `IPackedRef` and `TnAbiModule` together with the layout constants and
  `gltfOf`/`tslOf`; the alternative was that module importing the runtime interface back from
  `browser-backend.ts` to describe the calls it implements. `browser-backend.ts` re-exports the four
  public ones (`IPackedRef` was private before and stays private), so every consumer's import line is
  unchanged.
- **`denormalize` and `ATTRIBUTE_CLASSES` sit in `browser-attribute-sync.ts`, not in
  `browser-marshal.ts`,** although the audit's helper region is where they were found: both are
  attribute concerns (three's normalized-lane denormalization, the attribute class list) and their
  only consumers are the attribute code in the two files that keep an attribute's shadow and define
  its surface.
- **`eulerFromQuaternion` moved with the value views.** Its one caller is the Quaternion view's
  `_onChangeCallback`. It stays exported from `browser-value-views.ts` and re-exported from
  `browser-backend.ts`; `bridge-crossings.spec.ts`, which imports it from `browser-backend.js`, passes
  unchanged.
- **A moved counter names its own file.** `debug-telemetry.ts`'s default caller stays
  `browser-backend.ts`, because the counters that rely on it (`bridgeWrappersCreated`,
  `bridgeWrappersReleased`, `bridgeWrapRequests`, the shared-transform pair) still live there. The
  runtime's five counters pass `browser-wasm-runtime.ts`. A default cannot be "updated" for a file it
  no longer describes, and rewriting it into a stack lookup would change every defaulted caller's
  recorded value, which AC-1 forbids.
- **`pnpm quality`'s baseline needs one prune by the parent.** `docs/verification/quality-baseline.json`
  carries a `file-cap` row for `packages/three-native/src/browser-backend.ts` at 3 405 lines against
  the 3 000 cap. The row is now stale (1 810). `scripts/check-quality.ts:486` fails only a `new` or
  `grew` file-cap finding, so the gate is green and leaves the row alone;
  `pnpm quality --update-baseline` should drop it, and that file is this lane's forbidden file.

## Execution Phases

#### Phase 1: pin
**Status:** DONE
**Files:** `packages/three-native/__tests__/bridge-caller.spec.ts` (new)
- [x] A spec asserts the caller file name each bridge counter records for a fixed call. Green on today's code. proof: `pnpm exec vitest run packages/three-native/__tests__/bridge-caller.spec.ts` — Evidence: exit 0, `Tests 2 passed (2)`, run before a single line moved (13:22, against the unmodified 3 405-line file). It pins three fixed calls: `mesh.applyMatrix4(new Matrix4())` and `mesh.rotation._order = "YXZ"` inside a named function, for which the counter source `__tnDebugSources["bridge:call Mesh.applyMatrix4"]` and `["bridge:set Euler.order"]` must name that function and must NOT match `/browser-[a-z-]*\.ts/`; and `bridgeWrappersCreated`, added with no caller, which must name an existing file under `packages/three-native/src/`. Negative control after Phase 3: dropping `browser-value-views` from `bridge-meter.ts`'s frame filter reds the first case (`1 failed | 1 passed`, the caller becomes `…browser-value-views.ts:…` instead of `promoteMatrix`), and restoring the filter makes it 2/2 again — so the pin is load-bearing for the regex AC-1 names.
- [ ] The ABI smoke runs green on today's code and its result is recorded. proof: AC-3 — NOT RUN: no built `tn-native-engine-abi-module` in the tree (see AC-3).

#### Phase 2: extract types, marshal and runtime
**Status:** DONE
**Files:** `packages/three-native/src/browser-{abi-types,marshal,wasm-runtime}.ts` (new), `browser-backend.ts`, `bridge-meter.ts`, `debug-telemetry.ts`, `__tests__/browser-entry.spec.ts` (spy target only)
- [x] Three modules extracted; regex and default caller updated. proof: AC-1 and the Phase 1 spec — Evidence: `browser-abi-types.ts` 423 lines (the ABI types, the layout constants, `IAbiHelpers`, `gltfOf`, `tslOf`), `browser-marshal.ts` 79 (three's typed arrays and scalar order, `REF`, `TYPED`, the ref test, `Color.set`/`setValues`), `browser-wasm-runtime.ts` 505 (`countCall` and `createWasmRuntime`). `bridge-meter.ts` 237 → 244: the frame filter's inline regex became one named `BACK_END_FILE` constant, the three old names plus the five new ones, so the caller search looks through every file the back end was split into. `debug-telemetry.ts` 115 → 117: the default caller is documented where the moved counters stopped relying on it, and the runtime's five `debug.add` calls name `browser-wasm-runtime.ts`. `browser-entry.spec.ts`: `vi.spyOn(backend, "createWasmRuntime")` → `vi.spyOn(wasmRuntime, "createWasmRuntime")`, one import added, no assertion changed; that spec is 6/6. `pnpm exec vitest run packages/three-native/__tests__` after this phase: 48 of 49 files green, the one red being the pre-existing `shadow-node.spec.ts` (see Phase 3); `pnpm --filter @threenative/three-native typecheck` exit 0.

#### Phase 3: extract views and sync
**Status:** DONE
**Files:** `packages/three-native/src/browser-{value-views,attribute-sync}.ts` (new), `browser-backend.ts`
- [x] Two modules extracted. proof: AC-1, AC-2, AC-3 — Evidence: AC-1 exit 0, 48/48; AC-2 `browser-backend.ts` 1 810 lines, largest new file 616. AC-3 NOT RUN (no built module), stated above. `browser-value-views.ts` 616 lines carries the value plans, `IValueLanes`/`IValuePlan`/`IValueClass`, the loan pool, `toEngineArgs`, `lend`/`repay`/`promote`, `defineValueView`, `toEngine` and `eulerFromQuaternion` to a factory that takes the back end's `runtime`, `registry`, `refOf`, `adopt`, `wrap`, `hold`, `addressOf`, `rotations`, `quaternions` and `sharedTransformWrite`; `browser-attribute-sync.ts` 180 carries the attribute shadow (`arrays`, `itemSizes`, `shapes`, `pending`, `writeBack`, `itemSizeOf`, `rangeOf`, `syncRange`, `syncFull`, `instanceItem`) and the two helpers it exists for. The per-class loop stayed in `defineBrowserClasses`, and every call site in it reads the same names as before. Whole-package run after this phase: `Test Files 1 failed | 48 passed (49)`, `Tests 1 failed | 516 passed (517)` over `packages/three-native/__tests__` plus `packages/core/__tests__/softbody.spec.ts`; the one red is `shadow-node.spec.ts`'s "constructs core's automatic-depth node and installs through the facade setter", proven not this PRD's: restored the pre-split `browser-backend.ts` byte for byte and it fails identically, while the file it exercises, `packages/core/src/render/virtual-shadow.ts`, is being rewritten by another lane on this shared worktree (`git diff` shows its layer constants moving to `virtual-shadow-layers.ts`).
- [ ] A template runs. proof: AC-4 — NOT RUN, see AC-4.
