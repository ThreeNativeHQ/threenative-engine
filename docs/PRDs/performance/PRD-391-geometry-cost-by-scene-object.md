# PRD-391 — See geometry cost by scene object

**Status:** IN PROGRESS
**Priority:** P2 — Open: AC-7 no added traversal when uncaptured and Pixel 8 Midway proof from two views.
**Complexity:** 5 (MEDIUM); risk override: none
**Owner:** Engine authoring / diagnostics
**Depends on:** None; reuse the inspected scene observation, LOD and frame-budget implementations
**Progress:** 3/4 phases; 9/11 phase boxes; 7/8 acceptance criteria; phases 1-3 landed and verified, phase 4 partial (`prd:75%`)
**Date:** 2026-09-16
**Scope:** On-demand geometry inspection, a Geometry tab in the existing browser debug overlay,
and the same structured observation for authoring agents on browser and desktop native.

Implementation authorized by the owner on 2026-09-16 (the planning-only note below is superseded;
the planning validation record at the end of this document still stands). Complexity counts 11+
implementation files (3) and one new diagnostic collector (2).
Core, playtest and UI remain in the existing release cohort; no independent Studio release is needed.

## Context

A main character can have 500 triangles while a barely visible tree submits two million. A total
triangle counter cannot identify the offender, and an asset's full-detail count cannot establish
what the renderer submitted. Authors need cost, identity and projected size in one observation.

Inspection on 2026-09-16 found these reusable pieces:

| Existing path | Reuse / missing part |
| --- | --- |
| [Scene-node observations](../../../packages/playtest/src/three/scene-nodes.ts), `geometryOf` and `nodeObservation` | Names, hierarchy paths, geometry counts, bounds, instances and frustum membership exist. Counts describe buffers, not pass submissions; the observer does not aggregate named models or rank costs. |
| [FrameBudget](../../../packages/core/src/frame-budget.ts) and [RenderPassBudget](../../../packages/core/src/render-pass-budget.ts) | Reuse main/shadow/reflection/nested classification and measured totals; add ownership rather than a competing frame counter. |
| [RenderCameraCull](../../../packages/core/src/render-camera-cull.ts), [model LOD](../../../packages/core/src/model-lod.ts), [ClusteredMesh](../../../packages/core/src/clustered-mesh.ts), [projection mapping](../../../packages/core/src/projection-apply.ts) | Reuse camera/bounds/detail knowledge and source-to-render mappings. A source-scene traversal alone cannot describe optimized submissions. |
| [Core devtools](../../../packages/core/src/game.ts), [playtest contribution](../../../packages/core/src/playtest.ts), [DebugOverlay](../../../packages/ui/src/DebugOverlay.tsx) | Existing consumer seams. DebugOverlay is currently an entity-field table; it is not an existing geometry profiler. |
| Midway `tools/inspect-glb.mjs` and `src/render/airframe-lod.ts` | Local asset inspection returned Hornet: 347,281 triangles / 94 meshes / 75 materials; sailor: 38,992 / 1 / 1. The game's merged stand-ins demonstrate why fewer draws need not mean fewer triangles. These are asset measurements, not a new runtime benchmark. |

Capability discovery was completed before this PRD: the full request and focused mechanics matched
`FrameBudget`, `DebugOverlay`, `updateModelLods`, `ClusteredMesh` and
`renderer.minimumProjectedPixels`; their details were inspected. The combined ranked geometry
view was not found. Source inspection additionally found `observeSceneNodes`; discovery did not
surface it in the focused search. Document the new consumer capability through the existing
manifest generation path so the authoring agent can find it.

## Solution

### Consumer flow and ownership

Open the existing development overlay with backtick, select **Geometry**, and press **Capture**.
Capture one complete presented world frame and retain its immutable report. Default to named
objects sorted by measured submitted triangles, with an **Assets** grouping and expandable mesh
rows. Sorting/grouping reuse that report; **Refresh** explicitly requests another frame. Selecting
a row outlines its projected bounds in the preview. Copy JSON exports exactly that report.

