# PRD-467 — Live terrain editor, shape editing, and spatial surface diagnostics

**Status:** DONE
**Priority:** P2 — Remaining editor reassignment and portable bake/export consumption.
**Complexity:** 9 (HIGH); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** PRD-466 phases 1–2 public authoring/rendering contract
**Progress:** 3/3 phases verified (8/8 phase boxes); 1/1 acceptance box verified; prd:100%.
**Required companion:** [PRD-468 — atmosphere, cameras, and asset imports](PRD-468-strata-world-controls-and-asset-imports.md)

## Context

João wants to open the terrain editor URL, watch the agent build the world live,
click individual shapes, move/rotate/scale them, and use the existing GUI tools
to polish the result. Agent-first generation and full customization remain the
primary goal. The final output is a self-contained GLB usable in other games.

Embedded spatial debugging must also help an agent/human reconstruct a location
from maps/screenshots: inspect the actual terrain surface, register reference
imagery and landmarks, and receive measurable mismatch feedback. These tools are
part of the editor and headless inspection path, not a separate verification app.

This is a required companion to [PRD-466](PRD-466-strata-terrain-threejs-integration.md),
not an optional later feature. Both plans must be verified before claiming the
whole requested integration is delivered, including PRD-468's world controls and
on-demand imports. The execution request authorizes implementing all three PRDs in the shared worktree and draft PR #381.
Complexity: 3 for 11+ implementation files (mostly recovered editor modules),
2 for the authoring tool, 2 for worker/revision concurrency, and 2 for the
addon/consumer build boundary.

### The starting editor already exists

Use `/home/joao/Downloads/strata-terrain.html` and
`/home/joao/Downloads/AGENT_GUIDE.md`; PRD-466 records their input hashes.
Recover the named embedded sources, rather than inventing another editor.
The supplied editor already has brushes, layer selection/reordering, an inspector,
undo/redo, import/export, cancellable evaluation in a worker, and local restore.
Preserve these working features and the documented authoring operations/limits.

Observed gaps: `src/three/adapter.js` picks only terrain triangles; it does not
select individual props or expose transform gizmos. `src/editor/app.js` uses
localStorage, which a filesystem agent cannot share. Worker progress is not an
intermediate rendered snapshot. Scatter IDs are `${rule.id}:${acceptedIndex}`,
which can identify a different tree after masks change acceptance order.

Capability search/detail found `ScenePicker`, `InstancedBatch`, `mergeParts`, and
`markStatic`. `packages/core/src/picking.ts` returns normal Three.js intersections
and supports instanced meshes through Three.js's existing raycast path. Installed
`three/addons/controls/TransformControls.js` supplies the gizmo; it attaches to an
`Object3D`, so one instanced prop needs a selection proxy, not a new gizmo system.

## Solution

### One document shared by the agent and GUI

Serve the recovered editor at **`/terrain-editor/`** through the existing preview
Vite dev server and print the complete URL at startup. Starting or reusing the
terrain editor also returns a structured `editorUrl`, project/session identity,
and current revision; the controller presents that URL as a clickable live-editor
link to the user. Wait until the route is ready and use the actually bound port,
never a guessed port or `0.0.0.0` as a viewer address. Reuse an existing configured
port-forward/viewer URL when running remotely; report missing forwarding or startup
failure explicitly instead of offering an unreachable link. This does not request
public deployment. Repeated activation opens the same project and latest document.
The agent authors through
the API/JSON operations; driving the editor UI is never required.
`examples/strata-terrain-preview/terrain/` owns the saved authoring document:
Strata recipe, procedural shape parameters, and explicit placement overrides.
It is terrain authoring data, not a new engine scene format or executable JS.
Reference registrations, control/check points, north/origin metadata, and named
inspection probes are saved with that document; they are authoring annotations.
PRD-468 extends the same document with named cameras, environment settings, and
project-local asset references; it does not introduce another document authority.

Minimal Node/Vite middleware watches complete file saves and broadcasts revision
notifications via SSE. Agents can atomically save JSON or submit documented
`applyPatch()` command shapes through a local endpoint. The GUI commits the same
validated semantic transactions. Use existing Vite HMR for changes to editable
render source. No database, hosted service, second localStorage authority, or
new websocket library. Existing browser-only saves can be explicitly imported.

```mermaid
flowchart LR
  Agent[Agent API or JSON save] --> Doc[Validated document on disk]
  GUI[Recovered GUI tools and gizmos] --> Doc
  Doc --> Events[Revision notifications]
  Events --> Worker[Cancellable existing evaluator]
  Worker --> Scene[ThreeNative editor scene]
  Doc --> Export[Full world GLB bake]
  Scene --> GUI
```

One content-hashed revision is one synchronous semantic transaction. Serialize
writes to the document and reject stale base revisions with an explicit conflict;
never overwrite newer human/agent work. Save atomically and retain the previous
valid document/scene on validation or disk failure. Invalid external saves show
diagnostics; do not accept or silently erase them.

Bind writes to loopback and the configured project document. Validate host/origin,
bounded JSON bodies, patches, and transforms. No client-selected paths, filesystem
browser, arbitrary-code execution, or public unauthenticated write service.

### Watch construction without refreshing

