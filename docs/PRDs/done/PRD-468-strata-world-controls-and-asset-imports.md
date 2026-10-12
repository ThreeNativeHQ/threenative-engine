# PRD-468 — Live world atmosphere, controller cameras, and asset injection

**Status:** DONE
**Priority:** P2 — Remaining shipped handoff and EXR/native/mobile qualification.
**Complexity:** 7 (HIGH); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** PRD-466's public rendering/asset/export contract and PRD-467 phase 1's shared document/live session
**Progress:** 3/3 phases verified (7/7 phase boxes); 1/1 acceptance box verified; prd:100%.

## Context

João requires the AI controller to create/read/update/delete cameras, change camera
focus, and inject custom GLB models or image textures on demand using the
ThreeNative asset MCP. Atmosphere and the surrounding world presentation are
editable too: sky, sun, haze/fog, lighting/exposure, environment images and ocean.
The user sees these changes at the live terrain-editor link returned by PRD-467.
Agent-first authoring, complete custom replacement, an Unreal-like visual goal and
a portable full-world GLB remain the outcomes.

This is required companion scope, split from PRD-466/467 to keep each plan at three
phases/about eight boxes. It is not a later optional feature. Their ninth boxes
retain the separately requested ocean and spatial diagnostics; additional camera,
environment and import outcomes have their own bounded checklist here. Complexity
is 3 for the affected implementation files, 2 for live asset/material consumption,
and 2 for the editor/runtime/export boundary. This request authorizes planning,
not implementation or publication.

## Solution

### Responsibility contract

This is a terrain authoring tool with a realistic preview, not the game's runtime
or a general scene editor. This section is the authoritative boundary for all
three terrain PRDs. A feature is not assigned by which screen exposes it: the
editor may edit an appearance value, while project render source owns what that
value does. New appearance defaults never enter `@threenative/core` or the addon.

| Owner | Required responsibilities | Boundary |
| --- | --- | --- |
| Existing engine packages | Render/compute lifecycle, asset loading/cooking, instancing/culling, physics binding, and installed atmosphere/ocean mechanisms. | No terrain editor state, starter art style, lighting rig, shader composition or camera framing defaults. Extend an engine mechanism only for a demonstrated shared defect/capability gap. |
| `@threenative/terrain` authoring addon | Recover/evaluate Strata recipes; produce canonical geometry/masks/placements and surface diagnostics; adapt to ordinary Three.js geometry and perform tooling-side bakes/exports. | Pure root and `/three` imports do not pull editor/server/DOM code. No game loop, renderer, material factory, physics world, gameplay or requirement that games load recipes. |
| Terrain editor tooling | Saved authoring transactions/history, live link/revisions, selection/gizmos, spatial references, asset registration, preview camera CRUD/focus and controls for project-owned preview settings. | Editor cameras and debug views stay authoring-only. No gameplay entities, follow-camera system, animation editor, runtime scene graph or automatic writes to a game's chosen configuration. |
| Project-owned `src/render/` source and assets | Procedural prop shapes, material construction, texture-channel meaning, sky/sun/fog, ocean surface, lighting/exposure/post composition and all artistic defaults. | Copy starter source into the project; edit/delete/replace it there. Editor controls call those project functions directly with validated values, not a new render-plugin registry or engine-wide appearance vocabulary. |
| Consuming game source | Load chosen baked artifacts, register desired collision, select its own camera, configure appearance and implement interaction/gameplay. | The game runs without an editor URL, authoring document, file watcher, worker or recipe evaluator. A sidecar never spawns nodes, cameras, scripts, colliders or render stages automatically. |

**What the saved document means.** Keep Strata recipe/placement data, project-local
asset references, spatial annotations, named editor cameras and preview environment
values as clearly named authoring groups with documented units. It describes
terrain construction and preview state, not arbitrary game entities or behavior.
Physical water level/extent and biome/material-channel data belong to terrain;
wave bands, foam colour and shading belong to project-owned render source. Each
field has one authoritative owner; controls must not store a second water level
or silently reinterpret a material channel. Actual orbit pose and active viewer
navigation are session state; only explicit bookmark edits enter saved history.

**What an edit invalidates.** Terrain height edits invalidate evaluated geometry
and affected grounding; placement edits invalidate affected instance data; image
mapping edits invalidate the relevant material/asset bindings. Preview atmosphere
edits invalidate only affected render/LUT state; camera navigation changes only
the authoring view. Reading a probe or changing a debug overlay never edits the
world. Any terrain-dependent appearance cache may refresh after a terrain edit,
but a render-only edit must not trigger erosion or collider work.

### Concrete deliverables and game handoff

