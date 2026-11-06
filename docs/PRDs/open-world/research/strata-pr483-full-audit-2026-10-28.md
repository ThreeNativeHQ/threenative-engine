# Strata / PR #483 — full-scope audit report

**Date:** 2026-10-28. **PR:** https://github.com/ThreeNativeHQ/threenative-engine/pull/483

**Reviewed head:** `ca945345f6d679b995de79ff2a33398765c3f187`. **Comparison base:** `bb8708b9544b9615283e2a9d7d220bccbc39f3de`.

## TLDR

❌ Hold this PR for repairs. Three terrain contract tests reproducibly fail, PNG texture export produces incorrect MIME metadata, and the forest demo takes about 36.8 seconds to first observed readiness. The supplied coastal screenshot also shows visibly broken nearshore water.

⚠️ The feature-scaling problem is shared mutable state and competing save/bake/readiness paths. Splitting large files has improved navigation, but has not consistently established ownership of state or removed duplicated workflows. Tests that extract private declarations by name add maintenance cost.

✅ This is an audit/report only. No product fixes, merges, deployment, or relaxed acceptance thresholds were made. Detailed scout notes are retained below, including rejected and unverified candidates.

## Scope, confidence and method

The entire 642-file PR change inventory was assigned across terrain/assets/MCP, Strata/scaffolding, and shared runtime/platform scouts. The PR contains 71,707 additions and 318,387 deletions. Most large deletions are height arrays and patch regeneration: net deletion does not establish reduced executable complexity.

Scouts ran through LeanPi using `opencode-go/deepseek-v4.1-flash`, requesting `--thinking max`. Chrome data was collected through actual Chrome DevTools MCP connected to an audit-owned browser. The reviewed source was isolated in `.worktrees/strata-pr483-audit`; the active Strata branch was left alone. A further manager pass and deeper runtime/browser passes were stopped for the owner's immediate-delivery request; their unfinished conclusions are not presented as verified.

**Coverage is broad, not an exhaustive line-by-line certification of 642 files.** Each complete scout appendix names its inspected and unreviewed areas. Binary art, native device behavior, all five biome runtime journeys, and matched before/after visual acceptance remain unverified. Forest is the performance workload. The user screenshot is visual evidence only; its source revision and settings were not supplied.

Status vocabulary: **reproduced** = an executed check/probe; **source-confirmed** = an inspected implementation path; **candidate** = additional validation needed. P2 means a material correctness/reliability/scaling issue; P3 means maintenance or diagnostic debt. Scout priorities in the appendices are provisional and subordinate to the corrections here.

## Fresh checks actually executed

| Check | Actual result |
| --- | --- |
| Frozen offline workspace install | Passed; initial missing-build prerequisites were resolved before evaluating failures. |
| Strata dependency builds, including core/physics/terrain | Passed. |
| Assets and playtest builds / package validation | Passed. |
| Production Strata build | Passed in 4.04 s; main JS chunk 23,367.55 kB, gzip 6,161.61 kB; ineffective dynamic-import warning. |
| Focused terrain, Strata and CI contracts | 58 files: 55 passed, 3 failed; 1,006 tests passed, 3 failed, 3 skipped. |
| Isolated rerun of the three failing terrain cases | All three failed again; 46 unrelated cases filtered/skipped. |
| Starter asset pack on Node 20.19.6, 22.22.0 and 24.16.0 | All three produced identical 32,195,739-byte packs with SHA `3f5f6b327c06271a014e4c1b4b7c0f014623db19763b4a7943c7cd787a25184b`; committed pin differs. |
| PNG export probe through actual `cookTerrainWorld` | Both one-layer and two-layer PNG inputs produced `images[].mimeType: image/jpeg`. |
| Forest browser interaction | Rendered nonblank scene; W movement and V view cycling worked; editor opened and clamped an out-of-range brush radius. |
| Published starter asset release metadata | GitHub digest/size match the OLD committed pin, not the fresh source pack. |

The first CI-only test attempt could not import the unbuilt assets package. That was a local setup limitation, not a PR defect. Those import failures are excluded from the defect list.

## Confirmed defects and failed contracts

### F01 — P2 — Published starter assets and source assets are different generations

**Reproduced.** `packages/terrain/starter-assets.json:3` pins SHA `db382c88c02719e68556b5a655e304b3bb97c7be5b4bd571ba6fcc6601600514`, 31,599,993 bytes. The fresh pack is 32,195,739 bytes with SHA `3f5f6b...`; identical on three Node versions. `packages/terrain/__tests__/kit-assets.spec.ts:77` fails. GitHub's published release still has the old digest and size.

Impact: repository runs and installed-package consumers can receive different art. Repacking the same current source cannot reproduce the published pin. This undermines install/runtime/visual comparisons and release reproducibility.

Repair: reconcile the intended asset bytes, regenerate the manifest and credits, and publish that exact content-addressed pack through the existing release path. Preserve the strict digest assertion.

### F02 — P2 — Streamed forest exceeds its own size contract

**Reproduced.** `packages/terrain/__tests__/starter-kit.spec.ts:152`: streamed output excluding the alternative combined `world.glb` is **38,988,402 bytes**, above **26,214,400 bytes (25 MiB)**, about 48.7% over budget. The test already separates combined and streamed representations, so this is not a mistaken sum of the two alternatives.

Repair: census repeated textures/models and generated LOD payloads, then remove the actual duplication or excessive bytes. Keep the contract rather than increasing it without an explicit product decision.

### F03 — P2 — PNG maps are labelled JPEG in exported GLB

**Reproduced.** `packages/assets/src/world/terrain-world.ts:129` returns from normalization when maps already match; a single map also bypasses normalization. At `:834–842`, missing explicit MIME falls back to `image/jpeg` after `setImage(bytes)`.

A real 1×1 PNG with signature `[137,80,78,71,13,10,26,10]` produced a GLB image labelled `image/jpeg`, for both one and two matching PNG layers. This is incorrect interchange metadata. Existing tests explicitly supply PNG MIME for the first layer, avoiding this case.

Repair: derive MIME from the supplied bytes when omitted and retain the explicit validated override. Add this exact small regression case to the existing cook test.

### F04 — P3 — Export generator reports the wrong package version

**Reproduced.** `packages/terrain/src/core/io.ts:408` emits `@threenative/terrain 0.1.2`; the package is `0.1.3`. `terrain-consumer.spec.ts:269` fails. `scripts/prepare-release.ts:292` has a synchronization path, but it has not made this reviewed head consistent.

Repair: run/fix the existing version synchronization and retain the consumer assertion. This is provenance drift, not a claim that geometry export fails.

### F05 — P2 — Landform conflict recovery can reject without handling the second failure

**Source-confirmed; runtime reproduction pending.** `packages/terrain/src/editor/selection.ts:190–192`: the `saveLayer` catch awaits `controller.snapshot()` without a nested catch. Both field application and mouse-up fire it with `void`. If the commit fails and the recovery fetch fails, the recovery rejection escapes. The neighboring placement-save path already handles this second failure explicitly.

Repair: reuse that existing recovery behavior, retain the draft, and report the connection failure. Test commit failure followed by snapshot failure.

### F06 — P2 — Existing scatter recipes acquire an undocumented required field

**Scout executed the validation rejection; source inspected.** `packages/terrain/src/core/validation.ts:525`, `operations.ts:832`, `types.ts:220`: omitted scatter `asset` previously defaulted to pine and is now rejected. Current fixtures have been updated, which does not migrate saved consumer documents. The current Breaking notes mention the export rename but omit this recipe change.

Repair: provide an explicit migration/error with the missing-field instruction and cover a pre-PR saved document. Preserve fail-closed validation; do not silently overwrite a rejected document.

### F07 — P3 — Published provenance instructions name a removed package path

**Source-confirmed.** The terrain package ships `starter-credits.json` and excludes the old `starter-assets/` tree. Starter READMEs still direct consumers to `@threenative/terrain/starter-assets/credits.json` (for example alpine README line 16).

Repair: update the five READMEs to the shipped credits location and check the packed contents. The provenance data exists; its documented location is wrong.

### F08 — P3 — MCP output-directory validation happens in conflicting stages

**Source-confirmed.** `packages/terrain/src/mcp/tools.ts:62–73` accepts a new project-relative `out`; `mcp/cook.ts:132–138` later requires it under `assets.source`. The schema/description does not communicate that restriction. A seemingly valid request can launch a child only to fail.

Repair: validate and explain the existing restriction before spawning. Reuse the current path guards.

## Forest performance data — diagnostic, not a benchmark verdict

Browser: Chrome 151, Linux, NVIDIA/Turing (RTX 2080 host), DPR 1. The screenshot viewport was 1600×900; the reported drawing buffer was 1568×715. Other GPU workloads were present, OS foreground/occlusion was not independently qualified, and a valid 30-second/1,000-frame steady-state sample was not completed. Consequently these readings do not prove representative FPS, a before/after regression, or hardware acceptance.

| Forest observation | Fresh reading | Interpretation |
| --- | --- | --- |
| First observed readiness | 36,775.9 ms; game resource 36,777.4 ms | Above the scenario's 15,000 ms target in this diagnostic environment. |
| Readiness after reload | 15,117.9 ms | Different cache conditions; not a paired optimization result. |
| Post-first-frame longest task | 1,314 ms | Above the 250 ms scenario limit in the sampled run. |
| Warmup at first ready observation | `incomplete`, pending 1 | Readiness/report consistency needs tracing; does not alone prove an actively compiling GPU after reveal. |
| Resident/loaded cells | 48 / 48 | No recorded streaming failures in the sampled forest state. |
| Instances | 218,816 | Actual scene population from the shipped resource surface. |
| Player GPU window | 12.02 ms; 933,232 triangles | Four samples; diagnostic only. |
| Meadow GPU window | 31.84 ms; 3,418,667 triangles | Four samples; diagnostic only. |
| Overview GPU window | 79.95 ms; 6,081,801 triangles | Four samples; substantial view-dependent workload. |
| Contact / movement | W increased travel; grounded true; max contact error ~0.000067 m | Opening/interaction success is separate from performance qualification. |
| Main production JS | 23.37 MB raw, 6.16 MB gzip | Bundle cost confirmed; no module-by-module attribution yet. |

The forest complaint has concrete evidence, but the expensive function/stage has not been isolated. A whole-world or overview workload reaches millions of triangles despite relatively few instanced draws. Fewer draws alone does not establish a cheap frame. Investigate visible instance/LOD/shadow/reflection work before adding another local optimization flag.

The first browser scout's short frame-count ratios are not accepted as FPS measurements. Its console/network lists were empty because separate MCP connections lost collection history; this does not establish a clean run. Likewise, its trace could not span separate helper processes. These are measurement limitations, not Strata bugs. A persistent-connection follow-up was started and stopped for immediate delivery.

## User-supplied visual defect

❌ **V01 — Nearshore water is visibly discontinuous.** The supplied coastal screenshot shows a bounded polygon/strip with stretched repeating bright bands, a hard edge against the surrounding ocean, and a shoreline join that reads as a separate slab. This is a clear visual failure against a continuous natural shoreline target.

Evidence: `/home/joao/Downloads/strata-pr483-audit/user-shoreline-defect.png`. Source revision/settings are unknown. Geometry, UVs, normals, layer composition, and displacement are hypotheses, not diagnosed causes. Inspect the shared river/ocean/shoreline path before patching a camera angle or hiding the seam. No before/after visual acceptance is claimed.

## Architecture and antipatterns behind the token cost

### A01 — Multiple save owners instead of one commit/recovery policy

`SaveQueue` owns recipe intents; selection has independent placement/landform commit state; cameras/environment/assets have direct commits. Each carries revision adoption, retry, retained drafts, and UI state. `selection.ts` already has unequal recovery behavior between landforms and placements (F05).

Additional source candidates: `saveLayer` silently returns while saving (`selection.ts:171`); `reassign` ignores its returned snapshot (`:407–425`); external snapshots are deferred without an obvious retained replay (`saveQueue.ts:150`, `app/evaluation.ts:462`). Whether UI disabling and SSE reconciliation prevent each trigger still needs integration verification. Keep these candidates separate from proven edit loss.

Smallest direction: consolidate commit/revision/recovery policy in the existing journal/controller, with explicit ownership. Avoid adding a fourth save wrapper.

### A02 — Readiness orchestration remains embedded in a very large scene

`examples/strata-terrain-preview/src/game.ts:382–465` owns local timer/promise/error state, with separate stream-join bookkeeping around `:958`. Tests locate eleven local declarations by name and execute extracted source (`__tests__/strata-loading.spec.ts:28–140`). A harmless rename can require test surgery, while the real wiring is replaced by fakes.

The issue is coupling between private lexical structure and tests, not the mere presence of readiness logic. Prefer a small directly exercised boundary using the existing startup/resource contracts; retain real end-to-end reveal assertions. Do not create a second readiness system in game code.

### A03 — World-cell decomposition does not fully isolate mutable state

The former approximately 10k-line file was split, which is an improvement. The current facade is still 2,807 lines and collaborators span data, models, render, chunks, impostors and prewarm. Several collaborators import shared types through the facade that imports their implementations. These are erased type edges, **not a demonstrated runtime cycle**.

The maintenance concern is state ownership and the number of modules needed to reason about a lifecycle change. Put shared contracts in the existing leaf module and make mutation/teardown ownership explicit. File splitting alone does not solve this.

### A04 — Bake and export workflows are duplicated across entry points

`packages/terrain/src/kit.ts:86–140` and `src/mcp/cook.ts:161–250` repeat recipe/height/asset/material preparation. The editor export route (`editor/server.ts:479–498`) runs a cook in the Vite process while MCP uses an isolated child with a deadline.

This creates drift and unequal failure containment. Reuse the existing preparation/isolation path where its contract fits; keep appearance in copied game source. In-process export has no evident equivalent deadline/concurrency guard, but request-blocking latency was not measured.

### A05 — Avoidable full-data scans make larger worlds expensive

`packages/terrain/src/core/placement-edits.ts:380–430` repeatedly searches the full placement array for overrides/removals: O(records × edits). Its 20k-record test uses one override, missing the bulk-edit scaling case. `packages/terrain/src/starter.ts:470–500` scans all cell runs/placements when prop colliders rebuild after movement, instead of first excluding distant cells.

These are source-confirmed work patterns, not measured frame-time attribution. Reuse the existing cell boundaries and a temporary ID index; measure record visits as the scale test before claiming FPS gains.

### A06 — Diagnostic policy is mixed into product behavior

A 596-line `waterProof.ts` is imported by ocean, sky and game code and keyed to the playtest label `horizon-sea`. The scene also computes acceptance booleans using threshold literals (`game.ts:1004–1057`). This links validation vocabulary to rendering/scene code and makes extending views costly.

Keep raw measurements in the scene, thresholds in assertions, and load proof-only instrumentation only when needed. Do not remove the numeric water proof: its fail-closed checks are valuable. The 23 MB bundle has not been attributed specifically to this module.

### A07 — Format/text contracts and snapshots inflate change cost

Staging extracts sky metadata with a line-format regex (`stage-terrain-kits.mjs:12`), while scaffold tests carry whole-tree hashes plus a long historical comment log (`scaffold.spec.ts:235–380`). Multiple tests assert command text, private declaration names, and JSON step names.

These checks can protect real packaging/wiring contracts; they are not inherently wrong. The cost is opaque failures and redundant manual updates. Read structured metadata where it already exists, automate intentional snapshot updates, and retain behavior assertions. The scout's claim that every template edit requires all sixteen hashes is overstated.

### A08 — Agent-facing tools amplify whole-document traffic

