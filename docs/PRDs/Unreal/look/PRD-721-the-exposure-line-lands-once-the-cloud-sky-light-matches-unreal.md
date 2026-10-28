---
prd_contract: v1
---

# PRD-721 — The exposure line lands once the cloud sky light matches Unreal

**Status:** IN PROGRESS
**Priority:** P1 — the default look cannot ship until the exposure line lands: PRD-632's L1 and L9 checks need it, and it is held today because sunlit-room locks and ratchets break (Phase 3).
**Complexity:** 4 (MEDIUM) — about 8 harness and core files (+2), the shared cloud and sky-light capture state that every scene reads (+2); risk override: the line moves every locked scene and layer, so every lock and ratchet is checked
**Owner:** João
**Depends on:** [PRD-632](PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md) (the exposure line is its Phase 2 work) and [PRD-633](PRD-633-the-sky-is-an-atmosphere-and-it-lights-the-scene.md) (the cloud deck and the sky capture)

## Context

The exposure line is `lane/skylight` 373c26507. It replaces the pi-sized fixed exposure with Unreal's 2.4, which comes from the calibration constant and the exposure compensation (UE 5.8.3: Engine/Source/Runtime/Engine/Private/SceneView.cpp:2060-2066, Engine/Source/Runtime/Engine/Private/Scene.cpp:517-520, Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessEyeAdaptation.cpp:810-820). It also adds a cloud ambient term and an opt-in per-pixel sky trace.