| Deliverable | Contents and consumer |
| --- | --- |
| Default `world.glb` | Terrain, placed prop geometry, final transforms and embedded portable PBR images; optional static water snapshot. No cameras, lights, fog, HDR environment binding, debug/reference objects, editor state or gameplay. A frozen ocean is labelled static. |
| Authoring project | Recipe/document, original imported assets/provenance, preview settings/bookmarks and editable render source. The agent/editor reopens it; games do not deserialize it at startup. |
| Explicit ThreeNative handoff | On request, emit/copy baked terrain/placement data, required prepared assets and project-owned `src/render/` source, plus a small environment-settings sidecar. Ordinary game source loads these and wires the existing engine APIs. It does not import the editor. |
| Optional collision/geospatial data | Canonical collision heights and coordinate metadata already specified by PRD-466/467. The game explicitly opts into their use; the GLB has no universal collision/GIS guarantee. |

The settings sidecar carries only preview appearance values, units and local asset
references for the copied render source. It is not a universal scene format or
portable substitute for atmospheric shaders. Generating that handoff is required
when requested; consuming it is optional. Do not overwrite an existing game's
render files/settings: produce an explicit new destination or return a conflict.
Preview edits never alter a previously exported game until a new handoff is
explicitly applied by game source. Source customization remains ordinary code,
not executable strings in authoring JSON.

For a ThreeNative handoff, choose either the static GLB scene or the baked-data
scene construction in game source. The latter may use live spectral ocean and
wind from copied render source. Do not load both representations of the terrain,
props or water. Imported asset lights/cameras are not activated as world lighting
or the gameplay camera merely because they were present in the model file.
Export returns the committed revision, snapshot time, written files and included/
excluded feature groups; it does not call a static GLB a complete live game.

### One live world, ordinary Three.js objects

Extend PRD-467's saved authoring document, semantic transactions, revision checks,
undo/redo and local middleware. Environment and camera fields are authoring
settings consumed by editable game render source, not a new runtime scene format.
Each running view uses one normal ThreeNative renderer/loop. The editor and normal
game fixture share project render source, not mutable camera/world state or a
second renderer embedded in the editor. Keep stable selection IDs and the shared
controller authoring session. Camera-only
and environment-only operations must not reevaluate/erode terrain, rebuild its
collider or restart the scene. Reuse normal Three.js cameras, lights, textures and
models through the existing engine context.

Capability search/detail identified `Atmosphere`, `AtmosphereLuts`,
`resolveAtmosphereParameters`, `updateAtmosphereParameters`,
`directionalTransmittance`, `WorldEnvironment` and `createAssetLoader`.
Atmosphere owns compute/LUT lifetime, not sky meshes, materials or lights; the game
supplies all scattering coefficients and radii. `WorldEnvironment` is generated
game source, not a new engine package. Its `TN_RENDER_CHAIN` reports applied/dropped
stages with reasons; this is not proof that their pixels look right. Discovery
found no camera-bookmark CRUD system: use installed PerspectiveCamera,
OrthographicCamera, `lookAt`, bounds and the recovered orbit controls.

### Controller camera CRUD and focus

These operations control editor observation cameras only. Gameplay follow/aim/
cutscene cameras and camera behavior belong to the consuming game's source.
Bookmarks are never part of the default GLB or environment handoff.

Expose documented structured operations through the shared authoring API/local
endpoint: create, get/list, update, delete, activate, and focus a camera. Return
stable IDs, current values, active-camera ID and revision. Save named cameras with
position, target, up, projection type, perspective FOV or orthographic extent/zoom,
and near/far planes. Reads also expose the actual current viewer pose; manual orbit
changes must not make controller observations stale or be reset by terrain rebakes.
Persist an orbit edit to a bookmark only through an explicit save/update action.

Validate finite values, noncoincident position/target, usable up vector, positive
zoom, valid FOV and ordered clipping planes. Compute aspect from the current
viewport rather than saving a stale browser aspect. Deleting the active camera
selects the ordinary editor fallback and reports it; unknown IDs fail without
changing the view. API and GUI camera lists/inspectors consume the same operations.

Focus targets may be a local XYZ point, stable selected prop ID, registered
landmark or terrain region. Resolve actual world bounds/registered coordinates;
frame with viewport aspect and projection, derive a useful distance/clipping range
and expose framing-margin overrides. Do not focus an instancing batch when one
tree was requested. Update world matrices before reading hidden-object bounds.
An orthographic top-down camera supports map overlays and surface inspection.
Missing targets return named diagnostics and retain the last valid camera.

### Editable atmosphere and environment

Provide controller reads/patches and GUI fields for the following appearance
groups. Saved preview settings drive the live editor. A consuming ThreeNative
game adopts them only through the explicit project-source/settings handoff;
another game engine supplies its own equivalent. The editor validates/binds
values; `editor/environment.ts` must not implement shaders, create an artistic
lighting rig or own appearance defaults.

