# PRD-510 — A typed shader IR with ordered effects (N08a)

**Status:** PROPOSED
**Priority:** P2 — Wave 2: the typed shader IR with ordered effects; 4 open boxes and no GPU work required to start.
**Complexity:** 4 — new native data model with a large operator surface; no GPU needed to test it
**Owner:** João
**Work package:** N08 — [native-engine batch](../README.md) · [N08 index](README.md)
**Depends on:** [PRD-500 (N03) — API catalog, binding ABI and version protocol](../PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md)

## Context

§9.1: a typed native shader IR holding constants, inputs, uniforms, attributes, arithmetic,
swizzles, functions, conditionals/loops, assignments, texture operations, storage buffers, compute
operations and stage-specific builtins — distinguishing pure expressions from ordered effects (a
graph is not a DAG of arithmetic). Today every TSL graph is built by upstream `three/tsl` in JS and
compiled by upstream `WGSLNodeBuilder` inside the host; the templates' `src/render/` and
`packages/core/src/` (e.g. `compute-driven.ts`) author against it. The N03 catalog lists which TSL
functions are supported.

## Solution

1. **IR** (proposed: `packages/runtime-native/src/engine/shader/ir/`,
   `include/threenative/engine/shader_ir.h`): typed nodes with WGSL-compatible scalar/vector/matrix
   types; pure nodes are hash-consed; effect nodes (assign, store, texture store, atomic, discard,
   loop/if bodies) live in ordered blocks with explicit scope.
2. **Builder API mirroring TSL** (proposed: `src/engine/shader/tsl/`): native functions for each
   catalogued TSL authoring function — `float`, `vec3`, `uniform`, `attribute`, `positionLocal`,
   `time`, `Fn`, `If`, `Loop`, `texture`, `storage`, `instanceIndex`, operators, swizzles. In a
   strict build an authored `Fn` is compiled native code that constructs IR (§9.1).
3. **Type checking** at construction: mismatched operands, swizzles past arity, a storage write in
   a vertex stage, etc. raise `TN_TSL_TYPE <node> <reason>` with the authoring source location.
4. **Unsupported TSL** (uncatalogued node) is a named diagnostic `TN_TSL_UNSUPPORTED <name>`,
   never a silent substitute (§9.1, §9.3).
5. **Reference corpus:** a set of graphs authored once in TS; the reference run dumps upstream TSL's
   node tree; the native run dumps the IR; a normalizer compares structure and types.

## Out of scope

- WGSL emission, layouts and validation — [PRD-511](PRD-511-n08b-shader-packages-not-wgsl-text.md).
- Graphs built from compiled game code — [PRD-513](PRD-513-n08d-compute-multipass-and-a-dynamic-graph.md).

## Execution Phases

#### Phase 1: IR core
**Status:** NOT STARTED
**Files:** proposed `src/engine/shader/ir/*.cpp`, `tests/native-engine/shader_ir_test.cpp`
- [ ] Pure expressions are deduplicated and effects keep program order inside nested `If`/`Loop` blocks. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_tsl_ir_order`
- [ ] Type errors raise `TN_TSL_TYPE` with a source location for each fixture case. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_tsl_ir_types`

#### Phase 2: TSL builder parity
**Status:** NOT STARTED
**Files:** proposed `src/engine/shader/tsl/*.cpp`, `packages/runtime-native/tests/native-engine/tsl-corpus/`
- [ ] Every catalogued TSL function used by the corpus builds IR structurally equal to the upstream node tree. proof: `node packages/runtime-native/tests/native-engine/differential.mjs --suite tsl-ir`
- [ ] An uncatalogued node raises `TN_TSL_UNSUPPORTED` naming it. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_tsl_unsupported`

## Decisions

- **Effects are ordered, not inferred from a DAG (§9.1).**
- **No JS interpretation of `Fn` bodies in strict builds (§9.1).**
