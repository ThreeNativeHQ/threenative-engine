# PRD-397 — Build-time content pipeline: atlas, material dedupe, instancing, static merge

**Status:** Phases 1-2 landed, **Phase 2's falsification box fired**, and a native measurement has
since re-priced the whole PRD. The atlas is real, tested and deterministic; the census it exists
to enable was run against the reference game's own 29 models and says the atlas is unavailable on
the model the hypothesis rests on (209 -> 176 singletons, 16%, against a PRD that opened claiming
4-5x). The engine then turned out to do this already at runtime: 1,561 authored meshes collapse to
**3 draws, 9.98 ms -> 2.31 ms, 4.3x**, with no build step. A build-time merge therefore competes
with a runtime collapse that already handles repeated geometry and material, and can only win on
the residue — which is the case the census measured as small. At **8.9 µs/draw**, removing every
one of the reference game's 573 draws is a ~5.1 ms ceiling; the realistic figure is under 1 ms.
**Phases 3-4 are not started**, because building a merge on a falsified premise is the failure
this PRD was written to avoid. Its load-time and memory case is untouched by all of this.
**Complexity:** 7
**Owner:** unassigned
**Depends on:** PRD-395 complete (the published µs/draw figure is what this PRD is priced
against). PRD-396 is **not** a dependency — they touch disjoint code and can land in either
order — but if PRD-396 has landed, its numbers are the baseline this PRD measures from.
**PR:** (open as draft before Phase 1) — label `prd:0`

**Priority:** P1 — Open: static merge bounds and instancing transform parity; measured 573 draws per frame.
## Problem

573 draws/frame (main 158, shadow 364, reflection 51) for 1.04M triangles is **~1,815
triangles per draw**. The scene is 1,561 meshes. A GPU that finishes in 1.9 ms is being fed
by a CPU that takes 16.1 ms to describe the work.

Content census:
- Carrier: **95 meshes, 76 materials, 73 distinct texture sources** — one texture per material.
- Destroyer: 2 meshes each.

A runtime per-material merge (`mergeParts`) was tried: it found **274 buckets with 213
singletons**, replaced **246 of 1,561** meshes, and **moved no frame time** (46.5 fps vs
48–51 without — inside the spread).

That result is usually read as "content doesn't matter." It is the opposite. The merge found
213 singletons because 73 distinct texture sources per carrier means *materials cannot be
deduplicated while each one owns a private texture*. A per-material merge over
one-texture-per-material content has almost nothing to merge by construction. **The atlas is
the prerequisite, and the failed experiment is the evidence for it.** Merge without atlas is
the null result we already have.

Target: **1,561 → 300–400 objects, 573 → 150–200 draws, 4–7 ms recovered, low risk** —
because every transformation happens at build time, producing generated game source and
generated texture artifacts. No runtime semantics change. Helps browser equally.

## Scope / Non-goals

**In scope**
- Build-time texture atlas packer with UV rewrite, deterministic, in `packages/<tools>`.
- Build-time material dedupe *after* atlasing, keyed on the post-atlas material signature.
- Build-time static merge across deduplicated materials, replacing `mergeParts`.
- Build-time instancing for repeated props (destroyers at 2 meshes each, aircraft, crates).
- Screenshot parity gate between pre-pipeline and post-pipeline builds.
- Regenerated midway game source and texture artifacts as the shipped output.

**Non-goals — explicitly refused here**
- **No runtime merging, atlasing or deduplication.** `mergeParts` at runtime is deleted or
  left unused, not extended. If a transformation cannot be done at build time it is not done.
- **Ranked option 5 (GPU-driven culling / indirect draws upstream in three.js) is not taken.**
  It depends on this PRD and is 2–4 ms at high effort; it gets its own PRD only after this
  one publishes the post-pipeline draw count and per-draw cost.
- **Ranked option 3 (shadow lane) is not taken.** Shadow draws fall here only as a side
  effect of fewer objects. Per-light caster culling, cascade reduction and static-light
  throttling remain unstarted; the 856 shadow-caster-exempt objects keep their exemption.
- **Ranked options 4, 6, 7** are not taken and not prepared for.
- No appearance changes shipped from `packages/`. Atlas layout decisions and merge groupings
  ship as generated game source and generated artifacts; `packages/` holds only mechanism.
- No lightmap baking, no LOD generation, no mesh decimation. Triangle count is a
  non-target — 1.04M triangles at 1.9 ms GPU is not a problem and must not be "fixed."

## Phases

### Phase 1 — Deterministic atlas packer + UV rewrite

- [x] Files wired: `packages/assets/src/atlas/packer.ts` — shelf-packs sources into pages, emits a
      sorted manifest and a per-source UV transform. The packing order is derived from the sources
      (taller, then wider, then key) rather than inherited from the caller, because the caller's
      order is a directory listing. Page bounds are checked for every placement, not only at the
      start of a shelf, so the invariant does not rest on the sort.