| Group | Required editable behavior |
| --- | --- |
| Sky/atmosphere | Procedural physical sky or imported background image, sun direction/elevation, scattering parameters and atmospheric depth/haze. Reuse atmosphere LUT updates and game-owned sky/material source. |
| Lighting/exposure | Sun colour/intensity, environment illumination/rotation/intensity, exposure and fields already exposed by the project's tone/post source. Sky/background and illumination are independently selectable; this is not a universal render-stage editor. |
| Fog | Enable/disable and tune game-owned distance/height fog where the chosen render source supports it; reuse installed atmospheric aerial perspective for depth haze. Unsupported selected modes return a diagnostic, never a silent replacement. |
| Water | Ocean level/extents and supported spectral/appearance parameters from PRD-466's existing ocean source, without a terrain rebuild unless the edit also changes its recipe. |
| Custom look | Replace the sky/material/post source or all environment mappings in project source; no package edits and no locked starter style. |

Custom render source may expose different controls or report an unsupported field;
that never makes the original starter shader mandatory. Changing the appearance
completely must remain possible without modifying package code or an editor
rendering backend. A source edit uses existing Vite HMR, not JSON code execution.

Persist explicit units and complete validated physical atmosphere parameters.
Initial values come from the selected editable starter, with named overrides.
Recompute only affected LUTs/material bindings. Invalid values preserve the last
valid scene/document; failed or rebuilding environment loads show status. Imported
HDR illumination and a procedural sun must have explicit authored contributions,
so swapping backgrounds does not silently double light intensity. Keep controller
readbacks and the GUI on the same rendered/requested revision, including pending
LUT/asset work. New cloud/weather solvers are not a prerequisite; custom sky source
remains replaceable rather than claiming an installed weather simulation.

### Import models, surface images and environment images on demand

The GUI offers file picker/drop import; the agent can register local files returned
by the existing ThreeNative asset MCP without UI clicks. Both paths stage bounded
files and create stable project asset IDs under the preview/game's `assets/` tree.
Store source hash, project-relative path, type, measured bounds, provenance/license
metadata where supplied, and preparation status. Same-name conflicts require an
explicit replacement or new ID; failure retains existing art and the document.
Do not erase referenced files when removing a palette entry or undoing placement.

| Input | Consumption |
| --- | --- |
| GLB | Any valid model supported by the installed loader, not a starter allowlist. Load through `ctx.assets.model()`, expose measured bounds and explicit source-unit/scale/pivot adjustments, and make it available for placement/scatter and the existing individual gizmo. A rigged import may be placed in a declared static pose; this does not add animation authoring. |
| PBR image | Supported PNG/JPEG/WebP images are assigned explicitly as albedo, normal, roughness, AO, height, opacity or other game-owned material inputs. Decode/validate, cook through existing asset preparation, and use `ctx.assets.texture()` with colour data in sRGB and numerical maps linear. Images are not assumed to be heightmaps or models. |
| Environment image | HDR/EXR equirectangular files, or supported ordinary environment images, may be assigned to background and/or environment lighting. Resolve local/cooked paths with `ctx.assets.resolve()` and reuse installed `three/addons/loaders/HDRLoader.js`/`EXRLoader.js`; do not send HDR through the ordinary image texture decoder or clamp its radiance as albedo. |

Keep necessary model geometry/hierarchy and its authored materials. Imported
lights/cameras remain inactive, with explicit diagnostics; they do not overwrite
the world environment or editor camera. Preserve the source file for custom game
use, but omit those authoring-irrelevant nodes from default world export.

Loading/preparation happens asynchronously with visible asset-specific progress.
Promote a mapping only when validation/load succeeds, then update affected objects
or materials in the open scene. New files use content-addressed/versioned loader
paths to avoid stale cache reuse. Reuse the existing compiler and asset cache;
preserve tiling textures rather than indiscriminately atlasing them. Import byte
and decoded-dimension limits are explicit, configurable project limits; the
25 MiB starter budget is not a ban on larger custom models.

Validate actual file format, finite geometry, image dimensions, dependencies and
supported extensions. Report missing/unsupported resources by name; never promise
all malformed GLBs, image codecs or proprietary shader formats will work. External
GLB references require explicitly supplied project-local dependencies and are not
silently fetched. Browser requests cannot select arbitrary filesystem paths; use
bounded uploads or configured project-local registration. The trusted local agent
can copy MCP outputs into the project before registration.