`terrain_patch` emits the complete edited recipe; parsing/patching serializes full documents. This is O(recipe size) per iteration. The PR greatly reduces starter recipes to a few kilobytes by externalizing height data, so it improves the old problem substantially. Remaining whole-document traffic is a contract tradeoff; measure actual response bytes before designing a stateful replacement.

### A09 — Fragile cache/fallback boundaries need targeted scrutiny

`assets/src/compile.ts` detects terrain GLBs in a preliminary read and later reads them again for cooking; terrain cache identity uses manual version strings. `terrain-world.ts:308–318` catches all foliage-thinning errors, potentially hiding an unexpected derivation failure as fewer far LODs. These are source-confirmed maintenance/diagnostic risks; their production frequency is unmeasured.

Use the existing content/pass identity and distinguish expected ineligibility from unexpected failures. Keep validation and explicit diagnostics.

## What to borrow from the local Unreal source

Read-only source inspected at `/home/joao/projects/UnrealEngine`, commit `396c9f059`, tag `5.8.3-release`. Borrow the patterns, not Unreal code or its framework architecture.

| Unreal source | Relevant idea | Strata application |
| --- | --- | --- |
| UE 5.8.3: `Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:3129` | Bound components created per frame and outstanding async work independently. | Budget admission, CPU preparation and GPU publication separately; keep near-player work ahead of far cover. |
| Same file `:3360–3396` | Publish completed async results only if their target is still used; preserve completion ordering. | One owner for stale-result rejection, generation identity and teardown. |
| UE 5.8.3: `Engine/Source/Runtime/Engine/Private/HierarchicalInstancedStaticMesh.cpp:2686–2712` | Reject obsolete/concurrently invalidated hierarchy results instead of applying stale state. | Explicit revision checks at publication, not scattered special-case flags. |
| Same file `:2864–2922` | Background hierarchy construction and explicit game-thread application. | Keep expensive preparation outside the visible-frame critical path, with bounded publication. |

This is not a recommendation to copy Unreal's numerical budgets. ThreeNative's own measured frame/cell contracts and existing workers should supply its budgets.

## Corrections to raw scout claims

The complete notes below are included because the owner requested everything. They are candidate collection, not an endorsed list of 53 bugs.

| Candidate | Disposition |
| --- | --- |
| RUNTIME-01: type-only dependency cycle is P1 | Downgraded to architecture concern A03; no current runtime cycle established. |
| RUNTIME-02/03: bounded readiness / WeakMap implies current reveal failure | Needs a concrete caller/timeline; copying a report hypothetically is not proof of an existing bug. |
| RUNTIME-04: removing compile windows creates a passing perf gate | Rejected as stated: an empty settled sample fails closed; separate steady-state and streaming-hitch measurements are both useful. |
| RUNTIME-05/08: sampler/copy validation implies device loss | Unproven. Native limit/error/range behavior needs actual platform tests. Cache invalidation after sampler-state mutation is a candidate, not a demonstrated live caller failure. |
| RUNTIME-06: clone necessarily writes getter-only source | Unproven; inspect real bound-class semantics. |
| RUNTIME-07: no-op dispose necessarily leaks | Unproven without ownership/release evidence. |
| RUNTIME-09: close always waits full timeout | Rejected as stated: the polling loop checks `closed`; slow observer/I/O behavior still needs measurement. |
| RUNTIME-10/11/12/13 | Diagnostic/coverage/cache candidates only; no unrun native result is claimed. |
| STRATA-01/02 P1 priorities | Downgraded; brittle tests and architecture costs are not production outages. |
| STRATA-03 private imports in repository tests | Not inherently a product defect. Runtime dependency on stale build output needs a specific reproduction. |
| STRATA-06 suggestion to relax failing budgets | Rejected. Keep acceptance bounds and fix measured causes. Historical PRD timings do not qualify this head. |
| STRATA-07 unused public API needs a CLI verb | Rejected: a library API need not have a CLI command; avoid inventing vocabulary. |
| STRATA-08 historical cold-pack failure | Needs current reproduction; this head includes later copied-layout repairs. |
| STRATA-12/16 | Conditional rejection-handling candidates; existing launch-failure hooks and current call paths need verification. |
| STRATA-15 optional stage-art skips | Coverage gap with local asset requirements; not proof ordinary runtime is broken. |
| TERRAIN-02/03/08 | Save/revision candidates described in A01; no claim of reproduced UI edit loss. |
| TERRAIN-10/11 | Material duplication / alternate-LOD combined-file cost needs artifact census. Alternate LOD scenes may be intentional; do not delete requested export behavior. |
| TERRAIN-18 | Copied game-owned appearance source is intentional. Consolidate duplicated mechanism, not user-editable look. |
| TERRAIN-20 | Atomic whole-document intent refusal may be correct conflict behavior; not data corruption by itself. |
| TERRAIN-21 | Pinned HTTPS/hash verification protects integrity; download memory/time limits remain robustness debt, not a demonstrated exploit. |
| TERRAIN-22 | Version publication conflict is conditional on actual publication/release procedure; no republish failure established. |
| TERRAIN-23 | Malformed GLB / primitive counting edge cases need focused witnesses before treating as a live consumer bug. |

## Repair order

1. **Restore a reproducible release candidate:** reconcile asset pack, forest byte budget, export MIME and generator version; rerun the exact failing contracts.
2. **Unify editor commit/recovery behavior:** first cover double-failure recovery, then reproduce overlapping landform/direct-save/SSE cases before changing ownership.
3. **Attribute the forest frame:** same camera, resolution, cache policy, quiet GPU, persistent trace and a valid settled window; count LOD/shadow/reflection work as well as draws.
4. **Fix the visible shoreline defect:** reproduce the supplied pose, isolate the shared cause and require matched visual judgment. Keep quality and budget assertions intact.
5. **Reduce maintenance amplification:** existing leaf contracts, one preparation path, structured metadata, directly tested boundaries; avoid a wholesale rewrite.

## Positive changes worth retaining

The PR removes huge inline height arrays, converts the untyped editor into typed modules, adds an intent journal and atomic fail-closed document writes, centralizes much starter runtime behavior, reuses WorldCells for props, and adds substantive texture/race/export tests. The package asset archive is content-addressed and its extractor refuses unsafe entry types. These are real improvements even though acceptance and architecture cleanup remain incomplete.

## Limitations and retained artifacts

No full workspace suite, native/Android/iOS runtime qualification, complete current-head CI run, or accepted paired performance/visual result was produced in this audit. GitHub reported this pinned PR as draft and conflicting with develop when inspected. The supplied screenshot's revision is unknown. Additional source gaps are explicitly listed in the scout appendices.

Screenshots are in `/home/joao/Downloads/strata-pr483-audit/`. The genuinely rendered forest and editor captures were inspected/collected; an accidentally mis-targeted transient blank screenshot is not a product verdict. The temporary audit checkout is disposable investigation material, not a product patch.

---

# Complete scout notes — provisional evidence and hypotheses

**Read the corrections above first.** Original claims/severities are preserved for completeness and traceability. A note marked confirmed by a scout can still be downgraded or rejected by the audit. Historical evidence and unexecuted recommendations are not fresh checks.



## Appendix — Terrain, assets and MCP

# PR #483 audit — packages/terrain, packages/assets, engine-mcp, scripts (scout report)

Head `ca945345f6d679b995de79ff2a33398765c3f187`; base `bb8708b9544b9615283e2a9d7d220bccbc39f3de`. Read-only; no repo files created/edited. Historical PRD/CHANGELOG claims are separated from fresh source proof.

## 1. Coverage and unreviewed paths

**Covered (source, not just names):**
- Full owned diff inventory: 160 files, +17,254/−276,597 in owned paths (recipes dominate the deletion).
- Terrain editor: `saveQueue.ts`, `selection.ts`, `landforms.ts`, `picking.ts`, `server.ts`, `worker.ts`, `app.ts`/`index.ts`, `app/evaluation.ts`, `app/session.ts`, `app/strokes.ts`, `app/tools.ts`, `app/exports.ts`, `app/api.ts`, `app/dom.ts`, plus `AGENT_GUIDE.md`, `package.json`, `tsup.config.ts`, `tsconfig.json`.
- Terrain core: `placement-edits.ts`, `world-package.ts`, erosion diff, validation/operations/types/terrain/io/export diffs.
- Runtime: `starter.ts`, `kit.ts`, `kit-assets.ts`, starter kit `world.ts`/READMEs/recipes, `starter-assets.json`, `starter-credits.json`.
- MCP: `server.ts`, `tools.ts`, `cook.ts`, `cook-child.ts`, `child.ts`, `glb-stats.ts`, relevant tests by name/selected bodies.
- Assets: all of `world/terrain-world.ts` (968 new lines), `lod/simplify-pool.ts`, `lod/cards.ts`, `lod/eligibility.ts`, `lod/generate.ts`, `passes/shared-images.ts`, `compile.ts` terrain wiring, `passes/model.ts`, `passes/lightmap*`, `audio-pcm.ts`, `index.ts`, `package.json`.
- engine-mcp diff, `scripts/capture-terrain-mcp-tools.ts`, `scripts/api-surface.json`, `scripts/not-owned-capabilities.ts`, `.gitignore`, package `files`/exports.

**Not reviewed in depth:** most test bodies (I read names plus selected fixtures), `editor/shell-layout.ts` (443 new lines), `shell-dialogs.ts` (181), `app/assets.ts`/`cameras.ts`/`environment.ts`/`layers.ts` beyond wiring, full 3k-line `compile.ts`, all assets tests, example app (other scout), binary images/GLBs, PRDs. No runtime/build was executed (see §5), so performance claims below are hypotheses unless labelled source-proven.

## 2. Findings

### TERRAIN-01 — P2 — confirmed: old `scatter` recipes without `asset` now fail validation
`packages/terrain/src/core/validation.ts:525` adds `scatter requires an asset identifier`; `core/operations.ts:832-836` no longer defaults to `"pine"`; `core/types.ts:220` makes `asset` required; `core/terrain.ts:436` makes `scatter(options)` required. Repro run: a document `{type:"scatter", params:{count:5}}` that previously meant pine is now **REJECTED**.
Minimal path: `Terrain.fromJSON(oldDoc)` → `validateDocument` → `validateLayer` → fail. In the editor, `TerrainEditorDocument` constructor falls back to an empty terrain with a diagnostic (`editor/server.ts:170-181`), so an old project file opens blank rather than as the authored world; `terrain_patch` rejects the same recipe.
False-positive check: all in-repo recipes/editor fixtures now carry `asset`, so tests pass; the break is for existing user documents. CHANGELOG’s Breaking section does not mention it.
Recommendation: either restore a named default with a deprecation diagnostic, or fail with a migration message and bump the package major/minor. Test: validate a pre-PR recipe fixture and assert an explicit migration error (or acceptance).

### TERRAIN-02 — P2 — confirmed: landform/layer saves are silently dropped while another save is in flight
`packages/terrain/src/editor/selection.ts:171-172`:
```ts
async function saveLayer(layer, base = snapshot, remember = true) {
  if (saving || !base) return;   // no message, no retry, no draft clear
```
`mouseUp` calls `void saveLayer(layerDraft, gesture.base)` (selection ~line 371) and `applyFields` calls `void saveLayer(next)` (~283). If a placement transform save is still awaiting its HTTP commit, the next landform drag/field commit is discarded with no `message`, while `layerDraft` remains visually applied. Contrast `save()` at line 131, which tells the user “Wait for the current transform save.”
Trigger: commit A held pending, drag/apply landform B, release. B is never committed. Test to falsify: hold the mock commit, call `saveLayer` twice, expect a message/queued commit; currently the second returns immediately.

### TERRAIN-03 — P2 — confirmed: `reassign` leaves the selection snapshot stale, so the next save 409s
`selection.ts:407-425`: `reassign` awaits `controller.commit(...)` but ignores the returned snapshot and never updates local `snapshot`. The next gizmo save/undo sends `baseRevision: current.revision` from the pre-reassign snapshot. Server returns 409; `save` catches and says “apply again to rebase explicitly” while retaining a draft (`selection.ts:155-162`).
Trigger: reassign an orphan override, then drag the same placement. Test to falsify: after `await reassign`, assert the next `commit` baseRevision equals the commit response revision.

### TERRAIN-04 — P2 — confirmed: non-JPEG material maps are embedded in `world.glb` as `image/jpeg`
`packages/assets/src/world/terrain-world.ts:834-842`: `normalizeKind` returns early when all maps of a channel already share dimensions/format (line 129-130), leaving `map.mimeType` unset. The first layer’s texture is then written with:
```ts
.setMimeType(mimeType ?? layer[`${channel}MimeType`] ?? "image/jpeg")
```
`diffMimeType`/`nrmMimeType` are optional in `ICookTerrainWorldMaterialLayer` (line ~55), so a caller passing PNG `diffBytes`/`diff` without a MIME gets PNG bytes labelled `image/jpeg`. That is an invalid glTF texture and can fail decode or violate validators/loaders. `normalizeKind` only sets `mimeType` when it re-encodes (line 151-158).
False-positive check: test `terrain-world.spec.ts:361` passes `diffMimeType: "image/png"`; starter cooks always pass JPEG. The public API default is the gap.
Recommendation: sniff the bytes (or `sharp.metadata().format`) per map, set the MIME automatically, and only honour the explicit field as an override. Test: 1×1 PNG `diffBytes`, no MIME, parse `world.glb` JSON and assert `images[0].mimeType === "image/png"` (a tsx repro was blocked by workspace resolution; run through the package test runner).

### TERRAIN-05 — P2 — confirmed: published package no longer ships the credits file every starter README points at
`packages/terrain/package.json:17-28` ships `starter/*/*` (json/r16/mjs/ts/md) and `starter-credits.json`, but **not** `starter-assets/`. All five starter READMEs say provenance is at `@threenative/terrain/starter-assets/credits.json` (e.g. `starter/alpine/README.md:16`), a path that does not exist in the published tarball and is not an export. Base shipped `"starter-assets"` wholesale.
False-positive check: tests assert `starter-credits.json` bytes equal `starter-assets/credits.json` (`starter-kit.spec.ts:324`), so the data is shipped, but the documented path is not.
Recommendation: point READMEs at `@threenative/terrain/starter-credits.json`, or add a re-export/shim. Test: `npm pack --dry-run`/tarball listing plus a link check over READMEs.

### TERRAIN-06 — P2/P3 — confirmed: MCP `out` contract disagrees with actual cook
Parent accepts any project-relative non-existing directory (`mcp/tools.ts:62-73`, `resolveOutput`), and the tool description only says “Relative directory that must not exist yet” (`tools.ts:34`). The child then rejects anything not under `assets.source` (`mcp/cook.ts:132-138`), after a process spawn and after `resolveAssetSource`; the default is under `assets.source`. An agent that calls `out: "worlds/forest"` (valid per schema) gets a failure instead of a world, burning the child start and tokens.
Recommendation: validate the relation to `assets.source` in the parent before spawning, or allow project paths and teach the asset manifest. Test: `parseGenerateInput` + parent call with `out:"worlds/x"` should fail before `runIsolated`/child.

### TERRAIN-07 — P2 — confirmed: `/api/export` runs an unbounded GLB cook inside the Vite process
`packages/terrain/src/editor/server.ts:479-498`: the route reads up to 64 MiB of prepared glTF JSON, dynamically imports the project’s `@threenative/assets`, then `await cooker.cookTerrainWorld({ preparedWorld })` in-process. There is no timeout, abort signal, concurrency guard, or child isolation; the MCP equivalent deliberately uses `runIsolated` with a 60 s kill (`mcp/server.ts:52-65`). A large prepared world or a slow texture/GLB encode blocks Vite’s request loop, SSE commits and editor HTTP APIs, and can retain hundreds of MB.
False-positive check: revision is re-checked after the cook, which protects consistency but not availability.
Recommendation: reuse the isolated-cook child (or a worker) with a deadline and body cap; reject concurrent exports. Test: a prepared world whose cook is slow must not delay `GET /api/document` beyond the deadline.

