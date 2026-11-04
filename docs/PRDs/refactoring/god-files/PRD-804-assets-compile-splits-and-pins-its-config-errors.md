# PRD-804 — `compile.ts` splits, and every asset config error is pinned

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: Each of the 59 invalid-config cases throws its exact message. proof: `pnpm exec vitest run packages/assets/__tests__/compile-config.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: `compile.ts` is under 1 000 lines, no new file exceeds 1 000, and no existing spec changes. proof: `wc -l` and `git diff --stat packages/assets/__tests__/` — Evidence: pending.
- [ ] AC-3 [local]: Asset units, including determinism and receipts, stay green, and a template build cooks the same outputs. proof: `pnpm --filter @threenative/assets test` and `pnpm test:templates` for the starter kit — Evidence: pending.

## Integration Ledger

Integration: unchanged — `compileAssets` stays the entry that `threenative build` calls.

## Execution Phases

#### Phase 1: pin
**Status:** NOT STARTED
**Files:** `packages/assets/__tests__/compile-config.spec.ts` (new), `packages/assets/__tests__/basis-transcoder.spec.ts` (new)
- [ ] A table-driven spec covers the 59 config errors. Green on today's code. proof: AC-1
- [ ] `resolveBasisTranscoder` is pinned for found, missing and override paths. Green on today's code. proof: `pnpm exec vitest run packages/assets/__tests__/basis-transcoder.spec.ts`

#### Phase 2: break the cycles
**Status:** NOT STARTED
**Files:** `packages/assets/src/compile-types.ts` (new), `compile.ts`, `health.ts`, `image-quality.ts`, `passes/{texture,audio,model}.ts`
- [ ] Types and `classify` moved; no value cycle through `compile.ts` left. proof: AC-3 plus a grep that `health.ts` and `passes/*` import no value from `compile.js`

#### Phase 3: extract the rest
**Status:** NOT STARTED
**Files:** `packages/assets/src/compile-{config,rows,layout,receipt}.ts` (new), `compile.ts`
- [ ] Four modules extracted. proof: AC-2 and AC-3
