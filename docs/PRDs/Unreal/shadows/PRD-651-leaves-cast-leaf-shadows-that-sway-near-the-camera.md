---
prd_contract: v1
---

# PRD-651 — Leaves cast leaf shadows that sway near the camera

**Status:** IN PROGRESS
**Priority:** P1 — no box is ticked: on the owned engine, which is the default, an alpha-tested leaf card casts a solid rectangle, because the native shadow depth program discards nothing; tree shadows also stand still in the wind, and a back-lit leaf darkens through normal bias.
**Complexity:** 6 (MEDIUM) — 1–5 files per phase in the native engine and core (+2), the native engine and the browser are separate build boundaries (+2), swaying casters change what the shadow cache may keep (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-649](PRD-649-shadow-calibration-scenes-are-built-in-unreal-and-judged-until-parity.md) Phase 2 (the shared `foliage` scene and its `wind` run). Phase 2 depends on [PRD-488](../../open-world/PRD-488-foliage-moves-in-the-wind.md) (the wind node). Coordinates with [PRD-643](../gi/PRD-643-glass-fog-and-leaves-take-the-bounce-light-too.md), which owns the bounce light on leaves, and [PRD-VQ-15](../../rendering/PRD-VQ-15-hair-card-material-qualification.md), which owns hair-card shadows.

## Context

**ThreeNative today:**

- **Native engine (the default engine):** `Renderer::depthProgram` builds the shadow depth program
  with an empty fragment stage. It also clears the diffuse map from the vertex variant, so no UV
  reaches it (`packages/runtime-native/src/engine/renderer/renderer.cpp:2120-2140`). The material's
  `alphaTest` discard exists only in the colour program (`packages/runtime-native/src/engine/shader/standard.cpp:1532-1536`).
  So a leaf card's shadow is the whole card. Phase 1 reproduces this before the fix.
- **Browser (three):** three's shadow pass copies `alphaTest` and the map, so cards cut correctly
  there. It ignores `alphaTestNode`. `WorldImpostorSurface` works round that with `maskShadowNode`
  and a positive `alphaTest` floor (`packages/core/src/render/world-impostor-surface.ts:72,381,451`).
- **Wind:** [PRD-488](../../open-world/PRD-488-foliage-moves-in-the-wind.md) (PROPOSED) decided
  that cached virtual-shadow levels draw casters at rest pose, so wind adds no level redraws. A
  tree then sways while its shadow stands still.
- **Distance:** `VirtualShadowNode` already gives coarse levels a coarser caster
  (`shadowLodBias`) and drops casters under `minCasterTexels` (`packages/core/src/render/virtual-shadow.ts:209`).
  This PRD does not add a second caster LOD.

**Unreal 5.8.3** (source read 2026-10-20; clean-room summary, no code copied):

| Behaviour | Default | Source |
| --- | --- | --- |
| Masked casters | The shadow depth pixel shader runs the material's clip, so a leaf card casts a leaf | `Engine/Shaders/Private/ShadowDepthPixelShader.usf:48-105` |
| Wind in the shadow | World position offset runs in every shadow level, unless the primitive sets a disable distance; then a clip level whose distance threshold (about `2^(level − 3)` cm) passes that distance draws the rest pose | `Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapPageCacheCommon.ush:26-44`; `r.Shadow.Virtual.Clipmap.WPODisableDistance` 1, `.LodBias` 3 |
| Cache | A swaying caster invalidates its pages into the dynamic layer, redrawn while it moves | `VirtualShadowMapCacheManager.cpp:85-215`; per-primitive `ShadowCacheInvalidationBehavior` `Auto` (`PrimitiveComponent.cpp:347`) |
| Leaf receivers | Pixels of the Two Sided Foliage and subsurface shading models skip the normal bias and the screen ray, and widen the sun's source as opacity falls, from a 5° minimum. The two-sided flag of a default lit material is not that shading model | `Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjection.usf:84-98,352-355,1047-1058`; `r.Shadow.Virtual.SubsurfaceShadowMinSourceAngle` 5 |

## Solution

1. **A leaf casts a leaf (Phase 1).** The native depth program keeps the UV and the map when the
   material has `alphaTest > 0` or an alpha-test node, and discards with the same test as the colour
   program. A material with `side = DoubleSide` casts from both faces. Opaque materials keep the
   empty fragment stage, so their cost does not change. The browser path gets one fix: a caster
   whose cut comes from `alphaTestNode` alone casts the same cut, without the impostor workaround.