### TERRAIN-08 — P2 — hypothesis (needs integration test): deferred external snapshots are discarded, not replayed
`externalSnapshotAction` (`saveQueue.ts:150-158`) returns `"defer"` whenever a local intent exists. The only subscriber (`app/evaluation.ts:462-464`) simply `return`s on `"defer"` and stores nothing. When the queue later drains, the external snapshot is gone unless the server re-emits it. Direct-commit lanes (`createEditorSelection.save/saveLayer`, cameras, environment, assets) bypass `SaveQueue`, so an SSE broadcast caused by those lanes can be dropped while a stroke is queued. `c.saved` and `queue.#confirmed` then stay stale; each following save gets a 409 and pays a rebase round trip, and the preview can miss the external metadata update.
False-positive check: after a successful commit the queue’s own `#confirmed` is fresh; the bug is only for snapshots authored outside the queue or adopted while another intent was in flight.
Recommendation: keep the deferred snapshot and apply/adopt it when `hasLocalIntent()` becomes false; route all commit lanes through the queue. Test: queue one intent, deliver a direct-lane SSE snapshot while the commit is held, drain, assert `queue.base.revision`/`c.saved` equal the snapshot.

### TERRAIN-09 — P2/P3 — confirmed: MCP token cost is the whole recipe plus a code snippet
`mcp/server.ts:71` returns `JSON.stringify(patchRecipe(...))`, the entire edited recipe; `terrain_generate` returns a ~30-line `load` snippet plus every path/stat (`mcp/cook.ts:250-330`). There is no size cap on `terrain_patch` input or output, and `parsePatchInput` parses the recipe three times (`isTerrainDocument` → `patchRecipe` → `toJSON`). This is a direct contributor to the reported token sink: a repeated patch loop re-emits the recipe on every call.
False-positive check: the PR massively reduced recipes to 2.5–8 KB (from ~66k lines), so this is much better than base, but still O(recipe) per call.
Recommendation: return a compact summary/diff or a path to the updated recipe; add explicit max recipe/commands sizes. Test: a 10-command patch over the largest starter recipe stays under a stated byte budget (or the tool returns a path/diff).

### TERRAIN-10 — P2/P3 — confirmed-source / perf hypothesis: each mesh node gets its own property resolver, so shared materials are duplicated
`packages/assets/src/world/terrain-world.ts:556-562`: inside `for (const { node, mesh } of meshNodesOf(speciesDoc))`, `createDefaultPropertyResolver(doc, speciesDoc)` is recreated per node. A species with N nodes sharing one material produces N material copies (only `TEXTURE` is deduped later, line 935). This inflates `world.glb` and prevents material-level batching; the comment deliberately keeps geometry private, but materials need not be.
False-positive check: the sampler/UV test at `terrain-world.spec.ts:917` wants distinct samplers when they differ; identical materials should still merge.
Recommendation: one resolver for the species (or a property-identity cache) and dedupe materials by full state while preserving differing samplers. Test: two nodes with identical materials → one material in the GLB.

### TERRAIN-11 — P2/P3 — confirmed-source / perf hypothesis: `world.glb` embeds every alternate LOD level and its instancing buffers
`terrain-world.ts:909-927` creates one named scene and one instanced node per species-and-LOD in the **same** `world.glb` that is also written to disk as `models/*.glb` glTF files. The default scene is the only one a loader draws, but parsing/uploading `world.glb` still allocates accessors, meshes, and per-instance TRANSLATION/ROTATION/SCALE buffers for every far level of every species. This is a startup/memory cost that grows with species × LODs × placements, exactly where the PR added two far levels per species.
False-positive check: GLTFLoader only draws the default scene; but GLTFLoader still parses all accessors in the JSON/BIN (buffers are loaded eagerly), so the cost is real, though unmeasured here.
Recommendation: keep alternate levels in the separately streamed model GLBs only; or emit `world.glb` with the near scene and a documented separate LOD package. Test: load `world.glb` and assert node/accessor counts do not scale with species LOD count.

### TERRAIN-12 — P3 — confirmed: any foliage-thinning failure silently disables all far levels
`terrain-world.ts:308-318`: `farLevelDocument` catches *every* exception from `thinFoliageCards` and returns `undefined`; `deriveFarLevels` then returns the levels collected so far (line 344-345). A regression or malformed-but-valid model produces fewer/no far levels with no diagnostic, while the PR’s stated performance goal depends on them.
False-positive check: `thinFoliageCards` throws intentionally for non-card/static models (documented), so some catch is correct; a blanket catch still hides real bugs.
Recommendation: catch only the documented “no eligible cards” error, or report a diagnostic. Test: inject a non-card error and assert a diagnostic/warning rather than silent omission.

### TERRAIN-13 — P3 — confirmed: compile reads every GLB twice and hardcodes the terrain cache key
`packages/assets/src/compile.ts:2862` reads and `unpackGlb`s **every** `.glb` source to detect `tnTerrainWorld`, then `cookOne` reads the same bytes again at line 3104. For a model-heavy project this doubles I/O and JSON parsing at build start.
At `compile.ts:3108-3112` the terrain-world digest is a literal `"terrain-world-v1"` / `"terrain-world-native-separate-v2"` instead of a hash of the terrain pass configuration; changing the `modelPass({ vertexLayout: "separate", ... })` options without remembering to bump the string reuses stale cooked terrain. False-positive check: the comment/string version is intentional cache versioning, but it is a manual invariant with no test asserting it changes with options.
Recommendation: hash `terrainPasses` configuration like other passes; reuse the already-read bytes in `cookOne`. Test: change a terrain pass option, compile twice, assert a new output digest.

### TERRAIN-14 — P3 — confirmed-source / perf hypothesis: prop colliders rescan all placements every 4 m
`packages/terrain/src/starter.ts:470-500` (`PropColliders.#rebuild`) iterates every `run` in every cell and every record in the run on each 4 m follow movement, testing hypot. It ignores the manifest’s cell index to skip distant cells. With large placement counts this is O(total placements) per step, not O(nearby).
False-positive check: movement threshold limits frequency; no measurement here.
Recommendation: bucket runs by cell and visit only cells within `reach`, or maintain a coarse spatial index. Test: count record reads for a 10k-placement world and assert they scale with nearby cells, not total.

### TERRAIN-15 — P3 — confirmed-source / perf hypothesis: `editWorldPlacements` is O(records × edits)
`packages/terrain/src/core/placement-edits.ts:380-430`: every `remove` and every override does `current.findIndex(...)`, after building the full record array; clears do a full `filter`. The only perf test uses 20,000 records and **one** override (`placement-edits.spec.ts:370-384`), so the quadratic case is untested.
Recommendation: build an `id → index` map once and mark removals. Test: 100k records × 1k overrides with a time/operation budget.

### TERRAIN-16 — P3 — confirmed: MCP child inherits inspector/profiler flags
`mcp/server.ts:55-58` passes `...process.execArgv` to the cook child. If the MCP server is started with `--inspect`/`--inspect-brk` (or another port-binding flag), the child tries to bind the same debugger port and the cook fails; the user only sees a child error. False-positive check: normal `npx` startup has empty `execArgv`.
Recommendation: filter `--inspect*`/profiler flags, or start the child with an explicit loader-only argv. Test: spawn the server with `--inspect=0` and call `terrain_generate`.

### TERRAIN-17 — P3 — confirmed: `kit.ts` and `mcp/cook.ts` duplicate the bake pipeline
`packages/terrain/src/kit.ts:86-140` and `packages/terrain/src/mcp/cook.ts:161-250` both: read `recipe.json`, inline `raw16` heights with the same 0.1 m lattice shortcut, read `assets.json` + `surface.json`, evaluate/apply overrides, build species/materials and call `cookTerrainWorld`, then write `water.json`/table. A change to the world-package or starter format must be made twice, and the comments already drift (`kit.ts:92` vs `cook.ts:174`). This is a concrete example of feature-change coupling.
Recommendation: one `bakeStarter(kitDir, out, options)` used by both. Test: a single fixture asserting both entry points produce byte-identical `world.json`/`recipe.json` for a kit.

### TERRAIN-18 — P3 — confirmed: five near-identical starter `world.ts` remain
`starter/alpine/world.ts` vs `starter/desert/world.ts` differ only in names/URL (verified with sed/diff); each is ~300 lines, and the five READMEs are 105–126 lines each (560 total). `addStarterWorld` centralizes behavior, but the five copies of `PropColliders` subclass, `add<Kit>`, URL constants, collider tables and docs remain. This is the main agent-token/maintenance multiplier in `packages/terrain`; PRD-590’s “one starter world source” is only partly realized.
Recommendation: generate the five `world.ts` from one spec table (the generator is already implicit), or ship one parameterized kit module plus a small per-kit config. Test: a stale-generated-file check (header + regenerate diff).

### TERRAIN-19 — P3 — confirmed: landform conflict recovery can throw an unhandled rejection
`selection.ts:190-192`: `snapshot = await controller.snapshot()` is not wrapped in try/catch (unlike `save` at line 158-162). Callers use `void saveLayer(...)` (`mouseUp`, `applyFields`), so a network failure during conflict recovery escapes as an unhandled rejection; the user sees no message and the draft recovery path dies. Test: commit rejects + `snapshot()` rejects, assert a message and no unhandled rejection.

### TERRAIN-20 — P3 — confirmed by test: whole-document intents couple unrelated edits
`saveQueue.ts:232-246` marks an intent whole-document when *any* non-layer recipe field or metadata differs; the layer diff is then replayed atomically. `editor-save-queue.spec.ts:520-550` proves the consequence: a config seed edit is queued together with a toggle of a layer another writer removed, the toggle fails, and **the seed edit is refused too** (`server.document.recipe.config.seed` stays 73, `unsent.length === 1`). The label still says “1 edit(s)”, so the user cannot tell the config change is inside the refused unit.
Recommendation: split intents per independent field/lane, or report the bundled fields. Test: refuse only the incompatible layer command and retain the seed.

### TERRAIN-21 — P3 — hypothesis: starter asset download has no pre-download/body bound
`packages/terrain/src/kit-assets.ts:99-120`: when the local `starter-assets` directory is absent (published package), `fetch(url)` buffers `arrayBuffer()` whole, then checks `manifest.bytes`/SHA-256. A slow or hostile endpoint can stream an arbitrarily large body into memory before rejection; `Content-Length`, redirect count and timeout are unchecked. The cache directory is also trusted if present, without verifying its contents. False-positive check: the archive URL is package-pinned and HTTPS, and the hash is checked after download, so this is a DoS/robustness rather than integrity issue.
Recommendation: stream with a byte cap and timeout, hash while streaming, and validate `Content-Length` when present. Test: a file/URL response larger than `manifest.bytes` fails without allocating the extra (or with a bounded read).

### TERRAIN-22 — P3 — confirmed: release/API break under the same package version
`packages/terrain/package.json` stays `0.1.3` (base also `0.1.3`), while the PR removes `exportWorldGLB` (`packages/terrain/src/export.ts:201-...` now exports only `prepareWorldGLTF`), makes `scatter` options/`asset` required, and adds `bin`/exports. CHANGELOG’s Breaking section mentions the export rename but not the `scatter` change. If 0.1.3 is already published, this cannot be republished and is a semver violation; even unpublished, consumers’ recipes break silently.
False-positive check: the repo may bump versions at release time; I found no changeset. Test: package-version/tarball assertion in CI + a migration note for `scatter`.

### TERRAIN-23 — P3 — confirmed: `glb-stats` miscounts nontriangle primitives and does not check GLB length/version
`packages/terrain/src/mcp/glb-stats.ts:20-32` only validates the magic and the first chunk bounds; it ignores `version` and total length. It counts lines/points as draws but never adds triangles (fine), yet `TRIANGLE_STRIP`/`FAN` triangle counts ignore index restart values, and a non-indexed primitive without `POSITION` throws via `accessorCount(undefined)`. `measureGlb` is used in the MCP result, so malformed-but-loadable files can produce wrong `triangles` or a tool error.
Recommendation: validate version/total length, handle primitive mode 0/1/2/3 (skip triangles) and missing POSITION explicitly. Test: a line primitive and a valid GLB with trailing bytes.

### Positive/verified changes (not findings)
- `placementCells` new extent check and ID sidecar (`world-package.ts:130-160`, `282-303`) are fail-closed and covered by tests; the sidecar enables `editWorldPlacements`.
- `editor/server.ts` commit is atomic (`writeFileSync` temp + `renameSync`), validates the whole document, and refuses invalid disk saves rather than overwriting; `restoreLastValid` never writes a synthetic fallback.
- `runIsolated` kills the process group and rejects on timeout/abort; path/symlink checks in `resolveOutput` are careful and tested.
- `starter.ts` reuses one loader for all kits and restores materials on dispose; `editWorldPlacements` validates and rejects unknown fields, duplicate IDs, and placements outside the extent.

## 3. Architectural coupling / feature-change examples

- **Three independent “save lanes”**: `SaveQueue` (terrain recipe), `createEditorSelection` (placements/landforms), and the camera/environment/asset operations each call `controller.commit` directly. Adding a new authoring feature means deciding which lane owns it, keeping `snapshot`/`c.saved`/`#confirmed` in sync, and duplicating conflict/draft handling. TERRAIN-03/08/19 are symptoms.
- **World-package knowledge spread across packages**: `packages/terrain/src/core/world-package.ts`, `packages/assets/src/world/terrain-world.ts`, `packages/terrain/src/starter.ts`, `packages/core/src/world-*`, and the generated `load` snippet in `mcp/cook.ts` all restate cell/run/placement/bounds/grounding rules. Changing the placement record or sidecar requires coordinated edits and tests in several packages; `editWorldPlacements` adds a fifth.
- **Two starter bake pipelines** (`kit.ts` vs `mcp/cook.ts`) plus five `world.ts`/README copies: a starter format or asset-list change is a multi-file, multi-copy change and a large context load for agents (TERRAIN-17/18).
- **Editor server vs MCP cook isolation asymmetry**: one runs heavy cooks in a child with a deadline; the other in the Vite event loop (TERRAIN-07). Feature work on export must be done twice.
- **Manual cache keys**: `compile.ts` terrain keys are literal strings, unlike hashed pass configurations; a pass change without a version bump yields stale outputs (TERRAIN-13).

## 4. What improved in PR

- Starter recipes shrank from ~66k lines each to 2.5–8 KB by moving heights to `heightmap.r16`; repo/token/context cost drops dramatically.
- The 1,481-line untyped `editor/app.js` became typed modules with a client intent journal (`SaveQueue`) that separates “in flight/queued/refused”, rebases once on 409, merges whole documents, and exposes retry/discard. The 614-line save-queue suite covers concurrency, reorders and refusals.
- Landform gizmo math became a tested pure module (`landforms.ts`), and placement picking/projection is injected and tested without a renderer.
- Editor document writes are fail-closed and atomic; invalid disk saves are surfaced instead of overwritten.
- The shared `addStarterWorld`/`PropColliders`/`editWorldPlacements` API removes most per-kit runtime duplication and lets games edit placements from source without rebaking.
- Deterministic far-LOD derivation, parallel simplifier workers, preserved card components, native separate vertex layout, shared JPEG optimization, and texture-map normalization are all covered by new tests.
- The MCP server now has closed schemas, path/symlink hardening, process-group timeout kill, GLB measurement, and a cold-load test.
- Starter assets are content-addressed and downloaded with SHA-256 verification through a restricted tar extractor (no links/devices).