Opening the URL loads the latest document without resetting to a demo. Each
committed hill, pad, road, or population edit produces a visible new revision.
Retain the last valid geometry while building, show requested/rendered revisions
and progress, discard stale worker results, and preserve selection by stable ID.
Coalesce pending previews; terminate the worker for real cancellation of a long
synchronous erosion pass. The supplied operation-progress callback alone does
not prove the world is changing on screen.

For a 512-metre, 129-vertex grid with 100 props, simple non-erosion commits appear
within 2 seconds after server acceptance on the measured machine. Verify three
successive agent edits while the page remains open. Longer erosion must show
progress/cancellation and leave the GUI responsive; maximum-resolution evaluation
is not promised to be real-time. Mark preview/export resolution explicitly and
reevaluate exports from committed data at the chosen resolution.

Use PRD-466's editable realistic terrain/ocean/lighting source in the editor, not
a separate reduced renderer. The five starter documents appear in the user-requested
order: Temperate Forest/Grassland, Mountain/Alpine, Desert/Canyon, Coastal/Island,
Snow/Tundra. They are editable examples, not locked artistic presets.
Atmosphere/lighting and camera changes from PRD-468 update the running scene
without dispatching terrain evaluation or resetting the current view.

### Select and gizmo one object

Click a tree/rock/grass instance to select that placement, with visible selection
and inspector state; do not select its whole batch. Map picker `instanceId` to a
durable authoring key. The object list also selects overlapping/occluded objects.
Use one TransformControls proxy for full translate/rotate/nonuniform scale; update
that instance immediately during drag and suspend camera orbit while dragging.
Commit one transaction on drag end; Escape cancels and undo reverts the whole drag.
Numeric position/rotation/scale inputs provide precise, keyboard-accessible edits.

Fix scatter identity using deterministic candidate keys, independent of rejection
and acceptance order; random draws for one candidate must not depend on earlier
candidates being accepted. Never persist a mesh-array index as identity.
Manual overrides contain the stable key, position, quaternion, positive scale, and
named grounding choice. Rebuild, reload, API edits, runtime bake, and GLB export
all consume them. Removed candidates retain unmatched overrides and a visible
diagnostic with explicit remove/reassign actions; never silently retarget edits.

Grounding defaults on: moving X/Z regrounds using the actual model bounds. Lifting
records an explicit grounding override and retains measured clearance. Validate
finite coordinates/rotations and positive scales. UI angle conversion is explicit:
terrain operation rotations use degrees; supplied scatter yaw uses radians.

Terrain landforms select the stable recipe layer with a footprint/handle, not a
fictional independent mesh buried in an eroded heightfield. Translate/rotate/scale
supported stamp/heightmap/paste parameters through the recipe. Support vertical
offset/scale with the smallest explicit operation contract where needed. Disable
axes that a heightfield cannot represent, such as overhanging landform rotations,
with a reason; free-standing props retain ordinary full 3D transforms.

### Preserve GUI polish and portable export

| Tool group | Required recovered behavior |
| --- | --- |
| Landforms | Sculpt, smooth, flatten, ramp, stamps, erosion, and supplied heightmap/copy/paste. |
| Surface/population | Material/biome paint, scatter/clear, individual selection, and editable shape parameters. |
| Paths/water | Road/river controls, carving and water placement, using PRD-466's realistic ocean rendering. |
| Document | Layer enable/reorder/inspect, undo/redo, import, existing data exports, and the new full-world GLB action. |
| Spatial inspection | Reference overlay, scale/north grid, terrain probes, contours/heatmaps, profiles, and landmark mismatch feedback through the same saved document. |

The new default world export contains terrain, generated/placed props, manual
transforms, and portable baked PBR textures. It must not call the supplied
terrain-only `makeExport(..., 'glb')` and present that as a complete world.
Shader-driven effects are frozen/baked as specified in PRD-466; live water/wind
simulation does not travel inside standard GLB. Keep the editable source document
separately. Export errors preserve it and the previous valid export.

### Embedded geospatial awareness and reconstruction feedback

Reuse supplied `src/editor/topographic.js` height/slope/material modes and contour
projection, `Terrain.inspect()`, `sampleHeight`, `gradientAt`, and `slopeAtIndex`.
Existing `Heightfield` queries and `ScenePicker` provide the canonical/rendered
surface observations. These are discovered mechanisms, not a shipped full GIS
or automatic map-to-terrain reconstruction system. Extend them in the terrain
tooling; do not build another scene picker, heightfield, or GIS platform.

| Embedded tool | Feedback useful to both the agent and GUI |
| --- | --- |
| Coordinates and reference | Local metre grid, north arrow, origin and extent; top-down map overlay with opacity and saved scale/rotation/translation; labelled control/check points. |
| Surface probe | X/Z, elevation and datum status, triangle normal/slope/aspect, material/splat weights, biome, and water membership/level where known; distinguish ground from a prop hit. |
| Surface views | Contours, elevation/slope/material/biome heatmaps with legends, units and range; grid spacing/preview resolution and stale-revision indicator. |
| Cross-section and region | Draw a transect to inspect distance/elevation/grade; bound a region to inspect min/max/mean elevation and slope, using the actual evaluated surface. |
| Reconstruction mismatch | Compare named reference landmarks/profiles with the measured world; return horizontal/elevation residuals, maximum/RMS error where defined, tolerances and missing/uncalibrated observations. |

