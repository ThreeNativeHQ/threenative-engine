# PRD-506 — Three imports bind natively and callbacks are reclaimed (N05b)

**Status:** PROPOSED — early spike for gate T; blocks nothing else (owner decision 2)
**Priority:** P2 — Early spike: three imports bind natively and callbacks are reclaimed; 6 open boxes.
**Complexity:** 5 — crosses the compiler's module system, the generated ABI and the engine lifetime protocol at once
**Owner:** João
**Work package:** N05 — [native-engine batch](../README.md) · [N05 index](README.md)
**Depends on:** [PRD-505](PRD-505-n05a-the-language-corpus-compiles-on-linux-x64.md), [PRD-502 — Handles keep identity and aliases](../N04-lifetime-and-numerics/PRD-502-n04b-handles-keep-identity-and-aliases.md), [PRD-503 — Unreachable cycles are reclaimed](../N04-lifetime-and-numerics/PRD-503-n04c-unreachable-cycles-are-reclaimed.md)

## Context

§2.2 keeps game source unchanged: `import { Scene, Mesh } from "three"`, `WebGPURenderer` from
`three/webgpu`, TSL from `three/tsl`. §8.4 notes the compiler's `tsbindgen` emits C declarations
only, and its example uses generated `.ts` declarations with reference directives — so the
package/module adapter that makes those imports resolve must be qualified explicitly. §7.1 makes
cross-language cycles (a closure capturing a mesh wrapper, registered on that mesh) a qualification
condition: rooting every callback forever is a failure, and a compiler without a working
rooting/tracing path is not qualified. The minimal native object fixture comes from N04
(proposed: `packages/runtime-native/src/engine/scene/`).

## Solution

1. **Module adapter.** proposed: `tools/native-typescript/module-map.json` maps `three`,
   `three/webgpu`, `three/tsl` to the generated native wrapper modules from the N03 catalog
   (proposed: `packages/three-native/generated/native-aot/`). One constructor identity across all
   three specifiers (§2.2): `Mesh` from `three` and from `three/webgpu` is the same class.
2. **Wrappers adapt, never compute (§8.3).** Generated stubs translate names, overloads, option
   objects and return values into ABI calls; no matrix maths, traversal or shader generation in them.
3. **Callback protocol.** A TS closure passed to the engine becomes a callback-plus-context pair on
   the ABI (§8.2). The context is a GC-visible root registered with the engine's reachability layer
   (N04c), not a permanent root: the engine reports the closure as reachable only while its owning
   object is reachable, so a mesh ↔ closure cycle is collectable once the scene drops the mesh.
4. **Unsupported import surface** (a name present upstream but absent from the catalog) fails at
   compile time with `TN_NATIVE_TS_UNSUPPORTED_EXPORT <specifier>#<name>`, never at runtime.
5. **Rollback:** nothing ships yet; the legacy V8/QuickJS host is untouched.

## Out of scope

- The language corpus itself — [PRD-505](PRD-505-n05a-the-language-corpus-compiles-on-linux-x64.md).
- Generating the catalog and ABI — [PRD-500 (N03)](../PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md).
- TSL graphs built from compiled code — [PRD-513 (N08d)](../N08-native-tsl-and-shader-packages/PRD-513-n08d-compute-multipass-and-a-dynamic-graph.md).

## Execution Phases

#### Phase 1: Imports resolve to native wrappers
**Status:** NOT STARTED
**Files:** proposed `tools/native-typescript/module-map.json`, `tools/native-typescript/corpus/three-fixture/`
- [ ] The §2.2 snippet (`Scene`, `Mesh`, `BoxGeometry`, `MeshStandardMaterial`, `mesh.position.x += 1`) compiles unchanged on Linux x64 and prints the same scene dump as the reference build against upstream `three@0.185.1`. proof: `node tools/native-typescript/run-corpus.mjs --native --case three-fixture`
- [ ] `Mesh` imported from `three` and from `three/webgpu` is the same constructor (`instanceof` both ways). proof: `node tools/native-typescript/run-corpus.mjs --native --case import-identity`
- [ ] Importing an uncatalogued export fails the build with `TN_NATIVE_TS_UNSUPPORTED_EXPORT`. proof: `node tools/native-typescript/run-corpus.mjs --native --case unsupported-export --expect-compile-error`

#### Phase 2: Callbacks cross and come back
**Status:** NOT STARTED
**Files:** proposed `tools/native-typescript/corpus/callbacks/`, `packages/runtime-native/tests/native-engine/aot_callback_test.cpp`
- [ ] A native engine callback invokes a compiled TS closure with the right arguments and the closure's exception surfaces as a status code, not a crash. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_aot_callback`
- [ ] A mesh ↔ closure cycle is reclaimed after the mesh leaves the scene and its last TS reference drops, within the defined safe point. proof: `node tools/native-typescript/run-corpus.mjs --native --case callback-cycle`
- [ ] 10,000 create/attach/detach cycles hold engine object count and RSS flat. proof: `node tools/native-typescript/run-corpus.mjs --native --case callback-churn`

## Decisions

- **No permanent rooting of callbacks (§7.1).** A compiler that can only pin closures forever is not qualified for this profile; the stop rule in [PRD-505](PRD-505-n05a-the-language-corpus-compiles-on-linux-x64.md#decisions) applies.