## 5. Commands actually executed and results

- `git log`, `git status`, `git diff --stat/numstat/name-status`, `git show base:...` for base comparisons (no writes).
- `cat`/`sed`/`nl`/`rg`/`diff` over the listed files; `ls` of starter/starter-assets dirs.
- `find`/`rg` for callers and tests (`validatePlacementOverrides`, `scatter`, `grounding`, `prepareWorldGLTF`, `exportWorldGLB`, `unpackGlb`, `saveLayer`, `reassign`, `createDefaultPropertyResolver`).
- Runtime repro (tsx, repo source, read-only): old scatter recipe → `REJECTED: scatter requires an asset identifier`.
- Runtime repro (tsx): directive diff `diffLayers([{enabled:true}],[{enabled:false}])` → `[{"op":"toggle","id":"x","enabled":false}]` (toggle path works).
- Attempted a read-only PNG-MIME cook repro via `/tmp` script: failed before task code with `ERR_PACKAGE_PATH_NOT_EXPORTED` (workspace `@threenative/terrain` resolution), so **no runtime proof** for TERRAIN-04 yet; source-proven only.
- No `npm install`, network, build, test runner, `git checkout`/commit, or repo file creation was performed.

## 6. Missing runtime proof and questions

1. **TERRAIN-04**: run the assets test runner with a PNG `diffBytes` and no `diffMimeType`; inspect `world.glb` JSON. This needs the package’s built `dist`/workspace alias, which my direct tsx run could not resolve.
2. **TERRAIN-07**: measure API latency while a large `/api/export` cook is running; verify no timeout exists (source shows none).
3. **TERRAIN-08**: integration test with the real editor session: direct-lane commit + queued stroke + SSE; determine whether any later event re-adopts the deferred snapshot.
4. **TERRAIN-10/11/14/15**: measure GLB material/node counts and collider scan counts; my claims are structural, not performance numbers.
5. **TERRAIN-05/22**: `npm pack --dry-run` on `packages/terrain` and the release process (does it bump `0.1.3`?) to confirm the shippability/semver issue.
6. **TERRAIN-01**: decide whether this is an accepted breaking change; if yes, it needs a migration path for saved `world.json` documents, not just a CHANGELOG line.
7. **TERRAIN-09**: agree on a token budget for `terrain_patch`/`terrain_generate` outputs; the current tools return O(recipe) JSON plus a code snippet by design.

**Overall:** the PR’s core direction (typed editor, intent journal, fail-closed document, single starter runtime, far-LOD derivation) is sound and substantially better than the base. The highest-value fixes before merge are the silent landform-save drop (TERRAIN-02), stale snapshot after reassign (TERRAIN-03), the MIME fallback (TERRAIN-04), the missing credits path (TERRAIN-05), and either documenting or reverting the `scatter` compatibility break (TERRAIN-01).


## Appendix — Strata example and scaffolding

# Scout report — PR #483 (Strata) — areas: `examples/strata-terrain-preview/`, `packages/create-threenative/`

Base `bb8708b95`, head `ca945345f`. All findings below are from fresh reading of the working tree/`git diff base...HEAD` in `/home/joao/projects/threenative/threenative-engine/.worktrees/strata-pr483-audit`. Nothing was edited. "Historical" marks anything taken from the PR's own PRDs rather than reproduced here.

## 1. Coverage

**Diff size in my areas** (`git diff --numstat base...HEAD`):
- `examples/strata-terrain-preview`: **85 files, +13,302 / −4,981**
- `packages/create-threenative`: **134 files, +2,252 / −123**

**Current size** (not a bug by itself, used as token-cost evidence): preview `src` 14,929 LOC, `__tests__` 5,934 LOC, `scripts/*.mjs|mts` 9,664 LOC, `playtests/*.json` 2,760 lines. Total ≈ 33k lines for one example app.

Read in full: `src/game.ts` (all hunks + the `enter`/`exit`/spawn-gate/state-publish regions), `src/render/loading.ts`, `src/render/waterProof.ts`, `src/world/forestStage.ts`, `src/main.ts`, `src/launchFailure.ts`, `src/viewStatistics.ts`, `scripts/bake.mjs` (head + fingerprint/stamp), `scripts/stage-terrain-kits.mjs`, `packages/create-threenative/src/terrain-kit.ts`, `src/index.ts` (packageManager region), `src/doctor.ts` diff, `__tests__/strata-loading.spec.ts` (harness head + gate harness + typecheck test), `__tests__/water-proof.spec.ts` (head), `__tests__/editor-durability.spec.ts` (head/tail), `__tests__/forest-stage.spec.ts` (head + skip logic), `__tests__/scaffold.spec.ts` (hash table + test), `__tests__/terrain-kit.spec.ts` (integration block), `playtests/terrain.playtest.json` (structure + assert block), `vite.config.ts` diff, `check-temperate.mts` diff, `terrain-mcp-tools.json`, `scripts/__tests__/mcp-tool-schemas.spec.ts`, `PRD-591` (status/AC/evidence).

Skimmed only: `src/render/editorView.ts` (revision hunks only), `src/render/biomes.ts` (`measureBiome`), `src/render/props.ts`/`propStreaming.ts`/`cover.ts`/`terrain.ts` diffs, `scripts/fixtures/kit-game/KitScene.ts` (head + constants), all 18 `scripts/verify-*.mjs` (inventory + sample), `playtests/editor.playtest.json`, `__tests__/prop-streaming.spec.ts`, `prop-lod.spec.ts`, `editor-view` playtest JSON.

**Not reviewed (honest gap):** `src/render/river.ts` (1,039 LOC, no diff), `pack.ts` (854, only 28 lines of diff), `propMaterials.ts` (1,204, 126/53 diff), `scatter.ts` (660, untouched), `packages/terrain/*` (other scout), all `scripts/dem/*` binaries, `prep-*.py`, `scripts/verify-consumer.mjs` internals (647 lines), remaining `create-threenative/templates/**` JSON payload byte-for-byte.

## 2. Findings

### STRATA-01 — P1, confirmed (source-proven). The "shared readiness gate" was deleted and re-inlined into the 1,591-line scene, then tested by scraping the scene's source.
- `examples/strata-terrain-preview/src/render/loading.ts` lost `createSpawnReadiness` + `spawnReadinessSnapshot` (−185 lines, diff hunk at old `loading.ts:69-193`).
- `examples/strata-terrain-preview/src/game.ts:382-465` now hand-rolls the identical state machine inside `enter()`: `deadlineAt` (386), `spawnReady`/`spawnError`/`spawnSettled` (387-392), `spawnPromise` + `resolveSpawn`/`rejectSpawn` (393-398), `settleSpawn` (399-408), `failSpawn` (410-423), `spawnTimer` (425-428), `captureSpawnFailure` (429-454), plus per-stream `spawnJoins` bookkeeping (958-993) and a second copy of the join for the `?stage=` arm (734-750).
- The compensation is in the test: `__tests__/strata-loading.spec.ts:28-47` (`GATE_NAMES` = 11 **local variable names** of `enter()`), `:36-63` (`gameDeclarations()` walking the AST of `game.ts`), `:106-140` (`spawnGate()` splicing those declarations into `runInNewContext`), 23 `runInNewContext`/`createSourceFile` call sites in that one file. `forest-startup.spec.ts:307-343` and `prop-lod.spec.ts` repeat the technique.
- **Minimal triggering path:** rename `settleSpawn` (or move it into a helper class) → `Error: Missing production declaration settleSpawn` in 6+ tests; no production behaviour changed.
- **Impact:** every future edit to `enter()` carries a hidden cost of editing a test that mirrors its private scope; the extracted code runs against *hand-written fakes* (`setTimeout`, `ctx.state.set`, `Promise.all`) so it cannot fail when the real wiring breaks — the fidelity is inverted: more test code, less coverage of the real path. It also directly contradicts the PRD shipped in this same PR (PRD-591 AC-2 "the example's readiness module is deleted").
- **False-positive check:** confirmed no other module exports a readiness gate (`rg 'createSpawnReadiness|spawnReadinessSnapshot'` → only that PRD doc); no engine-owned replacement is used for the `settle/reject` semantics (`WorldCells.whenSpawnReady` is only one of the joins). The three guards (`released`, `spawnSettled`, `capturingSpawnFailure`) and the `try/catch` around `captureSpawnFailure` are legitimate; the problem is location + test strategy, not the semantics.
- **Smallest root-cause fix:** put the gate back in one module (`src/render/spawnGate.ts` or engine `WorldCells`) taking `{now(), setTimeout}` so it is unit-testable directly; delete `gameDeclarations`/`GATE_NAMES`. **Falsifying test:** the new gate spec must fail when `settleSpawn` is replaced by `() => undefined`; and `strata-loading.spec.ts` must shrink without losing an assertion.

