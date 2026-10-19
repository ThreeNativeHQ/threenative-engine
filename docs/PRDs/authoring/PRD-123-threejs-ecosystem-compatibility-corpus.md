---
prd_contract: v1
---

# PRD-123 — Three.js ecosystem compatibility corpus and honest scorecard

**Status:** PROPOSED, 2026-08-15. Planning only; no corpus row or compatibility percentage in
this document is execution evidence.

**Priority:** P2 — Planning-only corpus and scorecard: 20+ upstream rows, license dispositions, generated score.
**Outcome:** a pinned, reproducible corpus answers how much ordinary Three.js source runs through
ThreeNative unchanged. Every row says `pass`, `fail`, `blocked`, or `excluded`, links to executed
evidence, names the owning gap, and contributes honestly to a fixed denominator. A user can inspect
the generated report before deciding whether an existing Three.js project is a plausible
ThreeNative candidate.

**Depends on:** the shipped native conformance runner and its 67 implemented registry rows,
`@threenative/playtest`, the pinned workspace Three.js version, and the existing browser/desktop
execution lanes. It consumes those instruments; it does not replace or reopen their PRDs.

**Complexity: 7 → high mode.** The implementation is mostly manifests, adapters, and report
validation, but the evidence crosses upstream source, ecosystem packages, browser WebGPU, desktop
native, and platform-honesty boundaries.

## 1. Why this exists

The repository already proves selected behavior well. `packages/runtime-native/conformance/registry.json`
contains 67 implemented rows across core, materials, rendering, assets, animation, runtime, input,
UI, and WebGPU/TSL. That is a curated correctness matrix. It is not the denominator behind the
product question:

> If I bring normal Three.js source, which parts work unchanged on ThreeNative?

Today there is no pinned inventory of upstream examples, addons, common ecosystem libraries, or
real project-shaped source. There is therefore no defensible compatibility percentage, no visible
list of unmeasured categories, and no mechanical link from a failed real-world subject to its
owning PRD.

The missing product is measurement, not another abstraction. ThreeNative remains a host beneath
upstream `WebGPURenderer`; it does not wrap Three.js, fork its renderer, mirror its scene graph, or
rewrite a project into framework vocabulary.

## 2. Score contract

The corpus manifest is the denominator. A row cannot disappear because it failed.

Every row records:

- stable id and category;
- source repository or package, immutable ref/version, license, and source hash;
- exact entry file and Three.js version range;
- expected targets: browser, desktop, Android, iOS;
- evidence tier required on each target;
- status on each target: `pass`, `fail`, `blocked`, or `excluded`;
- report/artifact path and owning PRD or issue for every non-pass;
- exclusion reason and product rule, when exclusion is legitimate.

Evidence tiers are cumulative:

1. **Resolve:** dependencies install and imports resolve.
2. **Build:** unchanged subject source bundles against the catalog Three.js version.
3. **Boot:** runtime reaches ready with no unallowed console, network, or native diagnostics.
4. **Behavior:** a semantic playtest or deterministic interaction reaches its assertion.
5. **Visual:** when appearance is material to the subject, a nonblank capture passes its declared
   tolerance against the browser reference.

A row passes a target only when it reaches its declared tier. “Built” cannot become “compatible”
when the row requires behavior or visual evidence.

The generated report shows, per target and category:

- `passed / total non-excluded rows` as the compatibility score;
- counts for fail, blocked, excluded, and unmeasured/missing evidence;
- evidence coverage: rows with fresh artifacts divided by all manifest rows;
- the exact manifest hash, Three.js version, source SHA, adapter class, and run date.

Blocked rows remain in the score denominator and do not pass. Exclusions are shown beside the score
and require a checked reason; they are never silently removed. No cross-target aggregate may be
shown without the target-specific table immediately beside it.

## 3. Corpus shape

Phase 1 starts with a bounded certified corpus, not every GitHub result mentioning Three.js.

### A. Upstream Three.js

Select at least 20 representative entries from the exact catalog release:

- core scene/camera/geometry/material examples;
- `WebGPURenderer` and TSL examples;
- `GLTFLoader`, `KTX2Loader`, animation, controls, postprocessing, audio, input, and workers;
- deliberate browser-only/unsupported controls such as raw GLSL under WebGPU.

Selection is category-stratified and stored in the manifest. A script verifies that every required
category has at least one row and that the pinned upstream ref matches the workspace Three.js
version.

### B. Ecosystem libraries

Pin a small representative set with real source callers, initially:

- `three-mesh-bvh`;
- `three-stdlib`;
- one maintained postprocessing library;
- one physics integration that is valid on browser and has an explicit native disposition;
- one asset-loading extension not already represented by the upstream rows.

A package name alone is not a row. Each library needs a minimal project-shaped caller exercising
its documented public surface and requiring behavior or visual evidence.

### C. Real project-shaped source

Add at least five immutable, license-compatible subjects from public Three.js games, tutorials, or
representative snippets. Prefer small source slices that preserve camera, assets, input, update
loop, and one player-visible behavior over vendoring whole repositories. Record provenance and
license for every retained source file.

## 4. Source-integrity invariant

The game/example source under test stays normal Three.js.

Allowed harness work:

- choose the entry file;
- provide HTML/canvas bootstrap outside the subject;
- map pinned package imports;
- serve declared assets;
- inject deterministic input and observations from the runner;
- select the browser or native launch recipe.

Forbidden compatibility edits:

