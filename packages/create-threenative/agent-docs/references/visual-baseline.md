# Visual baseline — what each `src/render/` file ships, and the traps

Companion to the `Visuals` section in this project's `AGENTS.md`. Everything here is ordinary
Three.js source in this project, yours to rewrite or delete.

## What is already there, so you do not rebuild it

- `shapes.ts` — `roundedBox`, `block`, `ball`, `tube`, `spike`. **Build props out of these,
  not raw `BoxGeometry`.** A sharp box reads as Minecraft; the same box with a 0.14 corner
  radius reads as a toy, and that is most of the difference between a scene that looks
  designed and one that looks like a test harness. For the seeded randomness that varies a
  run of meshes, the scene builds `createRandom(seed)` and passes it down.
  `src/render/` imports shared Unreal look plumbing from `@threenative/core`; its lighting and materials stay game-owned.
- `lighting.ts` — key, sky/ground bounce, **rim**, ambient, with soft shadows and a
  `normalBias` tuned for rounded geometry. The rim is what stops silhouettes reading as
  flat cut-outs; do not delete it while "simplifying".
- `camera.ts` — `createSpringArm`, a frame-rate-independent follow camera. Its offset and its
  **lead** are the framing: the default aims ahead of the character rather than centring it,
  because a level that runs one way puts half the picture behind the player otherwise.
- `postprocessing.ts` — the editable presets and `setupPost` delegation.
- `WorldEnvironment` from `@threenative/core` — the shared Unreal render chain, with filmic tone mapping and metered exposure. Override options in `quality.ts`; `TN_RENDER_CHAIN` reports applied or refused stages.
- `materials.ts` — `floorMaterial`, `structureMaterial` and `propMaterial`, over a `DataTexture`
  metre grid and a grain normal map. **Two greys and one saturated colour is the whole rule:**
  light grid where the player walks, dark grid on sides and structure, and a single saturated
  hue reserved for what they can touch. A lit floor alone in black reads as a test fixture no
  matter how good the floor is, and the darkest band is the cheapest thing to fix in a first
  screenshot.
- `arena.ts` — the ground, the walls and one platform builder. **Keep something in all three
  depth bands:** the ground the player stands on, the dark mass behind it, and the sky above.

## Traps

Each of these has cost real debugging time. All of them fail *silently* — nothing in
typecheck, lint, or a playtest catches one, and several look exactly like "the effect is on
and does nothing".

1. **`CanvasTexture` samples black under `WebGPURenderer`.** Procedurally painting a canvas
   and using it as a `map` produces a black surface, silently. Get variety from alternating
   material colours across a run of meshes instead, or from `softCircleDataTexture`, which
   writes sprite pixels straight into a `DataTexture` and is the framework's way around this.
2. **`flatShading` fights `roundedBox`,** which welds its seams precisely so normals
   interpolate across them. Do not set both.
3. **Import a render module and then call it.** `setupPost` and `setupLighting` are inert
   if the scene only imports them.

### TSL post-processing stages that install and then do nothing

4. **`SSRNode.maxDistance` defaults to `1` — one world unit.** On any scene larger than a
   tabletop every reflection ray dies after a metre and returns nothing, on every pixel. This
   reads as "screen-space reflections are on and have no effect". Set it to the distance across
   the scene you actually want reflected.
5. **`reflectNonMetals` defaults to `false`.** A polished stone, wood, or painted floor is not
   metal, so by default it never reflects — only metals do. A polished floor is the usual
   reason to reach for SSR at all, so this default silently removes the effect you wanted.
   `roughnessNode` left `null` is the mirror-image mistake: every surface is then treated as a
   perfect mirror.
6. **Do not swizzle the normal you hand a pass.** `ssr()` calls `.sample()` on that node, so it
   needs the whole `TextureNode` from the MRT target; `normal.xyz` produces a plain vec3 and the
   pass dies at shader build with `this.normalNode.sample is not a function`. `@types/three`
   declares the parameter as `Node<"vec3">`, which is exactly what makes the swizzle look
   correct — the types are wrong here and the runtime is right.