### STRATA-02 — P1, confirmed. Scaffold "byte-stability" test is a 16-entry hash table with a 130-line changelog in source; every intended template change costs 16 manual hashes.
- `packages/create-threenative/__tests__/scaffold.spec.ts:235-380` `PRD_201_PARENT_SCAFFOLD_HASHES`: ~130 lines of `// Recomputed after <sha>` comments followed by 16 sha256 values; `:786-835` scaffolds all 16 templates, hashes every byte (`scaffoldTreeHash`, `:420-453`), and `expect(actual).toEqual(PRD_201_PARENT_SCAFFOLD_HASHES)`.
- This PR alone adds 12 comment lines (`git diff` hunk at `:194-232`, `:281-330`) and rewrites 14 of the 16 hashes.
- **Triggering path:** change one byte in any template (this PR adds the terrain MCP entry to 13 templates' 7 client configs) → 13-16 failures that say only "hash mismatch"; the fix is manual re-measurement.
- **Impact:** the dominant token/maintenance cost of any template or patch change; it also encodes *no* intent (a hash cannot say which change was allowed), and the comment log duplicates git history inside a test file that agents must read and extend.
- **False-positive check:** the test does guard real regressions (platformer/ kart asset assertions at `:795-825` are genuinely useful and separate). The cohort-pin placeholder (`COHORT_PIN`, `:436-441`) already solves the one recurring automated change; the rest is not automated.
- **Smallest fix:** keep per-template *allowed-diff* assertions instead of whole-tree hashes (e.g. assert the set of changed paths vs the previous commit, or hash only the shared patch bytes that actually move), and move the historical log to the PRD. **Falsifying test:** an allowed template edit (add a comment line to `templates/starter/src/game.ts`) must pass without touching the test; an accidental delete of `templates/kart/kit.json` must fail.

### STRATA-03 — P2, confirmed. Preview tests/scripts reach into other packages' `src/` and `dist/`, so unrelated refactors break the example and vice-versa.
- `__tests__/editor-durability.spec.ts:4-9` imports `../../../packages/playtest/src/scenario.js`, `packages/terrain/src/editor/app/evaluation.js`, `.../session.js`, `.../editor/server.js`, `packages/terrain/src/index.js`, `../../../test-support/temp-dir.js`.
- `__tests__/prop-lod.spec.ts:19-20`, `__tests__/forest-stage.spec.ts:24` import `packages/core/src/{game,scene,picking}.js`.
- `scripts/bake.mjs:390` hashes **and imports** `../../../packages/terrain/dist/index.js`; `scripts/verify-ocean.mjs:4`, `verify-tool-groups.mjs`, `verify-surfaces.mjs:6` import `packages/playtest/dist/...`, `packages/runtime-native/conformance/metrics.mjs`, `packages/terrain/__tests__/fixtures/png.mjs`.
- **Triggering path:** move `packages/terrain/src/editor/app/evaluation.ts` (a private path, not in the package `exports`) → preview tests fail to resolve; conversely, a preview-only change can break `packages/terrain/__tests__/kit-assets.spec.ts:10`, which imports `../../create-threenative/src/terrain-kit.js` across package boundaries.
- **Impact:** the example is not an example — it is a second consumer coupled to internals, so "hard to add features" is structurally enforced; also `bake.mjs` silently uses a **stale** `dist` if `packages/terrain` was not rebuilt (its content is hashed into the bake stamp, so a stale dist just gets baked and stamped as current).
- **False-positive check:** `@threenative/terrain` *is* a declared devDependency of the preview (`package.json` devDependencies) and exposes `./starter`, `./kit`, `./editor/server` — so exported subpaths exist for the cases that matter; only the tests bypass them.
- **Smallest fix:** add the missing `exports` entries (`./editor/app/*`, `./test-fixtures/*`) or a `@threenative/terrain/testing` entry, and import via package specifiers. **Falsifying test:** `pnpm --filter strata-terrain-preview test` must pass with `packages/*/src/**` renamed to a private folder.

### STRATA-04 — P2, confirmed. Several proofs assert on *build-script text* instead of behaviour.
- `__tests__/water-proof.spec.ts:20-60`: parses `package.json`, then `expect(command).toMatch(/^pnpm build && node \.\.\/\.\.\/packages\/playtest\/dist\/runner\/cli\.js playtests\/terrain\.playtest\.json /)` and `toContain("--url '…&waterproof=1'")`, `toContain("&& node scripts/verify-ocean.mjs artifacts/playtest/web --proof=water")`. This is the first test in the file, i.e. the proof suite's headline "coverage".
- `__tests__/strata-view-statistics.spec.ts:47` reads `playtests/terrain.playtest.json` to derive expectations; `__tests__/strata-loading.spec.ts:1080-1099` compiles a fixture with `ts.createProgram` inside a unit test.
- **Triggering path:** change the artifact directory name or add `--headed` to a different position → test fails with zero behavioural information; conversely, if `verify-ocean.mjs` stops actually checking anything, these tests still pass.
- **Impact:** false confidence plus brittleness; string assertions are the cheapest thing to write and the most expensive thing to maintain across a 33k-line example.
- **False-positive check:** the ROI/layout math in the same file (`padded`, `clipWaterProofRoi`, `classifyWaterProof` tests) is real unit coverage and is fine; only the manifest/JSON scraping is the issue.
- **Smallest fix:** assert the exported script *behaviour* (`verify-ocean.mjs` exports a `verify(dir, mode)`; the spec calls it with a synthetic readback), and drop the manifest regex. **Falsifying test:** rename `artifacts/playtest/web` → suite should still pass; break `verify-ocean.mjs` classification → suite must fail.

### STRATA-05 — P2, confirmed (source) / runtime unproven. 596 lines of GPU diagnostic live in production source and are wired into three product modules, keyed to one playtest step name.
- `src/render/waterProof.ts` (new, 596 lines): `WaterProofProbe`, MRT limit assertions, `copyTextureToBuffer` row-layout math, a module-global `physicalCopy` (line 552), `console.info("TN_WATER_PROOF:…")` on every observation (`:520`), and `sampleActiveWaterProof` which **hard-codes** `if (request?.label !== "horizon-sea") return { available: false }` (`:563-565`).
- Imported by product code: `src/render/ocean.ts:38,316-321`, `src/render/sky.ts:45,259-270`, `src/game.ts:54,1479-1482`, and registered as a game plugin (`game.ts:1572`).
- **Triggering path:** rename the playtest step `horizon-sea` (or add a second water view) → proof silently returns `available:false`; the verifier then fails for a reason that points at the GPU, not the label. On a device whose `readRenderTargetPixelsAsync`/MRT limits differ, the code throws from the world pass.
- **Impact:** the flag is a module-level const read from `location.search`, so none of it is dead-code-eliminated: every user of the preview downloads and boots the diagnostic. It is also the kind of code that needs a GPU to test, which is why it is guarded only by a synthetic-layout unit test.
- **False-positive check:** the fail-closed design (length/format/limits/non-finite checks) is genuinely good and the ROI math is tested; `water-proof.spec.ts` has real tests, so this is not untested code — the finding is placement and coupling, not correctness.
- **Smallest fix:** move it under `scripts/` (or a `*.proof.ts` loaded via dynamic `import()` only when `waterproof=1`) so the beauty path never links it, and pass the step label in from the playtest resource instead of the literal. **Falsifying test:** `pnpm build` must produce a bundle with no `TN_WATER_PROOF` string unless the flag is on; renaming the step must be caught by a test, not by a GPU run.

### STRATA-06 — P2, historical (PR's own evidence) + source-proven thresholds. The lane's own performance budgets are self-documented as failing.
- `playtests/terrain.playtest.json` asserts `enterMs ≤ 50` (`:685`), `afterFirstFrameTaskMs ≤ 250` (`:1042`), `timeToReadyMs ≤ 15000` (`:1049`), `maxViewGpuMs ≤ 12` (`:1062`), `measuredGpuViewCount ≥ 17` (`:1055`).
- PRD-591 (added by this PR) records on its own machine: `timeToReadyMs` 27.1→28.4 s and 26.3→27.1 s, `afterFirstFrameTaskMs` 482/488→597/787 ms, "still failing their budgets", `enterMs` "10 to 45 ms… the assertion has a thin margin under load". Verdict there: "`test:terrain:web` is 41 of 44 before and after".
- **Impact:** the "slow" complaint is corroborated by the PR's own numbers: the primary proof lane is red on three budgets, and `enterMs ≤ 50` is a flake surface by its own description.
- **False-positive check:** these are *their* host, not mine; I did not run the web playtest (needs WebGPU/headed browser + build) so I make no numeric claim of my own.
- **Smallest fix:** split "must pass" budgets from "recorded observation" resources until each has a measured margin; assert only `enterMs` with a percentile or a wider bound. **Falsifying test:** run `pnpm --filter strata-terrain-preview test:terrain:web` twice on an idle machine and report the three budget values.

### STRATA-07 — P2, confirmed. New public package entry (`./terrain-kit`) has no product caller.
- `packages/create-threenative/package.json:55-58` adds export `"./terrain-kit"`; `tsup.config.ts:10` adds the entry; `src/terrain-kit.ts` is 98 lines with careful symlink/allowlist checks; `__tests__/terrain-kit.spec.ts` is 322 lines including a packed-tarball check.
- `rg 'copyTerrainKit'` repo-wide: only `tsup.config.ts`, the spec, and `package.json`. No CLI command, no template, no `src/index.ts` import, no docs page.
- **Impact:** an API the user cannot reach from the CLI (`create-threenative` / `threenative`) but which is published, semver-locked and tested forever; the only way to invoke it is a hand-written `import { copyTerrainKit } from "create-threenative/terrain-kit"` (spec line 157 does exactly that to prove it works). That is speculative surface — the "kit" story the PRDs describe is completed by `stage-terrain-kits.mjs` + `template-assets`, not by this module.
- **False-positive check:** searched `templates/`, `agent-docs/`, root `scripts/`, `docs/guides` for `terrain-kit` usage — only `scripts/api-surface.json` records the export. The `copyTerrainKit` logic itself is reasonable and its error codes are tested.
- **Smallest fix:** wire it to a CLI verb (`threenative terrain kit <kit> <dir>`) in the same PR, or delete the export and keep the staging script. **Falsifying test:** a scaffolded project must be able to produce `terrain/alpine` using only documented CLI commands.

### STRATA-08 — P2, confirmed + historical. `prepack` now depends on another package's build output; a packaged-CLI spec is documented as failing because of it.
- `packages/create-threenative/package.json:73`: `"prepack": "node -e … && node scripts/stage-terrain-kits.mjs"`; `scripts/stage-terrain-kits.mjs:6` does `import { starterAssetsDir } from "../../terrain/dist/kit.js"` and reads `packages/terrain/starter-assets/credits.json` + `starter/<kit>/…`.
- PRD-584 (in this PR) states: "the `create-threenative` prepack … runs `stage-terrain-kits.mjs`, and the spec's copied tree has no `packages/terrain/starter-assets/credits.json`" and lists the golden-path CLI-packing failure as still failing.
- **Triggering path:** `pnpm pack` (or the golden-path spec that copies a subset of the tree, or a fresh clone before `pnpm -r build`) → `ERR_MODULE_NOT_FOUND ../../terrain/dist/kit.js` or `TN_TERRAIN_STAGE_METADATA`.
- **Impact:** publishing the CLI is now coupled to the build order of a sibling package and to a credits file outside the package; a cold tree cannot produce a tarball. This is exactly the class of coupling the PR otherwise claims to remove.
- **False-positive check:** `packages/terrain/dist` is produced by root `pnpm build`, and CI may build first; `template-assets/terrain/**` is committed, so a *published* tarball is fine. The failure mode is local/prepack-time, which is where the CLI proof runs.
- **Smallest fix:** stage into `template-assets/` in a checked-in deterministic step (or read `packages/terrain/starter-assets` by path, not through `dist`), and make `prepack` fail with `TN_TERRAIN_STAGE_MISSING_BUILD: run pnpm --filter @threenative/terrain build` instead of a module resolution error. **Falsifying test:** `pnpm pack` in a tree with `packages/terrain/dist` removed must fail with that message; the golden-path "packs a cold-layout CLI" spec must pass.

### STRATA-09 — P3, confirmed. Staging contract is enforced by a regex over `bake.mjs` source text.
- `scripts/stage-terrain-kits.mjs:12`: `const SKY_SOURCE = /^\s*sky: "(hdri\/[^"]+\.hdr)",$/gmu;` and `:33-40` throws unless exactly one match.
- **Triggering path:** reformat the kit's bake call (`sky:` on the same line as `bakeKit(`, or drop the trailing comma after a formatter change) → `TN_TERRAIN_STAGE_METADATA: alpine bake.mjs must supply one sky HDRI to bakeKit. Found 0.` — a build failure with a misleading message.
- **Impact:** formatting is now a publishing contract; the error names the wrong cause.
- **Smallest fix:** have `bakeKit` export/return its resolved sky path (or read the kit's `recipe.json`/`assets.json` which already cite it) instead of parsing JS. **Falsifying test:** reformat the call in a fixture copy; staging must still produce the same credits.

### STRATA-10 — P3, confirmed. The five kit names and the input file list are duplicated in four places.
- `KITS = ["alpine","coastal","desert","forest","tundra"]` + `COPIED` (6 files) in `packages/create-threenative/src/terrain-kit.ts:7-14`; `KITS` + `INPUTS` (5 files, credits split out) in `scripts/stage-terrain-kits.mjs:9-10`; the same enum in `terrain-mcp-tools.json:18`; the same five worlds again in `examples/…/src/render/biomes.ts` and `packages/terrain/starter/<kit>/`.
- Also `SUPPORTED_PACKAGE_MANAGER = "pnpm@10.25.0"` (`src/index.ts:73`, applied at `:690`) duplicates the root `package.json` `packageManager` field.
- **Triggering path:** add a sixth kit → 4-5 edits, one of which (`INPUTS` vs `COPIED`) silently disagrees if only one is updated: `terrain-kit.ts` copies `credits.json` as an input, the stage script *writes* it.
- **Impact:** drift that fails with `TN_TERRAIN_KIT_NAME`/`TN_TERRAIN_STAGE_METADATA` rather than a type error; the pnpm pin silently stops matching the repo's.
- **Smallest fix:** one exported `KITS`/`KIT_INPUTS` const imported by both TS and the mjs script; derive the pnpm pin from the root `package.json`. **Falsifying test:** a unit test asserting the staged folder set equals `COPIED` already exists (spec `:70-80`) — extend it to assert the two constant lists are the same object.

### STRATA-11 — P3, confirmed. `bake.mjs` now loads a TypeScript loader at import time and depends on an undeclared package.
- `scripts/bake.mjs:7-9`: `import { register } from "tsx/esm/api"; register();` followed by `const { BIOMES } = await import("../src/render/biomes.js")` and `GROUND_MAPS` (`:11-12`); `:383-389` adds six preview source files to the bake fingerprint.
- `tsx` is **not** in `examples/strata-terrain-preview/package.json` (checked) and not in its `node_modules` (checked) — it resolves only from the workspace root's devDependencies.
- `bake` runs from `dev`, `build`, `typecheck` and `test` scripts, so every one of those now pays a loader hook + TS transpile of 6 modules, and **any edit to `scatter.ts`/`terrain.ts`/`biomes.ts`/`terrainAssets.ts`/`benchmark.ts`/`placements.ts` invalidates `.bake-stamp`** → full re-bake on the next command.
- **Impact:** hidden dependency (works by hoisting accident), slower inner loop, and a bake that now depends on the game's view code — increasing the blast radius of render changes into authoring.
- **False-positive check:** the freshness property is real and desirable (the baked placements must follow `scatter.ts`); the problem is *how* it is obtained, not that it is obtained.
- **Smallest fix:** declare `tsx` in the preview's devDependencies (or make the imported modules `.ts` under `tsx`'s `--import`), and hash the *bake inputs* (placement counts/arrays) rather than whole source files. **Falsifying test:** delete root `node_modules/tsx`; `pnpm --filter strata-terrain-preview build` must still work.

### STRATA-12 — P3, hypothesis. `onReveal` is called outside the loading screen's try/catch, so a reveal-probe throw becomes an unhandled rejection.
- `src/render/loading.ts:322-341`: `void (async () => { try { await host.startup.whenReady(); } catch { …; return; } if (done) return; finish(); host.onReveal?.(); })();` — `onReveal` at `:339` is past the `catch`.
- `src/game.ts:326-339` `initializeRevealProbe()` **throws** `"Reveal probe requires virtual shadows"` / `"…requires ready props and an uncovered world"`.
- **Triggering path:** any configuration where `sky.sun.shadow.shadowNode` is not a `VirtualShadowNode` at reveal time (a shadow configuration the preview does not currently produce) or `ctx.startup.phase !== "ready"` in that tick → `Uncaught (in promise)` in the console, which the playtest's `assert.diagnostics.noConsoleErrors` (`terrain.playtest.json:670-675`) fails on.
- **False-positive check (ran):** `src/render/sky.ts:141-164` builds a `VirtualShadowNode` unconditionally on the outdoor-sky path and assigns it before the sky is returned, and `loading.ts:316` sets `layer.opaque = false` immediately before `finish()` — so on today's paths the throw is unreachable. This is a latent-trap finding, not a live bug.
- **Smallest fix:** wrap `host.onReveal?.()` in the same `try/catch` that already reports a launch failure, or make the probe *disable* itself instead of throwing. **Falsifying test:** a unit test in `strata-loading.spec.ts` whose `onReveal` throws must leave `console.error` called once and no unhandled rejection.

### STRATA-13 — P3, confirmed. Dead interface member keeps a stub in every test host.
- `src/render/loading.ts:42` still requires `readonly renderer: { compileAsync(scene, camera): Promise<void> }`, but the `compileAsync` prewarm call was deleted from `finish()`. It is now referenced only by the type and by test hosts (`strata-loading.spec.ts:150`, `forest-startup.spec.ts:113`).
- **Impact:** every new loading-screen test must fake a capability nothing uses; `warmup.status` (`:46`, `:259`) is the only startup signal actually read.
- **Smallest fix:** drop the member (or use it). **Falsifying test:** typecheck of `strata-loading.spec.ts` with the host's `renderer` removed.

### STRATA-14 — P3, confirmed. The crag diagnostics embed the playtest's pass thresholds.
- `src/game.ts:1004-1057` (inside `ctx.entities.add("props", { debug: … })`) computes `baseRingBuried` as `(cragBaseClearance ?? 1) <= -0.49 && (cragRingSamples ?? 4) >= 4`, `baseRingMeasured >= 100`, plus `Math.max(...alpineCrags.map(...))` and regexes (`/^(mountain|volcanic|reveal):/`) recompiled per call.
- Readers: `playtests/terrain.playtest.json:1103,1114`, and `src/render/props.ts` writes `cragBaseClearance`/`cragRingSamples`.
- **Impact:** product code contains the acceptance magic numbers of its own test, so the "proof" is partly circular (`-0.49` is defined by the gate it is checked against) and the diagnostic block (~55 lines) is part of the 1.6k-line scene.
- **False-positive check:** the values do come from real per-instance measurements; the burial threshold is the questionable part, not the sampling.
- **Smallest fix:** publish the raw numbers (`cragBaseClearance` min, `cragRingSamples` sum) and put `-0.49`/`4`/`100` in the playtest assertion where they belong. **Falsifying test:** change the threshold in the playtest and confirm no source file changes.

### STRATA-15 — P3, confirmed. The `?stage=` forest arms are unexercised and their tests skip silently.
- `src/world/forestStage.ts:35` `import.meta.glob("../../local-assets/forest-stage/*/world.ts")`; `local-assets/` is gitignored (root `.gitignore:208`), so on a clean checkout the glob is empty and `addForestStage` throws `Forest stage before: … is not staged`.
- `__tests__/forest-stage.spec.ts:111,264,289` guard with `it.skipIf(!existsSync(...))`; the same file hard-codes measured asset alpha fractions (`SOURCE_CUT` 0.3211 / 0.7637729644775391 / 0.8238) tied to binary texture bytes in `packages/terrain/starter-assets/`.
- **Impact:** an entire feature (kit-reuse proof of PRD-590/591) passes CI by not running; if it does run, the numbers are tied to assets it does not own.
- **False-positive check:** `skipIf` is legitimate for licensed local art; the problem is that nothing in CI stages the arms, so the feature has no gate — and no playtest references `?stage=`, so the runtime path is untested end-to-end.
- **Smallest fix:** one CI job that copies the staged forest kit (`local-assets/forest-stage/{before,after}`) and runs the spec plus a 1-step playtest with `?stage=after`. **Falsifying test:** with the assets absent the spec must still be *pending in the report* (it is), and the coverage gate must count it.

### STRATA-16 — P3, hypothesis. `game.start()` rejection is unhandled in the entry point.
- `src/main.ts:15-18`: `void game.start().then(() => { failures.ready(); … })` — no `.catch`; `showLaunchFailures` subscribes to `onLaunchFailure` but a thrown/rejected `start()` (as opposed to an emitted failure event) surfaces as `Uncaught (in promise)`.
- **Impact:** the launch-failure UI may coexist with a console error, failing `noConsoleErrors`.
- **Smallest fix:** `.catch((error) => showLaunchFailures-style report)`. **Falsifying test:** a `main`-level unit test whose `start()` rejects must not leave an unhandled rejection (`launch-failure.spec.ts` already covers the event path at `:145`).

### STRATA-17 — P3, confirmed (mechanical). Duplicated comment blocks and pure-pass-through variables in the scene.
- `src/game.ts:1510-1522`: the comment "A short window so a playtest run actually closes one; the default 300 frames is longer than this scenario runs…" appears **twice** back-to-back (with punctuation variants), on `frameBudget` and again on `frameBudget.onWindow`.
- `src/game.ts:965-991`: `spawnJoins` status objects (`{data:"pending", prewarm:"pending"}` → `.then` observers) exist only to feed the failure receipt at `:1212-1224`, i.e. ~30 lines of bookkeeping for a diagnostic string.
- **Impact:** the two best indicators of copy-paste-in-a-hot-file; the second is the kind of thing the AST-scraping tests then depend on.
- **Smallest fix:** delete the duplicate comment; derive the receipt from `stream.readinessAt()` alone. **Falsifying test:** none needed beyond STRATA-01's module extraction.

## 3. Architectural coupling / "what a feature change costs"

Concrete feature-change paths traced end to end:

1. **"Add a sixth terrain kit."** Edit: `packages/terrain/starter/<kit>/` + `starter-assets/credits.json` + `KITS`/`COPIED` (`create-threenative/src/terrain-kit.ts`), `KITS`/`INPUTS` (`stage-terrain-kits.mjs`), `terrain-mcp-tools.json` enum, `BIOMES` + `createOutdoorSky` rig (`src/render/biomes.ts`, `sky.ts`), `BENCHMARK` poses (`benchmark.ts`), a `worldLoads` entry + `initialState` fields (`game.ts`), `kit-game/playtests/<kit>.playtest.json`, the 16-tree hash table, and 7 MCP configs × 13 templates if the tool description changes. That is ≥ 9 files across 4 packages before any new brush/art exists, and none of it is a type error if forgotten except the enum.
2. **"Change how spawn readiness is decided."** Requires editing a lexically-scoped 90-line closure in `game.ts:382-465` **and** the test that extracts it by name (`strata-loading.spec.ts:28-47`), plus the `spawnReadiness` state array contract read by playtests.
3. **"Let the water proof check two views."** Blocked by a string literal in `waterProof.ts:563` and a verifier that binds to the `horizon-sea` capture name.
4. **"Ship a template change."** 16 manual hash re-measurements plus a new 2-line comment in `scaffold.spec.ts`.
5. **"Touch `packages/terrain/src/editor/**`."** Preview unit tests import those private paths directly (`editor-durability.spec.ts:5-7`), so a rename breaks the example's suite with a resolution error.
6. **"Edit `scatter.ts` (a render file)."** Invalidates the bake stamp (`bake.mjs:383-389`) → every `pnpm dev/build/typecheck/test` re-bakes all five worlds first, through a `tsx` loader that is not a declared dependency.

## 4. What genuinely improved in this PR

- **Fixture de-duplication:** five per-world consumer fixtures (`kit-game/{Alpine,Coastal,Desert,Forest,Tundra}.ts`, **2,651 lines deleted**) replaced by one parameterised `KitScene.ts` (929) + per-world playtests — a real −1.7k and one place to change the consumer story.
- **Second prop pipeline deleted:** `props.ts` −338 (`levelFor`/`setLevels`/`createProps` ladder gone, per PRD-591 AC-1), `selection.ts` −329, `landforms.ts` deleted; `check-temperate.mts` migrated to `createStreamedProps` instead of the ladder — this is the PRD's promise actually kept.
- **Readiness *snapshot* code deleted:** `loading.ts` −185, and the spawn gate now joins the engine's `WorldCells.whenSpawnReady` + stream `prewarmed` (the join is right; see STRATA-01 for where the gate itself went).
- **Measured height bands instead of constants:** `biomes.ts:323-350` `measureBiome()` derives `elevationRange`/`heightBands`/`snowBand` from actual samples, with non-finite guards — this is the PRD-591 "constants → measured" item done properly.
- **Water proof is numeric, not visual:** the diagnostic attachment + half-float readback + `classifyWaterProof` fail-closed checks (format, row length, identity range, non-finite) replace pixel eyeballing; the copy-layout math is unit-tested.
- **Kits have one source and a guard:** `stage-terrain-kits.mjs` derives `credits.json` per kit from `starter-assets/credits.json` and refuses to write when a credit is missing; `mcp-tool-schemas.spec.ts:36-50` compares the recorded terrain MCP schema/description to the served table, so that snapshot cannot drift silently.
- **Doctor handles the optional addon:** `doctor.ts:221,236,644-652,2201-2206` warns (`status: "warn"`) instead of failing when `@threenative/terrain` is absent — a correct fix for an optional dependency.
- **Editor conflict path is durable by test:** `editor-durability.spec.ts:190-200` proves two stale writes return 409 and then 200, and that `not-saved` state is surfaced — the "never drops an edit" claim has a real regression test (though it imports private paths; STRATA-03).

## 5. Commands actually executed (and results)

```
git -C <worktree> rev-parse HEAD                       -> ca945345f6d679b995de79ff2a33398765c3f187
git diff --stat/--numstat base...HEAD -- <my areas>     -> 219 files +14,871/−5,195 (preview +13,302/−4,981; create-threenative +2,252/−123)
find/wc src, __tests__, scripts, playtests (preview)    -> 14,929 / 5,934 / 9,664 LOC / 2,760 JSON lines
rg -rn (misused, -r = replace) — corrected to rg -n     -> noted; all cited line numbers re-checked with `rg -n`/`sed`
rg 'createSpawnReadiness|spawnReadinessSnapshot'        -> only PRD-591 doc (no other module)
rg 'copyTerrainKit' repo-wide                           -> tsup.config, spec, package.json only
rg 'terrain-kit' repo-wide                              -> exports map + api-surface.json only
ls examples/strata-terrain-preview/node_modules         -> no `tsx`; root package.json:127 has tsx 4.23.5
rg 'import.meta.glob' packages/runtime-native/scripts   -> no matches (native bundler support unverified)
git diff --diff-filter=D/A (my areas)                   -> 6 deleted preview files, 6 added create-threenative files
npx vitest run --config vitest.config.ts \
  __tests__/groundSampler.spec.ts __tests__/placements.spec.ts \
  __tests__/strata-view-statistics.spec.ts              -> 2 files pass (13 tests), 1 FAIL: "Cannot find package '@threenative/core/world'" (packages unbuilt — environment, not proven a PR bug)
npx vitest run --config vitest.config.ts __tests__/strata-loading.spec.ts
                                                        -> 50 passed, 1 FAIL: "Cannot find module '@threenative/terrain/starter' or its corresponding type declarations" (same env cause; the failing test is the in-test `ts.createProgram` typecheck at :1080-1099)
```

No `bake`, `build`, `pack`, install, network or Git write commands were run (all write to the tree).

## 6. Missing runtime proof and open questions

**Not proven here (needs GPU/desktop/CI artifacts):**
- Whether the preview actually boots, and whether the reveal probe / water proof ever throw at runtime (STRATA-05, STRATA-12). Both need `?waterproof=1` headed WebGPU.
- Actual `timeToReadyMs` / `afterFirstFrameTaskMs` / `maxViewGpuMs` / `enterMs` values (STRATA-06) — only the PR's historical numbers exist.
- `pnpm --filter strata-terrain-preview typecheck` and the full 5,934-line test suite (blocked: `packages/*/dist` absent, and `typecheck` runs `bake` which writes files).
- `pnpm pack` under a cold tree (STRATA-08) and the golden-path CLI spec.
- Whether `pnpm build:desktop` supports `import.meta.glob` (STRATA-15) — no handler found in `packages/runtime-native/scripts`, but I did not read the bundler's esbuild plugin chain.
- Whether `@threenative/terrain` 0.1.2 is actually published (the MCP shim falls back to `npx`); network/source for that is out of scope.

**Questions for the author:**
1. PRD-591 AC-2 says "the example's readiness module is deleted" — is the inlined gate in `game.ts:382-465` intended as the end state, or a leftover of the split? (STRATA-01)
2. Is `create-threenative/terrain-kit` meant to be a user-facing API? If yes, which CLI verb reaches it? (STRATA-07)
3. Which of the four failing playtest budgets in PRD-591 are accepted debt, and where is that recorded outside the PRD narrative? (STRATA-06)
4. `terrain.playtest.json` asserts `measuredGpuViewCount ≥ 17`; with 5 worlds × 3-4 views, is that count stable if a view is added? (coupling: `viewStatistics.retainViewWindow` discards the first window after each visit)
5. Is the `console.info("TN_WATER_PROOF:…")` line intended to remain in the shipped preview build? (STRATA-05)


## Appendix — Shared runtime and native platform

# Strata PR #483 — RUNTIME SCOUT REPORT

Pinned head `ca945345f`, base `bb8708b95`. Scope: `packages/core/`, `runtime-native/`, `three-native/`, `playtest/`, `procedural-animals/`, `examples/{wasm-engine-boot,native-smoke,procedural-animals}`, `scripts/{profile-starter,visual-gate}.ts` (200 files, 34,003 insertions / 37,260 deletions in my slice). Historical PRD comments are treated as claims, not evidence; everything marked **confirmed** was read in current source.

---

## 1. Coverage and unreviewed paths

Read in full: new/split core modules (`world-cell-{data,chunks,batches,models,impostors,proxy,prewarm,render}.ts` import graph, `world-cells.ts` structure, `world-bundle-safety.ts`, `world-load-limiter.ts`, `world-package.ts` head, `startup-readiness.ts` changed regions, `warmup.ts` changed regions, `game.ts` startup/warm-up regions, `frame-budget.ts`/`render-pass-budget.ts` diffs, `compressed-texture-preparation` wiring), three-native (`texture-sources.ts`, `browser-renderer.ts` `initTexture`/`copyTextureToTexture`, `object-surface.ts`, `browser-entry.ts`), playtest (`perf.ts`, `deviceTransport.ts`, `captureLock.ts`, `cli.ts`), scripts (`profile-starter.ts` argument/RAF/GPU capture, `visual-gate.ts` lease), runtime-native (`shader/ir.{h,cpp}` changed regions, `graph.cpp` texture lowering, `renderer.cpp` mip/copy/normal/sampler regions, `web_host.cpp` new ABI, `renderer.h`), examples (`wasm-engine-boot` new pages/playtest matrix/package scripts).

Read only diff-level, not line-deep: `world-cell-render.ts` (2,676 lines, only `validateGpuFrame` path), `world-cell-impostors.ts`, `compressed-texture-preparation.ts` body (1,008 lines; behaviour only through its 1,409-line spec and `renderer.ts` wiring), `world-terrain-splat.ts`, `world-tiles.ts`, `world-gpu-scene.ts`, `world-impostor-surface.ts`, `procedural-animals` (2-line spec / donor motion), `native-smoke` worker-proof, `three-native/api/*.json`, `runtime-native` CMake/conformance scene JS, `frame_op_stream_replay_test.cpp`.

Not reviewed at all: `packages/core/patches/*.patch`, `three-patch/source-delta.patch` (3,017 lines), `mcp/*`, `runtime-native` physics Rust, native bindings headers, all of `examples/procedural-animals` donor tree, `tools/`, `.github/` beyond a targeted `rg`.

Size (this is itself a finding): `packages/core/src` = **94,866 lines / 199 files**; `packages/core/__tests__` = **121,774 lines / 288 spec files**. Tests already exceed source by 28%.

---

## 2. Findings

### RUNTIME-01 — P1 — Confirmed (source-proven architecture): the world-cell "split" leaves a 2,807-line facade and reintroduces a dependency cycle through it
`packages/core/src/world-cells.ts:1-2, 390-470` (class `WorldCells extends Group`), 2,807 lines, ~60 private fields, 6 collaborator objects (`#render`, `#chunks`, `#models`, `#impostors`, `#prewarm` + impl), 14 public methods. Every split module imports the shared `IAssetState` **through the facade** while the facade imports values from them: `world-cell-data.ts:18`, `world-cell-render.ts:1`, `world-cell-chunks.ts:36`, `world-cell-impostors.ts:35`, `world-cell-prewarm.ts:6` all `import type { IAssetState } from "./world-cells.js"`, and `world-cells.ts:1-2` imports `CellModels`/`CellRender` as values. Today this survives only because five of the six edges are `import type` (erased). Add one value import in `world-cell-chunks.ts` and the runtime graph is cyclic (TDZ on `WorldCells` class evaluation).

Trigger: any feature that touches a cell's state layout (e.g. adding one field to a resident cell) — `world-cell-data.ts` defines the interface, `world-cell-models.ts` owns `IAssetState`, `world-cells.ts` reads and mutates it, `world-cell-render.ts` and `world-cell-impostors.ts` consume it, and each of those imports the type from the facade, so an agent must read 2,800 lines of facade plus 6 modules to change one field. This is the concrete mechanism behind "hard to add features / token sink".

False-positive check: cyclic *type* imports are legal and compile; I am not claiming a current runtime cycle. I am claiming the boundary is nominal: the shared type lives in a leaf (`world-cell-models.ts`), the facade re-exports it (`world-cells.ts:3`), and submodules import it from the *hub* instead of the leaf.

Smallest root-cause fix: move `IAssetState` (and the collaborator-facing interfaces) into `world-cell-data.ts` (already the type leaf) and make every submodule import only `world-cell-data.js`/`world-cell-chunks.js`; forbid `world-cell-* → world-cells` imports. Falsifying test: a one-file spec that imports each `world-cell-*.ts` under `node --experimental-strip-types` (or a `dependency-cruiser`-style assertion) and fails when any submodule imports the facade; plus `pnpm typecheck` after converting one type import to a value import in a scratch branch (should still be legal, but the cycle test pins it).

### RUNTIME-02 — P2 — Confirmed (source): startup-readiness multiplexes three different waits onto one `#windowTimer` and one 10 s budget
`packages/core/src/startup-readiness.ts:404-445`. `#windowTimer` is (a) the compile-settle fallback (line ~392), (b) the after-holds warm-up budget (line ~433), and (c) the settlement wait (line ~422). The after-holds budget is hard-wired to `#stableWindowMs` (`STARTUP_STABLE_WINDOW_MS = 10_000`, line 70), while the held warm-up's own pass is allowed `STARTUP_COMPILE_BUDGET_MS / 3` = **5,000 ms** with pending compiles awaited *past* that deadline (`warmup.ts` `compileWithinDeadline` pushes the unfinished work into `pendingCompiles`), and a normal compile of the PR's own quoted 46,190-instance forest can take tens of seconds on slow adapters.

Trigger: held pass deadline expires at 5 s, `heldCompletion` still pending → `game.ts:1570 await heldCompletion` → 10 s timer fires → `#timedOut = "warmup"`, readiness resolves **while the GPU compile continues**, i.e. the exact reveal-under-compile the second warm-up exists to prevent, plus a `TN_STARTUP_LATE` warning every launch. Also `cancel()`/`#finishFrameWindow()` clear whichever wait currently occupies the field; correctness depends on the three phases never overlapping, which is asserted by comment, not code.

False-positive check: the reveal-under-compile is deliberate and documented ("a slow machine gets the world with a late shadow… instead of a loading screen that never lifts"), and `startup-readiness.spec.ts:495` covers "bounds a held warm-up that never settles". What is not covered/tested: `#timedOut`/continuation after reveal, or that the settlement timer installed by `finish()` (line ~417) is not the same field cleared by the after-holds `.then` (line ~448). No test distinguishes the three uses.

Fix: three named timer fields and a distinct `afterHoldsBudgetMs` option (game passes `heldBudget + slack`, not the frame-window constant); cancel the pending warm-up (an `AbortSignal` through `warmUpScene`) when readiness reveals past budget. Falsifying test: in `startup-readiness.spec.ts`, set `stableWindowMs` small, make `afterHolds` settle late, assert `timedOut === "warmup"`, assert exactly one timer is live, and assert a late `afterHolds` resolution cannot clear the settlement timer (inspect behaviour by resolving early and asserting reveal waits for `settled()`).

### RUNTIME-03 — P2 — Confirmed (source), fragility: the launch-gate completion promise is smuggled through a `WeakMap` keyed on the public report object
`packages/core/src/warmup.ts:236-247` (`warmUpCompletions`), `:1246-1252` (`warmUpCompletions.set(finishedReport, completion)`), `warmUpSceneWithCompletion` does `warmUpCompletions.get(report) ?? Promise.resolve()`. The lookup fails **silently**: any wrapper that clones/rebuilds the report (`{...report}`, a serializer round-trip, a test double) yields the resolved fallback, so `game.ts:1570 await heldCompletion` becomes a no-op and held startup reveals with compiles still in flight — the original bug this PR is fixing, reintroduced by a refactor three files away. `IWarmUpReport` is explicitly the serializable public surface, so copying it is a normal thing to do.

False-positive check: today `finish()` returns the same object identity through all paths and `game.ts` uses `result.report` directly, so the current path works (focused tests pass). The finding is about the contract, not current breakage.

Fix: return `{ report, completion }` directly from `warmUpScene` (the fields already exist in `IWarmUpReport`'s builder) or make `completion` an explicit non-enumerable property; delete the WeakMap. Falsifying test: a warm-up over a fake renderer whose `compileAsync` never resolves, then assert `warmUpSceneWithCompletion(renderer, ...).completion` is pending and that a copied report has no completion (documents which shape is contractual).

### RUNTIME-04 — P2 — Confirmed (source): the perf gate now discards every window that compiled, which can erase the steady-window evidence it exists to gather
`packages/playtest/src/runner/perf.ts:892-901`: `discard = (w,i) => (i===0 && length>1) || window.surface?.compiling === true`; `steady = budgets.filter(...)`. `surface.compiling` is set per window whenever `renderer.compiling` was true at *any* sample or `compileCount` moved (`game.ts:1759-1763, 1898`). A streaming world compiles pipelines continuously (asset arrival, LOD, shadow nodes), so a title can mark most or all windows compiling.

Impact: a run whose windows are all `compiling:true` now fails with `TN_PERF_WINDOWS_MISSING` (per the function's own doc) instead of measuring — and the heavy compile windows, precisely the hitch evidence, are labelled "not steady" rather than counted. That biases percentiles downward and makes the gate unstable across machines. It is a deliberate methodology change, but it is applied to the *entire* window rather than to the hitch.

False-positive check: `perf.spec.ts:213-240` pins the new behaviour (all-compiling → all discarded; settled windows after startup are assessed) and `:243` pins the malformed-flag throw; `assertBudgetSurface` (perf.ts:849-861) prevents a string flag from qualifying. No test asks what happens when compiling windows are the *only* windows, i.e. the failure mode above. `assessPerfMarkers` is a pure function, so this is verifiable without a device, but the frequency of `compiling:true` in Strata needs a log to confirm.

Fix: keep the window, tag it (`compile: true`) and apply bounds to it with a separate, explicitly documented rule, or fail with a dedicated code before discarding everything. Falsifying test: 10 `compiling:true` windows at 12 fps → assert which outcome is intended, and a mixed run (compiling startup + compiling steady tail, no clean window) → assert it does not report `pass`.

### RUNTIME-05 — P2 — Confirmed (source), partial fix: sharing equal samplers does not remove the >16-sampler device loss
`packages/runtime-native/src/engine/shader/ir.cpp:692-715`, `graph.cpp:471-491`. Sharing only happens when the state string (wrapS/wrapT/wrapR/mag/min/anisotropy) is **equal** and only for `!renderTarget && !depthTexture && !storageTexture`. A fragment program with 17 sampled textures at distinct states still builds a layout with 17 samplers; `renderer.cpp:2491-2507` then only logs `TN_PROGRAM_SAMPLERS` after the fact. WebGPU's 16-sampler-per-stage limit is exactly what loses the device per the commit message.

Second, narrower defect in the same code: `samplerOwner` caches on `textures_.size() * 1000003u + exprs_.size()` (`ir.cpp:698-710`, `ir.h:269`) and **not** on `samplerStates_`. Any `setSamplerState` for an already-created texture that adds no texture/expression leaves stale owners. Today `graph.cpp` sets state immediately after creating the texture, so the key moves; nothing enforces that ordering.

Trigger: a material with ≥17 distinct sampled textures/states (terrain splat plus a mask stack is the PR's own motivation), or any future lowering that sets sampler state after first emission. Need runtime proof: no native test asserts a >16-sampler program either fails cleanly or shares.

False-positive check: `native-engine/shader_ir_test.cpp` gained 34 lines; I did not verify it covers sampler sharing/`samplerOwner` staleness. WebGPU limit is a known spec constant, not a measurement.

Fix: bump a `samplerStatesRevision_` in `setSamplerState` and use it in the cache key; when a stage still exceeds `kMaxSamplers`, fail program construction with a named error instead of a stderr note (or synthesize one shared sampler and a uniform-driven state). Falsifying test: `shader_ir_test.cpp` — create 17 textures with distinct states, assert the program reports the sampler count; then call `setSamplerState` on texture 0 after `samplerOwner(0)` and assert the owner answer changes.

### RUNTIME-06 — P2 — Hypothesis: `source` is installed as a getter-only accessor on every engine texture prototype, so a three-compat write to `texture.source` throws in strict mode
`packages/three-native/src/texture-sources.ts:93-107`: `Object.defineProperty(Native.prototype, "source", { configurable: true, get(){…} })` — no setter. `texture.source` is writable public API in three (`Source` reassignment is how `copy()`/cloning/serialisation work), and every ES module is strict, so a write raises `TypeError`. The repo itself never writes `.source` (`rg '\.source ='` only found unrelated fields), which is why it is currently invisible — and the new `browser-textures.spec.ts:146-162` only exercises `DataArrayTexture`, not a copy/clone path.

Impact: silent three-compat divergence on the native back end; core code that clones a texture would crash only on native. Needs a 5-line repro in the three-native harness (`const t = new bound.Texture(); t.source = { dataReady: false }` under strict mode) to promote from hypothesis to confirmed.

False-positive check: if the engine's own `Texture` constructor never assigns `source` and no product code does either, nothing breaks today; `clone()` is wrapped (line 80-90) but the wrapper calls the original clone, which upstream copies `source` — not verified in this checkout's bundled build (`rg` found no literal assignment in `three.module.js`, so I cannot call it confirmed).

Fix: add a setter that stores into the same `dataSources` WeakMap, or define `source` lazily per instance. Falsifying test: the repro above plus `const clone = texture.clone(); expect(clone.source).toBe(texture.source)`.

### RUNTIME-07 — P3 — Confirmed (source): native `dispose()` becomes a no-op for instanced/batched meshes and every `*Light`
`packages/three-native/src/object-surface.ts:236-245`, called from `browser-entry.ts:161`: `cls.prototype.dispose ??= () => {}`. Three documents `InstancedMesh.dispose()` as freeing the instance buffers and `Light.dispose()` as freeing the shadow map; on native those calls now silently do nothing, with no diagnostic and no test. A game that manages GPU memory by disposing on scene exit behaves differently on web and native. The comment asserts "the engine frees those with the object" — unverified.

False-positive check: `pnpm typecheck` and existing specs pass; nothing in the repo calls these disposes in a way the test suite observes. Fix: route to a real release or log once (`TN_NATIVE_DISPOSE_NOOP`) so the divergence is observable; test: construct a native `InstancedMesh`, call `dispose()`, assert it is callable and (if implemented) frees.

### RUNTIME-08 — P3 — Confirmed (source): native `copyTextureToTexture` validates only signs, not the region against the textures
`packages/runtime-native/src/engine/renderer/renderer.cpp:1511-1530` takes `copy.width/height/depth` and encodes a copy with **no** bound check against `source.width/height/depth` or the destination's size/layers; `web_host.cpp:490-515` rejects only negative values and `w < 0 && h < 0`. The JS facade (`browser-renderer.ts:892-935`) computes the size from a Box3/Box2 and forwards it. An oversized region becomes a WebGPU validation error inside an encoded command → uncaptured error → device loss, not a JS exception. Three's web backend throws on a bad region. Impact: a game's mistake loses the device instead of throwing. Fix: clamp/validate in `Renderer::copyTextureToTexture` and throw `TN_NATIVE_COPY_TEXTURE_RANGE`. Test: native ABI test calling the new `_tnw_web_copy_texture` with a region one texel over and asserting a refusal (no device creation needed if the check is in the host's `refuse` path).

### RUNTIME-09 — P3 — Confirmed (source shape), impact unproven: playtest `close()` now blocks on the in-flight mailbox poll, and the response observer is awaited on the poll path
`packages/playtest/src/runner/deviceTransport.ts:235-256` stores the pending wait in `responsePoll`; `close()` does `await this.responsePoll?.catch(...)` (line 253) *after* setting `closed`. If `waitForResponse` does not short-circuit on `closed`, `close()` waits out `operationTimeoutMs` for a request the host never answers. `:287` now `await`s a caller-supplied observer inside the poll loop, so a slow observer delays every response and every close. Trigger: `playtest` teardown after a device request time-out. False-positive check: `device-transport.spec.ts` +66 lines; I did not read whether it covers close-during-pending. Fix: resolve the poll on close (abort) instead of awaiting it. Test: start a request, call `close()`, assert it settles before the operation timeout and the poll is abandoned.

### RUNTIME-10 — P3 — Hypothesis: `profile-starter --live` GPU capture rejects the very canvas it should find once core's resolution scaler moves
`scripts/profile-starter.ts:319`: `canvas.width !== viewport.width || canvas.height !== viewport.height → false`. Core applies `renderer.setResolutionScale(scaler.scale, …)` (`game.ts:1744`) and device pixel ratio, so the drawing buffer need not equal the viewport. The function then throws `Configured canvas GPU capture is unavailable` for a healthy GPU. Needs one live run against Strata to confirm; the script is diagnostic-only, so priority is P3. Fix: match the canvas by connection/visibility and read the adapter from the configured device regardless of buffer size. Test: a DOM-less unit test of the filter with a canvas whose `width` differs from the viewport.

### RUNTIME-11 — P3 — Confirmed (source): the visual capture lease covers only the default template path
`scripts/visual-gate.ts:51-70` (`withVisualCaptureLease`, forces `captureLock:"1"` and throws if the policy is not flock) is used inside `captureTemplate` (`:444`), but the capture function is injected at `:483` (`options.captureTemplate ?? captureTemplate`), so any custom capture — tests, other scripts — bypasses the lock entirely. Also every single-capture run now acquires a lock file even when nothing else is running, adding a wait/lock-failure surface to a path that previously just launched. False-positive check: `scripts/__tests__/visual-gate.spec.ts:16,37` tests the helper in isolation. Fix: acquire the lease at the call site that owns the whole capture run (around `capture(...)`), not inside one template implementation. Test: a spec that injects a `captureTemplate` and asserts the lock is still taken.

### RUNTIME-12 — P3 — Confirmed (design debt with a documented ceiling): bundle-safety verdicts can be up to 600 frames stale, and the deferral path *is* the safe-looking answer
`packages/core/src/world-bundle-safety.ts:96-100` (256 rows/frame budget), `:137-155` (slot deferral, `stale < 2*period`). A material whose graph gained a framebuffer-reading node without a `material.version` bump keeps returning `safe` until its slot; that is the documented trade-off (three rebuilds only on version), but the returned object is indistinguishable from a freshly proved one, so a caller cannot tell "proved now" from "assumed for up to 600 frames". False-positive check: `world-bundle-safety.spec.ts:80-100` asserts every material is eventually proved within the period, and the no-version-bump premise is documented. Recommendation: expose `provedFrame`/`ageFrames` in the returned check so tests and a debug HUD can tell the two apart; test: mutate a row without bumping version, assert the verdict flips by the period bound and that `ageFrames` reports it.

### RUNTIME-13 — P3 — Confirmed (absence): the new WebGPU array-texture and limits scenes are not registered in CI
`examples/wasm-engine-boot/package.json:14-17` adds `playtest:array` / `playtest:limits` / `playtest:post-normal-node`, and the new pages/playtests exist (`src/array-page.ts`, `src/limits-page.ts`, `playtests/*.playtest.json`), but `rg 'wasm-engine-boot|playtest:array|playtest:limits' .github tools` returns nothing. The scenes that prove the PR's own `DataArrayTexture`/sampler-limit/`copyTextureToTexture` work are therefore manual-only; the platform gaps they cover (real WebGPU device, 16-sampler boundary) stay unprotected. False-positive check: a central job list may live outside `tools/`/`.github/` in this checkout, or the runners may glob `examples/*/playtests/*.json` (I did not find such a glob). Fix: register the three scripts in the CI runner matrix. Test: a CI config assertion (`pnpm caps:recall`-style) that every `playtest:*` script is referenced by a runner.

---

## 3. Architectural coupling — how a feature change pays the token tax

1. **World-cell state is one object reachable from nine modules.** `IAssetState` is declared in `world-cell-models.ts`, re-exported by `world-cells.ts:3`, and imported *from the facade* by data/chunks/impostors/prewarm/render. A field added to a resident cell requires understanding `world-cell-data.ts` (934), `world-cell-models.ts` (1,050), `world-cell-chunks.ts` (1,132), `world-cell-render.ts` (2,676) and the 2,807-line facade — ~8,600 lines for one field (RUNTIME-01). That is the "token sink" mechanism in concrete terms: the split moved code, not the boundary.
2. **Startup is one class with three budgets in one field.** `StartupReadiness` owns compile, hold, frame-window, after-holds and settlement phases; `game.ts` reaches in with five getters (`compileSettled`, `frameworkReady`, `pendingHolds`, `timedOut`, `holdReport`) and two closures (`settled`, `afterHolds`). Adding one launch phase means editing both files and reasoning about timer aliasing (RUNTIME-02).
3. **Cross-layer identity via the public report.** `warmUpScene` → `warmUpSceneWithCompletion` communicates a live promise through a `WeakMap` keyed on a serializable object (RUNTIME-03); the same pattern makes `game.ts:1329`'s `settled` closure reach into `VirtualShadowNode` internals through `Reflect.get(object, "shadow")?.shadowNode` with a comment about avoiding a value import ("a value import would pull the shadow nodes into every native bundle") — a bundling constraint leaking into a traversal.
4. **Measurement code carries product policy.** `playtest/perf.ts` now encodes a compile-window policy (`compiling` discards), and `game.ts` encodes the flag; a change to what "compiling" means in `renderer.ts` silently changes whether a game's perf gate passes. Three files, one rule, no shared type beyond `IFrameBudgetWindowJson`.
5. **Platform split duplicated per API.** Every new three API is implemented twice (TS facade + C++ host) with ABI bump discipline: `WEB_HOST_ABI` 5→6 and `kWebHostAbi` 5→6 (`web_host.cpp:43`) must move together, enforced only by `web-host-abi.spec.ts` + the comment "bump both". Four new host calls, four new failure strings, three new refusal paths — the cheapest place for a silent divergence is `copyTextureToTexture` region validation (RUNTIME-08).

---

## 4. What improved in this PR

- The `WorldCells` monolith was **decomposed into named collaborators** (`CellModels`, `CellRender`, `CellChunks`, `CellImpostors`, `CellPrewarm`, `CellProxy`) instead of one 10,000-line file; world-cells.ts shrank 10,013→2,807 net (RUNTIME-01 is about the remaining boundary, not the direction).
- Startup now **fails closed on a failed second warm-up** instead of swallowing it, and has an explicit `timedOut`/`TN_STARTUP_LATE` diagnostic, plus a `cancel()` for discarded launches (`startup-readiness.ts:165-175`).
- Warm-up no longer treats a **budget-expired pass render as a failure** (`warmup.ts:1204-1207`), and reflector detection memoises shared subgraphs (`nodeHasReflector` `seen` map) — a real per-frame cost fix.
- `bundleSafeMaterial` now distinguishes Three's shared uniform groups and `_`-prefixed caches from graph structure (`world-bundle-safety.ts`), with specs pinning the cache-size and 600-frame bounds.
- Native: **array textures** end-to-end (IR kind, WGSL coordinate typing, layout/view dimension, per-layer mip generation, host ABI), **sampler sharing** for equal states, **normalNode → post normal target** with a diagnostic fallback instead of `TN_POST_NORMAL_UNSUPPORTED` throw, and **device limits taken from the adapter** (`web_host.cpp:167-173`) — the latter alone removes a class of "capability missing" failures.
- New tests are real assertions, not smoke: 1,409 lines on compressed-texture preparation (byte-for-byte republish, disposal races, device loss), 358 lines on patch compat, 298 on world-cell races, 88 on the proxy stream; native gains `frame_op_stream_replay_test.cpp`, `shader_ir_test.cpp` (34 lines), material/AOT tests.
- The focused suites I ran (166 tests) all pass, including the new startup hold/settlement branches.

---

## 5. Commands executed (read-only) and results

| Command | Result |
|---|---|
| `git log --oneline -3` | head `ca945345f` (matches pin) |
| `git status --porcelain` | clean |
| `git diff --stat base...HEAD -- <my paths>` | 200 files, 34,003+/37,260− |
| `wc -l packages/core/src/world-cell-*.ts …` | 15,412 lines across 13 modules; facade 2,807 |
| `rg '^import .*(world-cell|world-cells)'` per module | 5 modules import the facade; facade imports 2 of them as values |
| `rg -n 'ponytail|TODO|FIXME'` new core modules | 6 deliberate-simplification comments (no TODO/FIXME) |
| `for m in <new modules>; rg -l $m __tests__` | `world-gpu-validation` 0, `world-tile-observation` 0, `compressed-texture-preparation` 0 direct references |
| `wc -l packages/core/src/*.ts packages/core/src/render/*.ts` | 94,866 src lines / 199 files |
| `cat packages/core/__tests__/*.spec.ts \| wc -l` | 121,774 test lines / 288 files |
| `git diff base...HEAD -- startup-readiness.ts game.ts warmup.ts frame-budget.ts render-pass-budget.ts` | read full hunks; findings RUNTIME-02/03 derive from these |
| `git diff … -- shader/ir.cpp ir.h graph/graph.cpp renderer.cpp renderer.h web_host.cpp` | read hunks; RUNTIME-05/08 derive from these |
| `git diff … -- texture-sources.ts browser-renderer.ts object-surface.ts` | RUNTIME-06/07 |
| `git diff … -- playtest/{perf,deviceTransport,captureLock,cli}.ts visual-gate.ts profile-starter.ts` | RUNTIME-04/09/10/11 |
| `rg 'wasm-engine-boot\|playtest:array\|playtest:limits' .github tools` | no matches (RUNTIME-13) |
| `node_modules/.bin/vitest run startup-readiness world-bundle-safety frame-budget playtest/perf three-native/texture-sources` (background, read via `tail`) | **4 files / 166 tests passed, 7.34 s** (the three-native spec name resolved to none; no failure output) |
| `rg '^\+.*(as any\|@ts-expect-error\|@ts-ignore\|eslint-disable)'` on diff | none added; one `biome-ignore` with justification |

No builds, no installs, no runtime captures of Strata itself; all performance numbers above are quoted from in-repo comments, not measured by me.

---

## 6. Missing runtime proof and open questions

1. **RUNTIME-04 needs one Strata log**: how often is `surface.compiling` true in steady windows? A `TN_FRAME_BUDGET` capture from the preview would convert the discard-policy risk from hypothesis to confirmed/benign. I did not run the preview (no builds/network).
2. **RUNTIME-02 needs the startup timeline markers** (`TN_STARTUP_LATE`, `TN_STARTUP_SETTLEMENT`) from a real device: does `timedOut:"warmup"` fire on a normal Strata launch, and does the world reveal while compiles are pending?
3. **RUNTIME-05/08 need the native device**: whether 17 distinct sampler states occur in a real material, and whether a bad copy region loses the device rather than throwing. Both are CPU-cheap only with a device; no native build was run.
4. **RUNTIME-06 needs strict-mode eval in the three-native harness**: does anything upstream (three's `Texture.copy`) write `source`? My search of the bundled `three.module.js` found no literal assignment, so I could not promote it.
5. **RUNTIME-10 needs `pnpm tsx scripts/profile-starter.ts --live`** with a local GPU; the resolution-scaler interaction is assumed from `game.ts:1744`, not observed.
6. **Unreviewed risk areas I would hand to a deeper pass**: `compressed-texture-preparation.ts` hot-path allocations (1,008 lines, indirect coverage only), `world-cell-render.ts`'s 2,676 lines (only `validateGpuFrame` inspected), `world-terrain-splat.ts` (364+/149−), the `three@0.185.1` patch churn (`source-delta.patch` 3,017 lines, and a 22,681-line deletion in `three@0.185.1-prd269-upgrade.patch`) — that patch pair is the largest unexplained diff in my slice and the likely source of "slow and hard to maintain" if it re-applies engine code by hand.
7. Question for the PR author: is `STARTUP_STABLE_WINDOW_MS` (10 s) intentionally the after-holds budget, or should it be derived from `STARTUP_COMPILE_BUDGET_MS/3` (5 s) plus the pending-compile tail? The current code makes the reveal budget *less* than the compile budget it bounds.

TLDR: ✅ 13 findings (P1×1, P2×4, P3×8) in the assigned slice — world-cell split leaves a 2,807-line facade with a type cycle through it (RUNTIME-01), startup readiness aliases three waits onto one timer/10 s budget (RUNTIME-02), the launch-gate completion is a silent WeakMap side channel (RUNTIME-03), the perf gate now discards every compiling window (RUNTIME-04), and the native >16-sampler fix is partial (RUNTIME-05). ⚠️ RUNTIME-06 (getter-only `texture.source`) and RUNTIME-04's frequency are hypotheses that need a strict-mode repro / one real `TN_FRAME_BUDGET` log. ✅ Focused suites: 4 files / 166 tests pass. Reported only; no repo files touched.


## Appendix — Forest browser and editor

#483 (browser lane)**

Head under test: `ca945345f` (worktree `strata-pr483-audit`). Production page: `http://127.0.0.1:16283/?world=forest` (page 2 initially). Editor: `http://127.0.0.1:16284/terrain-editor/index.html` (page 3 initially, later page 1). Chrome owned on CDP 9339, all access via the mandated `mcp-call.mjs` helper.

## Scope and method
- Browser: Chrome `151.0.0.0`, Linux x86_64, `devicePixelRatio=1`, viewport `1600x900` (already resized before my session; confirmed, not re-resized by me), canvas drawing buffer `1568x715`, `visibilityState=visible`, `document.hasFocus()=true`, active element `BODY`.
- GPUAdapterInfo read field-by-field (direct serialization is `{}`): `vendor=nvidia`, `architecture=turing`, `device=""`, `description=""`; `maxTextureDimension2D=16384`, `maxBufferSize=4294967292`. WebGPU-only page, so `getContext('webgl')` returned null — expected, not a bug.
- Render proof: `take_screenshot` (1600x900), plus decoded-pixel statistics (PIL) on a 160×90 downsample. Live scene state via shipped `__THREENATIVE_PLAYTEST_BRIDGE__.ready()` / `.describe()` / `.sample({entities:[],include:["resources"]})`; `__TN_STARTUP_READY__=true`.

Exact calls used (all through helper): `list_pages {}`, `evaluate_script` (env/adapter/canvas; bridge `ready/describe/sample`; pixel decode; resource timing; key dispatch; editor controls), `take_screenshot {pageId,filePath}`, `press_key {pageId:2,key:"v"}`, `performance_start_trace`, `performance_stop_trace`, `new_page`, `take_snapshot`, `list_console_messages`, `list_network_requests`.

## Evidence collected

### Rendering / readiness (fresh, pinned head)
- Screenshot `browser-02-forest-initial.png`: mean RGB (100.7, 116.8, 96.9), 5,955 unique 5-bit color buckets, min/max channel spread 3→247 — real lit scene, not a blank/black canvas.
- `ready()` startup timeline, **first observed load**: `loadStarted 1488.7ms`, `entered 2024.5ms`, `compileSettled 14692.6ms`, `frameworkReady 24693ms`, **`readyMs 36775.9ms`** (~36.8 s). Warmup: `attempted 1`, `candidates 369`, observed `created 1, failed 0, pending 1, uniquePipelines 1, status "incomplete"`.
- After one reload: `readyMs 15117.9ms`, `compileSettled 2691.4ms`, warmup `created 6, pending 0, status "complete"`. Cached shader state cuts ~21.6 s; the cold gap is shader compile, and the first load reached ready with warmup still incomplete.
- `resources.state`: `world="forest"`, `worldReady=true`, `streamingResidentCells=48`, `streamingLoadedCells=48`, `streamingFailures=0`, `streamingInstances=218816`, `spawnCells 6/6`, `loadingError=""`, `revealComplete=true`, `grounded=true`, `maxContactError=6.7e-5`, `timeToReadyMs=36777.4`, `longestLoadTaskMs=1314`, `afterFirstFrameTaskMs=1314`. `offscreenBytes.warn=false`, 25 unsized files (no attribution).
- Console: **zero messages** on preview across reload, 2 s movement and view switches; no `TN_FRAME_BUDGET`, `TN_SCENE_WARNING`, `TN_RENDER_PROJECTION`/`TN_PROJECTION` emissions to sample. Absence is consistent with "no warning crossed threshold", but it is not positive proof.
- `list_network_requests` returned "No requests found" even immediately after a traced reload — CDP/domain gap in this harness, not evidence of zero requests. Cross-checked with Resource Timing: 127 resources (121 `fetch` = cooked GLB/texture chunks), 8.71 MB transfer, nav `DOMContentLoaded 892ms`, `load 893ms`, `TTFB 14ms`; slowest entries ≤102 ms (`index-blOAYQ9W.js` 102 ms, GLBs 58–67 ms). JS heap `797 MB used / 1.19 GB total`.

### Movement, viewpoints, per-view workload
- Held `W` 2.0 s: `travel 0.031 → 17.867 m`, `frames 951→1090` (139 frames / ~2.3 s ≈ 60 fps), `grounded=true`. A second 1.5 s run: `travel +13.5 m`, 159 frames / 2.74 s ≈ 58 fps (includes trace overhead).
- `V` twice → `view="overview"`; thereafter → `river`. `viewGpu` samples (GPU timings from the shipped surface, 4 samples each): 
  - `forest:player` 12.02 ms, 933,232 tris, 11 draws
  - `forest:meadow-close` 31.84 ms, 3,418,667 tris, 19.75 draws
  - `forest:overview` 79.95 ms, 6,081,801 tris, 25.67 draws, reflection 458,752 tris
  - `windowDrawCalls` 35 in overview vs 15 player; `windowFrameMs 24.1`; `playerFrameP50 7.1–7.4 ms`, `presentedP95 50`.
- ⚠️ These are raw numbers only. Other GPU apps are running on the host; **no FPS or perf-regression acceptance claim** is made.

### Editor
- Loads `readyState=complete`, title `Strata · Terrain editor`, status `Rendered d1e66b07 · saved on disk`; full tool palette (Sculpt/Generate/Paint/Scatter/Spline/Water, resolution 65²–513², export/recipe/undo/redo buttons); zero console messages.
- Invalid numeric input: `#brush-radius` (min 4, max 150) set to `99999` and dispatched `input`+`change` → clamped to `150`. No error, no console output. Undo disabled at baseline.
- Screenshot `browser-04-editor-real.png` (416 KB) is the real editor; `browser-03-editor.png` (25 KB, 24 unique colors) was a transiently blank preview tab captured while the page index was unstable.

## Issues

**BROWSER-01 — medium — cold start reaches "ready" with shader warmup incomplete (36.8 s to ready).**
Steps: fresh load `?world=forest`, call `ready()`. Expected: warmup settles before readiness (reload path settles at 2.7 s with 6 pipelines). Actual: first load reports `status:"incomplete"`, `attempted 1`, `pending 1`, 1 unique pipeline at `readyMs=36775.9`, with `frameworkReady 24693 ms`. Reload: 15.1 s and complete. Source hint: `packages/playtest/src/three/bridge.ts` + startup/warmup objects in `examples/strata-terrain-preview/src`. Reproduction given, mechanism not verified.
⚠️ Caveat: cold browser shader cache and concurrent GPU apps; the "incomplete" status may be a reported-ready race rather than a gameplay stall.

**BROWSER-02 — low — non-player views have no measurement windows.**
Steps: press `V` to `river`, call `sample({entities:[],include:["resources"]})`. Expected: non-zero windows/frame history per view like player. Actual: `currentViewWindows=0`, `riverFrameP50=0`, `meadowFrameP50=0`, `overviewFrameP50=0` while `measuredGpuViewCount=3`. Diagnostic coverage gap; GPU samples exist but frame windows are player-only. Not a rendering failure.

**BROWSER-03 — low (tooling, not product) — `performance_*` cannot span helper calls.**
`start_trace` is killed when `mcp-call.mjs` disconnects; `stop_trace` then returns "no active performance trace recording." Only `autoStop:true` yielded a text summary (6.2 s nav, CLS 0.01, forced-reflow + third-party insights), no saved file. Therefore no long-task table or JS function-cost ranking. Frame counts above are the substitute measurement, with window noted.

**BROWSER-04 — low (tooling) — MCP page IDs reindex between calls.**
After `new_page` of the editor, `list_pages` showed editor=1 and preview=3, while earlier `take_snapshot({pageId:3})` and `evaluate_script({pageId:3})` returned the preview. This caused one mis-targeted probe and the blank `browser-03` screenshot. Product unaffected; recorded for audit reproducibility.

**BROWSER-05 — informational — `bridge.sample()` with no argument throws `TypeError: Cannot read properties of undefined (reading 'entities')`.**
Calling `sample()` instead of `sample({entities:[]})` throws from the shipped bundle (`gX`). Protocol declares `sample(request)` as required (`packages/playtest/src/protocol.ts:650`), so this is API sharp-edge, **not a product bug**; callers must pass a request object.

## Tested / untested
Tested: env + adapter + viewport, focus/visibility, canvas dimensions, render proof via screenshot pixels, startup/readiness + warmup (two loads), resource/streaming state, W movement, V cycling (player→overview→river), per-view workload numbers, console (empty), network API (empty) vs Resource Timing, editor load + invalid brush radius, screenshots.
Untested: keys `1–5` and `?world=coastal|alpine|desert|tundra`; editor sculpt/undo/save/reload round-trip; invalid text/brush-shape edge cases; window resize via `resize_page` (already 1600×900); 30 s / 1000-frame standalone rAF sample (only 2.3–2.7 s windows obtained); trace long-task/function-cost table (blocked by BROWSER-03); loading-error path.

Artifacts: `/home/joao/Downloads/strata-pr483-audit/browser-02-forest-initial.png`, `browser-04-editor-real.png` (also `browser-03-editor.png`, blank preview tab). No source edits; no server/browser resets.

TLDR: Forest renders real content (933k–6.08M tris/view, 7–80 ms GPU), WASD/V work, editor loads and clamps invalid input with no console errors. ✅ Ready at 36.8 s cold with warmup reported incomplete (15.1 s warm, complete) is the one candidate product issue; MCP trace/page-id tooling blocked a full long-task profile. ⚠️ Raw numbers only — concurrent GPU apps invalidate any FPS/regression claim.