An authoring agent requests the same capture through the existing playtest `sample` transport.
Use a proposed optional `geometry` request/result field and `runtime.geometry` capability; these
are additions to the existing protocol, not currently shipped APIs or a new CLI. Expose the same
collector through the core development host for DebugOverlay. Reuse runtime observation
contributions, as the pipeline census already does. Preserve entity snapshots and `sceneNodes`.

The renderer-facing collector belongs in core: it needs platform/render-pass knowledge that a game
must not recreate. Playtest owns the serialized contract/transport; `@threenative/ui` owns the
browser diagnostic view. Existing project/template CSS owns its presentation and outline style.
The private Studio can consume the contract later; this PRD does not add a Studio panel or engine
editor. This follows the [charter](../../architecture/CHARTER.md): portable mechanism belongs in
the engine, appearance remains game-owned, and no scene format or editor is introduced.

### The five field groups

| Field group | Required meaning |
| --- | --- |
| Identity | Scene generation + runtime object id, readable hierarchy path, model root and logical asset path when known. Expand a character/carrier into its component meshes. |
| Geometry | Full-detail triangles when known, selected-detail triangles, measured submitted triangles, active LOD/cluster state when available. Label each distinctly. |
| Camera contribution | Estimated projected bounds in drawing-buffer pixels, viewport-area fraction, camera distance, frustum membership and visibility/cull reason when known. |
| Repetition | Object/copy count per asset and aggregate submitted work. Report shared geometry once for unique geometry inventory, and each submitted instance for rendering work. |
| Submission | Draws and triangles by main/shadow/reflection/nested pass, plus material count. A shared batch draw belongs to the batch, not one whole draw charged to each source. |

Names are labels, not identity or asset keys. Preserve loader provenance through ordinary and
skeletal clones without requiring game annotations. Procedural/unknown assets remain explicitly
unattributed; shared geometry identity can group them within a run, but a matching display name
must never merge unrelated assets. IDs need only remain stable for that scene generation.

### Measurement contract

1. **Capture an actual frame.** Stamp the report with frame/tick, camera, viewport, resolution,
   backend and capture duration. Arm collection only on explicit request; finish after the world
   frame and its nested passes. Coalesce concurrent requests for that frame. If no frame arrives
   within 2,000 ms, return an unavailable result, never the previous capture as fresh. Scene
   exit/disposal cancels pending capture. No database, upload, credentials or remote service.
2. **Count what the renderer submits.** Ordinary triangle meshes respect indices/non-indexed
   positions, draw ranges, material groups, active instances and repeated passes. Lines/points are
   not triangles. Reconcile attributed rows plus an explicit unattributed bucket with measured
   pass totals. Use actual renderer submission instrumentation, not `visible` flags as proof of
   a draw; observation must not change existing hooks or cause projection to decline.
3. **Keep identity through optimization.** Preserve source-to-proxy/batch membership and active
   LOD provenance. Do not sum inactive LOD alternatives into active cost. A merged material batch
   may have measured batch cost but unavailable per-member draws. GPU-indirect/cluster counters
   without reliable readback must say unavailable with a reason, never zero or a buffer-capacity
   guess. Do not add GPU readback solely for this v1. Full-detail cost is unavailable when the
   source detail cannot be recovered.
4. **Estimate visual contribution honestly.** Use the captured render camera and drawing-buffer
   viewport, including orthographic projection, zoom and resolution scaling. Clip projected
   bounds; near-plane crossings/camera-inside bounds need a conservative result. Bounding area
   is an estimate, not visible pixel count or an occlusion test. Main-camera absence does not
   remove shadow/reflection work. Unknown or displaced bounds must not produce a confident
   small-object warning.