7. **A dangling graph branch renders a blank frame.** When a pass needs a *texture* rather than
   an expression, materialise the chain **once** with `convertToTexture` and reuse that texture
   on both sides of the composite. Passing `convertToTexture(lit)` into the pass while adding
   its result back onto the unconverted `lit` builds two parallel copies of the same graph, one
   rendered into a target and one not — and whether the frame appears then depends on whether
   some *other* stage happens to re-materialise the second copy. Measured on a real scene: it
   rendered with bloom on, rendered with SSR off, rendered with godrays off, and came back as
   the bare background colour only when all three conditions lined up. That is what a dangling
   branch looks like from the outside, and it is not a driver bug.

Nothing in the toolchain can see your game. `pnpm test` proves behaviour, never the look —
so when you change something visual, actually look at it before reporting it done.

## The chain, in order — and what each stage costs

`postprocessing.ts` builds a `WorldEnvironment` and hands its stages to the engine's render
chain, which sorts them into one canonical order. The order is not a preference:

1. **ambient occlusion** and **SSGI** gather, because both read the depth and normal buffers the
   scene pass wrote and neither can read a composited image.
2. **denoise** runs inside the gather stage on its AO and GI terms, before they are added to the
   beauty pass — denoising the composite instead smears the geometry it was meant to preserve.
3. **godrays**, then **SSR**, which add light rather than remove it, so they see the frame the
   gather has already occluded and lit.
4. **sharpen**, because RCAS is defined on the finished picture and sharpening before bloom
   sharpens edges that bloom then spreads back out.
5. **bloom**, then **vignette**, then the tone curve — the last thing the frame meets.

Exposure is applied as a multiply on the scene pass, ahead of every stage, so the gather, the
reflections and the bloom threshold all see the same exposed image. `renderer.toneMappingExposure`
is live too and reaches the frame at the same point, but only when no output node is installed;
with any stage running, the multiply is the shutter.

### Cost

Measured on a dense interior (a sandbox cathedral, not one of these templates) at 1600x900 on a
desktop RTX 2080, browser WebGPU, as GPU time per frame — `gpuMs` in `TN_FRAME_BUDGET`, not the
CPU `render` phase, which reads ~5.5 ms while the GPU frame is 14.7 ms and therefore cannot see
this at all:

| configuration | gpuMs | fps |
| --- | --- | --- |
| every stage on | 14.7 | 56.8 |
| minus SSGI + denoise | 5.5 | 126.3 |
| minus SSR | 10.6 | 77.0 |
| minus bloom | 10.1 | 72.4 |
| minus denoise only | 12.8 | 60.3 |
| every stage off | 2.2 | 333.3 |

The scene, its shadow map and the overlay together cost 2.2 ms of that frame; the chain costs the
other 12.5. **SSGI is the expensive one by a wide margin** — the gather is ~7.3 ms and its two
full-resolution denoise passes ~1.9 ms at `medium` — which is why `ssgiQuality: "high"` (3 slices
x 16 steps) and full-resolution SSR are the two knobs to reach for first when a frame is late.
Godrays measured ~0.0 ms here and are off by default for a different reason: a shaft needs a sun,
an occluder and interior air to read at all, and none of these templates is an interior.

Your scene is not this one. Read your own numbers out of `TN_FRAME_BUDGET` before believing any
row above applies to it.

### Turning a stage on

Every stage that ships off is one property in the preset object in `postprocessing.ts`:

```ts
gtaoEnabled: true,      // contact occlusion in the crevices SSGI's room-scale gather misses
godraysEnabled: true,   // needs the shadow-casting light setupLighting returns; interiors only
vignetteAmount: 0.25,   // corner darkening, as the fraction removed at the extreme corner
ssgiEnabled: true,      // also for mobile: add it to mobilePreset and measure the result
```