**Coordinate contract.** World geometry remains local metres with Y up. Record
which local X/Z direction is north (default -Z, explicitly overridable). Preserve
an optional projected CRS identifier, geospatial origin, source units, and vertical
datum as metadata; do not put million-metre eastings directly into float32 meshes.
Unknown datum/scale is unknown, not zero. Do not mix latitude/longitude degrees
with metres or silently guess a projection. Full CRS reprojection, map services,
and global geodesy are outside this first local reconstruction tool.

**Calibrate reference imagery.** Import a bounded local image and persist its
content hash/source metadata. A top-down map can use the smallest 2D similarity
registration: two distinct known control pairs determine scale/rotation/translation;
a third independent checkpoint is needed before claiming measured alignment.
Known map scale/extent/north can supply those constraints directly, but report
which values are supplied versus inferred. Do not silently mirror the image.
Residuals at fitted controls alone do not prove accurate reconstruction.

Perspective screenshots remain annotated view references unless explicit camera
calibration/ground-plane information makes a metric mapping valid. An arbitrary
screenshot or decorative map has no trustworthy elevation/scale by itself.
Allow unknown/inferred landmarks so the agent can iterate, but do not present
their inferred measurements as geospatial truth. No automatic reconstruction,
world-location lookup, or elevation invention from pixels is promised.

**Measure the surface being used.** A probe identifies document hash/revision,
evaluation resolution, coordinate frame, units and sample source. At a mesh hit,
report the actual triangle elevation/normal; when also reporting a bilinear
heightfield estimate, label it separately and expose the difference. Both supplied
samplers are bilinear, which can differ inside a nonplanar cell. Aspect is undefined
on flat ground, and a query outside the terrain fails explicitly rather than
clamping to an edge and pretending a measurement exists. Water readbacks retain
their measured time/staleness. Never query newly requested data and label it as
the older visible scene, or vice versa.

Contours/profiles derive useful default intervals and sample spacing from map
extent, grid spacing and elevation range, with visible manual overrides. Bound
query region sizes/profile sample counts. Define each statistic's sampling method
and distinguish horizontal distance from surface distance; do not promise exact
continuous-area statistics from a finite grid.

**Agent feedback without UI clicks.** Expose the same read-only point, transect,
region, and landmark-comparison queries through a documented authoring inspection
API/local endpoint returning structured JSON. Reuse the headless evaluated arrays
for queries; a browser is needed only for rendered observations. Return numerical
values, tolerances, residuals, provenance/unknown flags, diagnostics, and revision
identity rather than only screenshots or a generic PASS. A saved query can be
rerun after each semantic patch so the agent can tell whether a ridge, road grade,
pad elevation, coastline, or landmark fit improved. Invalid/missing observations
cannot count as zero error. This is feedback for authoring, not a new automatic
terrain optimizer or evidence-report subsystem.

References, grids, gizmos, heatmaps and debug probes are editor-only and excluded
from world GLB geometry/textures. Keep optional local-origin/north/georeference
metadata in namespaced root extras or an authoring sidecar without making a GIS
plugin necessary for GLTFLoader. Exporting retains metre-scale local geometry and
the same edited placement transforms; reference images are not embedded by default.

### World controls and asset injection

[PRD-468](PRD-468-strata-world-controls-and-asset-imports.md) owns the controller's
camera CRUD/focus operations, editable atmosphere/sky/sun/fog/ocean settings, and
GLB/PBR-image/HDR-environment import through both agent and GUI paths. These are
required parts of this terrain editor. Reuse this PRD's validated revisions,
selection IDs, history and live scene; do not create another renderer, upload
service, scene format or editor. Asset MCP outputs register as project-local
assets and become available for placement, scatter and material/environment use.

## Scope and ownership

Browser/dev-server/editor entries under `packages/terrain/editor/` are optional
tooling excluded from runtime/headless imports. No generic game editor, Studio
integration, realtime multiplayer authoring, cloud persistence, remote map service,
automatic photogrammetry, or full GIS/reprojection stack. PRD-466 carries
the explicit narrow charter allowance for this terrain-only tool. No appearance
defaults move into core; the editor consumes ordinary Three.js objects and the
same game-owned render source as the runtime.

## Acceptance Criteria

AC-1 through AC-7 and AC-9 are phase boxes. AC-8 below proves the saved consumer
handoff. The ninth box covers the newly requested embedded spatial feedback path
without hiding it in the existing GUI tool claim.
All are `local`, actor: implementing agent. New scripts/tests are implementation
targets, not commands that currently exist.