- [x] Files wired: `packages/assets/src/atlas/rewrite-uvs.ts` — rewrites a UV buffer onto its page
      in place, with the tiling policy stated and separated: `uvsTile` reads the geometry,
      `wrapTiles` reads the sampler, `resolveSourceTexel` is the inverse a test can round-trip
      through. A tiling source is excluded and reported, never clamped.
- [x] Required test passing: `atlas.deterministic` — the same inputs in reversed order produce a
      byte-identical manifest. Result: `npx vitest run packages/assets/__tests__/atlas.spec.ts` →
      0 (15 tests)
- [x] Required test passing: `atlas.uv-roundtrip` — a sampled texel through the rewritten UV
      resolves to the same source texel; every rewritten coordinate stays inside its own page.
      Result: `npx vitest run packages/assets/__tests__/atlas.spec.ts` → 0
- [x] Required test passing: `atlas.rejects-tiling` — a tiling source is excluded and reported, a
      source larger than a page is excluded rather than scaled, and a zero dimension throws rather
      than dividing by itself.
      Result: `npx vitest run packages/assets/__tests__/atlas.spec.ts` → 0
- [x] Observed red: removing the derived sort turns `atlas.deterministic` red
      (`AssertionError: expected '{ "excluded": [] …' to be '{ "excluded": [] …'`) — **and it also
      turned the overlap test red**, which found a real bug: a shelf could overflow the page when
      the first item on it was not the tallest. The bounds check now runs per placement, so the
      packer is correct for unsorted input too and only the determinism test depends on the order.
- [x] User verification: carrier atlased. Baseline **73 distinct texture sources** → result **0
      atlas pages, 73 of 73 sources excluded as tiling**. `hornet.glb` is 94 meshes, 75 materials
      and 73 texture sources, and **all 94 of its primitives sample outside the unit square** — its
      UV range is `[-18.375, 18.625]`. Command:
      `pnpm census:content /home/joao/projects/threenative/sandbox/midway-open-pacific/public/assets`

### Phase 2 — Post-atlas material dedupe

- [x] Files wired: `packages/assets/src/content/dedupe-materials.ts` — a signature over post-atlas
      material state. It deliberately ignores the material **name**, which is the field that made
      every imported part its own bucket, and keeps materials apart on any field it does not
      understand, because an unknown difference is a reason not to collapse.
- [x] Files wired: `packages/assets/src/content/census.ts` and `pnpm census:content <dir>` — reads
      geometry and materials only, reports the buckets as authored and again with every atlasable
      texture repointed at a page. No GPU, no runtime, no game, which is why this number was
      obtainable while the frame lane was not.
- [x] Required test passing: `dedupe.signature-distinguishes` — two materials differing only in a
      non-atlas uniform do not collapse; three differing only in the private texture the atlas
      replaced collapse from 3 buckets to 1; a material whose source the atlas excluded keeps its
      own texture and stays a singleton.
      Result: `npx vitest run packages/assets/__tests__/atlas.spec.ts packages/assets/__tests__/content-census.spec.ts`
      → 0 (19 tests)
- [x] Observed red: this one did not need forcing — the census's **first** tiling policy read the
      sampler's wrap mode, and glTF's default wrap is `REPEAT`, so it excluded **214 of 220**
      sources and reported that atlasing changed nothing. That is a false negative that would have
      killed the atlas on a measurement error. The policy now reads the geometry's own UVs, and a
      `REPEAT` sampler whose surface stays inside the unit square packs normally.
- [x] User verification: carrier material count. Baseline **76 materials** → result **75
      materials, unchanged by atlasing**, because none of its textures can be packed.
- [x] User verification: scene-wide material count. Measured across the reference game's 29
      shipped models: **232 materials over 426 meshes and 326 distinct texture sources**.
