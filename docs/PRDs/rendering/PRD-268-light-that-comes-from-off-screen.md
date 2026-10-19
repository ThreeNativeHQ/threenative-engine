---
prd_contract: v1
---

# PRD-268 — light that comes from off-screen: an irradiance probe volume on WebGPU

**Status: SUPERSEDED 2026-10-03 — folded into
[PRD-267](../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) at runbook row C6,
which carries this mechanism as its Phase 3 and its native gate as Phase 2. Kept in place with its
text: `docs/PRDs/AGENTS.md` archives *finished* work in `done/`, and a superseded proposal with 0
ticked boxes is not finished. The file below is PROPOSED — filed 2026-08-29, measured at `7e5a9fe1`.
PRD-266 landed as
[PRD-278](../done/PRD-278-every-template-ships-the-render-chain-and-says-what-ran.md); judged after
[PRD-269](../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md). Batch: docs/PRDs/lighting.**

**Priority:** P2 — Its irradiance probe volume, off-screen-emitter fixture and hue gate are unbuilt.
**Goal: a surface is lit by light it cannot see.** This is the one item in the batch that closes a
real gap rather than wiring an existing one, and it is the reason screen-space GI alone never reads
as Lumen.

**Complexity:** a WebGPU port of an upstream WebGL class — SH bake, atlas storage, sample node,
placement, update scheduling — plus native parity = **HIGH**. Budget it as the long pole of the
batch and land it last.

## The problem, measured at `7e5a9fe1`

### 1. Screen-space GI is blind to everything off screen, by construction

`ssgi()` marches the depth buffer. Light from behind the camera, behind a wall, or outside the
frustum contributes nothing, so panning the camera changes the lighting of surfaces that did not
move. In an interior — the case Lumen is bought for — most bounce arrives from exactly there. No
amount of `sliceCount` fixes this; it is not a quality setting, it is the technique's domain.

### 2. Upstream has the class and it does not run here

`three/addons/lighting/LightProbeGrid.js` ships in `three@0.185.1`: a 3D grid of L2 spherical-
harmonic irradiance probes with a `CubeCamera` bake, an SH projection pass, and a padded 3D texture
atlas. Its own docblock says:

> Note that this class can only be used with `WebGLRenderer`. A version for `WebGPURenderer` will
> be added at a later point.

Confirmed by its imports: `WebGL3DRenderTarget`, `WebGLCubeRenderTarget`, `WebGLRenderTarget`,
`ShaderMaterial`. The native runtime is `WebGPURenderer`-only
(`packages/runtime-native/AGENTS.md`), so the class as shipped is unreachable on desktop, Android
and iOS — and per the root charter a web-only feature is unfinished. **This is the repo-mining item
of the batch: not a vendor, a port.**

### 3. It is mechanism, so the framework owns it — and it must own none of the look

Probe placement, bake scheduling, atlas layout, GPU upload and the sample node are exactly the
plumbing every game would repeat and none should write. The game supplies volume bounds, probe
density, and when to re-bake. The game supplies nothing about colour, intensity or falloff — those
come out of the scene it already authored. It passes the charter test: a game can change the
appearance completely by changing its lights and materials, never by editing package code.

## What ships

`packages/core/src/render/probe-volume.ts`, exported from `@threenative/core`:

- **Bake** — render each probe's surroundings and project to L2 SH, on `WebGPURenderer`. Upstream's
  cubemap-plus-SH-projection path reimplemented with `three/webgpu` render targets and a TSL
  projection pass; the SH maths, the atlas padding rule (`ATLAS_PADDING = 1` per sub-volume
  boundary) and the repack layout are ported as-is, since that is the part worth taking.
- **Storage** — one padded 3D texture atlas, sub-volume per axis-split, sized from the requested
  density. The padding exists so hardware trilinear filtering does not bleed across sub-volume
  seams; drop it and the seams show.
- **Sample** — a TSL node returning irradiance at a world position, composable into the PRD-266
  chain **before** `ssgi()`, so screen-space GI adds on-screen detail on top of the off-screen base
  rather than competing with it.
- **Scheduling** — bakes are amortised across frames against the `FrameBudget` `render` phase, in
  the `ResolutionScaler` shape: a pre-registered budget, never a synchronous stall. A full bake of a
  dense volume must never land in one frame the player is watching.
- **Reporting** — probe count, atlas bytes, bake progress, and staleness (how many frames since the
  probes covering the camera were last baked), under a `TN_PROBE_VOLUME` marker.

**Deliberately static-lighting-first.** Probes bake on demand and on request, not every frame.
That is not Lumen's fully dynamic path and the docs must say so plainly rather than imply it.

**Specular fallback is a scope note, not scope.** SSR's off-screen blind spot has the same shape and
the same fix (sample the probe atlas as a rough reflection fallback). File it separately once the
diffuse volume is measured; adding it here doubles a PRD that is already the batch's long pole.

## Acceptance criteria

1. **A surface is lit by an emitter it cannot see.** A fixture scene places a saturated emissive
   panel outside the camera frustum and a neutral wall inside it. With the volume baked, the wall's
   sampled irradiance carries the emitter's hue above a pinned threshold; with the volume absent it
   does not. *Mutation:* return zero from the sample node and the spec fails on the hue delta —
   a screenshot-only assertion would not, since bloom and tonemapping can move the same pixels.

2. **It runs on `WebGPURenderer`, and nothing imports the WebGL path.** A packaging spec asserts
   `packages/core/src/render/probe-volume.ts` and its transitive imports reference no
   `WebGL*RenderTarget` and no `three/addons/lighting/LightProbeGrid.js`. *Mutation:* import the
   upstream class and the spec fails naming the symbol. This is the guard that keeps the port a
   port.

3. **Atlas seams do not bleed.** Sampling either side of a sub-volume boundary returns values
   consistent with their own sub-volume within tolerance. *Mutation:* set `ATLAS_PADDING` to `0`
   and the boundary spec fails.

4. **A bake never stalls a frame.** Baking a volume large enough to exceed the per-frame bake
   budget spreads across frames, and no single frame's `render` phase exceeds the configured
   budget by more than the pre-registered slack. *Mutation:* bake synchronously in one call and the
   frame-budget spec fails on the spike.

5. **Fail closed on malformed input.** Zero or negative density, an inverted or degenerate bounds
   box, or a density whose atlas would exceed the device texture limit throws at construction with
   the limit named — never a silently clamped volume. *Mutation:* clamp instead of throwing and the
   fail-closed spec goes green.

6. **Staleness is reported, not hidden.** Sampling probes that have never been baked reports a
   stale/unbaked state through `TN_PROBE_VOLUME`; it does not return black as though it were an
   answer. *Mutation:* drop the staleness field and the playtest reports unobservable rather than
   green.

7. **It runs on native.** A conformance case under PRD-270's process, on the desktop lane at
   minimum, or this PRD does not close.

## Out of scope

Voxel cone tracing (`compix/VoxelConeTracingGI`) — the technique that would beat this on quality
and the only shortlist entry worth revisiting later. Reopen it only when probe density is *measured*
to be the limiting factor, not before. Specular probe fallback, as noted above. Probe relighting
without a re-bake.

## Verification

`pnpm typecheck && pnpm lint && pnpm test`; the off-screen-emitter playtest on the browser lane
with the capture pasted; `pnpm visuals:ab` against a template with the volume on and off; the
native conformance case from PRD-270. Record probe count, atlas bytes and bake cost per frame in
the verification file. `pnpm build` regenerates `capabilities.json` with the probe-volume entry in
the same commit, phrased so a plain-words search — *"light bouncing from a room I cannot see"* —
finds it.