On the reference scene the line passes: both Sky locks and the LitFloor lock hold again, the total distance to Unreal falls from 10.79 to 9.56 over 5 runs, and the judge reads NEUTRAL on Sphere_Chrome (#541 comments 6351374778 and 6351693270).

On `gi:sunlit-room` it fails the lock policy. Measured by exposure-lane on 2026-10-22, with the sRGB PNGs decoded to scene-linear values first:

- At L7-high, sun15-leak Floor and Ceiling break, at colour difference 2.3 and 2.8 against bounds of 0.50 and 0.42. The ratchets cut at 340abbffd break too: sun15-door Back_Head at 4.99 against 2.03, and Back_Left at 6.18 against 2.14. Six L9 rows break, 1-8% past their bounds.
- The room reads 0.52-0.77 of Unreal at L7-high with a sun at 60°. The old pi exposure made every sunlit term 1.31x too bright, and that hid the gap.

The cause has three parts. Each one is measured at sunlit-room L7-low, where only the unoccluded sky light reaches the frame:

1. **(B) The cloud term, the main part.** The clear sky light reads 0.83-1.06 of Unreal. Unreal's clouds add 125% to the clear upward sky light at sun60, and ours add 47%. So our cloud term is 0.41-0.74 of Unreal at sun60 and 1.14-1.37 at sun15: its response to the sun elevation is wrong. Proof: one Unreal render with `r.VolumetricCloud=0` against ours with `?off=clouds`. At sun60 the sky light carries 26-59% of the indoor light.
2. **(A) The lower hemisphere.** Our sky light is black below the horizon. Unreal's template SkyLight sets `lower_hemisphere_is_black=false` and captures the lit ground and the height fog (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/ReflectionEnvironmentRealTimeCapture.cpp:919-960). Our L7-low ceiling reads 0.00, against Unreal's 0.17.
3. **(C) Bake convergence.** 5 bake passes reach about 87% of the converged series (1 pass against 5 passes measured). Cornell has no sky and reads over Unreal (a wall at 1.30), so this part is small and must not push cornell higher.

Ruled out: the cloud ground contribution (`m_SimpleVolumetricCloud` does not set it), and the bounce passes as the main lever.

No captured pose sees the sky above about 21° of elevation, so no Sky lock can see the cloud term. Only the indoor frames show it.

Files read: `scripts/unreal-look/scaffold/render/{clouds,exposure,sky,giCache}.ts`, the lock board (`~/.cache/tmp-tn/epic-tools/lock-board.md`) and exposure-lane's handoff (`~/.cache/tmp-tn/exposure/NEXT.md`, with `regions.py` and the capture arms).

## Solution

1. Port Unreal's cloud lighting rule for the sky-light capture, so that the cloud term follows the sun elevation the way Unreal's does. Candidates, in order: the shadow march at a grazing sun, the multiple-scattering octaves, and the sky ambient on clouds. Find the term in `clouds.ts` `bakeCloudRadiance` and in the GPU cloud node. Cite Unreal paths only, and copy no Unreal code.
2. Take the lower hemisphere from exposure-lane's 625142712: the height fog in the sky-light capture, with its spec on the 2.4 units.
3. Close the bake gap only as far as cornell allows.
4. Rerun the full receipt for the combined line. Every lock that breaks gets the 3-part receipt: no judge regression in that frame, a smaller total distance over that scene and layer, and the lock re-cut in the same commit. No ratchet may regress.

The owner rule of 2026-10-22 applies: Unreal defaults are the engine default. A SkyLight or cloud default that a new scene gets goes in `packages/core`, and the harness takes it from there.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Cloud term of the sky light | `clouds.ts` `bakeCloudRadiance` → the sky-light capture every scene reads | Corrects the sun-elevation response | Phase 1 |
| Lower hemisphere of the sky light | the sky-light capture → height fog and lit ground below the horizon | Replaces the black lower hemisphere | Phase 2 |
| Exposure 2.4 | `exposure.ts` (`lane/skylight` 373c26507) → every harness frame | Replaces the pi exposure | Phase 3 |

## Execution Phases

#### Phase 1: The cloud term follows the sun elevation
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/clouds.ts`, the GPU cloud node, a spec under `scripts/__tests__/`
- [ ] A spec fails on today's cloud term and passes with the fix: the ratio between the cloud term at sun60 and at sun15 matches Unreal's within 15%. proof: `pnpm exec vitest run <the new spec>`.
- [ ] At sunlit-room L7-low, the cloud term reads 0.85-1.15 of Unreal at sun60 and at sun15, in every region. proof: the capture arms and `regions.py` from `~/.cache/tmp-tn/exposure/NEXT.md`, 2 runs per arm.

#### Phase 2: The lower hemisphere and the bake
**Status:** NOT STARTED
**Files:** the sky-light capture (625142712), `scripts/unreal-look/scaffold/render/giCache.ts`
- [ ] At sunlit-room L7-low, the ceiling reads at least 0.85 of Unreal. proof: `regions.py` on the L7-low arms, 2 runs per arm.
- [ ] At sunlit-room L7-high, every region reads 0.85-1.15 of Unreal at sun60, and no cornell wall moves further from Unreal. proof: `pnpm unreal-look:compare --scene gi:sunlit-room --layer L7` and `--scene gi:cornell --layer L7`.

#### Phase 3: The exposure line lands
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/exposure.ts` (`lane/skylight` 373c26507), the re-cut locks
- [ ] Every lock holds, or has the 3-part receipt with its re-cut in the same commit, and no ratchet regresses. proof: `pnpm unreal-look:compare --check` over the reference scene L0-L9, gi:sunlit-room, gi:cornell and gi:neon-corridor (fixed-phase capture, 2 runs per arm, 5 at L9 when two runs differ by more than 0.002).
- [ ] A fresh judge reads IMPROVEMENT or NEUTRAL in every frame against BEFORE, with the Unreal frames as the target, and the sheet is posted on #541. proof: the judge verdict and the #541 comment link.
- [ ] The line is merged on the epic. proof: the `merge-log.txt` line.

## Decisions

- 2026-10-22 (team-lead): the exposure line stays held until Phase 3 passes. The templates switch to auto exposure with Unreal metering (PRD-632) without it, because the fixed 2.4 constant does not set a template frame under auto exposure.
