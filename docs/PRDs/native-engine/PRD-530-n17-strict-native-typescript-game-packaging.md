# PRD-530 — Strict native-TypeScript game packaging (N17)

**Status:** PROPOSED — later milestone (gate T), after promotion; not required by N20 (owner decision 2, 2026-10-04)
**Priority:** P2 — Later milestone (gate T) after promotion, per owner decision 2; 7 open boxes.
**Complexity:** 4 — gate T: compiler, engine and packaging meet in one inspected artifact
**Owner:** João
**Work package:** N17 — [native-engine batch](README.md)
**Depends on:** [N05 — native TypeScript](N05-native-typescript-qualification/README.md), [PRD-499 (N02)](PRD-499-n02-the-host-links-without-a-js-engine.md), and the engine PRDs the chosen game needs; starts after [PRD-533 (N20)](PRD-533-n20-platform-qualification-performance-default-promotion.md) promotes the V8-runtime product

## Context

Gate T (§1) is a representative TypeScript game, written with the familiar imports, compiled to native
code and running on the native engine with no interpreter or JIT. §13 adds the packaging rules:
separate configuration dimensions for engine implementation, game runtime and UI; contradictory
combinations rejected; artifact identity naming engine, ABI, compatibility and shader-package
revisions, compiler identity, architecture, GPU backend and capabilities; checksum-verified prebuilt
SDK artifacts. §17 requires that a game edit rebuilds the game module and its assets, not Dawn, the
engine or LLVM. Packaging today is `packages/runtime-native/scripts/package-desktop.mjs`,
`package-android.mjs` and `install-prebuilt.mjs`; profile resolution lives in `packages/create-threenative`.

## Solution

1. Three configuration dimensions (proposed names, recorded in N00's ADR): engine `legacy | native`,
   game runtime `js | native-aot | cpp`, UI `webview | native | none`. Strict = `native` +
   `native-aot|cpp` + `native|none`; any contradiction fails at configuration time, and a strict
   artifact refuses to dynamically load a JS runtime component.
2. The packager embeds an identity manifest (§13) and a capability list in the artifact; startup
   rejects a mismatched ABI, compatibility or shader-package version before the game starts (§8.2).
3. The compiler and native SDK come from checksum-pinned prebuilt artifacts; a game-only edit relinks
   the game module only.
4. The strict artifact is inspected with N02's JS-free tool, and the inspection result plus the
   identity manifest form the evidence manifest (§15.2).
5. Rollback: the `legacy` engine profile stays selectable; there is no automatic fallback from a
   strict artifact to it (§1).

## Out of scope

- The compiler qualification itself (N05). Release-wide qualification and promotion (N20).

## Execution Phases

#### Phase 1: Profiles and identity
**Status:** NOT STARTED
**Files:** `packages/create-threenative/` (profile resolution), proposed `packages/runtime-native/scripts/package-strict.mjs`
- [ ] Every contradictory engine/runtime/UI combination is rejected with a named error. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-profile.spec.ts`
- [ ] A strict artifact carries the §13 identity manifest and refuses a mismatched ABI at startup. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_artifact_identity`

#### Phase 2: Incremental strict builds
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/scripts/package-strict.mjs`
- [ ] A game-source-only edit rebuilds the game module without recompiling Dawn, the engine or the compiler. proof: `pnpm exec vitest run packages/runtime-native/__tests__/strict-incremental-build.spec.ts`
- [ ] Prebuilt SDK and compiler artifacts are refused on checksum mismatch. proof: `pnpm exec vitest run packages/runtime-native/__tests__/strict-prebuilt-checksum.spec.ts`

#### Phase 3: Gate T
**Status:** NOT STARTED
**Files:** proposed representative game under `examples/`
- [ ] The representative TS game's strict Linux artifact passes JS-free inspection: no VM, no WebView, no embedded script. proof: `node packages/runtime-native/scripts/inspect-js-free.mjs --binary <strict linux artifact>`
- [ ] That inspected artifact runs its playtest journey end to end on desktop. proof: `node packages/playtest/dist/runner/cli.js <game>.playtest.json --target desktop`
- [ ] The same game's strict Android artifact passes its journey on the emulator. proof: `node packages/playtest/dist/runner/cli.js <game>.playtest.json --target android`

## Blocked on

- Choosing the representative game for gate T: owner decision (João).
- The strict Android artifact on physical hardware: the owner's attached device.
