# PRD-505 — The language corpus compiles on Linux x64 (N05a)

**Status:** PROPOSED — early spike for gate T; blocks nothing else (owner decision 2)
**Priority:** P2 — Early spike off the critical path: the pinned compiler and fixture corpus; 6 open boxes.
**Complexity:** 4 — a third-party LLVM-based compiler, pinned and cached, plus a fixture corpus; no engine code yet
**Owner:** João
**Work package:** N05 — [native-engine batch](../README.md) · [N05 index](README.md)
**Depends on:** [PRD-500 — API catalog, binding ABI and version protocol](../PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md)

## Context

§1 and §8.4 name ASDAlexander77/TypeScriptCompiler as the first candidate for compiling
game-authored TypeScript and generated binding stubs to native code — not the engine's
implementation language. Nothing in this repository compiles TypeScript ahead of time today: the
native host transpiles with SWC (`MYSTRAL_USE_SWC` in `packages/runtime-native/CMakeLists.txt`) and
executes in QuickJS or V8. §17 requires the compiler to be a cached, checksum-pinned SDK artifact,
never an LLVM rebuild per game. This PRD qualifies the language subset only; the `three` module
adapter and callback lifetime are [PRD-506](PRD-506-n05b-three-imports-bind-natively-and-callbacks-are-reclaimed.md).

## Solution

1. **Pin, don't vendor a moving target.** proposed: `tools/native-typescript/compiler.lock.json`
   records the upstream commit, the prebuilt toolchain archive per host and its SHA-256. A provision
   script downloads and verifies it into a cache outside the repo; a checksum mismatch fails closed.
2. **The corpus is the contract (§8.4).** proposed: `tools/native-typescript/corpus/`, one small
   program per feature, each with an expected stdout file: classes, inheritance, getters/setters,
   constructors taking object options, enums and unions, ordinary imports including the import
   cycles the fixtures use, typed arrays, closures, exceptions (throw/catch across functions),
   async loading behaviour the first game needs. Native callbacks and native resource lifetime
   live in PRD-506 because they need the ABI.
3. **Memory mode (§8.4, R15).** Use the compiler's correctness-oriented default (Boehm GC). The
   non-freeing mode is rejected for anything long-running; reference counting is rejected while its
   cycle limitation stands. A corpus case allocates in a loop for N iterations and asserts bounded
   RSS, so a non-freeing build fails the suite.
4. **Fork policy.** Start on the pinned upstream commit. A fork (proposed:
   `tools/native-typescript/patches/`) is allowed only for a reduced failing corpus case; each patch
   carries the minimized reproduction, a semantic test, a native target test, and is written to be
   sent upstream. No LLVM fork, no language extensions for unrelated npm packages.
5. **Every case runs twice.** Reference run: the same file under Node (`tsx`) produces the expected
   stdout. Native run: compiled executable produces byte-identical stdout and exit code. A
   divergence is a named failure, never a re-blessed expectation.

## Out of scope

- `three` / `three/webgpu` / `three/tsl` import resolution, native callbacks, wrapper rooting — [PRD-506](PRD-506-n05b-three-imports-bind-natively-and-callbacks-are-reclaimed.md).
- Android arm64 — [PRD-507](PRD-507-n05c-the-same-corpus-runs-on-android-arm64.md).
- Shipping a game artifact — [PRD-530 (N17)](../PRD-530-n17-strict-native-typescript-game-packaging.md).

## Execution Phases

#### Phase 1: Pinned, cached compiler
**Status:** NOT STARTED
**Files:** proposed `tools/native-typescript/compiler.lock.json`, `tools/native-typescript/provision.mjs`
- [ ] The provision script fetches the pinned toolchain, verifies its SHA-256, and a second run is a cache hit with no download. proof: `node tools/native-typescript/provision.mjs --check`
- [ ] A tampered archive is refused with a named checksum error. proof: `pnpm exec vitest run tools/native-typescript/__tests__/provision.spec.ts`

#### Phase 2: The corpus, reference and native
**Status:** NOT STARTED
**Files:** proposed `tools/native-typescript/corpus/*.ts`, `tools/native-typescript/run-corpus.mjs`
- [ ] Every corpus case produces its expected stdout under Node. proof: `node tools/native-typescript/run-corpus.mjs --reference`
- [ ] Every corpus case compiles to a Linux x64 executable whose stdout and exit code match the reference. proof: `node tools/native-typescript/run-corpus.mjs --native --target x86_64-linux-gnu`
- [ ] The allocation-loop case holds RSS bounded under the selected memory mode. proof: `node tools/native-typescript/run-corpus.mjs --native --case alloc-loop`

#### Phase 3: Fork ledger, if needed
**Status:** NOT STARTED
**Files:** proposed `tools/native-typescript/patches/`, `tools/native-typescript/FORK.md`
- [ ] Each local patch has a minimized case in the corpus that fails without it and passes with it. proof: `node tools/native-typescript/run-corpus.mjs --native --without-patches` reports exactly the patched cases red

## Blocked on

- Owner decision on whether a research fork may be published under the ThreeNative org, should Phase 3 need one — João.

## Decisions

- **Compiler stop rule (§8.4, §18).** If the agreed corpus needs broad compiler or runtime redesign, stop this integration before the engine rewrite expands. Do not replace TS authoring with C++ or declare V8 the finished answer; reassess the language profile or another AOT candidate explicitly. The C++ core remains reusable.
- **Static Hermes is excluded from the strict target (§8.4, R16).** Its native output participates in the Hermes runtime; it may only be evaluated for a separately labelled compatibility product.
- **No general-purpose compiler is written here (§1, §2.3).**
