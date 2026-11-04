# PRD-804 — `compile.ts` splits, and every asset config error is pinned

**Status:** IN PROGRESS — six modules extracted, `compile.ts` 3 520 → 952 lines, AC-1 and AC-2 green; AC-3's template cook was not run by this lane, see below.
**Priority:** P2 — 59 `TN_ASSETS_CONFIG_INVALID` throws have about 17 spec references, and `compile.ts` holds value cycles with `health` and three passes (all phases open).
**Complexity:** 4 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [God files](README.md)

## Context

Read-only audit, 2026-11-04:

- `packages/assets/src/compile.ts` is 3 520 lines: types (124–475), constants and manifest-row narrowers (476–916), `assets.*` config parsing (917–1 620), `resolveLayout` and directory scan (1 621–1 935), manifest and receipt reuse (1 937–2 306), output writers and native package (2 308–2 606), Basis transcoder (2 607–2 706), `compileAssets` and a 757-line `compileOnce` (2 708–3 520).
- Value cycles: `compile` with `image-quality`, `health` and `passes/{texture,audio,model}` (through `classify` and `AssetKind`).
- Public entry (`index.ts`): `compileAssets`, `resolveBasisTranscoder` and the types `AssetKind`, `IAssetCompileOptions`, `IAssetCompileResult`, `IAssetPass`, `IAssetPassOutput`, `IBakeReceipt`, `IBasisTranscoder`.
- Pinned by `compile.spec.ts` (1 731 lines), `bake-receipt`, `determinism`, `native-package`, `model-texture-pass`, `lod-generation` and others. Not pinned: most config-parser messages, `resolveBasisTranscoder`.

## Solution

Pin, then extract in order: `compile-types.ts` (types, `classify`, `AssetKind`; removes the cycles),
`compile-config.ts`, `compile-rows.ts`, `compile-layout.ts`, `compile-receipt.ts`. `compileOnce` and
`compileAssets` stay in `compile.ts`, which re-exports the moved symbols; `index.ts` is unchanged.

## Acceptance Criteria

- [x] AC-1 [local]: Each of the 59 invalid-config cases throws its exact message. proof: `pnpm exec vitest run packages/assets/__tests__/compile-config.spec.ts` — Evidence: exit 0, 92/92 tests. 91 rows pin one exact message each through `compileAssets` (asserted with `toBe` on the thrown `message`, not a substring), plus one guard that the table never shrinks below the 59 the audit counted; the parser's own throw sites are 59 message shapes and the rows cover every one of them, labels included (`assets.lod.overrides['chair'].generation must be an object.`). Green on the unsplit `compile.ts` before any line moved, and unchanged after the split.
- [x] AC-2 [local]: `compile.ts` is under 1 000 lines, no new file exceeds 1 000, and no existing spec changes. proof: `wc -l` and `git diff --stat packages/assets/__tests__/` — Evidence: `compile.ts` 3 520 → 952; `compile-types.ts` 416, `compile-rows.ts` 480, `compile-config.ts` 737, `compile-layout.ts` 345, `compile-receipt.ts` 699, `compile-basis.ts` 40 — every file under 1 000. `git diff --stat packages/assets/__tests__/` prints nothing (exit 0): no existing spec was edited, the two new specs are untracked additions.
- [ ] AC-3 [local]: Asset units, including determinism and receipts, stay green, and a template build cooks the same outputs. proof: `pnpm --filter @threenative/assets test` and `pnpm test:templates` for the starter kit — Evidence: units green: `pnpm exec vitest run packages/assets/__tests__` exit 0, `Test Files 50 passed | 1 skipped (51)`, `Tests 831 passed | 2 skipped (833)` — that set includes `determinism`, `bake-receipt`, `native-package` and every pass spec. Still open: this lane may not run `pnpm build` or `pnpm test:templates` (both write `dist/` and generated files in a tree other agents share), and `@threenative/assets test` *is* `pnpm run build && publint --strict`, so the build/publint half and the starter-kit cook are unverified here.

## Decisions

