# PRD-621 — Render bundle validation without repeated graph work

**Closed:** 2026-10-16 at `90b9f946b`, archived to `done/`.

**Status:** DONE — 2026-10-16. Every phase and acceptance box verified.
**Priority:** P1 — Material graph validation consumes substantial sampled CPU time in the forest startup trace; reduce that work without weakening bundle safety.
**Complexity:** 3 (LOW); one implementation file and complex mutable graph state; risk override: none.
**Owner:** Codex, resumed session fba759fa-cdc9-43fc-b8db-0106117e4c38
**Depends on:** None

## Context

PR #483's forest diagnostic trace contains 804,494 events. Named graph-validation helpers consume substantial self samples: `graphSnapshotCurrent` 3,603 ms, `captureBundleGraph` 2,619 ms, `readBundleGraphChildren` 1,083 ms, `bundleGraphKeys` 903 ms and `bundleGraphChildReader` 573 ms. This startup-inclusive virtual-display trace supports function attribution, not FPS or attribution of the separate 1,619 ms runtime task.

The shared engine owns this fix: every WorldCells bundled scene reaches these checks. On develop, the helpers live inline in `packages/core/src/world-cells.ts`; the epic extracted their identical bodies into `world-bundle-safety.ts`. Deliver the fix through a separate develop PR, then integrate it into the epic.

## Solution

Preserve per-batch validation and the current graph witness. Reuse the stored child witness only as comparison storage while consuming the current reader's full output; never reuse its safety verdict without checking. Remove tuple/map/spread allocations from graph capture and traversal while preserving exact enumeration, property-read order, limits, reader error handling and repair. Do not use version-only, pass-only or frame-only safety caching.

Scope: existing WorldCells implementation and bundle tests, plus the existing runtime harness. No public API, rendering quality, materials, scene content, tolerances or budgets change. No module extraction or unrelated cleanup.

## Acceptance Criteria

- [x] AC-1 [local]: WorldCells performs less graph-validation work on a representative repeated-material settled scene, measured through the existing caller rather than an unused helper. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts` and the matched forest `trace` runs — Phase 1 and Phase 2 results below.

- [x] AC-2 [local]: Deep nonenumerable children, inherited dictionary/sparse-array edits, unknown or throwing readers, overflow and later repair retain current fail-closed behavior, including mutations during a pass. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts` — 42/42 and the full root suite below; no pass-level cache was introduced.

- [x] AC-3 [local]: The forest consumer uses the changed engine code, with comparable CPU attribution and no visible regression. Runtime budgets remain required in the epic and cannot be waived by this PRD. proof: matched forest `trace` runs, served-code receipts and two headed WebGPU capture pairs — Phase 2 records the conservative CPU result and fresh NEUTRAL verdict.

## Integration Ledger

Integration: unchanged — WorldCells main cull → `recordCpuMain` → `bundleIn` → material graph validation. The incumbent path is optimized in place; no parallel implementation or fallback replacement.

## Execution Phases

### Phase 1: Safe algorithm and regression proof

**Status:** DONE
**Files:** `packages/core/src/world-cells.ts`, `packages/core/__tests__/world-bundles.spec.ts`.

- [x] Reduce temporary graph allocation through the real WorldCells caller. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts` — baseline 41/41; candidate 42/42, exit 0. Unchanged ordered children retain the existing witness without re-recording; capture removes property tuples/map copies and traversal removes the combined spread array. This proves the caller's allocation path, not a CPU-time gain.
- [x] Preserve existing mutation/error/repair safety behavior. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts` — 42/42, exit 0; added stable-reader length/order changes, late iterator failure, malformed children and repair. Existing deep nonenumerable/inherited/sparse/overflow cases remain green. Per-batch checks remain, so no pass-cache invalidation rule is introduced.

Core typecheck passed (`pnpm --filter @threenative/core typecheck`, exit 0); focused Biome passed with 23 existing warnings and no errors. Parent diff review found no new public API, cache scope, limit or property-enumeration change. Baseline/candidate suite durations are not a performance claim; matched runtime evidence remains open.

The first broader typecheck caught the new partial Node fixture's direct typed assignment at `world-bundles.spec.ts:1159`; it now uses reflective assignment, preserving the same runtime property write. Root `tsc --noEmit -p tsconfig.json` then passed locally. Laptop job `prd621-type-lint-r2` passed workspace `pnpm typecheck` and `pnpm lint`, exit 0 (3,805 linted files, 1,445 warnings, no errors). The earlier workspace build passed on the identical engine source. Full unit/native/runtime qualification remains open.