5. **Rank a bounded, declared scope.** Default to top 50 rows, allow up to 500, and reuse the
   existing 50,000-node inspection ceiling. Aggregate and rank the inspected scope before
   slicing rows; do not sort the first 50 visited nodes. Distinguish row truncation from incomplete
   inspection, report matched/returned counts and unassigned work, and label rankings partial
   when a cap or unknown attribution prevents a global claim. Unknown costs sort separately.

Provide sorting by submitted triangles, draws and projected size. An optional **Small on screen**
filter uses an editable projected-diameter threshold (32 raster pixels by default), displays the
threshold, and excludes unmeasured bounds. It is a diagnostic filter, not a relevance score or
an instruction to delete an object. Geometry importance remains an authoring decision.

Outline only the selected captured projected bounds using the browser overlay; do not recolor,
hide, reparent or move game objects or cameras. Mark the capture as a snapshot and clear the
outline after camera/viewport changes or target removal. Offscreen/unresolved objects show their
status without a misleading outline. Controls need keyboard operation, labels and visible focus.

### Scope boundaries and risks

V1 includes capture, object/asset grouping, sorting, selection outline and JSON. It excludes
automatic LOD changes, simplification, deleting objects, gameplay-importance inference, per-object
GPU milliseconds, texture/memory profiling, occlusion queries, recording visibility frequency,
historical regression dashboards and new editor infrastructure. Repeated instances are covered;
frequency over time requires a later recording feature. Triangle counts alone do not predict FPS.

Browser UI follows the existing web-only `@threenative/ui` contract. The collector and agent
transport must run on desktop native in this PRD. Android/iOS are unverified and outside this
qualification scope; neither a browser capture nor desktop proof may be presented as mobile proof.
The local native build directory contains `tn-linux/mystral`; execution/compatibility is not yet
verified. No speculative owner or shared gate is required to create or implement this feature.

## Acceptance Criteria