2026-11-04: `resolveBasisTranscoder` moves to its own `compile-basis.ts` rather than into `compile-types.ts`. It resolves a file from disk, which is neither a type nor a pass; the cycle through `image-quality.ts` is what Phase 2 removes, so the module that causes it is the module that leaves. `copyBasisTranscoder` and `BASIS_DIRECTORY` join it, and `messageOf` moves to `compile-types.ts` — `compile-basis.ts` cannot import `compile-rows.ts`, because `compile-rows.ts` reads `image-quality.ts` and the cycle would simply reappear one module further along.

## Integration Ledger

Integration: unchanged — `compileAssets` stays the entry that `threenative build` calls.

## Execution Phases

#### Phase 1: pin
**Status:** DONE
**Files:** `packages/assets/__tests__/compile-config.spec.ts` (new), `packages/assets/__tests__/basis-transcoder.spec.ts` (new)
- [x] A table-driven spec covers the 59 config errors. Green on today's code. proof: AC-1
- [x] `resolveBasisTranscoder` is pinned for found, missing and override paths. Green on today's code. proof: `pnpm exec vitest run packages/assets/__tests__/basis-transcoder.spec.ts` — Evidence: exit 0, 4/4, run against the unsplit `compile.ts` and again after the split. Found: the resolved paths end in `three/examples/jsm/libs/basis/basis_transcoder.js`, the `.wasm` sibling is derived by the `.js → .wasm` rewrite and both files exist. Missing: the message is pinned byte for byte, cwd included (`TN_ASSETS_TRANSCODER_MISSING: could not resolve … from '<cwd>': … The runtime KTX2 loader needs it copied next to the compiled assets.`), and a compile that ships Basis output rejects instead of writing a build that 404s. Override: `compileAssets({ transcoder })` copies the injected pair into `public/basis/` byte for byte with no `three` install in the project. Two findings worth recording: vitest answers `createRequire(...).resolve` from this file's own install, so the spec fails the resolver through a `node:module` factory rather than a missing directory; and the receipt rows for that copy are already pinned by `bake-receipt.spec.ts`, so this spec does not repeat them.

#### Phase 2: break the cycles
**Status:** DONE
**Files:** `packages/assets/src/compile-types.ts` (new), `compile-basis.ts` (new), `compile.ts`, `health.ts`, `image-quality.ts`, `passes/{texture,audio,model}.ts`
- [x] Types and `classify` moved; no value cycle through `compile.ts` left. proof: AC-3 plus a grep that `health.ts` and `passes/*` import no value from `compile.js` — Evidence: `rg -n 'from "\./compile\.js"' packages/assets/src/image-quality.ts` prints nothing (exit 1); the same file now has `import { resolveBasisTranscoder } from "./compile-basis.js";` at line 15. `health.ts` and the three pass modules import `classify`/`AssetKind` from `./compile-types.js`. The only remaining `compile.js` importers in `src/` are the entry (`index.ts`, `watch.ts`) and three type-only edges (`pass-chain.ts`, `apply-worker.ts`, `passes/{lightmap,blender-import}.ts`), all erased. A value-import walk from `image-quality.ts` reaches `compile-basis.ts`, `compile-types.ts` and `ktx2-encoder.ts` and no longer reaches `compile.ts`; no module in the cluster appears in its own value closure.

#### Phase 3: extract the rest
**Status:** DONE
**Files:** `packages/assets/src/compile-{config,rows,layout,receipt}.ts` (new), `compile.ts`
- [x] Four modules extracted. proof: AC-2 and AC-3 — Evidence: `compile-config.ts` 737 (the `assets.*` parser, `nonEmptyString` and `embeddedTexturesFor`), `compile-rows.ts` 480 (the output names, `isRecord`, every manifest-row narrower, and `skippedCompressionRows`), `compile-layout.ts` 345 (`resolveLayout`, `scanDirectory`, `walkSources`), `compile-receipt.ts` 699 (`outputNameFor` and the reuse comparison, the auxiliary outputs, the receipt/pending journal, the pass-cost bookkeeping, the manifest and receipt writers, the native package). All moved code is verbatim; `compile.ts` keeps `compileAssets`, `compileOnce` and the transcoder charge, and re-exports every symbol it exported before: 18 exports before, 18 after, none lost, none added (computed by parsing both versions). `pnpm --filter @threenative/assets typecheck` exit 0.