### Phase 2: Runtime proof and delivery

**Status:** DONE
**Files:** Existing forest consumer and runtime harness; no new harness.

- [x] Measure reduced named guard CPU work on the forest consumer under matched conditions. proof: existing playtest `trace` command on baseline and candidate — four 90-second ABBA runs passed on RTX 2080/Turing. Named guard sampled self time: baseline 12,035/12,284 ms versus candidate 10,219/9,950 ms, mean reduction 17.1%. Sampled non-idle main-thread time fell 17.3%; generic Three child traversal stayed roughly flat. Static startup-inclusive, private-Xvfb function attribution only; no FPS or original 1,619 ms task claim. The larger allocation-callback aggregate is not claimed because the printed tables truncate.
- [x] Preserve visual output on the forest consumer. proof: two matched headed WebGPU captures per arm and a fresh read-only visual judge — native OpenCode Read viewed all four labeled PNGs; both pairs and overall NEUTRAL, no systematic forest/terrain/water/lighting/contact regression. Still images do not prove motion or transitions.
- [x] Pass the required selected repository checks for the candidate. proof: `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm native:verify:desktop` — all exit 0. Full root suite: 779 files passed/3 skipped; 10,668 tests passed/20 skipped, temporary-directory guard 1→1. Native qualification included 300 frames at 1280×720, physics playtest 14 assertions, loading pixels present at startup and absent when settled, and UI frame gate; V8/QuickJS prerequisites and the six-file 72-pass/1-skip rerun preceded the full suite. The matched forest proof above exercises the optimized guard; no broader platform or FPS claim is made.

Runtime proof used the unchanged epic forest consumer with a temporary exact helper patch from `2ee1a937d`, then restored source byte-for-byte and rebuilt baseline core. Served `world.js` response hashes differed as expected (`a248431df27b…` baseline, `5aa51204ce48…` candidate), including the actual helper signature; all four scenes retained 12,263,370 main triangles, 41 draws and zero WorldCells failures, at fixed 0.72 scale, surface 4× and single-sampled world/TRAA. Source restored to `bf938bba…`, epic tracked tree clean, owned server stopped and capture lease released. Artifacts remain ignored under the epic's `artifacts/resume-pr483/prd621-local/`.

The diagnostic command was `trace --url 'http://127.0.0.1:5296/?world=forest&showcase=1' --no-wait --no-input --settle 0.001 --seconds 90 --stall-ms 250 --allow-virtual-display --out <arm>.trace.json --text`, using shipped capture/display handling. Animation-callback counts (baseline 3,030/2,836, candidate 3,001/2,927) are a normalization cross-check, not rendered-frame or FPS evidence. Named guard self time per callback was approximately 4.15 → 3.40 ms. Two runs per arm on one host support this bounded CPU result; all epic runtime budgets remain separate.

The Argon gateway visual attempt returned HTTP 400 and no verdict. A new Go review used actual image-returning Read calls and supplied the NEUTRAL verdict above. Full local candidate build passed; the first `pnpm test` stopped with 21 missing-native-binary failures. Read-only triage confirmed absent V8/QuickJS executables before the changed guard could run. Building the V8 host/contract targets and QuickJS host/timestamp/renderable targets resolved them: six-file rerun 72 passed/1 skipped, then full `pnpm test` and desktop render qualification passed. Shipped doctor passed Node/Chromium/Xvfb/ADB prerequisites; iOS is not claimed here. PR CI and merge are delivery steps and remain unverified at this local completion point.

Delivery incorporated develop `14d688819` without conflicts. Its added Dawn build tooling and Xvfb scratch cleanup left the optimized helpers and native C++ runtime unchanged; the new native/distribution tests passed 70/70, CI contracts 209/209, and current lint/docs checks passed. Existing runtime proof is retained for those unchanged inputs. Archive checks passed 248/248 across six files; the official closure helper verified all five phase and three acceptance boxes before moving this file.

## Decisions

- 2026-10-15 (Codex): A module-level WeakMap alone does not eliminate graph walks and is rejected. The validation counter must continue to report actual work; do not optimize only the metric.
- 2026-10-15 (Codex, Argon read-only architecture review): Pass caching rejected. Graph getters/readers and synchronous Three added/removed listeners can mutate shared material graphs between batches. Keep each check and reduce temporary allocation instead. Initial docs check passed: 3,097 links; pre-push hook refused missing workspace build, so no remote branch or PR exists yet.
