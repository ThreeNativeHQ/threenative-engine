---
prd_contract: v1
---

# PRD-248 — The atmosphere is three LUTs; the sky is the game's

**Status: DONE (web), 2026-08-29.** `Atmosphere` ships and bakes its three LUTs; the sky mesh,
material and lights stay in the template, and no preset list was added. Evidence:
[PRD-248.md](../../verification/PRD-248.md) — web implementation and consumer evidence complete.
That record calls itself PARTIAL because **native and device lanes are UNVERIFIED**; the web
feature is finished and the unrun targets are named rather than inferred.

Source: [`DennisSmolek/SebH-TSL-Sky`](https://github.com/DennisSmolek/SebH-TSL-Sky), MIT, cloned at
depth 1 on 2026-08-28 — 3 895 lines across `src/`, all read for the split below. **Nothing copied.**

Parent batch: feature-mining.

**Complexity:** +2 new subsystem, +2 an LUT bake plus a depth-coupled render pass, +2 multi-package,
+1 public TSL surface = **7 → HIGH mode.**

## The question

There is no sky. `grep -ri "atmosphere\|skybox\|scattering" packages/*/src` returns nothing, and a
game that wants a horizon writes a gradient, or loads an HDRI and accepts one time of day. Nothing
gives it a sun that sets, and nothing gives it aerial perspective — the distance haze that is most
of why a large outdoor scene reads as large.

Two questions, per §11.1:

- **(1) Could the game write it portably itself?** The scattering maths, yes — it is TSL. **Aerial
  perspective is not**: applying it needs scene depth and a place in the render order, and the
  render order is owned at `game.ts:841-842`. The LUT bake also needs the compute lifetime PRD-242
  owns. So the mechanism sits behind two framework seams.
- **(2) Does it decide how anything looks?** **The upstream API does, and that half is refused.**
  The mechanism half does not, and that half is what ships.

## The split, and it is the whole design

Read against the live test — *can the game change the appearance completely without editing
framework code?* — the source divides cleanly:

| Upstream | Lines | Side | Why |
| --- | ---: | --- | --- |
| `sky/SkyAtmosphereBaker.js` — transmittance, multi-scattering and sky-view LUTs | 526 | **Framework** | Physically-derived compute over supplied coefficients. Owns no colour. |
| `sky/HazePostProcess.js`, `hazeScenePassDepth.js` — aerial perspective against scene depth | 434 + 33 | **Framework (the seam), game (the composition)** | Reading depth in the right pass is the seam; where the haze lands in the output node is the game's line. |
| `sky/AtmosphereParams.js`, `AtmosphereUniforms.js` | 85 + 85 | **Framework, with no defaults** | Rayleigh/Mie coefficients, planet radius, ozone. Physics the game supplies, like gravity — not a menu. |
| `presets.js`, `preset: 'earth'`, `QUALITY_PRESETS` | — | **REFUSED** | `Sky.js:55` `preset = 'earth'`. A preset menu is on §2's closed list and is `postprocessing: ['bloom']` by another name. |
| `sky/SkySun.js` — **owns a `THREE.DirectionalLight`** that auto-tracks the sun | 213 | **REFUSED** | `Sky.js:409-410`. Lighting is the game's, unconditionally. The framework hands back a direction and a transmittance; the game makes the light. |
| `sky/SkyAtmosphereMesh.js`, `SkyGround.js`, `SkyNight.js`, `SkyMoon.js`, `GroundedSkybox.js` | 581 + 187 + 287 + 420 + 145 | **Game** | Sky mesh material, ground, stars, moon. All look. Excellent kit source. |

So the framework ships **nodes, not a sky**:

```ts
const atmosphere = new Atmosphere({ rayleigh, mie, ozone, planetRadius, atmosphereRadius });
ctx.add(atmosphere);                       // IComputeDriven: LUT bake, lifetime, release
atmosphere.setSunDirection(elevation, azimuth);

// src/render/sky.ts — generated for you, edit or delete it freely
skyMaterial.colorNode = atmosphere.radiance(viewDirection);
sun.color.copy(atmosphere.sunTransmittance(sunDirection));   // the game makes the light
postProcessing.outputNode = atmosphere.aerialPerspective(scenePass, depth);
```

A game that never constructs `Atmosphere` is unaffected. A game that dislikes ours writes its own
sky in `src/render/` and never mentions it — the relationship the scaffold already has with
`src/render/camera.ts`.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| Nothing | No sky, no atmosphere, no scattering exists. `Replaces` is empty and this row says so. |
| `IComputeDriven` (PRD-242) | Depended on for the LUT bake, ordered dispatch and release. |
| `templates/*/src/render/postprocessing.ts` | Where aerial perspective is composited, in generated source. |
| `templates/*/src/render/lighting.ts` | Where the sun `DirectionalLight` already lives, and stays. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `Atmosphere` implementing `IComputeDriven` | a kit or template scene | nothing | n/a | remove it → the sky capture reverts to the flat background |
| 2 | `radiance(dir)` / `sunTransmittance(dir)` TSL nodes | that template's `src/render/sky.ts` | nothing | n/a | change a coefficient → the horizon colour moves; if it does not, the LUT is not being read |
| 3 | Aerial-perspective seam (depth available in the right pass) | `packages/core/src/game.ts` render order | nothing | n/a | delete the composite line in `src/render/` → haze gone, frame matches the unhazed baseline |
| 4 | Sun direction from time and latitude | `solarPosition`-equivalent, pure | nothing | n/a | known date/lat/lon → known elevation within tolerance; hardcode and it reds |

## Execution Phases

### Phase 1 — the LUTs, and a number that proves they are physical

**Proof subject:** Earth coefficients **and** a deliberately non-Earth set (thicker Rayleigh, no
ozone). One set alone would let a hardcoded table pass every assertion.

**Files (4):** `packages/core/src/atmosphere/luts.ts` (NEW), `atmosphere/params.ts` (NEW), tests
(NEW), `index.ts` (EDIT).

- [ ] Transmittance, multi-scattering and sky-view LUTs baked through `IComputeDriven`'s warmup —
      once, at startup, not per frame.
- [ ] **No default coefficients ship.** Constructing without them throws, naming the missing field.
- [ ] Zenith transmittance for Earth parameters is checked against the published value within
      tolerance. A scattering LUT nobody checked against a number is a texture of plausible colours.

| Test | Assertion | Negative control |
| --- | --- | --- |
| `should match published zenith transmittance for Earth coefficients` | within tolerance | perturb the Rayleigh coefficient → outside, reds |
| `should produce a visibly different LUT for non-Earth coefficients` | LUT hash differs | ignore params → identical, reds |
| `should throw when coefficients are omitted` | throws, names the field | default to Earth → silently ships a look, reds |

### Phase 2 — `radiance()` and a sky a template draws

**Files (4):** `atmosphere/index.ts` (EDIT), a template's `src/render/sky.ts` (NEW — generated
source), its playtest (NEW), a capture baseline.

