# PRD-497 — Architecture decision, scope and compatibility inventory (N00)

**Status:** PROPOSED — decisions approved by the owner 2026-10-04; the record and inventory are not yet written
**Priority:** P1 — Wave 1 of the owner-approved batch: the decision record and compatibility inventory every other native-engine PRD names is unwritten (6 open boxes).
**Complexity:** 3 — docs and one inventory script; no runtime code, but it reverses standing product rules
**Owner:** João
**Work package:** N00 — [native-engine batch](README.md)
**Depends on:** None

## Context

The batch changes what the native package is. `packages/runtime-native/AGENTS.md` says it is "a host, not a renderer", keeps upstream `WebGPURenderer` primary, and rules out a custom C++ renderer and a native GLTF replacement (§3, R1). `docs/architecture/CHARTER.md` outranks AGENTS.md and lists "a second renderer" and "an IR, a compiler" among the things that killed v1. The reversal therefore needs a recorded decision before any engine code lands (§3).

The compatibility target is the workspace-pinned `three: 0.185.1` in `pnpm-workspace.yaml`, with the patch `packages/core/patches/three@0.185.1.patch` (§2.2). §11.3 requires every module under `packages/core/src` (108 entries today) to be classified before porting starts.

## Solution

1. **Decision record** (proposed: `docs/architecture/NATIVE-ENGINE-DECISION.md`) carrying the ten decisions under `## Decisions` below, word for word in substance. It quotes the charter rules it amends in plain words.
2. **Charter and package docs follow the executables.** `CHARTER.md`, `packages/runtime-native/AGENTS.md` and `docs/architecture/NATIVE-RUNTIME.md` get only a pointer to the record now. Their rule text changes in the commit that ships the first native-engine artifact (gate E, [PRD-499](PRD-499-n02-the-host-links-without-a-js-engine.md)), because primary docs name only shipped things.
3. **Definitions** in the same record: native engine, game runtime, native-engine artifact (engine JS-free, game code on a VM — the first product), strict native artifact (no VM at all — gate T), WebView-UI labelling (§2.1), and the non-goals (§2.3). The configuration dimensions are engine implementation × game runtime × UI, and contradictory combinations are rejected (§13).
4. **Pinned reference**: three@0.185.1 plus the ThreeNative patch is the behavioural oracle. Upgrading it is a deliberate batch, never drift (§18).
5. **Module classification** (proposed: `docs/architecture/native-engine-inventory.json`, produced by `scripts/native-engine-inventory.ts`). Each `packages/core/src` module, and each module reachable from it, gets one class: `native-engine`, `binding-glue`, `build-tool`, `game-specific` or `unsupported`. Each entry also names its owning work-package key (§11.3). The script fails closed on an unclassified module.
6. **Compatibility denominator** (decision 6): the `three`, `three/webgpu`, `three/tsl` and addon symbols that templates, examples and sweep arms actually import, extracted by the same script. These become the first rows of the N03 catalog ([PRD-500](PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md)).

## Out of scope

- The reference outputs and baselines: [PRD-498](PRD-498-n01-baseline-and-differential-fixture-runner.md).
- The API catalog that turns the inventory into bindings: [PRD-500](PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md).

## Execution Phases

#### Phase 1: The decision is recorded
**Status:** NOT STARTED
**Files:** proposed `docs/architecture/NATIVE-ENGINE-DECISION.md`; pointer lines in `docs/architecture/CHARTER.md` and `packages/runtime-native/AGENTS.md`
- [ ] The decision record states all ten decisions below, gates E and T, the definitions, and three@0.185.1 + patch as the pinned reference. proof: `pnpm check:docs && pnpm exec vitest run scripts/__tests__/primary-docs.spec.ts`
- [ ] AGENTS.md mirrors regenerate cleanly after the pointer edit. proof: `pnpm sync:agents --check`