Reuse existing MCP Poly Haven downloads, Fab owned/free import tools and local
Unreal-to-GLB conversion where applicable; do not build a new marketplace client.
Honor their supplied license acknowledgement/provenance contracts. No purchase,
account login, public sharing or bundling private art is needed to test imports.
The automated fixture uses licensed test files in the same local-file shape as
MCP outputs; an actual marketplace account is not a closure dependency.

### Portable output and editable presentation

Imported placed models and surface images must survive PRD-466's self-contained
full-world GLB export with final transforms and ordinary PBR maps. Default export
requires no compressed-texture/instancing/engine extension or external files.
Do not replace imported geometry with the procedural starter during export.

Atmosphere, fog, HDR environment illumination, exposure and the live post chain
are receiving-game responsibilities; they are not standard GLB scene settings.
Preserve their settings/source assets in the authoring project and the explicitly
requested ThreeNative source/settings handoff, with export diagnostics. All editor
cameras, gizmos and reference overlays remain excluded from game handoff and GLB;
camera export is removed from this scope. This limitation must be
visible in the export result, not an implied promise of identical lighting in any
game. The static GLB still loads and renders without ThreeNative or the sidecar.

## Scope and ownership

PRD-467 owns document/middleware validation, live activation/link, recovered UI,
selection and spatial inspection. This PRD owns narrow camera/environment/import
operations and their live consumers, with shared validators updated in sequence
when integrating. PRD-466 owns terrain conversion, collision, ocean and full-world
export. Appearance remains editable preview/game source, never engine defaults.
PRD-468 owns the explicit environment/source handoff contract; PRD-466 owns
the shared export implementation. PRD-468 AC-8 proves their consuming-game boundary.
New paths below are proposed, not shipped entry points. No generic editor, second
asset cache, hosted upload service, new engine scene format or weather framework.

## Acceptance Criteria

AC-1 through AC-6 and AC-8 are phase boxes; AC-7 proves the portable GLB handoff.
AC-8 separately proves the ThreeNative game runs without authoring dependencies
and only adopts preview appearance through an explicit handoff.
All are `local`, actor: implementing agent. Commands below are implementation
targets using the existing Vitest/playtest/packed-consumer paths, not shipped
scripts today. Every named camera/environment/import operation is public and
reachable through the live authoring session rather than an internal test helper.

- [x] AC-7 [local, actor: implementing agent]: An imported-and-edited world exports as a portable terrain asset for an ordinary game. proof: `pnpm --filter strata-terrain-preview test:terrain:export` (exit 0), not the planned `test:consumer`, which is the packed-install proof and is reported separately — Evidence: `scripts/verify-import-export.mjs` runs after the default-world export proof, from a fresh editor page on the saved document (the reopen) and a fresh viewer page. It registers a model authored in feet (with its own camera and light nodes) from a local path, adjusts it to metres, maps an imported PNG onto `bark.albedo`, places 6 instances, and saves one instance scaled 2x the way the individual gizmo does. The export names the committed revision and the file is read directly: 6 placement nodes with the final identities, the model's own two authored materials (not the starter's), every image embedded in the file (no `uri`), no `cameras`, no `KHR_lights_punctual`, and neither imported node name. A plain `GLTFLoader` game with no authoring code then loads it: every imported placement's world matrix equals the live editor's transform (1e-4), the scaled instance arrives with scale 2, the mapped image's centre pixel (255,0,255) is among the loaded maps, 0 lights, 0 cameras, and no request leaves the consumer's origin. `report.receivingGameSupplies` names lighting, sky/environment, fog, exposure, post-processing and live water/wind as carried separately, and `report.waterIds` carries the static river. The default-world part of the script had stale hard-coded counts from the forest lane (4 shared meshes, 202 meshes, 404 maps); they are now counted from the file itself. A model without UVs is refused by the exporter by name (`asset:<id>/<part>: missing/malformed uv`); the fixture carries them.

## Integration Ledger

| Capability | Real consumer path | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Camera lifecycle/focus | Controller/GUI operation → saved bookmark or live pose → actual Three.js camera | UI-only orbit access and guessed focus coordinates | AC-1, AC-2 |
| Atmosphere and look | Shared settings patch → game render source/installed atmosphere → visible live world | fixed showcase lighting or a second atmosphere solver | AC-3 |
| Model injection | GUI upload/agent local registration → project assets → compiler/ctx.assets → placed prop | closed starter catalog and transient dropped-file objects | AC-4 |
| Surface/environment images | Registered image → semantic mapping → texture/HDR loader → actual material/sky | hardwired starter textures and mismatched colour spaces | AC-5, AC-6 |
| Portable delivery | Committed document/imports → PRD-466 world exporter → vanilla game | starter substitution and environment-code portability claims | AC-7 |
| ThreeNative game handoff | Explicit export → baked data/assets plus project render source/settings → normal game entry | runtime dependence on editor JSON/server and automatic adoption of preview state | AC-8 |