`TN_WORLD_ENVIRONMENT` prints every run and names each stage as applied, or refused **with a
reason** — `godraysEnabled is false`, `light 'sun' does not cast shadows`, `renderer:webgl2`. A
stage you turned on that is not in that line as `applied: true` did not run, and the reason says
why. An unknown `ssgiQuality` or `tonemapMode` throws at construction rather than quietly
becoming the default.

## Unreal's film curve and colour grade

`tonemapMode: "filmic"` runs the curve and the defaults of a fresh Unreal Engine 5.8.3 project
(`render/tonemap.ts`, your source). `tonemapMode: "aces"` is the named override. The curve takes
`filmicCurve: { slope: 0.88, toe: 0.55, shoulder: 0.26, blackClip: 0, whiteClip: 0.04, ... }`, and
the grade takes Unreal's controls under `colorGrade`:

```ts
colorGrade: {
  whiteTemp: 5500, whiteTint: 0,           // Kelvin; "colorTemperature" in temperatureMode warms instead
  global: { saturation: [1, 1, 1, 1.1] },  // [red, green, blue, master], like Unreal's panel
  shadows: { gain: [1, 1, 1.05, 1] },      // also midtones and highlights; limits shadowsMax, highlightsMin/Max
  toneCurveAmount: 1,                      // 0 = graded colour with no curve
}
```

A control left out keeps Unreal's default and adds no shader code. Both options throw under any
other `tonemapMode`. Unreal's colour LUT also clips each channel at 43.7 after exposure.
That clip is off by default because it moves hot-emitter pixels; `filmicCurve: { lutClip: LUT_CLIP }` turns it on.

## Shafts of light — the one recipe that is easy to get wrong

You want the beam a cathedral window or a hole in a cave roof throws. **Do not build cone
geometry for it.** A hand-authored additive cone draws its own silhouette, stacks two layers where
you see through both walls, and reads as a plastic tube; the `godRays` stage is the supported
route and it is already wired.

Four things have to be true, and three of them fail silently:

1. **`renderer.shadowMap.enabled = true`.** The stage raymarches the sun's shadow map, and three
   does not allocate one until something asks for it. With no shadow map the stage refuses — and
   because it refuses at build time it takes the *whole chain* with it, so SSGI, SSR and your
   tonemap all quietly stop too. The symptom is a flat, ungraded frame, not a missing beam.
   `ctx.renderer` is the framework's wrapper; `ctx.renderer.raw` is the three renderer that has
   `shadowMap`. Setting it on the wrong one throws `Cannot set properties of undefined`.
2. **The light casts shadows and reaches the room.** `castShadow = true`, and a shadow-camera
   frustum wide enough to contain the space — the default 10 m ortho extent shadows nothing in a
   50 m hall, and a shaft is only visible where the map says the air is lit.
3. **The beam has to pass through the opening.** Position the light so the line from it through
   the hole lands where you want the pool of light; a sun placed for a pleasing angle usually
   misses the hole entirely and lights the far wall instead.
4. **`godraysFloor` is the dial that separates beams from fog.** This is the one people miss. The
   pass adds haze to every pixel, not only to the beams. `godraysFloor` subtracts that out-of-beam
   scatter *before* `godraysIntensity` multiplies, so with the floor near zero, raising intensity
   scales the veil over the whole room and the frame just gets milkier. Raise the floor first,
   then the intensity.

Measured band on an interior (lumen-hall, across many captures):

```ts
godraysDensity: 0.7,      // above ~0.8 the haze stops being confined to the beams
godraysFloor: 0.08,       // subtracts the veil; raise this before raising intensity
godraysIntensity: 3.0,    // only scales what survives the floor
godraysMaxDensity: 0.6,   // clamp; a no-op at this density, louder at higher ones
godraysSteps: 56,         // below ~24 leaves visible slabs at each step boundary
```

A useful check that costs nothing: if turning godrays off moves the **median** brightness of the
frame by more than a few points, the stage is fogging the room rather than drawing shafts. Beams
change the bright end of the histogram, not the middle.