- [x] User verification: merge-bucket singleton count, the direct comparison against the failed
      runtime experiment. Result: **220 buckets / 209 singletons → 192 buckets / 176 singletons**,
      with **159 of 326 sources excluded as tiling**.

      **This box is the falsification point, and it fired.** 209 → 176 is a 16% reduction in
      singletons, not the collapse the 4-5x object and draw reduction is priced on. The census
      says exactly where it splits, and the split is not subtle:

      | model | meshes | materials | sources | buckets | singletons | tiling |
      |---|---:|---:|---:|---:|---:|---:|
      | `hornet.glb` (the carrier) | 94 | 75 | 73 | 75 → 75 | 75 → 75 | 73 of 73 |
      | `akagi.glb` | 146 | 36 | 33 | 34 → 26 | 32 → 22 | 23 of 33 |
      | `aircraft.douglas-sbd3.glb` | 23 | 21 | 61 | 21 → **4** | 21 → **3** | 0 of 61 |

      Where the UVs stay inside the unit square the atlas does exactly what this PRD predicted —
      the SBD collapses 21 materials into 4 buckets and 21 singletons into 3. Where they do not, it
      cannot be applied at all, and the carrier is the model the hypothesis was built on: all 94 of
      its primitives sample outside `[0, 1]`, over a UV range of `[-18.375, 18.625]`, and `akagi`
      reaches `[-166.5, 167.6]`.

      **So the prerequisite has a prerequisite.** The atlas is not the first step for this content;
      a UV re-unwrap is, and the repository already carries the dependency for it (`xatlasjs`, used
      today by the lightmap pass). That is a different change with a different risk profile — it
      rewrites authored UVs, so it needs the screenshot parity gate this PRD's Phase 4 describes,
      on a lane that can render. Phases 3-4 are re-priced against that, not against the 4-5x this
      PRD opened with.

### Phase 3 — Static merge and instancing

**Not started.** Phase 2's falsification box fired: on the reference game's dominant model the
atlas cannot be applied, so a merge over deduplicated materials has the same nothing to collapse
that the runtime experiment already found. Building it now would reproduce that null result at
build time instead of at runtime. The order changed, and the PRD says so rather than a commit
message: re-unwrap first, then atlas, then merge.

- [ ] Files wired: `packages/<tools>/src/content/StaticMerge.ts` — merges static meshes
      sharing a deduplicated material, preserving per-object bounds for culling.
- [ ] Files wired: `packages/<tools>/src/content/Instancing.ts` — repeated props emitted as
      instanced draws with per-instance transforms.
- [ ] Required test passing: `npm test -- merge.preserves-bounds` — a merged group's child
      bounds still cull individually where the generator says they should.
      Result: `<command>` → `<exit code>`
- [ ] Required test passing: `npm test -- instancing.transform-parity` — instanced transforms
      match the pre-instancing per-object matrices elementwise to 1e-6.
      Result: `<command>` → `<exit code>`
- [ ] Observed red: `instancing.transform-parity` failed at `<sha>` on a mirrored-scale
      prop; `<msg>`.
- [ ] User verification: carrier mesh count. Baseline **95 meshes** → result `<n>`.
- [ ] User verification: destroyer draw count. Baseline 2 meshes each, `<n>` destroyers →
      result `<n>` draws total.

### Phase 4 — Regenerate midway, screenshot parity, measure

**Not started**, for two independent reasons, either of which is sufficient. The pipeline has
nothing to regenerate midway *with* until Phase 3 exists, and the screenshot-parity gate and every
frame-time row here need a machine that can render the reference game — the same VRAM tenant
recorded in PRD-395 Phase 1 holds that lane.

- [ ] Files wired: midway's generated game source and texture artifacts regenerated through
      the pipeline; the generator step is in the build, not a one-off script.
- [ ] Files wired: `tools/screenshot-parity.ts` — fixed camera set, pre- vs post-pipeline
      builds, per-pixel and SSIM comparison.
- [ ] Required test passing: `npm test -- parity.screenshots` — every camera in the fixed set
      is within the declared threshold. Result: `<command>` → `<exit code>`, worst SSIM `<n>`
- [ ] Observed red: parity failed at `<sha>` at camera `<n>` with SSIM `<n>` from an atlas
      bleed at page edges; fixed by `<n>`-texel padding. Paste output.
- [ ] User verification: scene object count. Baseline **1,561 meshes** → result `<n>`.
      Target 300–400.
- [ ] User verification: main-pass draws. Baseline **158** → result `<n>`.
- [ ] User verification: shadow-pass draws. Baseline **364** → result `<n>`.
- [ ] User verification: reflection-pass draws. Baseline **51** → result `<n>`.
- [ ] User verification: triangle count. Baseline **1.04M** → result `<n>` (must not rise
      by more than 5%; merging must not duplicate geometry).
- [ ] User verification: native desktop render-phase p50. Baseline **16.1 ms** → result `<n>`.
- [ ] User verification: native desktop frame p50. Baseline **20.2 ms** → result `<n>`.
- [ ] User verification: GPU p50. Baseline **1.57 ms** → result `<n>` (atlasing may raise
      it; anything under 8 ms is still ~2x under budget and acceptable).
- [ ] User verification: browser WebGPU render-phase p50. Baseline `<record>` → result `<n>`.
- [ ] User verification: total texture bytes shipped. Baseline `<record>` → result `<n>`
      (atlasing must not balloon download size by more than 20%).
