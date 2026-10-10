# Batch — features borrowed from the Unreal Engine source

**Status: OPEN — filed 2026-10-09 against `origin/develop` at `6b18d913e`, from a read of
Unreal Engine 5.8.3 (`release` tag commit `396c9f05`). All thirteen PRDs are NOT STARTED.**

Each PRD here takes one mechanism that Unreal ships and proves in production, and rebuilds it
inside ThreeNative's rules: WebGPU and three.js, one source for browser and native host, mechanism
in `packages/`, look in generated `src/render/` source. The aim is the battle-tested behaviour, its
defaults and its failure guards, not parity with Unreal's feature list.

## What earns a place in this folder

All three clauses:

1. **The Unreal source shows the mechanism.** The PRD cites `UE 5.8.3: Engine/...:line` for the
   algorithm, the default values and the guards it copies in idea. A feature known only from
   Unreal's documentation goes to
   [the UE5 feature map](../open-world/threenative-ue5-feature-checklists-and-repository-reuse-map.md).
2. **No pending or finished PRD already owns the outcome.** Where one did, that PRD was amended in
   place instead (list below).
3. **It fits ThreeNative's rules.** The two questions, "never own the look", "auto by default" and
   "web-only is unfinished" in the root `AGENTS.md` all apply unchanged.

## The licence rule — read this before you open the Unreal source

Unreal Engine source is under the Epic Games EULA. ThreeNative is MIT.

- **Never copy Unreal code, shader code or comments** into this repository, and never paste them
  into a PR, issue or agent brief that lands here.
- **Do borrow ideas:** the algorithm, the data layout, the default values, the order of operations
  and the failure guards. Describe them in your own words and write new code.
- **Third-party code that Unreal bundles keeps its own licence.** Take it from its upstream release,
  never from the Unreal tree, and add the notice the licence asks for. Example: PRD-561 ports Sony
  Bend Screen Space Shadows from Bend Studio's Apache-2.0 release.
- Cite Unreal paths and line numbers as references. A citation is not a copy.

## How to read the Unreal source

Access to `github.com/EpicGames/UnrealEngine` needs a GitHub account linked to an Epic Games
account. A sparse, blob-less clone holds the renderer, shaders and config in about 200 MB:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/EpicGames/UnrealEngine.git "$UE_SRC"
git -C "$UE_SRC" sparse-checkout set \
  Engine/Source/Runtime/Renderer Engine/Source/Runtime/RenderCore Engine/Source/Runtime/RHI \
  Engine/Shaders/Private Engine/Source/Runtime/Engine Engine/Config \
  Engine/Plugins/FX/Niagara/Source Engine/Source/Runtime/Landscape Engine/Source/Runtime/AnimGraphRuntime
```

Keep the clone outside this repository. Re-read every cited line before you build on it: the
citations were checked on 5.8.3 and can move in a later release.

## How to work a PRD here

1. Run `engine_search_capabilities` and `engine_capability_detail` first (root `AGENTS.md`, "How
   you work"). Several Unreal ideas turned out to be shipped already; see "Already shipped" below.
2. Read the PRD's Unreal citations, then the ThreeNative files it names. Confirm the current
   behaviour before you change it: the tree moves daily.
3. Run Phase 1 first. Most PRDs here open with a measurement that decides whether the rest of the
   PRD continues. A decline is a valid result: record it under `## Decisions` and delete the moot
   boxes (rule R4 in [`../AGENTS.md`](../AGENTS.md)).
4. Follow the normal lifecycle: one draft PR per PRD, `pnpm prd:progress <file>` for the label,
   boxes ticked with their proof in the same commit as the work.
5. A PRD that finishes ahead of its siblings moves alone to `docs/PRDs/done/` with `git mv`. When
   the last one closes, the remaining folder moves whole to `docs/PRDs/done/unreal-source-borrowing/`.

## The PRDs, in recommended order

Order is value against cost. A wave can run in parallel; nothing in a later wave depends on an
earlier wave unless the "Waits on" column says so.