- [x] AC-8 [local, actor: implementing agent]: A GUI-polished world survives reload and exports as the same portable GLB content. proof: `pnpm --filter strata-terrain-preview test:consumer` with the editor-authored fixture — Evidence: PASS 2026-10-02. `pnpm --filter strata-terrain-preview test:terrain:authored` (`RECORD=1` rewrites, otherwise it must reproduce; both exit 0, WebGPU NVIDIA/turing, private Xvfb) polishes the forest world through the editor's real controls: a sculpt drag (`sculpt-1`), a scatter-brush drag of 12 spruce (`scatter-1`) and the numeric transform panel on one of its placements (position Y 55, rotation Y 45, scale 2/0.5/1.5, ground off), then saves a sun/fill/sky/haze/exposure look through the environment API (the settings PRD-468 AC-8 hands to a game). A fresh page then opens the saved document: terrain samples (13 heights, five of them on the sculpt stroke) and all 105 placement transforms equal the pre-reload values exactly, the exported GLB's terrain vertices equal the live heights, every live placement is a GLB node, the document JSON-round-trips to a commit that keeps the same revision (`70744865…`), and the reproduction is deterministic (second run matches the committed fixture). `scripts/fixtures/editor-authored.json` (12 KB: document, revision, samples, placement positions, the posed matrix) is that record. `test:consumer` then re-evaluates the fixture document with only the packed `@threenative/terrain` in a plain browser page and loads its full-world GLB with a vanilla `GLTFLoader`: the 13 terrain samples and exported vertices match the editor within 1e-6, the 105 placement ids are identical, the hand-posed matrix matches within 1e-4, every unedited placement's x/z matches within 1e-3 and its y within 0.084 m (the editor grounds on the triangle under it, the headless pose is the bilinear height; asserted under 0.25 m), the river id travels, no external URI, no editor global and empty `localStorage`. Negative control: changing the sculpt layer's opacity in the fixture fails by name (`terrain sample[8]: 30.82 vs 37.75`). Limit: the packed consumer supplies stand-in appearance, so the exported pixels are not compared here; the real starter art and placement-grounded matrices are covered by `test:terrain:export`.

## Integration Ledger

| Capability | Real consumer path | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Live authoring | Agent/API/file save → revision → editor worker → scene | localStorage-only authority and final-only preview | AC-1, AC-2 |
| Individual polish | Picker hit → stable key → gizmo proxy → saved override | terrain-only picking and transient instance-index edits | AC-3, AC-4 |
| Existing GUI | Recovered controls → shared semantic transactions | a separate GUI recipe copy | AC-5, AC-6 |
| Portable handoff | Saved document → PRD-466 full-world exporter → ordinary game | visual-only edits and terrain-only world exports | AC-7, AC-8 |
| Spatial feedback | Registered reference/query → evaluated or rendered surface → structured inspector and visible overlay/profile | global min/max only and uncalibrated visual guesses | AC-9 |
| World controls/import | Shared document → PRD-468 camera/environment/asset operations → same live scene | manual camera-only access and a closed starter asset list | PRD-468 AC-1 through AC-7 |

New locations are proposed. Record actual non-test entry points when implemented;
do not invent future line numbers.

## Decisions

- 2026-09-30 (João): Live editor URL, individual gizmos, existing GUI tools, and
  saved customization are required; agent-first generation remains primary.
- 2026-09-30 (João): Prioritize the five named environments and output a GLB
  easily usable in any game.
- 2026-09-30 (planning choice): Preserve and extend the supplied editor; keep this
  independently testable tool in a linked PRD with three phases/about eight boxes.
  Both PRDs remain required for the full outcome; no requirement is deferred away.
- 2026-09-30 (João): Embed geospatial awareness/debug tools so map/screenshot-based
  reconstruction gets actual terrain-surface feedback. Calibration uncertainty
  and numerical residuals must be visible to both the agent and user.
- 2026-09-30 (João): Activating the terrain editor must offer a usable live-view link.
- 2026-09-30 (João): Controller camera CRUD/focus, on-demand GLB/image imports, and
  editable atmosphere/environment are required. Split their separable consumer
  paths into required PRD-468 to keep this editor checklist bounded; no deferral.

## Execution Phases

### Phase 1: Shared document and live editor URL

**Status:** VERIFIED
**Files:** recovered `packages/terrain/src/editor/app.js`/worker, `src/editor/server.ts`,
preview Vite config/editor entry/document, `__tests__/editor-document.spec.ts`.
**Implementation:** Recover UI/worker; attach to the shared document and preview.
Reuse middleware, file watching, SSE, atomic validation and revision ownership.