- adding an `@threenative/*` import to corpus source;
- adding `if (native|android|ios|desktop)` branches;
- replacing a Three.js class, material, renderer, loader, or scene operation;
- weakening the required evidence tier after a failure;
- copying a failure into a hand-authored equivalent scene and calling that subject compatible.

A source-integrity check hashes the retained subject and scans for framework imports and platform
branches before every run.

## 5. Ownership and files

Expected implementation paths:

- `tests/compatibility/corpus.json` — fixed manifest and denominator;
- `tests/compatibility/subjects/**` — small retained callers plus provenance/license metadata;
- `scripts/compatibility/run.ts` — resolver/build/launch orchestration over existing runners;
- `scripts/compatibility/report.ts` — deterministic report and score generation;
- `scripts/__tests__/compatibility-report.spec.ts` — denominator, exclusion, stale-evidence, and
  source-integrity controls;
- `docs/verification/compatibility-<date>.md` and machine-readable JSON — executed evidence.

Do not add a package. Do not place corpus machinery in `@threenative/core` or
`@threenative/runtime-native`. The runtime conformance registry remains the owner of its selected
rows; the corpus references matching evidence rather than duplicating scenes where a row is
already equivalent.

## 6. Phases

### Phase 0 — Inventory and equivalence map

Freeze the first manifest, map every subject to existing conformance/playtest coverage, and label
one of:

- equivalent existing row;
- new corpus execution needed;
- explicit product exclusion;
- unsupported gap with an existing owner;
- unsupported gap with no owner.

No compatibility score is published in Phase 0. Exit only when every manifest row has a source
hash, license disposition, required evidence tier, and target matrix.

### Phase 1 — Browser execution

Run all eligible rows against headed Chromium WebGPU using the repository browser recipe. Reuse
playtest capture guards and semantic assertions. Record the actual adapter; SwiftShader may produce
diagnostic evidence but cannot satisfy a hardware-required row.

### Phase 2 — Desktop native execution

Bundle the unchanged eligible source through the normal native path and run the desktop matrix.
Rows requiring a browser DOM, CSS layout, unsupported raw GLSL, or another declared non-goal are
excluded only through the manifest reason check. Runtime crashes, missing shims, loader failures,
and visual mismatches are failures, not exclusions.

### Phase 3 — Scorecard and drift gate

Generate Markdown and JSON from the same report model. CI verifies manifest completeness,
source-integrity hashes, report schema, score arithmetic, and evidence freshness. Expensive native
execution may consume a dated artifact, but a stale artifact is labeled stale and cannot pass a
new Three.js catalog version.

### Phase 4 — Mobile evidence, when hosts exist

Run the same eligible rows on Android and iOS using existing device transports. Emulator and
simulator results are labeled as such. Physical-device compatibility remains blocked until a
physical run exists; it never inherits desktop or simulator status.

## 7. Acceptance criteria

- [ ] The initial manifest contains at least 20 upstream, five ecosystem-library, and five
      real-project-shaped rows, each pinned by immutable version/ref and source hash.
- [ ] Every row declares a category, license disposition, target matrix, required evidence tier,
      status, artifact, and owner for every non-pass.
- [ ] The score is generated from the manifest and cannot omit failed, blocked, or stale rows.
- [ ] Excluded rows remain visible and require a checked reason tied to an explicit product or
      upstream WebGPU limitation.
- [ ] Corpus source contains no `@threenative/*` import or platform-specific compatibility branch.
- [ ] Browser and desktop reports execute all eligible rows and distinguish resolve, build, boot,
      behavior, and visual evidence.
- [ ] The report records Three.js version, repo SHA, manifest hash, source hashes, adapter class,
      target evidence class, and exact rerun command.
- [ ] A catalog Three.js version change makes old evidence stale until the corpus reruns.
- [ ] Android/iOS rows say emulator, simulator, physical, blocked, or unmeasured accurately; no
      aggregate “mobile compatible” claim is generated.
- [ ] Existing conformance rows remain owned by the conformance registry; no second renderer,
      scene graph, loader implementation, or framework wrapper is introduced.
- [ ] Targeted report tests, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `git diff --check` pass.

## 8. Negative controls

| Control | Mutation | Expected |
|---|---|---|
| denominator laundering | remove a known failing row from generated input | manifest/report check exits non-zero |
| false coverage | mark a row passed without the required artifact tier | report validator rejects it |
| compatibility rewrite | add an `@threenative/core` import or platform branch to subject source | source-integrity gate exits non-zero |
| stale green | change the catalog Three.js version without rerunning | every prior row becomes stale/non-pass |
| silent category loss | remove the final controls or asset row | category-floor gate exits non-zero |
| exclusion laundering | change a runtime failure to excluded without an allowed reason | report validator rejects it |
| visual false pass | replace a subject capture with a blank/uniform frame | capture guard fails |
| platform overclaim | relabel simulator evidence physical | evidence-class validator exits non-zero |

## 9. Kill switches and rollback

- Stop expanding the corpus if maintenance exceeds one bounded compatibility run per Three.js
  catalog upgrade; keep the smaller representative denominator rather than a stale giant list.
- Reject any row that requires modifying upstream/project source to pass. Record the failure or
  exclusion instead.
- Do not publish a headline percentage if evidence coverage is below 90%; publish the raw status
  table and missing coverage instead.
- If score computation needs subjective weights, remove the composite score and retain category
  counts. The denominator must stay inspectable.
- If execution requires a renderer fork, custom scene graph, or native GLTF replacement, stop. The
  corpus measures compatibility; it does not buy compatibility by changing the product.
- Rollback is deletion of `tests/compatibility/` and `scripts/compatibility/`. It must not change
  runtime or generated-game behavior.