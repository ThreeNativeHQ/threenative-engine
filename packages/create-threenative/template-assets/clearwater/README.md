# Clearwater for ThreeNative

An opt-in, editable shallow-water abstraction adapted from
[Aurélien / Lumaris's Clearwater](https://github.com/Aureliengmz/clearwater).
It composes ThreeNative's existing FFT ocean, ripple field and water-surface capture;
it does not embed a second WebGL renderer or replace your scene, camera, lights or postprocessing.

**Qualification:** implementation candidate. The numerical/lifecycle contracts and installer
have been executed locally. Browser WebGPU pixels, desktop-native parity and mobile performance
remain unverified. This is not a claim of pixel-identical reproduction of the upstream demo.

## Install into an existing game

Use the `create-threenative` package built from this branch; older published versions do not
contain this module. From the game's root:

```sh
node node_modules/create-threenative/template-assets/clearwater/install.mjs
```

From an engine checkout, the equivalent is:

```sh
node packages/create-threenative/template-assets/clearwater/install.mjs /absolute/path/to/game
```

This copies source and the upstream license into `src/`, refusing to overwrite existing files.
The installer is optional: copying this bundle's `src/` contents does exactly the same thing.
There is no new runtime dependency and no new `threenative` CLI command. Default scaffold
files and their appearance are unchanged. Keep the license with redistributed adapted source.

## Add water

```ts
import { createClearwater } from "./clearwater.js";

// Inside Scene.enter(ctx):
const water = createClearwater(ctx, {
  size: 32,
  center: [0, 0],
  level: 0,
  depth: 2,
  sunDirection: [0.45, 0.82, 0.3],
});

// World-space events: footsteps, a projectile impact or an object hitting the surface.
water.disturb(1, 2, 0.25, -0.04);
water.follow(player.position.x, player.position.z);

// Optional live controls and CPU height query.
water.setLevel(0.5);
water.setSunDirection([0.3, 0.9, 0.2]);
const sample = water.sampleHeight(1, 2); // undefined until GPU readback arrives
if (sample !== undefined && sample.staleFrames <= 6) {
  // sample.height includes mean level, spectral height and the current local ripple.
}

// Explicit early removal; normal scene-root removal also disposes automatically.
water.dispose();
```

No manual `update()` or render-target juggling is required. The factory registers the fixed
clock and a single before-render dispatch; it unregisters both and releases its geometry,
materials, buffers, textures and reflection target on disposal. Do not also add `water.ocean`
to the scene: that would register a second compute dispatch. The exposed `mesh`, `material`,
`ripples`, `ocean` and `causticsTexture` are ordinary engine/Three.js objects, not wrappers.

Keep `mesh` as an untransformed scene-root child. `center` and `setLevel` are world-space;
parent transforms, rotating the surface and non-horizontal water volumes are unsupported.

## What is included

- Two cascaded GPU FFT bands, reusing `SpectralOcean` rather than duplicating Clearwater's FFT.
- A moving finite `RippleField`, uploaded only when changed; local disturbances never repeat
  across the ocean. The bounded patch intentionally returns false for out-of-patch impulses.
- Exact air-to-water dielectric Fresnel, Beer–Lambert RGB extinction, approximate in-scattering,
  scene reflection/refraction and derivative-widened sun glints.
- A three-channel refracted ray grid: the same height/normal field as the visible surface
  focuses light onto a planar receiver. This is not a scrolling noise caustic texture.
- Explicit bounded resolution controls; no hidden adaptive quality or global tone-mapping changes.

`reflectionLayers` can exclude expensive objects from the mirrored scene.
`reflectionScale` and `reflectionRefreshInterval` control mirror cost.
For a lower-cost starting point use `resolution: 32`, `segments: 64`,
`rippleResolution: 32`, `causticsResolution: 256`, `causticsSegments: 64` and
`reflectionScale: 0.25`. These are cost controls, not measured phone-performance guarantees.
`caustics: false` and `reflection: false` explicitly omit those passes.

## Demo and validation

The installer also copies the optional `ClearwaterDemo` scene, with a real opaque bed,
submerged blocks, a foreground pillar and a periodic disturbance. It has no DOM dependencies.
To run the fixture, select it in a scratch game's `src/game.ts`:

```ts
import { defineGame } from "@threenative/core";
import config from "../threenative.config.js";
import { ClearwaterDemo } from "./clearwaterDemo.js";

export default defineGame({
  display: config.display,
  renderer: config.renderer,
  scenes: { water: ClearwaterDemo },
  start: "water",
});
```

Use the game's existing browser/native entrypoints. Keep any UI disabled in this scratch fixture.
Check the bed through the water, the pillar's dry portion for refraction bleed, the reflection,
periodic rings, moving RGB caustics, two simultaneous water bodies, level/sun changes, scene
re-entry and disposal. Compare browser and native captures at the same time/camera before
calling either path qualified.

Repository checks:

```sh
pnpm exec vitest run packages/create-threenative/__tests__/clearwater*.spec.ts
pnpm typecheck
pnpm lint
pnpm test
```

The graph-construction test uses real Three.js objects but is not a WGSL compilation or pixel test.

## Boundaries

Requires ThreeNative's **WebGPU** renderer, including its native WebGPU path. It explicitly
rejects WebGL2: ThreeNative's FFT uses storage buffers/compute, unlike the upstream fragment-pass
FFT. Native, Android and iOS execution must each be qualified; shared source alone is not proof.

This is an **above-water**, finite, horizontal shallow-water surface, not an underwater-camera
system or deep-ocean terrain solver. The scene must provide real opaque geometry below it.
Refraction uses the opaque screen snapshot, so offscreen scenery and transparent objects are
not traced. Caustics are focused at `depth` below the mean level and fade when the actual receiver
is far from that plane. They modulate captured receiver colour, not individual direct-light
terms or shadow visibility: steep beds, cliffs, oblique receivers and exact radiometry require
a more advanced receiver/light integration. No chromatic-aberration postprocess, lens glare,
embedded pebble image or baked headland is copied from the standalone demo.

Optics, colours, sun radiance and tessellation live in `src/render/clearwater*.ts` and are yours
to edit. The original MIT notice is in `src/render/CLEARWATER-LICENSE.txt`.