| Wave | PRD | Outcome | Complexity | Waits on |
| --- | --- | --- | --- | --- |
| 1 | [PRD-560](./PRD-560-height-fog-follows-the-ground.md) | Fog thickens toward the ground and glows toward the sun, at near-zero cost | 3 LOW | — |
| 1 | [PRD-571](../BLOCKED/requires-physical-device/PRD-571-exposure-meters-a-histogram-and-ignores-the-sun.md) | Exposure ignores the brightest and darkest tenth of the frame | 2 LOW | — |
| 1 | [PRD-572](../done/PRD-572-shadow-casters-sort-themselves-into-static-and-moving.md) | A moving shadow caster updates its shadow without a `trackCaster` call | 3 LOW | — |
| 1 | [PRD-567](../done/PRD-567-terrain-layers-blend-by-their-own-height.md) | Terrain layers blend by their own height maps | 3 LOW | owner confirms the core/template split |
| 2 | [PRD-561](./PRD-561-contact-shadows-from-screen-depth.md) | Small objects and feet sit on the ground (screen-space contact shadows) | 5 MEDIUM | — |
| 2 | [PRD-563](./PRD-563-the-first-frame-starts-at-the-tier-the-gpu-family-holds.md) | The first frame starts at the tier the GPU family can hold | 5 MEDIUM | — |
| 2 | [PRD-569](./PRD-569-gpu-particle-emitters-cull-and-yield-to-the-frame-budget.md) | Off-view GPU emitters stop costing; effects yield to the frame budget | 5 MEDIUM | — |
| 2 | [PRD-566](./PRD-566-terrain-lod-morphs-on-the-gpu-and-picks-by-screen-error.md) | Terrain LOD morphs on the GPU and picks its level by screen error | 3 LOW | — |
| 3 | [PRD-564](./PRD-564-the-resolution-scale-changes-without-reallocating-a-target.md) | The resolution scale changes without reallocating a target | 6 MEDIUM | its Phase 1 hitch measurement |
| 3 | [PRD-570](./PRD-570-a-character-costs-what-the-camera-sees-of-it.md) | Distant and hidden characters animate and skin for less | 5 MEDIUM | its Phase 1 cost measurement |
| 3 | [PRD-562](./PRD-562-aerial-perspective-from-a-froxel-volume.md) | Distant land takes the colour of the sky it is seen through | 4 MEDIUM | — |
| 3 | [PRD-568](./PRD-568-mobile-builds-ship-gpu-ready-astc.md) | Mobile builds ship GPU-ready ASTC, not RGBA8 | 4 MEDIUM | [PRD-VQ-01](../done/PRD-VQ-01-native-asset-capabilities.md) |
| 3 | [PRD-565](./PRD-565-multisampled-targets-stay-in-tile-memory-on-android.md) | MSAA attachments stay in tile memory on the Android host | 3 LOW | [PRD-329](../performance/critical/PRD-329-the-native-gpu-frame-matches-chrome-at-matched-pixels.md) Phase 2 (Dawn on Android) |

## Existing PRDs amended from the same read

These keep their place and their numbering. Each one gained an Unreal section, and sometimes
reworded boxes and a dated `## Decisions` entry.

| PRD | What the Unreal source added |
| --- | --- |
| [PRD-345](../rendering/PRD-345-a-backlit-subject-is-not-a-hole-in-the-sky.md) | Decision only: exposure is out of its scope, now owned by PRD-571 |
| [PRD-384](../performance/PRD-384-adaptive-resolution-gpu-headroom.md) | Comparison with Unreal's dynamic-resolution controller; the gaps point to PRD-563, PRD-564 and PRD-549 |
| [PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md) | Pool-pressure resolution bias before falling back to cached levels; cross-reference to PRD-572 |
| [PRD-538](../open-world/PRD-538-shadow-maps-redraw-only-what-streamed-in.md) | Per-page eviction and a nearest-first page budget |
| [PRD-539](../rendering/PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md) | The TSR levers not yet tried, in order, starting with 200% history |
| [PRD-VQ-08](../rendering/PRD-VQ-08-clouds-and-overhead-transmittance.md) | Three-channel cloud shadow map that serves receivers below and inside the cloud |
| [PRD-459](../open-world/PRD-459-smooth-streaming-one-admission-budget-per-frame.md) | Texture uploads charged to the admission budget; stale Phase 1 status corrected |
| [PRD-460](../open-world/PRD-460-invisible-streaming-transitions.md) | Distance-driven cull fade, timed LOD fade, re-crossing and camera-cut rules |
| [PRD-VQ-10](../performance/PRD-VQ-10-texture-mip-residency.md) | Wanted mips from screen size, drop order over budget, no in-place shrink on WebGPU |
| [PRD-493](../open-world/PRD-493-terrain-layers-past-sixteen-textures.md) | Cross-reference to PRD-567 |
| [PRD-316](../rendering/PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) | Culling and budget points that PRD-569 must respect |
| [PRD-486](../open-world/PRD-486-characters-get-a-lod-chain.md) | Per-LOD required bones and posed-bounds culling |

## Already shipped, or declined — do not file again

- **Already shipped:** GPU-driven cull and LOD into indirect draws (`world-gpu-scene.ts`), the
  virtual-shadow clipmap with page cache and invalidation, pipeline warm-up and the native pipeline
  disk cache, Catmull–Rom history sampling (PRD-455), and the LUT colour grade (PRD-492).
- **Declined on measurement:** HZB occlusion culling. PRD-489 closed on 2026-10-06 with a median
  would-cull share of 0.013.
- **Declined by rule:** Niagara's graph editor and module stack (an editor and an IR are closed),
  RDG, bindless, async compute and heap aliasing (no WebGPU API), Nanite landscape, runtime virtual
  textures, and the mobile tonemap subpass (off by default in Unreal itself).
- **Declined in PRD-460:** stencil LOD dither.
