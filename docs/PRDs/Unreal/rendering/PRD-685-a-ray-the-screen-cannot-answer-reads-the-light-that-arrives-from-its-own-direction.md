---
prd_contract: v1
---

# PRD-685 — A ray the screen cannot answer reads the light that arrives from its own direction

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: the probe field keeps only irradiance, and no measurement says how much of the `cornell` `Box_Short` error a directional read of the same probes removes.
**Complexity:** 7 (HIGH) — 6–10 files: the radiance atlas, the filter, the sampler, two consumers, specs, one conformance scene (+2), new GPU data and a new sampler (+2), state across frames: radiance generations beside the SH generations (+1), native proof (+1), three consumers with different render paths (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the traced refresh: its 64 rays per probe fill the radiance octahedron). [PRD-604](PRD-604-a-surface-is-lit-only-by-probes-that-can-see-it.md) Phase 2 (the distance atlas shares the same rays). PRD-640 Phase 2 (`docs/PRDs/Unreal/gi/PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md`, on `feat/unreal-look-epic`): the first consumer. Coordinates with PRD-642 Phase 3 and PRD-643 Phase 2 on the same branch (`docs/PRDs/Unreal/gi/PRD-642-glossy-surfaces-reflect-what-the-camera-cannot-see.md`, `docs/PRDs/Unreal/gi/PRD-643-glass-fog-and-leaves-take-the-bounce-light-too.md`), which read the same cache.

## Context

**Unreal LOC:** 1,885 lines: radiance storage, spatial filter, mips and irradiance (641 lines of
`LumenRadianceCache.cpp` and `LumenRadianceCache.usf`), the interpolation with parallax correction
(610 lines, `LumenRadianceCacheInterpolation.ush` and `.h`) and the translucency radiance cache (634
lines, `LumenTranslucencyRadianceCache.cpp` and its mark shaders). **Port estimate:** about 400 to
600 ThreeNative lines. The trace, the clipmap rings and the visibility weights belong to PRD-603 to
PRD-605. This PRD changes what a probe stores and how a direction reads it.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A probe stores radiance per direction, not only irradiance.** Each radiance cache probe keeps an
  octahedral radiance map of 32 × 32 texels at Epic and 16 × 16 at High
  (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp:641-647`;
  `Engine/Config/BaseScalability.ini:434`, `:387`). Irradiance is computed from that radiance for the
  consumers that need only irradiance (`Engine/Shaders/Private/Lumen/LumenRadianceCache.usf:1140`).
- **The trace density follows the BRDF.** Screen probes scatter their BRDF into the radiance probes
  around them (`LumenRadianceCache.usf:307`). Trace tiles whose BRDF is above 0.1 trace at a higher
  density, and probes beyond 40 m always trace at a lower one
  (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenRadianceCache.cpp:93`, `:108`;
  `LumenRadianceCache.usf:377`, `:549`).
- **Neighbours filter each other.** A spatial filter blends a probe's radiance with its neighbours'.
  It is on by default and rejects a neighbour's ray whose hit point is seen at more than 0.2 degree
  apart (`LumenRadianceCache.cpp:46-49`, `:69`; `LumenRadianceCache.usf:1004`).
- **Borders and a mip.** A border pass makes the octahedron filter cleanly, and a mip chain serves
  wide cones (`LumenRadianceCache.usf:1416`; one mip level by default at
  `LumenScreenProbeGather.cpp:650-651`).
- **The read corrects for parallax.** A ray reads the eight corner probes of its clipmap cell. For each
  probe, the ray is extended to a sphere of 1.5 times the probe's minimum trace distance around it,
  and the probe is read in the direction of that point (`Engine/Shaders/Private/Lumen/LumenRadianceCacheInterpolation.ush:332-401`;
  the 1.5 scale at `LumenScreenProbeGather.cpp:663`). The cone angle picks the mip
  (`LumenRadianceCacheInterpolation.ush:444`). A ray must first travel the probe's minimum distance
  plus the cell occlusion distance before it reads the cache (`LumenRadianceCacheInterpolation.ush:179-190`).
