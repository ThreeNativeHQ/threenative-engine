# Repo grounding for the UE5 feature research

**Filed 2026-08-30, measured at `6adb26d4`.** Read this before either checklist document in this
folder. The checklists were written without access to this tree: they are a good statement of *what
"Done" means* for a UE5-class subsystem, and an unreliable statement of *what ThreeNative still has
to build*. This file supplies the second half — what already ships, what is already filed, and which
proposals the charter has already closed.

Nothing here weakens the checklists' Definition of Done. A feature that ships here still owes the
same evidence. What changes is the starting line.

## 1. Three defects in the research as filed

**(a) Two of the three files are the same document.**
`threenative-ue5-feature-checklists-and-repo-scan.md` (2,781 lines) and
`threenative-ue5-feature-checklists-and-repository-reuse-map.md` (2,973 lines) share the same
title, version, snapshot date, F-numbering, ranking table, Definition of Done and phase plan.
Ignoring whitespace they differ by 568 lines in one direction and 760 in the other — the reuse-map
adds the *Repository-reuse decision framework* (license markers ✅/⚠️/⛔/🧊) and longer per-feature
repo prose. **Keep the reuse-map, delete the repo-scan**, or the folder ships two rankings of the
same twenty features and a reader has no way to know which one moved. Two copies of a score is two
scores.

*Note (2026-10-12): the repo-scan file was not kept in the repository. Only the reuse-map remains.*

**(b) Several features are already in the tree, so their effort estimates are wrong.**
The research ranks F17 (virtualized geometry) at effort 8–9/10 and puts it in band B — Strategic. It
landed on 2026-08-30 and is on by default (`e69c737f`); the bake, the cluster DAG and the runtime
cut are in `packages/assets/src/virtual/` (1,313 lines) and `packages/core/src/clustered-mesh.ts` +
`clustered-batch.ts` (957 lines), and the batch that produced it closed seven PRDs with two of them
**declined on measured headroom** rather than unbuilt. Section 3 does this for all twenty.

**(c) It does not apply the charter's filter, so four of its recommendations are unbuildable here.**
The binding test is not impact-over-effort. It is the two questions: *could the game write this
portably itself*, and *does it decide how anything looks*. The second is a veto over the first —
anything that decides how it looks ships as generated user source in a template's `src/render/`, at
any size, no matter how strategic. On top of that, the charter closes an ECS, an editor, a preset
system, a scene format, an IR and a bespoke CLI vocabulary **with evidence**, and says each can
absorb the entire company. The research recommends `hmans/miniplex` for F6 and
`theatre-js/theatre` for F7 without knowing either question was already settled.

## 2. Two facts the research could not know, and both change the plan

### The render chain already exists, and it is the spine every A-band feature assumed had to be built

`packages/core/src/render/chain.ts` (598 lines) ships an ordered, tiered, self-reporting post
stack:

```text
ambientOcclusion · ssgi · godRays · ssr · denoise · temporalReproject · taa · traa ·
motionBlur · sharpen · bloom · vignette · lensDistortion · sparkle · gradualBackground
```

with `high | medium | low | off` tiers carrying real parameters (denoise iterations, slice count,
step count), an `auto` request path, an MRT-or-per-object velocity source with a rejection
measurement, dropped-stage reporting, a frame-budget window, and a `TN_RENDER_CHAIN` marker that
playtests and the native diagnostics both read. F1, F2, F12 and F16 in the research are all
specified as if this had to be designed. It does not: they are **stages plugged into a chain that
already names the tier it ran**. That is a different, much smaller piece of work, and it is why the
A-band effort numbers should not be trusted as filed.

The individual nodes — `SSGINode`, `SSRNode`, `DenoiseNode`, `TRAANode`, `TemporalReprojectNode`,
`SharpenNode`, `SSAAPassNode`, `VelocityNode` — live in
`packages/create-threenative/templates/starter/src/render/worldEnvironment.ts`, i.e. **as generated
game source**, which is where the charter requires anything that decides how it looks to live. Only
the `starter` template has that file today; the other six ship `postprocessing.ts` and no
`worldEnvironment.ts`. That gap is PRD-278, first tranche landed.