- [x] AC-1 [local, actor: implementing agent]: The activation-returned live link opens the current project and renders successive agent revisions without refresh. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` — Evidence: PASS 2026-10-01 — the public controller follows the plugin-returned bound URL and same project/session, including reactivation at the latest GUI revision. The runner-owned WebGPU browser renders three successive amplitude revisions (30/80/50) without refresh on a 512 m / 129-vertex grid with 100 actual instanced pine props (38,800 prop triangles). Measured mesh-height sums differ; first draw follows acceptance in 106–137 ms on NVIDIA/turing RTX 2080. The real GUI name edit saves to the shared document and a fresh scene run reads the latest recipe. Startup/missing-route rejection and a configured private HTTP forward are tested, including failed-forward rejection. This proves the measured latency fixture, not final starter art or mobile performance.
- [x] AC-2 [local, actor: implementing agent]: Malformed/stale writes cannot replace the valid document. proof: `pnpm exec vitest run packages/terrain/__tests__/editor-document.spec.ts` through real middleware — Evidence: PASS 2026-10-01 — seven public-import document tests use real loopback Vite middleware: multi-command rollback, stale 409, invalid external-save retention/recovery, hostile host/origin and client path rejection, malformed/media-type/64 MiB boundary errors, actual-port readiness and same-session reuse, live SSE/file-watch updates, and trusted private-forward writes/readiness with foreign-origin rejection and failure recovery. The browser integration terminates an active 200,000-droplet worker through the recovered Cancel button, retains the prior mesh, then renders the latest accepted recovery revision; older results cannot replace it. The original seven numerical/Three consumer tests still pass. An unregistered model now reports its asset ID, releases the busy state and retains the last valid scene; removing it recovers successfully without a page error.

Actual entry points: `packages/terrain/src/editor/server.ts` owns the fixed-file
revision authority and optional Vite middleware; `src/editor/index.ts` owns the
HTTP controller and recovered GUI mount. The original app/icons/presets/worker
and static shell are recovered under `src/editor/` to match normal capability
export discovery. Browser/headless root and geometry imports remain separate.
The preview uses `src/editor.ts`, project-owned `src/render/editorView.ts`,
`terrain/world.json`, and `/terrain-editor/index.html`. The authoring scene uses
the same terrain/ocean render helpers and normal ThreeNative game loop.

`test:terrain:editor` reuses withBrowserCapture for real agent/API/GUI/cancel
checks, then runStandalonePlaytest for the executable scene scenario. Its
changed-only frame observation avoids declaring already-rendered warmup geometry
an independent transition. The initial preview-resolution mismatch is corrected
by selecting the saved recipe resolution. No synthetic failed state is created.
All supplied controls are retained; selection/gizmos, calibrated spatial modes,
complete exports and shared undo/conflict polish remain their later phase boxes.

Initial shared-editor milestone checks (2026-10-01, commit `9cf0daa07`): root typecheck/lint/budgets and documentation links pass.
The full `pnpm test` command passes workspace package builds/checks and 521 root
test files / 6,483 tests (12 skips); the suite temporary directory count does not
grow. Public terrain imports pass 14 tests, including the real private forward.
`test:terrain:editor` passes on WebGPU NVIDIA/turing with actual GUI save, three
rendered agent revisions, cancellation/recovery and the executable scene scenario.
The existing browser and Linux desktop terrain/ocean regression scenarios pass
with this editor Vite config. The native host renders 300 frames with 226
presentations. Actual editor screenshots are tracked for draft PR #381; no mobile,
steady-state FPS, 100-prop latency or complete-editor claim is made.

The 100-prop milestone uses the supplied pine/boulder/grass shapes in editable
`src/render/props.ts`, with installed `mergeParts` and `InstancedBatch`. Ground
positions come from actual terrain-triangle picks, with transformed model bounds
and authored offsets preserved. Scene observations count actual instance buffers
and geometry triangles; these are not GPU timing measurements. The editor badge
reads the actual renderer kind. The missing-model and cancellation checks both
wait for completed worker recovery, including content-hash reuse.

100-prop/scatter milestone checks (2026-10-01): root typecheck, lint, budgets,
documentation links and 180 documentation tests pass. The full `pnpm test`
command passes workspace package builds/checks and 522 root test files / 6,485
tests (12 skips), with no suite temporary-directory growth. The final real
WebGPU editor run passes the 100-instance/38,800-triangle observations and
three distinct rendered terrain revisions in 106–137 ms, GUI persistence,
latest-revision reactivation, missing-model failure/recovery and cancellation.
The scene scenario also counts the actual 100 instances. This milestone does
not claim native editor props, final PBR starter art or steady-state FPS.

### Phase 2: Individual selection and persistent gizmos

**Status:** PARTIAL
**Files:** game-owned `src/render/selection.ts`, `landforms.ts`, `editorView.ts`
and `props.ts`; addon `core/placements.ts`, operation types/validation/evaluation;
public consumer/override tests and the editor browser scenario.
**Implementation:** Reuse picker/gizmo, preserve instance identity, persist one
transaction per drag, and consume overrides in bake/export. Preserve recipe
intent for landforms. Invalidate only affected static/instance data during drag.

- [x] AC-3 [local, actor: implementing agent]: One selected instance is translated/rotated/scaled through actual gizmo interactions. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` — Evidence: PASS — a real mesh click selects one durable placement key; actual translate X, rotate Y and nonuniform scale X drags change only that instance, suspend Orbit and save once. Escape saves nothing. Stamp selection reuses the same proxy with a terrain-following footprint; actual translate X/Y, rotate Y and vertical-gain Y drags change the stable recipe layer, rebuild on commit and retain selection. Numeric inputs change anisotropic stamp half-extents and bounded heightmap/paste footprints; layer-list clicks select those stable layers. X/Z rotation controls and handles are disabled with the heightfield-overhang reason; other unsupported rotation handles reject before a gesture. Landform Escape saves nothing and selective undo preserves another actor's layer name and roughness. The full real browser integration and standalone scene scenario pass on WebGPU NVIDIA/turing.
- [x] AC-4 [local, actor: implementing agent]: Manual overrides retain identity after re-evaluation, and the editor-authored world exports with its own water and art. proof: `pnpm exec vitest run packages/terrain/__tests__/placement-overrides.spec.ts` (13 passed) and `pnpm --filter strata-terrain-preview test:terrain:editor` (exit 0, WebGPU NVIDIA/turing) and `pnpm --filter strata-terrain-preview test:terrain:export` (exit 0) — Evidence: PASS 2026-10-01 (commit 90d69cc35) — public tests cover stable candidates across rejection changes, saved nonuniform transforms, unit quaternion/finite/positive-scale validation, atomic rejection (including explicit null grounding), retained unmatched diagnostics and transform records in `bakeTerrain`. The real browser restores every actual instance pose on reload; an unrelated layer edit retains the override, a stale drag preserves the newer actor edit and retains an explicit reapply draft, and selective undo retains the other actor's layer edit. Unmatched override removal works through the GUI. Installed `GroundSnap` uses the actual model bounds and terrain-triangle query; grounding on reaches clearance below 1e-4 m, while a real Y-handle lift records `grounding: false` and reports 2.5549 m clearance. GUI reassignment is now exercised: it transfers an unmatched override to the selected fresh durable key, preserves the other override, changes actual position/scale without terrain evaluation, and survives reload. The editor-authored world export now runs at all, where it previously failed before its own assertions: the props draw through node materials, so the encoder rejected the world outright. `src/render/water.ts` bakes every evaluated river and flooded body as static `MeshStandardMaterial` geometry coloured by metres of depth, the editor draws that same bake, and the recipe keeps its river rather than the fixture deleting it — `report.waterIds` is `[river]` and the vanilla GLTFLoader consumer reads one water node with 4,360 triangles. `src/render/portable.ts` binds this project's own CC0 1K ground maps plus its bark, stone and needle sets, so the eight embedded images are 20 KB+ starter maps rather than a fixture's 16x16 checkers, and the consumer counts 202 meshes and 404 PBR maps. `IWorldGLBInput` gained an optional per-placement `models` map, unit-tested for precedence and for failing closed on an unmatched key, and each placement carries every draw it owns, so 100 spruce nodes share four geometries instead of exporting one hundred poles. The export dialog's new `world` card calls the live view rather than the terrain-only worker export.