- **Glass reads the same kind of cache for its reflections.** Translucent surfaces get their Lumen
  reflections from a radiance cache by default (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenTranslucencyRadianceCache.cpp:13-17`).
  The surfaces mark the probes they need at a quarter resolution (`:21-25`), and the read treats
  the light as more distant, with a reprojection scale of 10 (`:37-41`). The higher-quality front
  layer pass is off by default (`Engine/Config/BaseScalability.ini:546`).

### ThreeNative today

- `ProbeVolume` (`packages/core/src/render/probe-volume.ts`) stores L2 spherical-harmonic irradiance
  in seven packed sub-volumes. A direction can read irradiance about a normal, not radiance along a
  ray.
- PRD-640 Decisions (2026-10-20) measured the cost of this. `Box_Short` faces the open front of
  `cornell`, and its rays leave through it. Unreal returns black there. ThreeNative's miss keeps the
  cache average and reads 101 against Unreal's 58. A per-ray read of the irradiance cache 0.5 to 2 m
  ahead moved the frame by 0.14 levels only. That decision says: "The miss tier needs directional
  radiance."
- PRD-642 Phase 3 plans to read "specular from the radiance cache in the reflected direction, widened
  by roughness". An SH irradiance field cannot answer that read.
- PRD-643 gives translucent pixels the irradiance of the cache. Their specular still reads the sky
  environment, so a glass pane indoors reflects the sky.

## Solution

**The gate first (Phase 1), on the CPU.** The harness bake (`scripts/unreal-look/scaffold/render/giCache.ts`)
already traces rays per probe on the CPU. Add an 8 × 8 octahedral radiance map per probe from the same
rays. Let a missed gather ray read it along its own direction with the parallax correction above.
Compare `cornell` L7 against Unreal Epic with and without the directional read. **Continue** only if
`Box_Short` or the slot between `Box_Tall` and `Wall_Red` moves toward Unreal by more than the
two-run noise floor, and no region moves away by more than that floor. Otherwise record the result
under `## Decisions` and delete Phases 2 and 3 (R4).

**Phase 2, the radiance atlas.** When `ProbeVolume` traces (PRD-603), it also writes the rays into an
octahedral radiance map per probe: `probeResolution` texels per side (start value 8, which is the
64 rays PRD-603 already casts) plus a one-texel border, in `rgba16float`, with one mip. A neighbour
filter with Unreal's hit-angle guard smooths it. The SH coefficients stay and are computed from the
same rays, so `sampleNode` does not change. A new `sampleRadianceNode(position, direction, coneHalfAngle)`
reads the eight corner probes with the parallax correction, the PRD-604 visibility weights, and a
mip from the cone angle. It answers nothing to a ray that has not yet travelled the minimum distance.

**Phase 3, the consumers.** The PRD-640 miss tier calls `sampleRadianceNode` instead of the
irradiance read. Translucent materials read their glossy specular from it, as Unreal's default
translucency reflections do. The PRD-642 rough specular can use the same call; that PRD keeps its own
box.

**Memory is auto-sized.** A room volume of 676 probes at 8 × 8 plus border costs about 0.5 MiB. The
PRD-605 rings hold about 28,000 probes, so the radiance atlas there would cost about 22 MiB. The
volume therefore sizes `probeResolution` and the number of rings that keep radiance from the PRD-605
byte budget. Coarse rings keep SH only, and the report says which rings have radiance.

**Names.** `probeResolution` is Unreal's name (`r.Lumen.ScreenProbeGather.RadianceCache.ProbeResolution`).
The manifest entry gains `@alias lumen radiance cache`, `@alias radiance probes` and
`@alias translucency reflections`. `TN_PROBE_VOLUME` adds the radiance resolution, the radiance
bytes and the rings that keep radiance.

**Where it lives.** The atlas, the filter and the sampler are mechanism in `packages/core/src/render/`
beside `probe-volume.ts`. How a material uses the radiance (the glass Fresnel, the specular strength)
stays in the game's material and the template's `src/render/`.

## Acceptance Criteria

- [ ] AC-1 [local]: `Box_Short` and the slot region of `cornell` match Unreal Epic within the PRD-631 thresholds at L7, with no other region worse than before. proof: `pnpm unreal-look:compare --scene gi:cornell --layer L7` — Evidence: pending.
- [ ] AC-2 [local]: The directional read adds at most 0.5 ms GPU time at 1920 × 1080 on the RTX 2080 over the irradiance read. proof: the frame budget's SSGI stage time, interleaved as in PRD-644 — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `probe-volume-radiance` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests probe-volume-radiance` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Octahedral radiance per probe | `ProbeVolume` with `trace`, every refresh | New data beside the SH atlas | Phase 2 |
| `sampleRadianceNode` for a missed ray | The PRD-640 miss tier on `high` | Replaces the irradiance read for a missed ray | AC-1 |
| Glossy reflections on translucent surfaces | Translucent node materials | Replaces the sky's prefiltered specular indoors | Phase 3 |

## Execution Phases

#### Phase 1: Does a directional read fix the open-front box
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/giCache.ts` (measurement only)
- [ ] The L7 per-region change on `cornell` from the CPU directional read is recorded under `## Decisions` with the gate verdict. proof: `pnpm unreal-look:compare --scene gi:cornell --layer L7`, irradiance read against directional read, 2 runs per arm.

#### Phase 2: The radiance atlas and its sampler
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/src/render/probe-radiance.ts` (new), `packages/core/__tests__/probe-volume.spec.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A probe lit by one bright direction returns that light along that direction and near zero opposite it, and its SH irradiance equals the old output within 1%. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] With parallax correction, a ray that starts off the probe centre reads the direction to its sphere point, and a ray shorter than the minimum distance reads nothing. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] The volume reports radiance bytes per ring and drops radiance on the coarse rings when the byte budget needs it. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] A capability search for "lumen radiance cache" returns `ProbeVolume`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: The miss tier and the glass read it
**Status:** NOT STARTED
**Files:** the PRD-640 gather module, `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/probe-volume-radiance.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A fresh visual judge on `cornell` and the `foliage` glass pose (BEFORE the irradiance read, AFTER the directional read, Unreal Epic as the target) returns IMPROVEMENT with no REGRESSION frame. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent.
- [ ] The conformance row `probe-volume-radiance` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests probe-volume-radiance`.
**Verification:** AC-1 to AC-3.