### There are 5,476 lines of hardware ray tracing in the native host, deliberately switched off

`packages/runtime-native/src/raytracing/` implements BLAS/TLAS construction and `traceRays` across
**DXR (1,276 lines), Vulkan (1,540) and Metal (864)**, with HLSL, GLSL and Metal raygen/closesthit/
miss shaders and precompiled DXIL and SPIR-V headers, exposed to JS as a `mystralRT` global
(`isSupported`, `getBackend`, `createGeometry`, `createBLAS`, `createTLAS`, `updateTLAS`,
`traceRays`).

It refuses on purpose. `isSupported()` returns `false` and `traceRays()` throws
`TN_NATIVE_RAYTRACING_UNAVAILABLE` before backend dispatch, gated by PRD-198 behind **one named
missing piece: buffer-to-texture copy-out interop**
([verification](../../../verification/prd-198-raytracing-gated-2026-08-25.md)). No code in
`packages/core` reaches it; the only references outside the implementation are the refusal
contract, a conformance refusal scene, and the capability manifest's constraint line.

This matters to three of the research's features at once. F16 (Lumen-like), F18 (MegaLights) and
F20 (path tracer) are all costed as software problems on WebGPU, because the research assumes
WebGPU is the only backend. Here, **the native arm already has the hardware path written**, and one
interop seam stands between the tree and a ray-traced native lane. It also mirrors the charter's
"a feature that works on web only is unfinished" in the other direction: a native-only capability
with no portable seam is the same defect, and this one is not currently reachable from any game.

## 3. Grounding table — all twenty features against this tree

**Verdict** applies the charter: *mechanism* ships in `packages/`, *look* ships as generated source
in a template's `src/render/`, *closed* means already decided with evidence and not reopened in a
feature.