- [ ] User verification: Android hardware render-phase p50.
      Blocker: Android hardware rows open on PR #275. Does not gate Acceptance.
- [ ] User verification: iOS hardware render-phase p50.
      Blocker: same as Android.

## Acceptance criteria

- [ ] Scene object count falls from 1,561 to ≤400.
- [ ] Total draws fall from 573 to ≤200.
- [ ] Triangle count does not rise more than 5% above 1.04M.
- [ ] Native desktop render-phase p50 improves by **≥4.0 ms** against its baseline at the
      time this PRD starts.
- [ ] Browser WebGPU render-phase p50 improves by ≥4.0 ms against its recorded baseline.
- [ ] Screenshot parity passes on every camera in the fixed set.
- [x] Atlas output is byte-identical across two builds.
      Proven at the packer: the same sources in reversed order produce an identical manifest, and
      removing the derived sort turns that test red.
      `npx vitest run packages/assets/__tests__/atlas.spec.ts` → 0
- [ ] Post-atlas merge singleton count is materially below 213 (the box in Phase 2 carries
      the number). **Measured and not met: 209 → 176 scene-wide, and unchanged on the carrier.**
      The criterion stands; the content has to change before it can be met, and Phase 2 records
      which change that is.
- [ ] GPU p50 stays under 8 ms.
- [ ] Shipped texture bytes rise by ≤20%.
- [x] No runtime merging, atlasing or deduplication exists in the shipped path. Everything landed
      here is build-time only, in `@threenative/assets`, and reads geometry and materials without a
      GPU or a running game. `mergeParts` is untouched and still the runtime option it always was.
- [ ] Every appearance-affecting decision ships as generated game source or a generated
      artifact; `packages/` contains mechanism only.

## Verification boundary

**Proven here:** that the object and draw counts of the reference game can be cut by 4–5x
at build time with pixel parity, and how much CPU frame time that buys on native desktop
and in the browser.

**The runtime already does this for the easy case, and the saving is now measured against a
control.** 1,561 authored meshes sharing one geometry and material, on the packaged native host,
with the engine's projection off and then on:

| | `renderScene` | draws |
|---|---|---|
| projection off | 9.98 ms | 1,535 |
| projection on | **2.31 ms** | **3** |

`"sourceRenderables":1562, "instancedBatches":1, "projectedObjects":1561` — **4.3x less CPU, no
build step and no game-side work.**

That reframes this PRD. A build-time merge is not competing with an unoptimised renderer; it is
competing with a runtime collapse that already handles every case where geometry and material
repeat, and it can only win where that collapse declines — which is exactly the reference game's
shape, 426 meshes carrying 232 distinct materials. The census measured that residue at 220 -> 192
buckets. **The remaining prize is the hard case by construction, and the hard case is the one the
census already showed to be small.**

**Now priced.** PRD-395 Phase 4 published **8.9 µs/draw** (7.74 µs at 629 draws, 8.90 at 2,469 —
it grows with draw count rather than staying flat), measured as `renderer.renderObjects` inclusive
over draw calls on a deterministic load-test scene. The per-draw loop is **87% of the render
phase**, so unlike PRD-396 this PRD is aimed at the right term.

The arithmetic for the reference game: 573 draws × 8.9 µs = **~5.1 ms**, an absolute ceiling
reached only by collapsing every draw to one. The census already found the achievable reduction is
far smaller — 220 → 192 buckets, 209 → 176 singletons — so **the realistic recovery is well under
1 ms**, against a 16.1 ms render phase. That does not kill the PRD, but it does re-price it: the
pipeline is worth building for load time and memory, and its frame-time case is a fraction of a
millisecond rather than the 4-5x this PRD opened with.

The strongest evidence for what batching *can* do is the load-test L3 control in PRD-395's table:
4,096 objects collapsed to 3 draws take **0.24 ms instead of 25.20 ms, 106x less CPU**. That is
the shape of the win when a scene has one shared material — and the distance between that and
midway's 232 materials over 426 meshes is exactly why the census falsified this PRD's premise.

**Not proven here:** that the recovered time matches PRD-395's µs/draw × draws-removed
prediction. If it does not, PRD-395's attribution is wrong somewhere and must be revisited
before ranked option 5 is priced — write that discrepancy into PRD-395's table rather than
opening a new PRD to explain it.

**Not proven here:** that this generalises to content the midway census does not describe.
The 73-textures-per-carrier shape is what makes the atlas the lever; a project already
sharing textures will see less.

**Not proven here:** anything about the shadow lane. Shadow draws fall here only in
proportion to object count. The 856 shadow-caster-exempt objects, per-light caster culling,
cascade count and static-light throttling are untouched and remain the next candidate PRD,
to be priced against the post-pipeline draw count this PRD publishes — not against the 364
baseline above.
