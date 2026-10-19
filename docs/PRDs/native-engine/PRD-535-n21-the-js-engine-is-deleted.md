# PRD-535 — The JS engine is deleted (N21)

**Status:** PROPOSED
**Priority:** P2 — Wave 6, one release after promotion: deleting the JS engine, the TS systems and upstream Three.js at runtime; 7 open boxes.
**Complexity:** 4 — wide deletion across core, templates' dependencies and the native host; reversible only by revert
**Owner:** João
**Work package:** N21 — [native-engine batch](README.md)
**Depends on:** [PRD-533 (N20)](PRD-533-n20-platform-qualification-performance-default-promotion.md) plus one release on the native default, [PRD-532 (N19)](PRD-532-n19-webassembly-native-core-browser-port.md)

## Context

Owner decisions 4 and 10 ([PRD-497](PRD-497-n00-architecture-decision-and-compatibility-inventory.md)) make one engine everywhere the end state. That leaves nothing for the legacy JS-owned engine, the TypeScript implementations of framework systems, or upstream Three.js at runtime. Keeping them would mean two implementations of every system and two looks. Today they are the JS-owned path documented in `packages/runtime-native/AGENTS.md`, the systems under `packages/core/src` classed `native-engine` by PRD-497's inventory, and the upstream `three` that every game bundle ships.

## Solution

1. Delete the legacy engine profile: the host's JS-owned scene and renderer path, frame-op serialization and replay, and the `legacy` value of the engine dimension.
2. Delete every `packages/core/src` module the inventory classes `native-engine`; its public names remain as generated bindings (N03).
3. Game bundles stop shipping upstream `three`: `three*` imports resolve to the generated compatibility package on every target. `three` remains a dev dependency for the N01 reference runner only.
4. The charter, `packages/runtime-native/AGENTS.md`, `docs/architecture/` and the templates' `AGENTS.md` are rewritten to describe the one engine (primary docs follow the executables).
5. Rollback: revert the deletion commit. That is why this waits a full release on the native default.

## Out of scope

- Removing V8 itself: game code still runs on it until gate T ([PRD-530 (N17)](PRD-530-n17-strict-native-typescript-game-packaging.md)).

## Execution Phases

#### Phase 1: Legacy engine gone
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/webgpu/bindings_frame_stream.cpp` and the JS-owned render path; `packages/create-threenative/` (engine dimension)
- [ ] The `legacy` engine profile no longer resolves and its host code is removed. proof: `pnpm typecheck && pnpm test`
- [ ] Desktop still passes its native gate on the remaining engine. proof: `pnpm native:verify:desktop`

#### Phase 2: TS engine systems and upstream runtime gone
**Status:** NOT STARTED
**Files:** `packages/core/src/` (modules classed `native-engine`), template `package.json` files
- [ ] No module classed `native-engine` remains in `packages/core/src`. proof: `pnpm tsx scripts/native-engine-inventory.ts --check --deleted`
- [ ] A built web game bundle contains no upstream Three.js renderer or scene code. proof: `pnpm exec vitest run scripts/__tests__/bundle-has-no-upstream-three.spec.ts`
- [ ] A desktop artifact carries no engine JS bundle. proof: `node packages/runtime-native/scripts/inspect-js-free.mjs --binary <desktop artifact> --engine-only`

#### Phase 3: Every template on the one engine
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/`, `docs/architecture/CHARTER.md`
- [ ] Every template's journey passes on web and desktop. proof: `pnpm test:templates`
- [ ] Primary docs name only the one engine. proof: `pnpm exec vitest run scripts/__tests__/primary-docs.spec.ts`