- [ ] The template builds its own sky mesh and material from `radiance(dir)`.
- [ ] Sunrise, noon and sunset produce measurably different captures.
- [ ] The sun `DirectionalLight` is created **in the template**, coloured from
      `sunTransmittance` — the framework creates no lights, and the diff shows it.

### Phase 3 — aerial perspective, which is the part a game cannot write

**Files (3):** `packages/core/src/game.ts` (EDIT — depth available to the seam, off unless asked),
the template's `src/render/postprocessing.ts` (EDIT — the composite line), its playtest (EDIT).

- [ ] A distant ridge desaturates with distance; near geometry does not. Asserted as a measured
      difference between near and far pixels, not by eye.
- [ ] Deleting the composite line removes it entirely.
- [ ] A game not using it pays nothing: identical draw calls and frame time to HEAD.

### Phase 4 — cost, on a phone, with the authority to refuse

- [ ] Physical Pixel 8, paired arms, cool device, cold launch. LUT bake cost at startup and per-frame
      haze cost both recorded.
- [ ] **If the bake pushes startup past its budget, the LUT resolutions become a required parameter
      rather than a framework choice**, and the number is recorded here. If the haze does not fit the
      frame, it ships marked, not defaulted on.

## Acceptance criteria (consumer-scoped)

- [ ] A template shows a sunrise that moves across a real day, on web and physical Android, with the
      sky mesh and its material written in that template.
- [ ] Changing a scattering coefficient in the template changes the horizon, with no package file
      edited.
- [ ] A distant ridge hazes and a near wall does not — measured.
- [ ] Deleting one line from `src/render/postprocessing.ts` removes aerial perspective completely.
- [ ] `packages/` contains **no preset list, no `quality` string, no default coefficient and no
      `DirectionalLight`** — grep pasted for each.
- [ ] A game that never constructs `Atmosphere` is byte-identical to HEAD in draw calls and timing.
- [ ] Startup and per-frame cost on a Pixel 8 are in the capability docs.

## Kill switch

The LUT bake and the depth seam survive on being unwritable by a game. If the template's own sky
ends up not using `radiance()` — because a gradient looked as good for that game — the node stays
and the subsystem is re-scored under §11.2 at the next round.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`DennisSmolek/SebH-TSL-Sky` @ `f7659396`**.

| To implement | Read |
| --- | --- |
| the transmittance / multi-scattering / sky-view LUT bake — the core borrow | `src/sky/SkyAtmosphereBaker.js:1-526` |
| the physical parameter set and its uniforms | `src/sky/AtmosphereParams.js:1-85`, `src/sky/AtmosphereUniforms.js:1-85` |
| aerial perspective against scene depth | `src/sky/HazePostProcess.js:1-434`, `src/sky/hazeScenePassDepth.js:1-33` |
| sun elevation and azimuth from time, latitude and longitude | `src/solarPosition.js:1-71` |
| **do NOT borrow** — a preset menu is on the closed list | `src/presets.js`, `src/Sky.js:52-108` (`preset = 'earth'`, `quality = 'medium'`) |
| **do NOT borrow** — it creates and owns a `THREE.DirectionalLight` | `src/sky/SkySun.js:1-213`, and `src/Sky.js:409-410` |
| **do NOT borrow into a package** — sky mesh, ground, night and moon are all look | `src/sky/SkyAtmosphereMesh.js`, `SkyGround.js`, `SkyNight.js`, `SkyMoon.js`, `GroundedSkybox.js` |