## Decisions

- 2026-09-30 (João): Controller camera CRUD and camera focus are required.
- 2026-09-30 (João): Import custom GLBs and image textures, including assets
  supplied on demand through the ThreeNative asset MCP.
- 2026-09-30 (João): Atmosphere and surrounding presentation are part of the world.
- 2026-09-30 (planning choice): Reuse the shared editor session, standard Three.js
  cameras and installed atmosphere/loaders; qualify these consumer paths separately
  to preserve the three-phase/about-eight-box limit. All three PRDs are required.
- 2026-10-02 (implementing agent, owner away): live surface inputs are the props' `bark.*` and `stone.*` textures, because the editor's ground is the baked vertex-colour preview; the editor view loads starter maps from the root (`assets.basePath`); proof captures stay in run artifacts because `docs/verification` is at its evidence cap; AC-7 and AC-8 are untouched.
- 2026-09-30 (João delegated scope decision): Define exact terrain/editor/game
  responsibilities. Editor cameras are observation tools only; remove their
  optional GLB export. Preserve atmosphere controls and custom imports, but make
  game adoption an explicit baked-data/assets/render-source handoff. No runtime
  recipe/preview-settings interpreter, automatic game mutation or general editor.

## Execution Phases

### Phase 1: Controller cameras in the live editor

**Status:** DONE 2026-10-01 (commit e9d2a2055)
**Files:** proposed `packages/terrain/editor/cameras.ts`, shared document/operation
validation, recovered camera inspector/orbit integration and
`__tests__/editor-cameras.spec.ts`; extend the existing editor scenario.
**Implementation:** Add bookmarks/actual-view reads and CRUD/activate/focus through
public middleware. Reuse projection/bounds/orbit controls and stable target IDs.

- [x] AC-1 [local, actor: implementing agent]: Controller camera CRUD changes the actual live camera and survives document reload. proof: `pnpm exec vitest run packages/terrain` (42 passed, 7 files) and `pnpm --filter strata-terrain-preview test:terrain:editor` (exit 0, no assertion failures) — Evidence: `packages/terrain/__tests__/editor-cameras.spec.ts` drives the real middleware at `POST api/cameras`: create/list/get/update/delete round trip, `new TerrainEditorDocument(path)` reads both `cameras` and `activeCamera` back off disk, 14 invalid plus one stale (`409`) write leave the revision untouched with `TerrainEvaluator.prototype.evaluate` never called, and deleting the live camera returns `fallback: "editor-camera"`. `scripts/verify-cameras.mjs` (real Chromium/WebGPU) saves and activates through the GUI panel and again through the controller, observes the live pose, `fov` and a changed view (`docs/verification/visuals/strata/468-controller-camera.png`), holds a right-drag orbit across an amplitude rebake, keeps the bookmark unchanged until an explicit update, and reads both cameras plus the active id back from the server.
- [x] AC-2 [local, actor: implementing agent]: Controller focus frames the requested object or location in either projection. proof: `pnpm exec vitest run packages/terrain` and `pnpm --filter strata-terrain-preview test:terrain:editor` (exit 0) — Evidence: `editor-cameras.spec.ts` measures a framed target inside 0.9 of the clip square at 16:9, 4:3 and 9:16 with a real Three.js camera, plus an orthographic framing whose extent does not grow with the aspect. `scripts/verify-cameras.mjs` focuses one spruce instance scaled `[2.4, 0.45, 1.6]` while every sibling `inspectProps` entry stays deep-equal and the focused instance keeps its own scale, measures it inside 0.9 at 1280x720 and 860x1000 with a different derived distance each time, frames a registered reference landmark, the `terrain` region and a local point, switches to the `survey-map` orthographic bookmark and frames the world from above (`docs/verification/visuals/strata/468-orthographic-map.png`, `468-focused-prop.png`), and an unknown prop id returns `No focus target for prop 'no-such-prop'` with the pose unchanged. Not proven in the browser: the near/far pair of an orthographic *prop* framing (unit-proven in the spec; the browser proves the screen frame and the drawn map render).

### Phase 2: Editable live atmosphere and model injection

**Status:** DONE 2026-10-02 (commits fb1290530 and 309335085)
**Files:** proposed `editor/environment.ts`, `editor/assetImport.ts`, existing
document validators/inspector, preview game-owned `src/render/` and
`src/world/terrainAssets.ts`; extend existing compiler/loader wiring and scenario.
**Implementation:** Bind validated appearance settings to existing atmosphere/
lighting/ocean source. Register staged GLBs from GUI and agent-local MCP-shaped
inputs into project asset mappings. Asset import and camera implementation can
proceed independently once PRD-467's shared document contract is stable; integrate
shared validators sequentially.