Prop transforms use one ordinary Three.js `TransformControls` proxy around the
project scene. The measurement mesh is never rendered; updates write only the
selected instance buffer. Initial creation and later edits write the same prepared
matrix, avoiding Euler round-trip differences when resetting a placement. Stable
authoring records keep requested transforms and the named grounding choice;
unmatched keys are not silently redirected. Public root and `/three` remain
headless. The recovered view contract receives the existing controller and applies
metadata through `setDocument`, separately from the evaluator worker.

Gizmo milestone checks (2026-10-01): all 20 public terrain tests and the real
WebGPU browser integration pass, including the fresh standalone scene scenario.
The three simple 100-prop terrain revisions draw in 141–167 ms on NVIDIA/turing
RTX 2080. Root typecheck, lint, budgets, documentation links and 180 documentation
tests pass. The full board's documentation/build/package-test phases pass; its
unit phase is green through the existing `pnpm gate:resume` path: 523 files /
6,489 tests pass (12 skips), with no temporary-directory growth. The earlier unit
attempt lost the asset-budget worker; that file passes all 26 tests alone and the
entire resumed suite passes. The worker exit's cause remains unconfirmed. Actual
selection/scale/grounding screenshots accompany this draft milestone. This proves
browser editor behavior, not native editor props, final starter art or FPS.

Revision-label follow-up (2026-10-01): the real browser reproduces metadata
incorrectly advancing the GUI and renderer revision after a missing-asset rebuild.
Both paths now compare against the recipe that successfully produced the scene.
While that recipe differs, metadata retains both rendered labels and all 100
instance matrices; the accepted metadata applies after successful recovery.
The same check passes during active 200,000-droplet erosion: metadata does not
restart the worker, cancellation retains the previous scene, and recovery applies
the latest accepted pose. The standalone scene scenario remains green. An actual
retained-preview screenshot shows the unrendered saved recipe and named asset
error. Landform handles, reassignment and portable bake/export consumption remain
open, so phase 2 remains partial.

Revision-guard verification (2026-10-01): root typecheck, lint, budgets,
documentation links and 180 documentation tests pass. The complete `pnpm test`
command passes documentation/build/package checks and 523 test files / 6,489 tests
(12 skips), with no suite temporary-directory growth. The real browser integration
and standalone scene scenario pass at this source state; no resumed test verdict
is needed for this follow-up.

Landform milestone (2026-10-01): game-owned `src/render/landforms.ts` maps stamp,
paste and heightmap recipe parameters to the existing proxy. The line marks a
footprint on the actual rendered triangles; no independent landform solid moves
inside an eroded heightfield. Positive vertical gain applies before metre offset;
additive stamp/paste now honor offset. Heightmaps retain their original full-world
sampler unless optional footprint fields are present, then reuse the existing
paste sampler. Public tests reject missing/nonnumeric height samples atomically,
exercise every blend and rotated anisotropic footprints, round-trip recipes and
compare baked collision arrays. The supplied noise/erosion golden remains exact.

All 24 public terrain tests and the expanded browser integration pass, including
stamp gizmo drags, numeric heightmap/paste edits, layer selection, preserved prop
behavior, cancellation/conflicts/recovery and the fresh standalone scene. The
100-prop revision observations draw in 164–188 ms on NVIDIA/turing RTX 2080.
WebGPU rejects `LineLoop`, so both the footprint and brush ring use ordinary
closed `Line` geometry. The expanded harness has a bounded 120-second callback;
individual simple-edit latency assertions still require less than two seconds.
Prop-only grounding/reset controls remain hidden on landforms despite the recovered
CSS, with actual visibility assertions. Object-list values distinguish placements
from layers even when a scatter rule is named `landform`; saved IDs are unchanged.
Phase 2 remains partial: reassignment and complete portable bake/export
consumption are still AC-4 work. Root typecheck, lint, budgets, documentation links
and 180 documentation tests pass. The complete `pnpm test` command passes
documentation/build/package checks and 523 files / 6,493 tests (12 skips), with no
suite temporary-directory growth. Browser and Linux desktop terrain/ocean consumer
regressions pass; the inspected nonblank desktop capture renders 300 frames with
202 presentations. Four actual 1440 × 900 WebGPU landform screenshots are tracked
for PR #381. This does not claim native editor props, final PBR starter art or FPS.