#### Phase 2: Every core module and every used symbol is classified
**Status:** NOT STARTED
**Files:** proposed `scripts/native-engine-inventory.ts`, `scripts/__tests__/native-engine-inventory.spec.ts`, `docs/architecture/native-engine-inventory.json`
- [ ] The inventory script walks `packages/core/src` and its reachable imports, and fails on any module without a class and owner. proof: red-green `pnpm exec vitest run scripts/__tests__/native-engine-inventory.spec.ts`
- [ ] The committed inventory classifies every current module with zero `unclassified` entries. proof: `pnpm tsx scripts/native-engine-inventory.ts --check`
- [ ] Every module classed `native-engine` names an N-key that exists in the batch index. proof: `pnpm tsx scripts/native-engine-inventory.ts --check`
- [ ] The used-symbol list covers every `three*` import in `packages/create-threenative/templates/` and `examples/`, including each `ctx.renderer.raw` property read. proof: `pnpm tsx scripts/native-engine-inventory.ts --check --symbols`

## Decisions

Owner decisions, João, 2026-10-04 (interview):

1. **The engine is JS-free.** Every engine system runs in C++: traversal, transforms, animation, batching, materials and TSL, visibility, streaming and rendering. No JS implementation of an engine system ships on any target. Gate E is mandatory.
2. **Speed first; a JS-free game binary later.** Game code keeps running on a JS VM (V8 on desktop and Android, the browser's own engine on web) through generated bindings. That makes [PRD-531 (N18)](PRD-531-n18-v8-game-runtime-adapter.md) the first shipping game runtime. Gate T ([N05](N05-native-typescript-qualification/README.md), [PRD-530](PRD-530-n17-strict-native-typescript-game-packaging.md)) is a later milestone. The N05 spike still runs early, but it gates nothing on the path to promotion.
3. **An early perf checkpoint can stop the program.** [PRD-534 (CP1)](PRD-534-cp1-the-native-engine-earns-the-port.md) measures native against current ThreeNative after N06 + N09. With no CPU win in the engine hot paths, N11–N15 do not start until the owner re-plans.
4. **One engine everywhere.** The web runs the same C++ core in Wasm ([PRD-532 (N19)](PRD-532-n19-webassembly-native-core-browser-port.md) is mandatory). The TS framework-system implementations and the upstream Three.js runtime are deleted once it ships ([PRD-535 (N21)](PRD-535-n21-the-js-engine-is-deleted.md)). The core is Wasm-safe from day one: single-thread fallback, retained views that survive memory growth, no blocking waits.

Calls made from the code by the agent, accepted by the owner ("go with what you think will be best"), 2026-10-04:

5. **Charter amendment, in plain words:** "a second renderer" and "the runtime is a host, not a renderer" become "ThreeNative owns one C++ engine behind the Three.js API on every platform". The closed list keeps banning an authored IR, a scene format and a compiler of game code *as a required authoring step*. The shader IR is internal and never authored. The later gate-T compiler is an optional build mode over unchanged TypeScript.
6. **The game API stays vanilla Three.js.** The charter's training-data thesis is the reason. The supported surface is the measured denominator (Solution 5–6), published in `capabilities.json`. An unsupported symbol fails at build, or at scene preparation, with a named diagnostic. There is no fallback, because there is no JS engine to fall back to.
7. **`ctx.renderer.raw` survives as the compatible `WebGPURenderer`.** Templates read only public renderer fields through it (`toneMapping`, `toneMappingExposure`, `shadowMap`, and setup passed to `setupLighting`), so it returns the engine's Three-compatible renderer object. Renderer-private fields and the raw GPU device are unsupported and named as such.
8. **Bindings are generated from one catalog for several VMs:** V8 first (N18), browser JS over Wasm next (N19), JSC when iOS returns. iOS is out of the first program but not designed out.
9. **Binding crossing cost:** the per-object API stays Three-compatible. Bulk typed-array paths, shaped like the existing physics ABI, are added only where CP1 shows that crossings cost real frame time.
10. **The legacy JS-owned engine is deleted** one release after [PRD-533 (N20)](PRD-533-n20-platform-qualification-performance-default-promotion.md) makes native the default ([PRD-535 (N21)](PRD-535-n21-the-js-engine-is-deleted.md)).

Fixed by the proposal: C++20 for the engine, Dawn and wgpu-native retained, no upstream Three.js bundle inside the native engine, TypeScriptCompiler as the first AOT candidate (§1, §4).