- [x] AC-3 [local, actor: implementing agent]: AI and GUI atmosphere/environment edits visibly update the same live world. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` (exit 0) and `pnpm exec vitest run packages/terrain/__tests__/editor-environment.spec.ts` (2 passed) — Evidence: `POST api/environment` takes `get` / `patch` / `reset` against the saved document revision (`packages/terrain/src/editor/environment.ts`), and a patch never reaches the evaluator (spec spies `TerrainEvaluator.prototype.evaluate`: zero calls; the recipe is unchanged after a reload from disk). Invalid values (negative intensity, elevation 120, bad colour, `fog.mode: "height"` by name, unknown fields) and a stale base return 400/409 and leave the revision unchanged. `scripts/verify-environment.mjs` (real Chromium/WebGPU) reads the effective look off the scene's own lights, fog, background, renderer exposure and sea uniforms (`view.inspectEnvironment()`), not off the saved settings: a controller patch swings the sun to azimuth -60 / elevation 18 / intensity 6; a real GUI field (`#env-fog-density`) sets haze 0.006; sky/haze/sea colours change together; exposure 0.35 drops mean luminance 90.6 -> 62.2. Each change is judged by a fixed-camera capture against the capture just before it, with a no-change control beside it (a captured canvas, judged by how far its average colour moves: control 0.0001, sun 3.97, haze 144, tint 188, reset 133; the average, because a moving sea shuffles pixels without moving it); `reset` returns the scene objects to the starter values exactly. The terrain `heightSum`, `vertexCount`, the full height array, every prop matrix and `evaluationRequests` are unchanged across all of it. A second page opened on the saved document draws the saved look (persistence), and the rejected GUI and controller values leave the live look and revision untouched. Captures are taken by the run into its artifacts (`artifacts/playtest/editor/`) and not committed: `docs/verification` is at its evidence cap. Not exercised: the editor view has no atmosphere LUT, so "failed LUT work" does not exist here; `TN_RENDER_CHAIN` is not reported by this view (rendered revision is, via `inspectEnvironment().revision`). Exposure turns on three's linear tone curve only while an override is saved; absent, the starter's untoned output is restored.
- [x] AC-4 [local, actor: implementing agent]: A custom GLB enters the palette and is placed/selected in the live editor through either import path. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` (exit 0) plus `pnpm exec vitest run packages/terrain/__tests__/editor-assets.spec.ts` (6 passed, 3 of them for models) — Evidence: `POST api/assets` (`register` for the agent's local path, `upload` for GUI bytes, `adjust`, `remove`, `list`) stores each file under a content-hashed name (`models/<sha12>-<id>.glb`) in a configured assets directory and saves a document entry with sha256, bytes, bounds measured through the node hierarchy, triangle count, license/source and diagnostics. The spec proves the registration byte-for-byte (served from an immutable hash URL), idempotent re-upload (same revision), a same-name conflict refused unless `replace: true`, a unit adjustment (feet to metres) saved beside the file without editing it, and that removal drops the palette entry and keeps the file. Invalid files are named and leave the document and the stored files unchanged: not a GLB, truncated, an external buffer reference (`missing-textures.bin`), a NaN vertex, over the configured byte limit, a relative path, a symlink, and a path read requested by a page (an Origin header, 403). Imported cameras and lights are reported as inactive and never read. `scripts/verify-assets.mjs` (real Chromium/WebGPU, its own fresh page) registers a feet-authored fixture GLB from a local path with provenance, measures 7.87 m unadjusted, applies scale 1/3.28084 and sees 2.4 m with the base on the placement; imports a second GLB through the real `#asset-file` input; confirms both ids are in `view.propAssets()` and in the scatter palette; places 6 and 3 scatter instances, measures each placed tree at 2.4 m times its own scale; selects one by a real click on the imported mesh, scales it 2x through the numeric fields (one transaction, no terrain evaluation, measured 4.8 m), and a second page opened on the saved document restores both models and the scaled instance. A garbage GUI file, an external-buffer GLB, a NaN GLB, a conflicting name and a page-origin path read are each refused by name with the revision and the valid placements untouched; an explicit `replace: true` swaps the model and keeps every placement; palette removal leaves the placements to fail loudly rather than erase art. The capture stays in the run's artifacts (the tracked evidence tree is at its cap). Limits: a multi-part model is placed as parts that share one pose, and its gizmo centres on the lowest part; export of imported placements into the world GLB is AC-7 and untouched here.

### Phase 3: Image injection and explicit game handoff

