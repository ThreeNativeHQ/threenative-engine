---
prd_contract: v1
---

# PRD-247 — The drei-vanilla helpers that are mechanism, one at a time

**Status: DONE (web), 2026-08-29.** Three of the surveyed helpers shipped and the rest were
refused with reasons: `Billboard3D`, `SpriteAnimator3D` and `CameraShake` are exported from
`@threenative/core`. Evidence:
[PRD-247-repair-2026-08-28.md](../../verification/PRD-247-repair-2026-08-28.md) and
[the roll continuation](../../verification/prd-247-roll-continuation.md) — web and unit gates
PASS. **Native execution is UNVERIFIED.**

Source: [`pmndrs/drei-vanilla`](https://github.com/pmndrs/drei-vanilla), MIT, cloned at depth 1 on
2026-08-28. `src/core/` is 4 170 lines across 19 files, all read for the verdict table below.

Parent batch: feature-mining.

**This PRD reverses a bad refusal.** The first draft of the batch README refused drei-vanilla
wholesale — *"`Billboard`, `Stars`, `Sparkles`, `CameraShake`, `Outlines`, `Grid` are all look"*.
That is wrong on its own terms: **CHARTER §5b names `billboarding` in its list of mechanisms the
framework may own**, beside pooling, lifetime, instancing, dispatch and culling. The refusal applied
the retired *"anything a screenshot shows"* wording to a bag of nineteen different things and threw
out the ones the charter explicitly allows.

drei-vanilla is not one decision. It is nineteen, and they do not all land on the same side.

**Complexity:** +1 ≤5 files per phase, +2 three small new nodes, +1 public surface, +1 template
proof = **5 → MEDIUM mode.**

## The verdict table

Each row answers the live test: *can the game change the appearance completely without editing
framework code?*

| Helper | Lines | Verdict | Reason |
| --- | ---: | --- | --- |
| **`Billboard`** | 68 | **SHIP** | Pure transform: orient a child toward the camera. Geometry, material, everything visual is the game's. §5b names billboarding as ownable. No incumbent here. |
| **`SpriteAnimator`** | 396 | **SHIP** | Atlas indexing and frame timing. The texture, the material, the frame rate and the atlas layout are the game's. `AnimationPlayer` covers skeletal clips and nothing covers sprite sheets. |
| **`CameraShake`** | 104 | **SHIP, mechanism only** | An additive transform offset composed over whatever rig the template owns. The **curve and intensity come from the game** — the upstream defaults (`maxYaw`, `maxPitch`, decay rates) do not ship, because those are the shake's feel. |
| `Trail` | 306 | REFUSE | `TracerPool3D` already exists (`packages/core/src/tracers.ts`). Two live implementations of one behaviour is a rejection, not a feature. |
| `Stars`, `Sparkles`, `Cloud` | 133 / 173 / 403 | REFUSE as shipped | Each ships geometry **and** material **and** colour. A game cannot change the appearance completely without editing them. Excellent `src/render/` material for a kit. |
| `Grid`, `Outlines`, `Caustics`, `Fisheye`, `MeshPortalMaterial`, `pcss`, `AccumulativeShadows` | 164 / 191 / 589 / 161 / 306 / 160 / 172 | REFUSE | Shaders and render-target compositions — the look itself. Also GLSL/`onBeforeCompile`-coupled and would need TSL rewrites regardless. |
| `useFBO`, `shaderMaterial`, `CubeCamera` | 39 / 68 / 67 | REFUSE | Thin wrappers over three.js a game writes portably in a few lines. §11.1 question 1 answers itself. |
| `Splat` | 639 | **SEPARATE QUESTION** | Gaussian-splat loading and rendering is an asset-format question, not a helper. WebGL-coupled upstream. Worth its own PRD if a game asks; not decided here. |

**13 of the 19 files touch `WebGLRenderer`, `ShaderMaterial`, GLSL or `onBeforeCompile`** — so the
refused rows are also mostly unportable to this renderer as written. The three shipping rows are not
among them.

## Why these three are framework code and not template source

- §11.1 question 1: a game *can* write a billboard in ten lines, and would — **in every game, for
  every billboarded object**, and would get the orthographic case and the parented-rig case wrong.
  §11.1's clause admits framework code *"once one game writes it more than twice"*; billboarding,
  sprite playback and shake are the archetypal more-than-twice helpers.
- §11.1 question 2: none of the three carries a colour, a texture, a material or a curve.
- **All three are ignorable.** A game that never imports them is byte-identical. A game that dislikes
  the shake writes its own in `src/render/` and never mentions ours — the same relationship the
  scaffold already has with `src/render/camera.ts`.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `TracerPool3D` — `packages/core/src/tracers.ts` | **Why `Trail` is refused.** |
| `AnimationPlayer` — `packages/core/src/animation.ts` | Skeletal clips. `SpriteAnimator` is the 2-D case it does not cover; the two do not overlap and this row says so. |
| `templates/*/src/render/camera.ts` | Where shake composes. The framework produces an offset; the template decides what to do with it. |
| `GPUParticles3D` | The shape all three follow. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `Billboard3D` | a template that has a world-space marker or nameplate | nothing | n/a | remove the parent → the child stops facing the camera, capture assertion reds |
| 2 | `SpriteAnimator3D` | a template with an animated pickup or effect | nothing | n/a | freeze the clock → the frame index stops advancing, test reds |
| 3 | `CameraShake` offset | a template's `src/render/camera.ts` composes it | nothing | n/a | delete the compose line → no shake, and the frame matches the unshaken baseline |
| 4 | Exports + capability docs | `packages/core/src/index.ts`, `capabilities.json` | nothing | n/a | drop `@situation` → `pnpm budgets` fails |

## Execution Phases

### Phase 1 — `Billboard3D`

**Files (4):** `packages/core/src/billboard.ts` (NEW), `index.ts` (EDIT),
`__tests__/billboard.spec.ts` (NEW), a template scene (EDIT).

- [ ] Follows the camera every frame; correct under a perspective **and** an orthographic camera,
      and under a rotated parent — the two cases hand-written billboards get wrong.
- [ ] Optional axis locking (`y` only, for trees and nameplates), because that is geometry-neutral.
- [ ] Costs nothing when unused: no global registry, no per-frame scan of the scene.

| Test | Assertion | Negative control |
| --- | --- | --- |
| `should face the camera under a rotated parent` | world quaternion matches | compose in local space → wrong under rotation, reds |
| `should face an orthographic camera by direction, not by position` | matches camera forward | use position-difference → wrong for ortho, reds |

### Phase 2 — `SpriteAnimator3D`

**Files (4):** `packages/core/src/sprite-animator.ts` (NEW), `index.ts` (EDIT), tests (NEW), a
template (EDIT).

**Proof subject:** a **non-uniform** atlas with per-frame durations, not an evenly-sliced grid — the
even grid is the case that needs none of the code.

- [ ] Frames advance on the fixed step, not on wall time.
- [ ] Loop, ping-pong and once modes; the texture, filtering and material stay the game's.
- [ ] No default frame rate that reads as a look choice — the game supplies it or it throws.

### Phase 3 — `CameraShake`, composed by the template

**Files (3):** `packages/core/src/camera-shake.ts` (NEW), a template's `src/render/camera.ts`
(EDIT — the composition, in generated source), a playtest (NEW).

- [ ] Produces a position and rotation **offset**; it never writes to a camera.
- [ ] Frequency, amplitude and decay come from the game. **No default that looks good ships.**
- [ ] The template's rig adds the offset after its own damping, which is why the framework must not
      own the write.

## Acceptance criteria (consumer-scoped)

- [ ] A template shows a nameplate that stays legible from any camera angle, including under a
      rotated parent, on web and native.
- [ ] A template shows a sprite-sheet animation playing at a rate the template chose, from an atlas
      the template supplies.
- [ ] A hit in a template shakes the camera with a curve written in that template's `src/render/`,
      and deleting that line removes the shake entirely.
- [ ] `packages/` contains no shake amplitude, no frame rate and no atlas layout chosen to look
      good — grep pasted for each.
- [ ] A game importing none of the three is byte-identical to HEAD in draw calls and frame time.
- [ ] `Trail` was not added, and `TracerPool3D` is still the only tracer — grep pasted.

## Kill switch

`count-loc.ts` per item, not for the set. Each of the three stands or falls alone: if a template's
hand-written billboard is not longer than the imported one across three call sites, that one is
deleted and the other two are unaffected.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`pmndrs/drei-vanilla` @ `28978f68`**.

| To implement | Read |
| --- | --- |
| billboarding, including the orthographic and rotated-parent cases | `src/core/Billboard.ts:1-68` |
| sprite-sheet indexing and frame timing | `src/core/SpriteAnimator.ts:1-396` |
| the shake offset (mechanism only — its defaults do not ship) | `src/core/CameraShake.ts:1-104` |
| **do NOT borrow** — the other sixteen files; 13 of 19 are GLSL/`onBeforeCompile`-coupled | `src/core/{Stars,Sparkles,Cloud,Grid,Outlines,Caustics,Fisheye,MeshPortalMaterial,pcss,AccumulativeShadows,Trail,Splat,useFBO,shaderMaterial,CubeCamera}.ts` |
