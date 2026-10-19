# PRD-479 — Fluid particle motion and sampling regressions

**Status:** DONE — genuine browser/native GPU and unchanged-consumer acceptance qualified; merge requires green exact-head CI.
**Owner:** Core / particle-fluid regression follow-up.
**Depends on:** Merged [PR #389](https://github.com/ThreeNativeHQ/threenative/pull/389).

## Problem and scope

The fluid solver shipped by [PRD-476](../done/PRD-476-fluid-lab-particle-water-at-60-fps.md)
still contains three reproducible correctness defects at develop `569fdb267538c5eae9472760fd71be59745b9a24`:

- An 18 m/s particle starting at x=-1.05 crosses the default 0.1 m dam gate in a single
  1/60 s endpoint-only prediction. Its endpoint x=-0.75 lies beyond the gate's expanded
  interval [-1.0468, -0.7532], so endpoint projection misses it.
- Component-wise velocity clipping permits vector speed sqrt(3) times `maxSpeed`, and
  collider projection can produce an over-limit final velocity.
- `sample` extends boundary water outside the tank, while a valid one-column volume can
  never satisfy the fixed four-column minimum and incorrectly reports the floor.

The actual merged source matches blob `44159cd07db98a88bc5d0e3b4d46bd542d574dba`.
The new generated-WGSL/sampler regressions fail three tests against those exact bytes;
the repaired source passes all 15 fluid tests. The completed qualification below observes actual GPU particle buffers.

This is a focused regression follow-up with its own PR. It does not rewrite the merged
PRD, redesign the solver, change its neighbor passes, add public API, or qualify new
frame-rate claims. The original PRD's recorded 16.8 ms presented p95 is not a passing
measurement for a literal 16.7 ms limit; no limit is relaxed here.

## Implementation

Use vector-magnitude clamping before prediction and after confinement. Subdivide the
predicted displacement into radius-sized segments and project each one using the
existing collider routine; the default worst case is four projections in the same
compute dispatch. This repairs the reproduced stationary gate case, not exact swept
collision detection for arbitrary grazing contacts or teleported colliders.

Keep the sampler's existing averaging policy, return the floor outside its authored
bounds, and admit fewer than four samples only when the whole volume has fewer columns.
The look remains game-owned. Reuse the public playtest bridge and the existing native
host for rendered evidence, with actual particle-buffer readbacks and no CPU solver copy.

## Execution phases

### Phase 1 — Repair the source contracts

- [x] Generated prediction and confinement shaders apply vector speed limits and radius-sized prediction segments. proof: `pnpm exec vitest run packages/core/__tests__/fluid-particles.spec.ts` — all 15 pass after the original merged source fails the new shader contract.
- [x] Surface sampling returns the floor outside bounds and the observed height for valid small volumes, excluding covered columns. proof: the same fluid suite — both new sampler regressions fail on merged source and pass after repair; `gpu-readback.spec.ts` also passes 11/11.

### Phase 2 — Qualify actual GPU behavior

- [x] Browser WebGPU keeps the default-speed particle on the correct side of the gate and preserves unobstructed motion and both speed limits. proof: `node --import tsx scripts/verify-fluid-collision.ts` exits0 at `ab9fa10f`; all11 positive assertions pass and the missing-gate control fails only collision, with actual validation before1/after2/errors0. All nine source hashes and four PNGs receive independent hash/visual audit ([retained proof](../../verification/prd479/ab9fa10f-browser/provenance.json)).
- [x] Linux native executes the same authored four-arm probe with the same numeric bounds. proof: source-built QuickJS/wgpu host `a051263c…a2a2b`, native tree `3b9b34c2`, actual NVIDIA RTX 2080; [retained native proof](../../verification/prd479/76d0c96c-native/provenance.json), four exact-source PNGs and real validation scopes before1/after2/errors0. Positive all assertions pass; disabled gate fails only collision. The maintained hosted job must also pass in exact-head CI before merge.

### Phase 3 — Preserve the existing consumer

- [x] The existing browser dam-break and coupling scenarios pass their unchanged state and nonblank-image criteria on this source. proof: `node --import tsx scripts/verify-fluid-consumers.ts` exits0 at `ab9fa10f`; all18 assertions and all8 nonblank 1280×720 captures pass, independently source/hash/visual audited. [Retained consumer proof](../../verification/prd479/ab9fa10f-consumers/provenance.json); scenarios and budgets unchanged.

## Acceptance criteria

- [x] The four-arm GPU fixture verifies the regression repair on both qualified runtimes with finite actual buffer values and the specified speed bounds. proof: [final browser actual scope/readback proof](../../verification/prd479/ab9fa10f-browser/provenance.json) plus native Phase2 proof above; all source/image hashes and visual/numeric bounds independently audited. Both actual producers complete validation before1/after2/errors0; real injected invalid-buffer control rejects startup.
- [x] The public fluid API and existing dam-break/coupling behavior remain compatible. proof: completed Phase 3 results plus full core tests, typecheck and unchanged API-surface validation.

## Verification notes

The missing-gate fixture is an assertion check, not another feature or acceptance box:
it must fail only `resource.FluidCollision.collisionPassed`. Every unexpected diagnostic,
including software device loss, invalidates the capture. Software adapters may establish
correctness but cannot establish hardware performance. Root CI must be green for the
exact final source before this PR is eligible to merge.

Initial `256059b2` local checkpoint: core 2,223 passed / 2 skipped; focused fluid/readback/proof tests 39/39 and CI structure/needs 141/141 pass. Package builds, full root/workspace typecheck, API/capability validation and lint pass (warnings remain). The ordinary root `pnpm test` launcher is blocked before execution by the local `tsx` Unix-socket restriction; this is not a full-suite pass. Independent review cleared the source and fail-closed proof routes. All runtime boxes remain open until hosted execution produces exact-source images and measurements.

First hosted diagnostic: [run37047774012](https://github.com/ThreeNativeHQ/threenative/actions/runs/37047774012) at `256059b2` reached actual GPU readbacks. Gate x=-1.046800017, free x=-0.75, diagonal travel0.300000029m and final speeds18.000000916/18m/s satisfy the fixed numeric checks. Qualification nevertheless failed `TN_CAPTURE_BLANK`: the original flat marker/gate image has only three colors. The unchanged [before](../../verification/prd479/256059b2-diagnostic/before.png), [after](../../verification/prd479/256059b2-diagnostic/after.png) and [minimal provenance](../../verification/prd479/256059b2-diagnostic/provenance.json) preserve this failure. The marker now draws the actual GPU position as a shaded sphere at `spacing * 0.44`, the solver collision radius; the gate geometry, numeric assertions and capture guard remain unchanged. A geometry/material regression passes. New positive/control and native/consumer execution remain pending; no runtime box is ticked from the diagnostic alone.

The next qualification source also reconciles develop `42fa306c0c46417afb4cafda23f55d09a557f860`, preserving its WorldCells/TerrainTiles/VirtualShadowNode changes. The fluid solver and numeric predicates remain byte-identical to the first diagnostic; only the physically sized particle visualization changes. Combined-source core build/declarations, full root/workspace typecheck and lint pass (1,014 warnings, no errors). The affected world/fluid/proof suite passes 203 tests with two skips. The real documentation/evidence budgets pass. Actual browser/native/consumer qualification still needs the new head; these local gates are distinct from the earlier runtime diagnostic.

The clean hosted rerun at `8c832dc0` ([run 37054144046](https://github.com/ThreeNativeHQ/threenative/actions/runs/37054144046)) stopped before rendering: the new physical-view test imports the public core package, but its build output was absent. The collision job now builds core before executing those contracts. CI structure/needs and view/proof tests pass 148/148 locally; no runtime acceptance is inferred from this prerequisite correction.

Browser checkpoint `b149762d`: the correctly sized sphere visibly remains against the gate; the missing-gate control travels through its wireframe boundary. The archive digest and all four PNG hashes were independently recomputed, and both after-images inspected. Native and unchanged consumer qualification remain pending. Develop `840d3530` is reconciled with no changes to core, playtest, native, the fluid example, proof scripts or the lockfile; its shooter-decal work is preserved unchanged. Final-source CI and remaining runtime criteria are still required.

The existing temporary-directory guard exposed one unregistered test fixture directory. Its sole failure is fixed using the shared `makeTempDir` helper while retaining explicit cleanup; guard and native proof-contract tests pass 8/8. This test-only correction does not alter the qualified runtime inputs. Documentation link/citation tests pass, and the actual 70.7 MB evidence tree remains under its 72 MB cap; two evidence-budget subprocess tests are locally blocked by the known `tsx` IPC restriction, not reported as passing.

The remaining `b149762d` hosted gates failed honestly. ARM64 QuickJS/wgpu built, but native startup reached the unchanged 120,000 ms bridge deadline (`TN_PLAYTEST_BRIDGE_MISSING`); artifact `11248008778` SHA-256 `79a9639f7ff8f4975433befc38a57b89f937079deec86d4d3c78b9acaac717c3`. The dam consumer passed all nine assertions and retained its four authored images; coupling reached falling/splash captures, then failed `TN_PLAYTEST_OPERATION_TIMEOUT`. Consumer artifact `11249751145` SHA-256 `2e55658d1c9280122921ed63e9698be7687a9763118ff3ca924cef0fd0de7153` is attached to the same run and currently expires 2026-12-31. No native or complete-consumer box is checked.

The next checkpoint changes diagnostic retention only: an early native failure retains the existing driver console through its supported factory seam and emits bounded allowlisted technical fields; consumer failures retain only recognized codes and an allowlisted operation/numeric budget parsed from the actual diagnostic. Missing channels remain explicitly unavailable. The fixture, solver, scenarios, timeout budgets and assertion gates are unchanged. Independent review cleared this diagnostic delta; 20 focused tests and root TypeScript pass. Develop `af7e253331a045b9d8fb5145d31e6b7adc715d32` is reconciled, preserving its documentation, scaffold hashes and tooling settings. A fresh hosted run is required to observe the failure cause rather than infer it.

Native validation follow-up: the retained `9da46881` diagnostic identifies an actual WGSL validation failure, rather than an unavailable adapter: concise `() => Return()` callbacks both append and return the terminal node, generating consecutive `return; return;`. The fluid guard callbacks now return void while preserving the same conditional early exits. The new generated-WGSL regression fails on the original source (1 failed / 15 passed) and passes after repair; the fluid/readback/browser-native proof contract suites pass 46/46. The repaired source still requires fresh native, browser and unchanged-consumer execution before qualification.

The first repaired native diagnostic reaches clean actual NVIDIA RTX 2080 readbacks and numeric assertions, but correctly fails the required baseline-image read because the shared device runner ignored `screenshots: "before-after"`. The runner now captures `before.png` after readiness and the initial sample, before measured advancement, using its existing nonblank capture gate. The real desktop-runner regression fails before repair and passes with tick-0/tick-3 captures; all 39 desktop tests pass. Independent review clears both bounded repairs. This diagnostic used an existing host and is not exact-source native qualification; fresh source-built-host and browser/consumer proofs remain required. The browser attempt queued behind another worker's capture lease and stopped at its existing 120-second deadline; no lease was overridden.

At `4627dfcd5`, the original positive/control browser proof, an independently source-built Linux V8/Dawn native host, and both unchanged consumers pass on the NVIDIA RTX 2080; 16 exact-source screenshots and all hashes were independently audited. The additional exact-source QuickJS/wgpu probe then reproduces a distinct portability defect: `wgpuDeviceCreateTexture` rejects `Texture usages TextureUsages(RENDER_ATTACHMENT) ... dimensions D3`. The existing Three patch now omits that unused flag only for compute-only 3D storage textures; 2D storage, ordinary 3D textures, explicit render targets and render-pass mipmaps retain their original usage. An actual descriptor regression fails before repair (1 failed / 2 passed), then passes; 49 focused fluid/readback/proof tests and all four patch-upgrade tests pass. The patch and normal pnpm lock hash change require new runtime qualification; no final-source native or consumer completion is claimed yet.

Full pre-patch root units execute 7,206 passing tests, with three unchanged time-budget failures in WorldCells GPU-scene, the build mutation arm and pristine-template typechecks. These are being rerun serially without changing their limits. Native package contracts execute 1,528 passing tests with two stale pinned-dependency SBOM receipt failures and a loaded conformance dry-run timeout; no complete native-package pass is claimed.

The later independent diagnostic audit found the original fixture callback returned a fixed empty array; normalized runtime-diagnostic defaults also did not establish an actual producer. The earlier numeric values and images remain valid evidence of their stated measurements, but those empty channels are not evidence of runtime health. The fixture now observes real WebGPU validation scopes around initialization and measured compute/readback/render work, awaits completion before sampling, exposes before/after completion counts 1/2 and zero actual errors, and rejects missing support, pending/rejected scopes or any non-null result. Real host console errors and device-loss markers remain disqualifying. The pinned native wgpu C API rejects the optional internal filter; qualification explicitly covers supported validation scopes and host-console channels, without a generic diagnostic-producer claim.

At `6e37e817a`, the source-built QuickJS/wgpu host passes the same four-arm positive probe and missing-gate control with genuine scope resources; actual injection of an invalid usage-0 buffer inside the initialization scope rejects startup with `TN_NATIVE_START_FAILED:Fluid GPU error scope reported an error`. Browser and unchanged consumers still wait for an unrelated capture lease; no lease is overridden and final acceptance boxes remain open. The three root timeout files pass all 129 tests when rerun serially at their unchanged budgets, and the native conformance retry passes all 62 tests. The local native SBOM receipts remain stale in the read-only dependency cache; exact-head CI must qualify its freshly provisioned dependency inputs.

The genuine validation-scope native proof is retained with [provenance](../../verification/prd479/dfe9e142d-native/provenance.json), [positive before](../../verification/prd479/dfe9e142d-native/gate-before.png), [positive after](../../verification/prd479/dfe9e142d-native/gate-after.png), [missing-gate after](../../verification/prd479/dfe9e142d-native/gate-disabled-after.png), and the actual [invalid-descriptor control receipt](../../verification/prd479/dfe9e142d-native/validation-control.json).

The actual browser positive/control run at `dd7d236c` passes after the real-scope fixture repair; nine source hashes and four images were independently audited ([browser provenance](../../verification/prd479/dd7d236c-browser/provenance.json)). Its fixture awaits real validation scopes, but that summary does not retain scope counts and is not claimed as an explicit resource-count audit. The later bounded verifier change asserts browser before/after scope completion 1/2 and errors0 and retains these observations for both runtimes; 19 proof tests and root typecheck pass, and [actual native provenance at `76d0c96c`](../../verification/prd479/76d0c96c-native/provenance.json) retains the observed counts. The unchanged consumer attempt then reaches its supported 600-second capture-resource deadline behind another task's live GI terrain lease; scenario, server and assertion budgets remain unchanged. No lease is overridden. Consumer completion and the browser's final explicit-resource verification need capture-owner coordination before readiness; no 100% or green-CI claim is made.

Final acceptance at `ab9fa10f`: the live capture owner releases naturally, the unchanged consumers pass all18 predicates and eight images, and the browser positive/control probe passes with retained real GPU validation resources. All nine browser source hashes and four images, all consumer image hashes/dimensions and visual captures, and the native actual producer/control evidence receive fresh independent acceptance review. The native qualifier's eight source inputs remain identical to `76d0c96c`; the final changes are proof/docs only. API contracts remain unchanged, focused regressions and root/workspace typecheck/lint/budgets pass, and the existing serial retries retain their original limits. The PRD is100% from actual acceptance evidence, not tests alone. Ready state starts the full board; exact-head CI and merge-queue qualification remain mandatory before merge, and local stale SBOM receipts are not a native-suite pass.

Exact-head CI at `526bd237d` exposes one scaffold pin mismatch: all13 trees deliberately embed the reviewed Three patch, while the existing byte-stability table still pins its old bytes. A [causal byte audit](../../verification/prd479/scaffold-patch-byte-audit.json) proves all13 prior pins match the old generated trees and changing only `patches/three@0.185.1.patch` reproduces every exact CI received hash. The table is refreshed for that intentional change, and the existing stability test now rejects a stale packaged patch against the canonical bytes. The unchanged full66 scaffold contracts pass; the actual stale-artifact control fails at the freshness assertion and is restored. Qualified browser/native source inputs remain byte-identical, so their genuine runtime acceptance is preserved. This repairs the required gate rather than waiving it; green CI for the new exact head remains mandatory before merge.

Merged-harness replay at `e7f7baabc84bee7a4639f777c3bee5df5e169faf`: the externally merged startup handshake uses its existing startup budget, and adapter-request provenance distinguishes rejection from absence; later operation and scenario budgets remain unchanged. The [fresh actual receipt](../../verification/prd479/e7f7baabc-merged-harness/provenance.json) retains 20 source hashes including both changed harness files, 16 PNG hashes, genuine GPU validation before 1 / after 2 / errors 0, all positive predicates and the missing-gate control failing only collision. Browser and source-built native run on NVIDIA RTX 2080; unchanged dam/coupling pass 18/18 predicates. Fresh independent source, raw-mailbox/console, image-hash and visual review finds no issue. The eight browser/native images are byte-identical to existing public blobs and reuse them; eight new consumer capture records retain six distinct image blobs without deleting history. Focused 20 bridge/timeout tests, 5 actual browser-provenance tests, package typecheck/build pass. PRD acceptance remains 100%; green required CI on the final published head and merge-queue qualification remain mandatory. The prior hosted coupling software-device loss is preserved as an invalid capture; its raw cause was unavailable, and one unchanged local SwiftShader diagnostic passed all 9 coupling assertions without loss, which does not replace required exact-head CI.

Required CI at `704ca6d1` still fails honestly: [the dam consumer job](https://github.com/ThreeNativeHQ/threenative/actions/runs/37107524153/job/111159202420) captures valid gated/running images, then records software-device loss and blank settled/final captures. Its uploaded failure retained codes but no original console reason, so OOM, driver reset, browser termination and shader validation are not established causes. Diagnostic-only collection now embeds bounded recognized loss-console excerpts and sanitized original thrown error details in the existing failure artifact, explicitly naming absent report/console channels; complete raw console stays local. No workflow, permission, assertion, scenario or timeout changes are made. Focused failure-evidence regressions fail before the helper and pass after it; 22 proof tests pass. The [supplemental source map](../../verification/prd479/diagnostic-retention-source-map.json) names the two changed collection-script hashes and 18 unchanged qualified inputs; the historical 20-input receipt is preserved exactly, not relabeled as current CI. Actual solver/harness acceptance remains supported by the audited replay, while final required CI and auto-merge remain blocked until green.