2. **Wind reaches the shadow where a texel can see it (Phase 2).** A caster with a wind
   `positionNode` sways in a shadow level when the sway amplitude is at least one texel of that
   level, and draws its rest pose in coarser levels. The engine measures the amplitude where it is
   used, so the author sets nothing. A swaying caster in a near level draws into that level's mover
   map, as any moving caster does (PRD-572), and the cached static layer stays valid.
   `worldPositionOffsetDisableDistance` (metres, Unreal's name) is the named override, and the
   caster reports it. This amends the PRD-488 rest-pose decision for near levels only.
3. **A Two Sided Foliage receiver is not over-biased (Phase 3).** A material marked `twoSidedFoliage`
   skips the normal bias and takes the widened source of Unreal's subsurface rule, so a thin leaf is
   neither self-shadowed black nor leaking. The marker is off by default. Unreal reads the shading
   model, and a two-sided cut card in its default lit model keeps the normal bias, so the engine never
   infers the marker from the sides or the cut. The leaf's transmitted colour stays in the template's
   foliage material (`src/render/`), which also sets the marker, and its bounce light is in PRD-643.

**Look is untouched.** The cut threshold, the wind curve, the leaf texture and the leaf colour come
from the game. The engine only makes the shadow follow them.

## Acceptance Criteria

- [x] AC-1 [local]: On `foliage/canopy` at `high`, a PRD-647 round returns no REGRESSION against BEFORE and MATCH or CLOSE against Unreal, with the leaf gaps visible in the ground shadow. proof: `pnpm unreal-look:capture --engine threenative --scene shadow:foliage --layers L5,L9 --reuse` for BEFORE and AFTER (two runs per arm), then `pnpm unreal-look:judge --layer L5` and `--layer L9` — Evidence: 2026-10-21 (b6c4f9d7f): both rounds return IMPROVEMENT on all four cells (sun 15 and sun 60, canopy and grass) and CLOSE against Unreal on all four. A third round, the old receiver key against the marker, returns IMPROVEMENT on all four cells (CLOSE, CLOSE, FAR, CLOSE against Unreal: the FAR cell is the fill level of shaded leaves, not the receiver rule). Floor shadow IoU against Unreal rose from 0.56 to 0.70 (BEFORE) to 0.77 to 0.90 (AFTER). Sheets and numbers: PR 541 comment 6325847354. Still wrong there: paler shadows, edges softer than Unreal's, shadow area 20% smaller.
- [ ] AC-2 [local]: In the `wind` run, the near-ground tree shadow moves with the tree, and the GPU cost of wind stays within PRD-488's 0.25 ms against wind off on the RTX 2080. proof: `pnpm unreal-look:calibrate --scene shadow:foliage --run wind` and `TN_FRAME_BUDGET` windows from `playtest perf` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Masked shadow depth program | Any `castShadow` mesh with `alphaTest` or an alpha-test node, on the owned engine | Replaces the empty fragment stage for masked materials | Phase 1 |
| Sway in near shadow levels | `VirtualShadowNode` levels drawing a caster with a wind `positionNode` | Amends PRD-488's rest pose in levels whose texel resolves the sway | AC-2 |
| Leaf receiver bias rule | Receivers whose material sets `twoSidedFoliage` | Replaces the uniform normal bias for those materials only | Phase 3 |

## Execution Phases

#### Phase 1: A leaf casts a leaf
**Status:** IN PROGRESS — native masked caster done; browser `alphaTestNode` cut and native parity open
**Files:** `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/runtime-native/src/engine/shader/standard.cpp`, native engine tests, `packages/runtime-native/conformance/registry.json`, `packages/core/src/render/world-impostor-surface.ts`
- [x] A 50%-cut leaf card casts a shadow with 50% ± 5% coverage of the card's projected area on the native engine. proof: red-green native engine test `native_engine_masked_shadow` (red first on the empty fragment stage). — 2026-10-20 (b98c06d40): red 1.000 coverage on the fragment-less depth program, green 0.500 after the masked depth program; tn-engine ctest 431/434, the three reds unrelated (perf timing at load 32, a known-red label, a load flake that passes alone).
- [x] A `DoubleSide` card casts from its back face. proof: the same test. — 2026-10-20 (b98c06d40): the card faces the light; `DoubleSide` shades 0.500, `FrontSide` 0.000 (three's shadowSide draws only its back faces).
- [ ] Browser and native match on the masked caster. proof: `pnpm parity --target desktop --only-tests masked-shadow-caster`.

#### Phase 2: Wind reaches the near shadow
**Status:** BLOCKED — the wind node of PRD-488 is not built (PROPOSED) and the PRD-649 `wind` run is not authored; neither exists to build on or to judge against
**Files:** `packages/core/src/render/virtual-shadow.ts`, `packages/core/__tests__/virtual-shadow.spec.ts`, the native VSM atlas
- [ ] A caster swaying 5 cm sways in a 2 cm-texel level and draws its rest pose in a 20 cm-texel level, and the override moves that boundary and is reported. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`.
- [ ] AC-2 holds. proof: the AC-2 commands.

#### Phase 3: Leaf receivers
**Status:** IN PROGRESS — the rule is on both engines and keyed on the marker; the parity run and the Two Sided Foliage sheet are open
**Files:** `packages/core/src/render/soft-shadow.ts`, `packages/core/src/render/virtual-shadow.ts`, `packages/runtime-native/src/engine/shader/standard.cpp`, `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/runtime-native/src/engine/scene/material.h`
- [x] A receiver marked `twoSidedFoliage` skips the normal bias and widens its source to the 5° minimum, on both engines. proof: red-green native test `native_engine_leaf_receiver`, and `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts packages/core/__tests__/virtual-shadow.spec.ts`. — 2026-10-21 (first keyed on the sides and the cut, re-keyed on the marker after the Unreal read): native green with the marker (marked leaf edge 0.972 m = the unbiased edge, marker alone 0.972 m; penumbra 0.079 m ordinary against 0.548 m on the marked leaf); the browser unit tests pass 131/131 and the `VirtualShadowNode` position test fails when the override is switched off. Scope in the browser: the virtual shadow levels and `sourceAngleShadowFilter`; the stock three PCF path keeps three's normal bias (see Decisions).
- [x] A two-sided cut card without the marker keeps the normal bias and the sun's own source, as Unreal's default lit does. proof: the same tests, and the rule-on against rule-off sheet on PR 541 (comment 6325847354, judge IMPROVEMENT against the old key). — 2026-10-21: red first on the sides-and-cut key (native: plain cut edge 0.972 m and penumbra 0.548 m, marker alone 0.585 m; browser: 3 specs red), green on the marker (plain cut edge 0.585 m = the biased edge, penumbra 0.079 m; the plain cut shadow coordinate equals the ordinary one).
- [ ] Browser and native match on the marked leaf receiver. proof: `pnpm parity --target desktop --only-tests leaf-receiver`. Scene and registry row exist (`conformance/scenes/shared/leaf-receiver.js`, now with the marker set); not run: this lane has no desktop runtime binary (`pnpm native:build` needs the V8 download).
- [ ] A Two Sided Foliage leaf matches Unreal's Two Sided Foliage leaf, with the sheets posted on the PR. proof: `pnpm unreal-look:compare --scene shadow:foliage` on the Two Sided Foliage variant of the scene, and a PRD-647 round. Not run: the scene's leaves are default lit in Unreal, so the Two Sided Foliage capture is new work (see Decisions).
**Verification:** AC-1 and AC-2.

## Decisions

- 2026-10-21 (leaf lane, correction of the first Phase 3 commit): the rule first read the sides and the cut
  (`side = DoubleSide` and an alpha test) and the game marked nothing. That was wrong. Unreal takes
  `bIsSubsurface` from the shading model (`VirtualShadowMapProjection.usf:84-98`), and the two-sided
  flag of a default lit material does not set it. The `foliage` scene's leaves are default lit in
  Unreal (a glTF proxy material), so the first key gave ThreeNative soft light bands on shaded leaves
  where Unreal's are evenly dark (a three-arm crop, rule off and on, is on the PR). The key is now
  the marker `twoSidedFoliage`, off by default. Native keys the shader variant on it
  (`VertexVariant::leafReceiver`, from `DrawItem::twoSidedFoliage`); the browser reads
  `builder.material` when the node builds. The marker is the one field of the owned engine that three
  does not declare: it is bound on every lit class, listed in `UNDECLARED_FIELDS` of the catalog sync,
  and the GI cache's node twin carries it. A template's foliage material sets it. PRD-643 Phase 3
  reuses the same marker for the back-face term.
- 2026-10-21 (leaf lane): the browser takes the rule where the engine owns the node: the virtual
  shadow levels (position without the normal bias) and `sourceAngleShadowFilter` (5° minimum). The
  stock three PCF path applies its normal bias before the material is known. A fix there needs a
  patch to three, which is the last resort, so that path keeps the bias. The templates' sun shadow
  runs through `VirtualShadowNode`, so the default look is covered.
- 2026-10-21 (leaf lane): Unreal widens the source "as opacity falls". A cut leaf has opacity 0 or 1
  after the cut, so only the 5° minimum applies.
- 2026-10-21 (leaf lane): the shared scene is `tools/unreal-reference/shadow/foliage/` (owner
  PRD-649, serves PRD-643): 8 two-sided cut leaf cards, 12 grass cards, a trunk and a pawn box, two
  suns, poses `canopy` and `grass`.

- 2026-10-21 (leaf lane): the foliage drew as solid quads at L7 and above because the GI cache
  (`scripts/unreal-look/scaffold/render/giCache.ts`, generated user source, so the game layer)
  swapped each material for a node material that kept six fields: the map and the alpha test were
  lost. `nodeTwin` now copies every settable field into the matching node class, as three's
  `fromMaterial` does. The native engine holds a material's fields as accessors on the class, which
  `for in` never lists (`packages/three-native/src/browser-backend.ts`), so three's own copy loop
  copies nothing there and every wall came back white on the first try. The copy therefore walks
  the prototype descriptors. A native engine fix (list the accessors as enumerable, with a native
  test) is open and would also serve any game that copies a material. The native engine has no
  physical node class, so a physical source is lit as a standard one there (the old behaviour).

- 2026-10-21 (leaf lane): Phase 2 is blocked, not started. The rule reads a caster's sway amplitude from
  its wind `positionNode`, and no such node exists: `engine_search_capabilities` for foliage wind
  returns only `SoftBody3D` (cloth), PRD-488 is PROPOSED, and no code under `packages/core/src` displaces
  foliage. The `wind` run has no Unreal capture either (PRD-649 Phase 2 is NOT STARTED). A guess at the
  amplitude API would be written twice, so the rule waits for PRD-488. AC-2 stays open for the same reason.
- 2026-10-21 (leaf lane): at L1 (sun only) a ThreeNative leaf differs from an Unreal leaf in three
  ways. The `foliage` scene with the sun at 60 degrees gives the numbers. Unreal values come from the
  scene-linear EXR. ThreeNative values come from the PNG through the inverse tone curve, which
  reproduces the Unreal PNG from the Unreal EXR to 0.41 rms.
  1. Unreal shades rough diffuse with the EON model. The Unreal project renders with Substrate, and
     its rough diffuse is `Diffuse_EON` at 0.4 times the roughness (UE 5.8.3:
     `Engine/Shaders/Private/BRDF.ush`, `Diffuse_GGX_Rough`). ThreeNative uses Lambert. EON depends on
     the view direction. On 5 leaf cards the Unreal-to-Lambert ratio varies by 9% to 12% from card to
     card (standard deviation over mean, per channel). Dividing by the EON-to-Lambert ratio of each
     card leaves 2% to 4%. The ratio comes from the card normal, the sun and the camera at each pixel,
     with no fitted parameter. Six grass cards with more than 1000 pixels leave 0.7% in green. At these
     angles EON is 0.91 to 1.36 times Lambert (floor 1.06 to 1.09, trunk 1.10 to 1.20, grass 1.13 to 1.36).
  2. ThreeNative adds white light. The standard material's specular term (F0 0.04, roughness 1) adds
     0.1 per unit of N.L to every channel. That is +4% on leaf green, +16% on red and +35% on blue.
  3. The red channel of Unreal's green foliage is a further 20% to 25% below the Lambert value of its
     albedo (leaf mean 0.61, grass 0.68; green 0.84 and 0.83; blue 0.86 and 0.80). The brown trunk and
     the grey pawn do not show this. Geometry, shadows (L1 has none), the texture (white RGB) and the
     tone curve do not explain it. The cause is open. One Unreal run of the same colour on an opaque
     box and on a masked card would tell a material-path cause from a colour cause.
  The common level of 0.83 may come from the sun calibration, which used Lambert. That is not verified.
  No code changed. A diffuse model is a look decision (render source) with a native twin. PRD-646
  AC-2 (the L1 direct-light cell) cannot pass on foliage before it exists.
- 2026-10-20 (slicing): the masked-caster fault is an engine bug (`packages/runtime-native/`), not
  a game one. Every game with leaves on the default engine has it, so it is fixed in the engine.
- 2026-10-20 (slicing): Unreal sways foliage in every shadow level by default. ThreeNative sways
  only where a texel resolves the sway, so the measured PRD-478 redraw cut holds in coarse levels.
  The `wind` run judges whether that difference shows. If it shows, the boundary moves, and the
  rule stays.