### Phase 3: GUI polish and GLB handoff

**Status:** PARTIAL
**Files:** recovered tools/inspectors, shared history/export integration, addon
agent guide, `editor/referenceOverlay.ts`, `editor/spatialInspector.ts`,
`__tests__/spatial-inspection.spec.ts`, `playtests/terrain-editor.playtest.json`,
runner-backed editor script. New paths are proposed.
**Implementation:** Wire every supplied tool to the shared document, keep save,
undo/export coherent across consumers, and exercise real public entry points.
Add saved reference registration and readonly spatial queries using the existing
sampling/topographic mechanisms. Keep GUI and agent results on the same revision;
measure actual surface errors and calibration residuals rather than visual guesses.
Use the existing harness; no new E2E framework or verification-report file.

- [x] AC-5 [local, actor: implementing agent]: GUI tool groups edit the shared authoring recipe. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` — Evidence: PASS 2026-10-02 (exit 0, WebGPU NVIDIA/turing) — a second real browser session drives every supplied tool group through its own controls against the same live editor and reads the shared document off disk after each commit, never an internal helper. Landforms: sculpt, smooth, flatten, stamp, erode and ramp each add their own new named layer (`sculpt-1`, `smooth-1`, `building-pad`, `eroded-hill`, `weathering`, `ramp-1`). Surface/population: material paint (`pad-surface`), biome paint (`biome-1`, naming the option's own `forest`), scatter (`scatter-1`, asset `spruce` and count 12 taken from their own controls, 103 actual instances in the scene) and clear (`clear-1`, naming the asset it erases). Paths/water: road (`road-1`, width 12 from its own option), river (`river-1`, depth 6 and `enforceDownhill` true) and water (`water-1`, saved body kind). Document: the eye disables and re-enables a layer on disk, move-earlier reorders the stack, duplicate names its copy `water-1-copy-1`, delete removes it, undo restores it and redo deletes it again, the opacity slider and the JSON parameter box each save one layer's own values (`opacity` 0.5, `params.level` 7), a malformed JSON edit is refused with a message and no revision change, importing the project's own recipe round-trips it exactly, and the project-recipe export card downloads `terrain-recipe.json` (3482 bytes). That session's four captures are `docs/verification/visuals/strata/467-tools-{ramp,scatter,water,document}.png`. 44 commits went through `POST /api/document` and 21 undos returned the recipe to exactly the layer ids the session found. The proof found and this change fixes two real defects: the recovered paint target select was discarded in material mode, so biome paint was unreachable from the GUI, and the scatter palette was a hardcoded starter list — it now asks the project view (`IEditorView.propAssets()`), which returns this project's own `PROP_ASSETS`. Heightmap/copy/paste remain wired through the same transaction path but are exercised by the landform session, not from a tool button.
- [x] AC-6 [local, actor: implementing agent]: Drag/cancel/undo operate as single edits without losing agent revisions. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` — Evidence: PASS 2026-10-02 (exit 0, WebGPU NVIDIA/turing) — three real gizmo drags (translate X, rotate Y, nonuniform scale X) on one selected instance save exactly `guiTransactions: 5` for three modes plus their two resets, and Escape saves nothing (`cancelledRevision` `710f15c3…`). A stale drag against a newer agent edit keeps the newer actor's layer edit (`conflictPreserved` `74f00a04…`) and retains an explicit reapply draft; selective undo retains the other actor's layer edit (`selectiveUndoLayer: "Other actor keeps this layer edit"`); an unrelated layer edit retains the prop override and every pose survives reload (`persistedReload` `eb07221b…`). The landform proxy behaves the same way: four completed drags on the stable recipe layer, Escape saving nothing, and selective undo restoring another actor's roughness while keeping its own changed offset/rotation/scale. Cancel terminates a running 200,000-droplet build, keeps the previously rendered mesh and renders the accepted recovery revision afterwards. Across the tool-group session every edit is one transaction and 21 undos take the shared file back to the identical layer list, so no session's history can discard another's revision.
- [x] AC-7 [local, actor: implementing agent]: Packaged editor tooling stays optional to headless/runtime consumers. proof: `pnpm --filter strata-terrain-preview test:consumer` — Evidence: PASS 2026-10-02 (exit 0, ~15 s). The consumer installs the packed `@threenative/terrain` and `three` outside the workspace and walks the installed `dist/index.js` and `dist/three.js` import graphs: each is one file whose only import is `three` (the root has none), and neither names an editor/server module or touches `document`, `localStorage`, `FileReader`, `Worker` or a `node:` builtin; both import in a Node process with no DOM. A fresh `createProject` scaffold is created inside that install and the shipped `terrain-authoring.md` is run in it: its first code block executes verbatim (257x257 evaluate, `bakeMesh`, `bakeTerrain`, recipe saved as `terrain/world.json`); its editor block runs against a real Vite server with the project-owned `/terrain-editor/` route, `await editor.activate()` returns a loopback `editorUrl`, and the printed `TerrainEditorController` patch (`hills` amplitude 35) lands in the shared document, followed by a scatter layer and a `validatePlacementOverrides` pose; a commit on the first revision is refused as stale; and the file on disk equals the committed document. That edited document is then exported as a full-world GLB in a plain browser page (chromium, import map onto the installed tarballs, no Vite, no editor global, empty `localStorage`) and read back by a vanilla `GLTFLoader`: 257x257 terrain, 6 placements, the posed placement's world matrix equal to the saved override (1e-4), the sampled terrain heights equal the evaluated state, no external URI, no camera, no page error or off-origin request. `vite` is the optional peer and is symlinked from the workspace because it cannot be installed offline; every `@threenative` module in the run is the tarball. The page supplies its own stand-in appearance (1x1 maps, boxes, a quad for the river), because appearance belongs to the game; the real starter art is carried by `test:terrain:export`.
- [x] AC-9 [local, actor: implementing agent]: Embedded spatial inspection gives calibrated, revision-bound terrain feedback usable for reconstruction. proof: planned `pnpm exec vitest run packages/terrain/__tests__/spatial-inspection.spec.ts` through public inspection/middleware plus `test:terrain:editor` — Evidence: PASS 2026-10-01 (commits 7e205e0cb, dd329a80b) — spatial-inspection.spec.ts (public entry points, red first) passes with the terrain suite (35 tests); `test:terrain:editor` passes on WebGPU NVIDIA/turing with GUI `window.strata.inspect` deep-equal to headless `api/inspect` on one rendered revision. No rendered reference overlay is built, so none can enter the GLB. Original plan: use a known asymmetric terrain and synthetic map with two fit controls plus an independent checkpoint, recover point height within 0.01 m and slope within 0.1 degree, report a deliberately displaced checkpoint's actual residual, and compare GUI/headless profile results. Reject degenerate/out-of-bounds queries, label unscaled/perspective references and unknown datum, distinguish bilinear/triangle values, preserve registration after reload, and keep debug overlays out of the GLB.