| F | UE label | In this tree today | Filed | Verdict | The real remaining gap |
|---|---|---|---|---|---|
| F17 | Nanite-like | **Shipped, on by default** — `clustered-mesh.ts`, `clustered-batch.ts`, bake DAG in `packages/assets/src/virtual/` | PRD-279…285: 4 done, 1 partly (GPU cut on native), 2 declined on measured headroom | mechanism | The GPU cut on native (PRD-283). Occlusion and streaming were **declined on the measured headroom**, not skipped — reopening needs a new measurement, not a proposal |
| F1 | Post-processing | **Shipped** — `RenderChain` + per-template `postprocessing.ts`; realism-effects coverage tracked by `scripts/realism-effects-coverage.ts` | PRD-011, PRD-273 | look → templates | Six of seven templates have no `worldEnvironment.ts` (PRD-278 tranche 2). Not a package |
| F16 | Lumen-like GI | **Partly** — `SSGINode`/`SSRNode`/`DenoiseNode` in starter source; baked static light done (PRD-256) | PRD-266…270 **all PROPOSED**, PRD-245 PROPOSED | mixed: nodes are look, velocity/probe transport is mechanism | The batch is filed and unexecuted. PRD-270 ("no lighting node ships web-only") is the charter rule made into a gate — execute that batch before proposing anything new here |
| F12 | Temporal upscaling | **Partly** — `traa`/`temporalReproject` stages, `resolution-scaler.ts` (280 lines, `resolutionScale: "auto"`), `render/batched-velocity.ts` | PRD-259 **declined at Phase 0**; PRD-269 (motion vectors) PROPOSED | mechanism | No upscaler, and PRD-269 is its precondition: skinned and instanced geometry have no motion vectors, so every temporal stage above is lying on animated content. **Fix the velocity source before adding a consumer of it** |
| F14 | Virtual Shadow Maps | **Shipped** — `VirtualShadowNode` + `readVirtualShadowMarker` exported from `@threenative/core`; `render/virtual-shadow.ts` (2,437 lines) and `render/virtual-shadow-pages.ts` (780 lines) | `161d11222` (PR #46, 2026-09-02); [PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md) PROPOSED (page path on) | mechanism | Not greenfield. What remains is coverage and tuning, not a system: `clipExtents` half-widths are the game's, the templates' default cascade depth is open, and occlusion culling over the page table is [PRD-489](../../done/PRD-489-gpu-scene-occlusion-culling.md)'s go/no-go |
| F18 | MegaLights / many lights | **Nothing** — no clustered or tiled light path anywhere in `packages/` | none | mechanism | Genuine greenfield. On native it could ride `mystralRT`; on web it cannot, so it must be specified two-tier from the start or it violates PRD-270's rule |
| F3 | Niagara-like VFX | **Partly** — `GPUParticles3D` (`particles.ts`), `TracerPool3D`, `FluidField2D`, `Billboard3D`, `SpriteAnimator3D` | PRD-027 done | mechanism, and `GPUParticles3D` is the charter's cited example of a legal one | No module/graph authoring layer. Careful: the graph must not decide appearance — geometry, material, colour, curve and timing stay the game's |
| F13 | Substrate materials | **Shipped as game source** — per-template `materials.ts` | PRD-011 | **look → templates** | Not a package, at any size. A layered-material *package* is the exact shape v1 shipped and measured worse than vanilla |
| F5 | PCG | **Partly** — `PRD-251 procedural world fields` Phase 1 complete, Phases 2–6 unexecuted; terrain done (PRD-043) | PRD-251 in `feature-mining/HIGH` | mechanism, but adjacent to the closed preset/editor question | Finish the filed PRD before importing a new framework. A node-graph PCG *authoring UI* is an editor and is closed |
| F8 | World Partition / HLOD | **Partly** — `PRD-253 content residency and screen-space HLOD` is **BLOCKED at Phase 0** on a portable native residency consumer | PRD-253, PRD-098 (LOD/instancing) **declined 2026-08-22** | mechanism | Blocked on a consumer, not on an algorithm. 3DTilesRendererJS does not unblock it |
| F15 | Virtual Texturing | **Partly** — KTX2/Basis transcoding shipped (PRD-095), model-internal textures compressed; `packages/assets/src/passes/` | PRD-095 done; PRD-099 vector textures **declined** | mechanism | Compression exists; there is no runtime page table, feedback buffer or residency cache. Note the BC7 block rule: every source texture must be divisible by 4 |
| F4 | Water | **Shipped, web only** — `packages/core/src/ocean/{spectral,fft}.ts`, `SpectralOcean` | PRD-246 done, **"web only, with named gaps"** | mechanism | **This is an open charter violation**, not a feature gap: a web-only capability is unfinished. It owes one native conformance case, which the PRD names and did not add |
| F19 | Physics suite | **Partly** — `@threenative/physics` (Rapier: bodies, colliders, joints, character controller, queries, layers, navigation); `SoftBody3D` cloth-first shipped 2026-08-30 (PRD-243) and clears the kill switch by 16× | PRD-040, 046, 243 done | mechanism | No destruction, no vehicles. Rapier is already adopted — the research's "adopt Rapier" is done |
| F9 | Motion Matching | **Nothing**; `animation.ts` (379 lines) is a clip/state player, `PRD-039` animation state machine closed WONTBUILD with recorded reopen triggers | none | mechanism | Greenfield, and gated on rigged assets — the same trigger PRD-039 records. Do not file it before those triggers fire |
| F11 | Control Rig / IK | **Nothing** — `skeleton.ts` is 46 lines (`attachToBone`, `skeletonBones`); `GroundSnap` handles feet-to-floor | none | mechanism | Greenfield. Smaller than the research implies because the bone seam and the grounding convention exist |
| F6 | Mass / ECS crowds | `PRD-258 many actors share one animation texture` is **BLOCKED at Phase 0** on a runnable many-soldier consumer | PRD-258 | **closed** — a code-first ECS is closed with evidence and not reopened in a feature | The crowd *rendering* path (animation texture) is legal and blocked on a consumer. The ECS half is not on the table. Do not adopt miniplex |
| F7 | Sequencer | **Partly** — `AnimationPlayer`, `PathFollow3D`, `CameraShake`, and `PRD-241 a sequence is one cancellable object` (done) | PRD-241 | runtime sequencing is mechanism; **a timeline editor is closed** | The cancellable-sequence primitive shipped. Theatre.js is an editor; adopting it reopens a closed question |
| F10 | Procedural audio | **Partly** — `audio.ts` (456 lines), `AudioBus`, native audio parity lane (PRD-057) | PRD-057 | mechanism | No DSP graph. Lowest-ranked A–C item and it stays there |
| F20 | Path tracer | **The native hardware path is written and gated** (§2) | PRD-198 | mechanism | Not "build a path tracer". It is *one interop seam*: buffer-to-texture copy-out. That is a far smaller and better-defined item than the research's 9–10/10 effort |

## 4. The re-rank the charter produces

Five, ranked. Anything that ships here still owes the checklists' Definition of Done and a playtest
scenario, and — per the charter — proof on native in the same commit.

| # | Item | Why it ranks here rather than where the research put it |
|---|---|---|
| 1 | **PRD-269 — motion vectors for skinned and instanced geometry** | The chain already runs `traa`, `temporalReproject`, `ssgi`, `ssr` and `motionBlur`. Every one of them is temporal, and on animated content their velocity input is wrong. This is not a new feature; it is the correctness bug under five shipped stages, and it is the precondition for F12 |
| 2 | **Execute the filed lighting batch (PRD-266…270)** | Filed, PROPOSED, unexecuted, and PRD-270 encodes the charter rule that no lighting node ships web-only. Executing a filed batch beats opening a new one |
| 3 | **[PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md)'s virtual shadow page path** | F14's system shipped 2026-09-02 (`161d11222`); the page path is the part still unexecuted, and it reuses the page table the cascades already own. Ranked here because the remaining question is whether pages beat cached clip levels on a measured scene, not whether to build one |
| 4 | **F4's native conformance case** | One case closes a standing charter violation. Cheapest row in this table by a wide margin |
| 5 | **PRD-198's buffer-to-texture copy-out interop** | Unblocks 5,476 already-written lines and changes the shape of F16, F18 and F20 at once. Scope it as an interop seam, not as a renderer |

Deliberately **not** in this list: F6 ECS and F7's editor (closed with evidence), F13 and F1 as
packages (look, so they ship as template source), F9 (waiting on its recorded rigged-asset trigger),
and F8 and F6's crowd path (blocked on consumers, not on algorithms — find the consumer first).

## 4b. The effort numbers, re-estimated

The research's effort column is a 0–10 abstraction assigned without seeing this tree, and its
priority score is `impact` discounted by that number. Both are wrong wherever the starting line
moved. Below, effort is restated in **agent-days at this repository's measured cadence** — the
virtual geometry batch (PRD-279…285: bake, cluster DAG, CPU cut, GPU cut, two declines on measured
headroom) was filed and closed inside 2026-08-30 — which is a unit someone can plan against, unlike
`7/10`.

"Remaining" means *from `6adb26d4`*, and it counts only the work the charter will actually accept:
look ships as template source and is priced per template; a mechanism blocked on a consumer is
priced as blocked, because no amount of engineering unblocks it.

| F | Feature | Research effort | Remaining | Why it moved |
|---|---|---:|---|---|
| F17 | Nanite-like | 8–9/10 | **shipped**, +2–3 d | Landed on by default. Residual is the GPU cut on native (PRD-283); occlusion and streaming were declined on measured headroom |
| F4 | Water | 4/10 | **0.5 d** | Shipped. The whole remaining cost is one native conformance case, which PRD-246 names and did not add |
| F7 | Sequencer | 4/10 | **shipped**, editor closed | PRD-241's cancellable sequence is the runtime half. The timeline editor is closed with evidence |
| F1 | Post-processing | 3/10 | **1 d** | The chain ships. Remaining is porting `worldEnvironment.ts` into the six templates that lack it (PRD-278 tranche 2), as generated source |
| F20 | Path tracer | 9–10/10 | **3–5 d** | Not a renderer. 5,476 lines of DXR/Vulkan/Metal RT are written; the cost is one buffer-to-texture copy-out interop seam plus the contract that ungates it |
| F2 | Volumetrics | 5/10 | **2 d** | `godRays` is already a chain stage and `Atmosphere`/`AtmosphereLuts` are in core. Remaining is a volumetric fog stage and its native proof |
| F12 | Temporal upscaling | 6–7/10 | **2 d + 3 d** | PRD-269 (motion vectors for skinned/instanced) is 2 d and is a correctness fix owed to five already-shipped temporal stages. The upscaler on top is 3 d |
| F5 | PCG | 5/10 | **3–5 d** | PRD-251 Phase 1 is complete and terrain shipped in PRD-043; phases 2–6 remain. A node-graph authoring UI is an editor and is not costed |
| F13 | Layered materials | 6–7/10 | **0.5 d / template** | As a package: rejected, at any size. As template `materials.ts` source: half a day each |
| F16 | Lumen-like GI | 9–10/10 | **4–6 d** | The nodes exist in starter source, the chain stages exist, baked static light shipped (PRD-256). Remaining is executing the five filed PRDs — and PRD-269 gates the temporal half of it |
| F11 | Control Rig / IK | 6/10 | **3–5 d** | Greenfield, but `attachToBone`, `skeletonBones` and the `GroundSnap` convention already exist as the seam |
| F19 | Physics suite | 9/10 | **6–10 d** | Rapier is adopted, cloth shipped 2026-08-30 clearing the kill switch by 16×. Remaining is destruction and vehicles only |
| F10 | Procedural audio | 5/10 | **4–6 d** | `AudioBus` and the native audio parity lane exist; the DSP graph does not |
| F14 | Virtual Shadow Maps | 7/10 | **6–10 d** | The cascades shipped 2026-09-02 (`161d11222`). This line is now the **page path only** ([PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md)), reusing the machinery F14 itself already owns |
| F15 | Virtual Texturing | 8/10 | **6–8 d** | KTX2/Basis transcoding shipped (PRD-095). The runtime page table, feedback buffer and residency cache are greenfield |
| F18 | MegaLights | 7–8/10 | **5–8 d** | Greenfield, and PRD-270's rule forces a two-tier design from the start: hardware RT on native, clustered on web |
| F9 | Motion Matching | 6/10 | **5–8 d, gated** | Greenfield and gated on the rigged-asset triggers PRD-039 recorded. Do not file before they fire |
| F8 | World Partition | 6/10 | **blocked** | PRD-253 is BLOCKED at Phase 0 on a portable native residency consumer. Effort is not the constraint |
| F6 | Mass / ECS crowds | 4/10 | **closed + blocked** | The ECS is closed with evidence. The crowd render path (PRD-258) is blocked at Phase 0 on a runnable many-soldier consumer |
| F3 | Niagara-like VFX | 6/10 | **3–4 d** | `GPUParticles3D`, `TracerPool3D`, `FluidField2D`, `Billboard3D` and `SpriteAnimator3D` ship. Remaining is a module layer that must not own appearance |

**What the re-estimate changes about the ranking.** The research's band A — F1, F2, F12, F14, F3 —
is not wrong so much as already half-spent: three of its five are hours of template work or a
correctness fix, not programs. Its band D contains the single cheapest high-leverage item in the
whole document, F20, because it costed a path tracer instead of the interop seam that is actually
missing. And two band-C items, F8 and F6, cannot be bought with engineering at any price until
somebody writes the consumer that unblocks them.

## 5. What to do with this folder

1. **Done 2026-08-30** — `threenative-ue5-feature-checklists-and-repo-scan.md` is deleted. The
   reuse-map is kept: it is a superset carrying the license triage.
2. Keep `threenative-repository-borrowing-catalog.md` as filed. It is the most directly useful of
   the three, and its license posture column is the part this repo cannot regenerate cheaply. Two
   entries are already settled in-tree and should be marked so: `dimforge/rapier` is adopted, and
   `zeux/meshoptimizer`'s territory is covered by the shipped cluster DAG.
3. Treat both remaining documents as **requirement checklists**, never as a queue. This file, the
   capability manifest (`packages/create-threenative/capabilities.json`, 197 entries, regenerated by
   `pnpm build`) and the PRD folders are the queue.