**Status:** DONE — AC-5 and AC-6 (2026-10-02, c5116502a) and AC-8, the explicit game handoff (2026-10-02), are verified.
**Files:** proposed `editor/assetImport.ts` image validation/mapping, material and
environment inspectors/source, `__tests__/editor-assets.spec.ts`, existing export
integration, consumer fixture and addon agent guide; project-owned render source
and a consuming-game entry for the explicit ThreeNative handoff proof.
**Implementation:** Register surface/environment images, prepare/load with existing
colour-space-aware texture/HDR paths, preserve mappings after reload, and extend
the full-world consumer fixture rather than introducing another exporter. Add
the explicit environment/source export using the same committed revision. Keep
camera/debug state out and never overwrite existing game source implicitly.

- [x] AC-5 [local, actor: implementing agent]: Imported PBR images replace chosen live surface inputs and retain their numerical meaning. proof: `pnpm exec vitest run packages/terrain/__tests__/editor-assets.spec.ts` (6 passed, 3 of them for images and mappings) and `pnpm --filter strata-terrain-preview test:terrain:editor` (exit 0) — Evidence: images are validated from their own bytes (PNG chunk checksums and end marker, JPEG frame header and end marker, WebP container, Radiance HDR and OpenEXR headers) with the project's configurable dimension limit, and a size that block compression would reject is reported as a diagnostic; a flipped byte, a cut file, a missing end marker, an oversize header and a non-image are each refused by name with the revision and stored files unchanged. `map` / `unmap` bind a registered image to a `<surface>.<channel>` input (`surfaceSpace`: albedo is sRGB, normal, roughness, ao, height, opacity and metalness are linear); bad names, unknown images and models as surfaces are refused, a replaced asset keeps its mapping and takes a new hash-named file, and a mapped image cannot be removed until it is unmapped. `scripts/verify-surfaces.mjs` (real Chromium/WebGPU) binds this game's five live prop inputs (`bark.albedo|normal|roughness`, `stone.albedo|normal`): a PNG imported through the real file input and mapped with the row's own "Use" control, two more registered from local paths and mapped by the controller. It reads each bound texture back: the same texture object as before with a different image (so no sampler is added; the ground shader that binds 15 of 16 is untouched), the file's exact centre-pixel bytes ([255,0,255,255], [200,128,160,255], [250,250,250,255]: no colour conversion), `colorSpace` and the GPU texture format (`rgba8unorm-srgb` for the albedo, a non-sRGB format for normal and roughness). Starter requests stay at 3 through mapping, unmapping and replacement (`unmap` puts the original image back from memory), and unmapping the albedo restores the starter image identity exactly. The picture changes where the input is drawn: a boulder's pixels move by 40.98 mean abs per channel when `stone.albedo` is mapped, and a tree's trunk by 0.044 beside an exact-zero control (time is not stepped between the two frames). A second page opened on the saved document binds the same three images; replacing `tint-albedo` loads a new hash-named URL and the new pixels ([0,255,0,255]) with no starter load. An input this render source does not have (`ground-moss.albedo`) is saved and reported by name in `inspectSurfaceDiagnostics()`, never drawn, and leaves valid mappings alone. The editor's prop textures now load at all: the view sets `assets.basePath: "/"` because the page lives at `/terrain-editor/` and bare map paths resolved beneath it. Decision: the live inputs are the props' because the editor's own ground is the baked vertex-colour preview, which has no PBR textures to replace; the game's textured ground is untouched.
- [x] AC-6 [local, actor: implementing agent]: Imported environment imagery changes the actual background/illumination and remains replaceable. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` (exit 0) and `pnpm exec vitest run packages/terrain/__tests__/editor-environment.spec.ts` (3 passed) — Evidence: `environment.sky` gains `image`, `rotation`, `intensity` and a separate `lighting` group (`image`, `rotation`, `intensity`); both name registered environment or image assets, refused by name otherwise, and an asset an environment draws cannot be removed (409, "clear it first"). The game's `src/render/environmentImages.ts` loads HDR through three's `HDRLoader`, EXR through `EXRLoader` and ordinary images through `ctx.assets.texture` (sRGB), addressed through `ctx.assets.resolve`, as float data with no clamp or tone-map. `scripts/verify-sky.mjs` generates a decodable Radiance HDR in-test (a sky of radiance up to 61 and a sun blob) and an ordinary PNG, then reads the scene's own objects: the HDR background through the real `#env-sky-image` field is a texture while `scene.environment` stays empty and fill and sun are untouched (background and illumination are independent); its peak radiance reads 61.2 and its source hash equals the registered asset's. Rotation (120 degrees) rearranges the picture (mean abs 24.9 against a 0.008 control) and a lower intensity darkens it. As lighting only, the sky returns to its colour, `scene.environment` becomes the image, the hemisphere fill is 0 unless set on purpose (an explicit 0.4 is honoured) and the sun stays its own contribution, so light is not counted twice; the lit picture moves by 230.8. An HDR background with an ordinary PNG as lighting works together. Clearing both returns the scene's objects to the starter exactly. An undecodable PNG (valid container, bad data) fails by name in the view while the last valid background stays drawn, a corrupt HDR header and a missing asset id are refused before they reach the document, and selecting the valid image again recovers. Replacing `dusk-hdr` under the same id loads a new hash-named file with the new radiance (26.2) and a second page opened on the saved document draws the saved imagery. Not done: an EXR is validated by header (spec) but no decodable EXR fixture was generated, so the EXRLoader path is untested in the browser; the editor has no atmosphere LUT, so "pending LUT work" does not apply.
- [x] AC-8 [local, actor: implementing agent]: A normal ThreeNative game explicitly adopts exported appearance and runs independently of authoring. proof: `pnpm --filter strata-terrain-preview test:consumer` through a packed/install-like game fixture and the game's own browser playtest — Evidence: PASS 2026-10-02 (exit 0, ~2 min; live WebGPU nvidia/turing run, not only a loader check). `scripts/verify-game-handoff.mjs` scaffolds a real game with `create-threenative` from this checkout's built dist (template `minimal`), installed with the locally packed `@threenative/core`, `physics`, `assets`, `playtest` and CLI tarballs; `@threenative/terrain` is neither declared nor installed there, and the game's source and its shipped web bundle contain no `@threenative/terrain`, `terrain-editor`, `/api/document` or `TerrainEditorController`. The handoff is exported by the packed terrain package from the GUI-polished fixture (PRD-467 AC-8): `assets/world.glb` (105 placements, terrain, river), `src/handoff/environment.ts` (the document's saved sun, fill, sky, haze and exposure, verbatim), `src/handoff/world.ts` (baked heights and grid), plus the game's own `src/render/handoffEnvironment.ts` and `src/scenes/Handoff.ts`. It is written to an explicit destination by `writeHandoff`, which refuses any existing file: a second handoff to the same tree throws `Handoff conflict` and the game's authored files hash identically afterwards. The game typechecks, `threenative build --target web` cooks the GLB through the asset pipeline, and `playtests/handoff.playtest.json` runs against `vite preview` of the build in a headed WebGPU browser (`pass: true`, no console or network error): the cooked world holds 105 placements (the pipeline batched them into one instanced draw), the file carries 0 lights and 0 cameras, the game binds its own sun (intensity 3.2, elevation 25 degrees), fill 0.35, exposure 1.2 and exp2 fog 0.0012 from the settings, registers a 129x129 heightfield collider on an origin anchor, and the physics ray and the drawn terrain meet the ground within 0.0034 m at five points. Capture: sky-blue background, hazed terrain, river visible. A later preview edit (hills amplitude +25) exported through the same packed page changes the terrain samples while the game's authored files hash identically. Negative control: expecting exposure 2.2 fails by name (`Resource assertion failed ... path 'exposure'`). The proof found one engine defect, fixed in its own commit with a unit test (red, then green): three's GLTFExporter pads each image's buffer view, so the exported PNGs ended in zero bytes after IEND and the asset pipeline refused them (`TN_ASSETS_MODEL_TEXTURE_UNDECODABLE`); `decodeImageBytes` now drops up to three zero padding bytes and still refuses any other trailing byte. Limits, stated plainly: the addon has no handoff generator, so `writeHandoff` and the settings-to-TypeScript step are this harness's own code, not a shipped command, and the conflict rule is proven for that code only; the game's `handoffEnvironment.ts` is custom render source written for this fixture rather than copied from the preview (the addon was not touched to adopt it); the stand-in appearance is the consumer page's grey 4x4 maps, so pixels are not compared with the editor; the cooked batch does not keep per-placement identity, which a game that needs it must exclude from instancing; native and mobile were not run. The harness holds the capture lock, so it waits when another playtest is running and fails with `NOT a test failure` text if that wait exceeds its limit; rerun then.

## Verification and delivery

Browser WebGPU proves the live authoring controls. Portable output reruns the
affected PRD-466 consumer/native scenarios; platform claims stay limited to those
actually executed. Exercise public operations and visible render changes, not
only document serialization or notification counts. Use genuine behavior
red/green and existing affected checks; prose-only work uses document checks.

Run `pnpm prd:progress` before execution and after each phase. One draft
implementation PR targets `develop` from an owning-repository worktree. Keep
current results on these boxes/the PR; archive only when all eight boxes are
verified. PRD-466/467 and this PRD must all pass before claiming the full requested
integration. Planning does not authorize marketplace purchases or publication.
