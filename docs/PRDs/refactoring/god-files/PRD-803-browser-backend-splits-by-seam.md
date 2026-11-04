# PRD-803 — `browser-backend.ts` splits by seam

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: Bridge crossing counts and the attributed caller file are unchanged after the split. proof: `pnpm exec vitest run packages/three-native/__tests__/bridge-crossings.spec.ts packages/three-native/__tests__/bridge-reads.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: `browser-backend.ts` is under 2 000 lines, no new file exceeds 1 000, and no existing spec assertion changes. proof: `wc -l` and `git diff packages/three-native/__tests__/` — Evidence: pending.
- [ ] AC-3 [local]: The ABI smoke passes against a built module. proof: `tests/browser-backend-smoke.ts` with `tn-native-engine-abi-module` built — Evidence: pending.
- [ ] AC-4 [local]: A template runs on the default web engine. proof: `pnpm test:templates` for the starter kit — Evidence: pending.

## Integration Ledger

Integration: unchanged — `browser-entry.ts` and `browser-renderer.ts` stay the consumers, through the same exports.

## Execution Phases

#### Phase 1: pin
**Status:** NOT STARTED
**Files:** `packages/three-native/__tests__/bridge-caller.spec.ts` (new)
- [ ] A spec asserts the caller file name each bridge counter records for a fixed call. Green on today's code. proof: `pnpm exec vitest run packages/three-native/__tests__/bridge-caller.spec.ts`
- [ ] The ABI smoke runs green on today's code and its result is recorded. proof: AC-3

#### Phase 2: extract types, marshal and runtime
**Status:** NOT STARTED
**Files:** `packages/three-native/src/browser-{abi-types,marshal,wasm-runtime}.ts` (new), `browser-backend.ts`, `bridge-meter.ts`, `debug-telemetry.ts`, `__tests__/browser-entry.spec.ts` (spy target only)
- [ ] Three modules extracted; regex and default caller updated. proof: AC-1 and the Phase 1 spec

#### Phase 3: extract views and sync
**Status:** NOT STARTED
**Files:** `packages/three-native/src/browser-{value-views,attribute-sync}.ts` (new), `browser-backend.ts`
- [ ] Two modules extracted. proof: AC-1, AC-2, AC-3
- [ ] A template runs. proof: AC-4