- [x] AC-1 [local; actor: implementation agent; browser WebGPU]: Capturing the representative scene yields per-pass submitted geometry whose attributed rows plus unattributed bucket equal renderer totals, with correct direct-mesh/instance/range/group accounting. — Evidence: E1 green for direct, instanced, draw-range and material-group accounting; E3 browser run reconciles exactly (9 + 12 = 21 draws, 3,844 + 180,010 = 183,854 triangles). Note honestly: on that fixture most of the frame is submitted where `onBeforeRender` does not observe it, and the report says so in the unattributed bucket rather than implying the nine rows are the whole frame.
- [x] AC-2 [local; actor: implementation agent]: Object and asset aggregation preserves clone identity, LOD choice and batch ownership; shared resources and alternate LODs are not double counted. — Evidence: E1 green (`geometry-capture.spec.ts` batch-ownership and asset-grouping cases, 16/16).
- [x] AC-3 [local; actor: implementation agent]: Camera-size estimates and availability labels survive perspective/orthographic, clipping and hidden/offscreen/shadow-only cases without claiming occlusion or gameplay importance. — Evidence: E1 green (near versus far, orthographic, camera-inside-bounds returning a conservative viewport-sized estimate, unknown bounds excluded from the small filter, shadow-pass attribution, not-submitted rows); E2 shows finite projected pixels under the fixture's orthographic camera and the "bounds unavailable" path in the real browser. The panel states in the view itself that the filter is a diagnostic, not a recommendation.
- [x] AC-4 [local; actor: implementation agent]: Top rows are ranked over the inspected scope; request limits, incomplete scans, missing attribution, expired captures and unknown values are explicitly reported rather than silently accepted as complete. — Evidence: E1 green (ranking-before-slicing, unknown-cost ordering, malformed-request and no-frame-timeout cases).
- [x] AC-5 [local; actor: implementation agent; browser UI]: Through the mounted DebugOverlay, Capture → sort/group → expand/select → Copy JSON exposes the captured result and correct outline without changing gameplay; visual inspection confirms readability and keyboard use. — Evidence: E2 green (19/19 unit, 2/2 browser on nvidia/turing) plus screenshots inspected at 1440x900 and 420x800. Controls are real labelled elements reached by role; the overlay root stays `pointer-events: none` so it cannot eat a click meant for the game.
- [x] AC-6 [local; actor: implementation agent]: A real playtest sample request advertises and invokes `runtime.geometry`, returns the same report contract as the overlay, and preserves existing entity/scene observations. — Evidence: E1 real-bridge case in `packages/core/__tests__/playtest.spec.ts` (capability advertised, no `geometry` key when unasked, entities unchanged either way) and E3's runner run returning the same contract. A real browser run also found a real bug here: the report crossed the transport with `frame: undefined` and `assertJsonSafe` failed the run closed; every optional field is now omitted, guarded by a JSON round-trip case.
- [ ] AC-7 [local; actor: implementation agent]: Without a capture request there is no added scene traversal, draw instrumentation or periodic geometry capture; cancellation and disposal remove capture state/hooks and release object references. — Evidence: E1 green for the whole behaviour (no own `onBeforeRender` before arming, present during the frame, deleted after, a game's own callback handed back by identity, records dropped, scene change and `stop()` cancelling). Left open for E3's remaining half: the capture-off/on run comparison through the performance harness, reporting idle frame impact, has not been executed.
- [x] AC-8 [local; actor: implementation agent; desktop native]: The same portable scenario reaches the geometry sample path and proves direct/instanced triangle attribution and explicit unsupported values through the native transport. — Evidence: E4 green, see P4-2a. The lane is not blocked on this machine after all: an earlier note recorded desktop playtests as GBM-blocked here, and the untouched control scenario launched the host, opened a window and rendered.

## Integration Ledger

| Capability | Reachable consumer / existing entry point | Existing path disposition | Evidence |
| --- | --- | --- | --- |
| Frame ownership | Geometry request → core game render loop → collector using [render-pass-budget.ts](../../../packages/core/src/render-pass-budget.ts) and projection mapping | FrameBudget remains authoritative for pass totals; add scoped attribution, no competing timer | AC-1/2/7, E1/E3 |
| Agent report | Bridge `sample` → [core/playtest.ts](../../../packages/core/src/playtest.ts) observation contributions → collector; [protocol.ts](../../../packages/playtest/src/protocol.ts) defines the addition | Keep `sceneNodes`, entity snapshots and existing capabilities backward compatible | AC-4/6/8, E1/E4 |
| Geometry tab | Existing mounted [DebugOverlay](../../../packages/ui/src/DebugOverlay.tsx) → core development host (`game.ts`, `installDevTools`) → same collector | Preserve entity tab; no additional global transport or public UI component | AC-5, E2 |
| Discoverability | Capability declaration/generation and [template instructions](../../../packages/create-threenative/templates/starter/AGENTS.md) → agent requests capture in a generated game | Extend existing diagnostics documentation and mounting instructions; no parallel recipe system | AC-5/6, E2/E3 |

Implementation must record any new production entry-point locations in these rows. Proposed fields
and new files below are implementation targets, not claims that those APIs already exist.

## Execution Phases

### Phase 1 — Capture a named geometry snapshot

**Status:** COMPLETE
**ACs:** AC-3/4/6
**Files:** New `packages/core/src/geometry-capture.ts`; existing `core/src/game.ts`,
`core/src/playtest.ts`, `playtest/src/protocol.ts`, `playtest/src/capabilities.ts`,
`playtest/src/assertion-report.ts` and observation serialization paths; reuse scene-node logic
instead of creating a second incompatible geometry inventory.

Wire a validated request to one bounded frame capture, using the existing contribution seam and
JSON/transport limits. Capture IDs, projected bounds and status together. Reuse existing timeout
and observation error conventions; absence and a valid zero remain different.

- [x] P1-1: The optional geometry request is reachable through the real bridge and development host without changing existing sample behavior. — `packages/core/__tests__/playtest.spec.ts` "answers a geometry capture through the real bridge without disturbing other observations": the bridge advertises `runtime.geometry`, a sample without `geometry` carries no `geometry` key at all, and both samples still observe `player`. 21/21 pass. Development host: `installDevTools` exposes `__THREENATIVE__.geometry()` (`packages/core/src/game.ts`).
- [x] P1-2: Named rows, projection estimates, caps and capture lifecycle satisfy focused E1 cases; record implementation locations and evidence here. — `packages/core/__tests__/geometry-capture.spec.ts`, 16/16 pass: indexed/unindexed counts, draw range and material group narrowing, instancing, lines/points as zero triangles, not-submitted rows, per-pass attribution, reconciliation remainder, batch ownership, ranking before slicing, unknown-cost ordering, malformed requests, no-frame timeout, cancellation, idle/restore hooks, perspective+orthographic+camera-inside projection, asset grouping. Collector: `packages/core/src/geometry-capture.ts`; loop arming: `packages/core/src/game.ts`; pass kind: `RenderPassBudget.activeKind()`.

**Verification:** E1 — green. **Checkpoint:** self-review done; the spec found two real bugs before
it went green (a never-submitted object read as `submitted` because its cost was known, and each
pass bucket received the object's whole cross-pass total instead of that pass's own). Independent
review still pending.

### Phase 2 — Attribute the rendered work

**Status:** COMPLETE
**ACs:** AC-1/2/7
**Files:** Collector plus existing `core/src/render-pass-budget.ts`, `projection-apply.ts`,
`assets.ts`, `model-lod.ts` and `clustered-mesh.ts` only where source ownership must be exposed.

Join source identity to submitted render objects, keeping batch-level costs when splitting would
invent precision. Attach/carry logical asset provenance through supported clone paths. Add ordinary
render accounting first; unavailable indirect paths remain named and reconciled, not miscounted.

- [x] P2-1: Source/asset grouping and measured pass ownership reconcile without charging shared draws or inactive detail twice. — `SceneRenderProjection.describeOwnership()` names the source behind each rendered object; a batch's single draw is counted once in reconciliation and each member row carries `draws: 0` with its own triangles (E1 case "charges a batch's single draw once however many sources it folded"). Full-detail cost comes from the shipped `baseGeometryOf`, so inactive LOD alternatives are never summed. Asset identity is the loader's stamp (`packages/core/src/assets.ts`), carried through clones by `Object3D.copy`, and two assets sharing a display name do not merge (E1 case).
- [x] P2-2: Collection is absent while idle and restored after capture/cancellation/disposal; E1 covers hooks, projection behavior and retained references. — E1 case "installs no hook while idle and hands a game's own callback back untouched": no own `onBeforeRender` before `beginFrame`, present during the frame, deleted again after `finishFrame` (deleted, not set to `undefined`, so the prototype no-op returns), a game's own callback is still invoked and handed back by identity, and the armed records map is dropped, releasing object references. Scene change and `stop()` cancel a pending capture (`packages/core/src/game.ts`).

**Verification:** E1 green; the browser portion of E3 is still open. **Checkpoint:** the attribution
boundary was reviewed: the instrument is `onBeforeRender`, which the renderer calls per submission
after culling, so no source-scene traversal count is labelled a submission — a walked-but-never-
submitted object is reported `notSubmitted` with `draws: 0`.

### Phase 3 — Present the Geometry view

**Status:** COMPLETE
**ACs:** AC-5/6
**Files:** Existing `ui/src/DebugOverlay.tsx`, `ui/__tests__/overlay.spec.tsx`,
`examples/abyss-framework/src/style.css`, `examples/abyss-framework/tests/viewport.playtest.ts`;
relevant generated UI styles/mounting instructions and capability declarations/reference output.

Implement the five field groups, explicit capture/refresh, object/asset toggle, sorting/filter,
expandable rows, selected bounds and Copy JSON. Use the existing development-host installation and
cleanup; do not attach the geometry capture to the overlay's existing 100 ms entity poll.

- [x] P3-1: The mounted overlay completes the specified keyboard-accessible workflow against the same report the bridge returns. — `packages/ui/__tests__/overlay.spec.tsx` 19/19 (10 of them new), including a negative control: asserting that a row with unknown bounds survives the small-on-screen filter fails, as it must. Every control is a real `button`/`select`/`input`/`fieldset` with a label, reached in the browser test by role. The capture never rides the 100 ms entity poll — the mock is called 0 times on opening the tab and once per press.
- [x] P3-2: Generated authoring instructions explain how to mount/open/request the feature, and E2 proves the styled view and selection behavior in the real browser. — `templates/starter/AGENTS.md` (and its generated mirror) says backtick → Geometry → Capture, the scenario form, and how to read the reconciliation; `DebugOverlay`'s manifest entry gains the two situations an agent would search. E2: `examples/abyss-framework/tests/viewport.playtest.ts` 2/2 on adapter nvidia/turing — tab, capture, real rows, pass table, selection outline, grouping, sorting, Copy JSON. Screenshots inspected at 1440x900 and 420x800; the first inspection found the panel unreadable over the game's own menu text and the threshold control unspaced, both fixed in the game's CSS before this box was ticked.

**Verification:** E2 — green. **Checkpoint:** the captured UI was inspected, not only asserted, and
the inspection changed the CSS. `pnpm budgets` then caught a real regression the DOM tests could
not: hooks running before the dev-only guard kept the devtools global reachable, so the overlay
survived into the production bundle. The gate is `scripts/check-core-boundary.ts`; the fix splits
the gate from the view so a production build drops it entirely.

### Phase 4 — Prove the complete workflow

**Status:** PARTIAL
**ACs:** AC-1/5/6/7/8 and final reconciliation
**Files:** Extend existing portable browser/native playtest fixtures, add a focused geometry
scenario, and use Midway's existing capture tooling for the representative integration run.

- [x] P4-1a: A focused geometry scenario proves the diagnostic on the in-repo representative fixture. — `examples/abyss-framework/playtests/geometry-capture.playtest.json` through the real runner, exit 0, `geometry.observed` pass, `status: captured`, 9 of 9 rows, tick 67, WebGPUBackend, 1280x720. Reconciliation is exact: 9 + 12 = 21 draws and 3,844 + 180,010 = 183,854 triangles.
- [x] P4-1b: Required engine checks and capability/template checks pass. — `pnpm typecheck` Done; `pnpm lint` exit 0 (764 pre-existing warnings, no errors); `pnpm test` green in every package except `packages/runtime-native`, whose 21 failures are the missing native build in this checkout (`packages/runtime-native/build/` does not exist here) in files this change does not touch at all; `pnpm exec vitest run packages/core/__tests__ packages/ui/__tests__ packages/playtest/__tests__` 2603/2603; `pnpm budgets` exit 0; `pnpm check:docs` 2,195 links across 1,112 files; `pnpm capabilities:sync` and `pnpm sync:agents` clean.
- [ ] P4-1c: E3 proves the diagnostic on Midway from the deck and distant-fleet views.
  Not run. Midway is a sandbox game outside this repository and would need its own tarball install and capture lane; the representative-fixture half of E3 is proved above, and the merged-draw-versus-submitted-triangles reading it was meant to demonstrate is covered by the batch-ownership case in E1.
- [x] P4-2a: E4 proves the portable collector through the desktop-native sample transport. — `examples/native-smoke/playtests/geometry-capture-desktop.playtest.json` on the real C++ host (`packages/runtime-native/build/tn-linux/mystral`, built 2026-09-09 in the primary checkout; this change is JS-only) with a bundle rebuilt from this tree: `geometry.observed` pass, `status: captured`, backend WebGPUBackend, 4 of 4 rows, direct-mesh attribution correct at 12 triangles per box, reconciliation exact (2 + 1 = 3 draws, 24 + 1 = 25 triangles). The run's overall verdict is red only on the `diagnostics` policy, from the fixture's own `[Audio] decodeAudioData received an empty or non-ArrayBuffer argument` — the untouched `loading-screen-desktop` control on the same host and bundle reports the identical error, so it is not this change.
- [ ] P4-2b: All AC evidence and review findings are reconciled before closure.
  AC-7's capture-off/on frame-impact comparison is not run, and no independent review has happened yet.

**Verification:** E3 partial (representative fixture green, Midway not run); E4 green.
**Checkpoint:** pending; one final independent review of unresolved or changed risks, reusing prior
evidence rather than rerunning equivalent checks.

## Verification Strategy

| Evidence | Smallest sufficient proof and distinct risk |
| --- | --- |
| E1 — accounting/contract | Extend `packages/playtest/__tests__/scene-nodes.spec.ts`, `three-bridge.spec.ts`, `packages/core/__tests__/render-pass-budget.spec.ts` and a focused collector test only where needed. Cover indexed/non-indexed meshes, draw ranges/groups, instancing, hidden parents, alternate LODs, shared/unknown assets, batching, shadow/reflection nesting, unsupported indirect counters, malformed requests and truncation. Exercise the real bridge for the contract; helper-only tests cannot satisfy AC-6. Use valid behavior red→green during implementation. |
| E2 — browser consumer | Extend `examples/abyss-framework/tests/viewport.playtest.ts` and the existing overlay unit test. A real rendered frame feeds the table; test capture/group/sort/select/copy, stale outline removal and keyboard controls. Inspect a screenshot at desktop and narrow viewport widths. Fake report rendering alone is insufficient. |
| E3 — representative browser | Run a fixture containing a cheap foreground subject, dense distant object, repeated instances, multi-material mesh, shared batch, LOD transition and shadow/reflection contributors. Prove camera/detail changes update the correct rows. Then capture Midway from deck and distant-fleet views using an isolated served copy and `tools/capture-lock.sh`. Confirm the report distinguishes full-detail inventory, merged draw reductions and submitted triangles; inspect the frame. Compare capture-off/on runs using the existing performance harness, report capture duration and idle frame impact, and verify capture does not change projection decisions or scene output. No promised FPS gain is inferred from fewer triangles. |
| E4 — desktop consumer | Run the same portable fixture/scenario using the existing runner with `--target desktop --executable <verified-host> --host-arg run --host-arg <built-game-bundle>`. Assert actual direct/instanced counts and honest unavailable fields through the native sample transport. A build or a generic native smoke result alone is insufficient. |

Use `holdTicks`/`waitTicks` for scenario progress. Browser runs name the WebGPU adapter and use the
approved hidden-display capture wrapper; never use the visible desktop or `xvfb-run`. The native
run needs the rebuilt compatible host and game bundle, not an assumed existing build. Required
tools are the repo's pnpm/Node installation, Chromium/WebGPU and local native build toolchain;
no credentials or new services are required. Record any execution failure on its open AC.

At implementation completion run the required engine `pnpm typecheck`, `pnpm lint`, `pnpm test`,
affected build/capability/template checks and the specified playtests. Store each result once in
this PRD or its single draft PR. Open that implementation PR before phase 1, keep phase boxes and
`pnpm prd:progress` current, and move this document to `done/` only when every required AC is proved.

For this planning-only change, validate links, PRD progress parsing and internal consistency.
Do not run implementation gates, fabricate red/green evidence, create another verification report
or tick implementation boxes.

Planning validation (2026-09-16): the repository link checker found 16 valid local links and no
missing targets; `pnpm prd:progress` parsed four phases, eight phase boxes and eight ACs, all open
(`prd:0%`); independent read-only planning review returned PASS with no material corrections.
No implementation or runtime verification was performed for this planning change.