## Verification and delivery

Gizmo proof drives visible interactions, not only an internal matrix helper.
Live proof observes rendered revisions, not only notifications/progress labels.
Browser WebGPU proves the authoring UI; changes to baked output rerun the affected
PRD-466 browser/desktop consumer scenarios. Use real red/green for behavior and
required type/lint/test/build/budget/selected-CI gates after nearest checks.

Run `pnpm prd:progress` before execution and after phases. Keep results on these
boxes or the PR; mirrors are regenerated only for changed agent guidance.
One draft implementation PR targets `develop` from an owning-repository worktree.
Archive only after all nine boxes pass. Planning does not authorize deployment
or npm publication, and does not claim implemented editor behavior. The overall
integration also requires PRD-468's camera/environment/import criteria.


Export/reassignment follow-up (2026-10-01): the expanded real editor integration
and standalone scene scenario pass, including explicit orphan reassignment and
removal, all actual reloaded poses, prior conflict/cancellation/grounding behavior
and landform operations. The 100-instance revisions draw in 187–199 ms on
WebGPU NVIDIA/turing. The new renderer export method rejects an accepted revision
that differs from the actually rendered document, reuses its real geometry and
final instance matrices, and adds canonical UVs on an owned export copy. The
separate public encoder needs caller-prepared PBR surfaces and exact-time baked
water. Successful dry-fixture vanilla/native consumers are described in PRD-466;
this does not tick the default full-world GUI handoff or AC-8. Reassignment and
actual export-consumer screenshots join PR #381's development captures.

Spatial inspection (2026-10-01, AC-9): `packages/terrain/src/editor/spatialInspector.ts`
answers read-only point, profile and saved-reference queries from the evaluated
arrays, labels `bilinear-heightfield` and `evaluated-triangle` separately with
their difference, and rejects non-finite, malformed and out-of-extent queries.
A top-down reference registers through the smallest 2D similarity from two
distinct controls; the synthetic 0.5 m/px, 30° sheet reports
`scaleMetresPerPixel` 0.5 and `rotationDegrees` 30, control residuals below
1e-9 m, and its deliberately displaced checkpoint residual of 5.000000 m against
a 1 m tolerance, so `calibrated` stays false. Perspective screenshots, one-control
maps and unknown datums are labelled and never fitted. References are stored beside
the recipe in the authoring document, reload with it, and reach neither the
evaluated state nor the GLB, whose JSON carries one node and no landmark names.
`packages/terrain/__tests__/spatial-inspection.spec.ts` (5 cases) runs through the
public inspection API, the real Vite middleware and `TerrainEditorController`:
`pnpm exec vitest run packages/terrain` passes 6 files / 35 tests. The editor lane's
`window.strata.inspect` profile and the headless `api/inspect` profile are asserted
equal on one rendered revision by `pnpm --filter strata-terrain-preview test:terrain:editor`,
which exits 0 on WebGPU NVIDIA/turing with 100-prop revisions drawing in 120–146 ms;
root `pnpm typecheck` and `pnpm lint` exit 0. Region statistics and a rendered
map/grid overlay are not part of this milestone.
