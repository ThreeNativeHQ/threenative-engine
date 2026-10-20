# Realistic ocean for ThreeNative

An opt-in, editable open-ocean composition adapted from
[Noniv/web-ocean](https://github.com/Noniv/web-ocean) (MIT, pinned at
`a07c7fd522ef0a897601c114f927a49d93d95520`). It reuses ThreeNative's `SpectralOcean`
FFT, `WaterSurface3D` mirror and compute lifecycle. It does not embed web-ocean's separate raw-WebGPU
device, canvas or render loop, and it changes no shipping default: the sailing kit's sea, `WaveField`,
Clearwater and coastal water are untouched.

**Qualification:** see PRD-648 for what was executed and where. Nothing here claims a platform that
did not run.

## Install into an existing game

From the game's root:

```sh
node node_modules/create-threenative/template-assets/realistic-ocean/install.mjs
```

From an engine checkout: `node packages/create-threenative/template-assets/realistic-ocean/install.mjs /absolute/path/to/game`.

This copies source and the upstream MIT notice into `src/`, refusing to overwrite anything that
exists. There is no runtime dependency and no new `threenative` command. Copying the bundle's `src/`
by hand does exactly the same thing. **Keep `src/render/REALISTIC-OCEAN-LICENSE.txt` with the source.**

To remove it, delete the files the installer added and undo your edits. Nothing else changed.

## Add a sea to any game

```ts
import { createRealisticOcean } from "./realisticOcean.js";

// Inside Scene.enter(ctx):
const sea = createRealisticOcean(ctx, { sun: [0.4, 0.8, 0.3] });
sea.reflect(island); // only what you name appears in the planar mirror

// Each frame, or whenever the viewed position moves:
sea.follow(camera.position.x, camera.position.z);
sea.wake(ship.x, ship.z, forwardX, forwardZ, speed01); // optional hull wake and wash
const height = sea.sampleHeight(ship.x, ship.z); // undefined until a GPU copy lands, never zero
```

Do not also `ctx.add` `sea.ocean` or `sea.maps`: the call already registered each once, and a second
registration would dispatch the simulation twice. Keep `sea.mesh` an untransformed scene-root child.

## Swap it into the sailing kit

Four edits to `src/scenes/Sailing.ts`: import `createRealisticSea`, `createRealisticMaps` and
`createRealisticWaterMesh` from `../render/realisticSea.js`, then replace

```ts
const ocean = ctx.add(createOcean());
const sea = createWaterMesh(ocean, new WaterSurface3D(SEA_MIRROR), { software });
```

with

```ts
const ocean = ctx.add(createRealisticSea());
const maps = ctx.add(createRealisticMaps(ocean));
const sea = createRealisticWaterMesh(ocean, maps, new WaterSurface3D(SEA_MIRROR), { software });
sea.setSun([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z]);
```

`scripts/realistic-ocean-consumer.ts` in the engine repository applies exactly these edits to a fresh
scaffold, and reverses them byte for byte.

## What it adds to a plain spectral sea

- **A real sea state.** A fetch-limited JONSWAP wind sea with Donelan-Banner spreading, a separately
  directed swell and capillary dispersion, scaled to the `waveHeight` you ask for (measured on the
  grid, so changing resolution changes detail and never height). It is handed to `SpectralOcean` as
  its `energy` curve, a backward-compatible option; without it the Phillips default is unchanged.
- **Three cascades** (256 / 48 / 9 m on a 128 grid): a swell, a chop and ripples down to 14 cm in one
  frame. These are tuning, not requirements.
- **Slope-moment filtering.** A pixel too far away to resolve the short waves inside it does not drop
  their slope: the variance they carry (integrated from the same spectrum) becomes roughness, so the
  sun's glitter path widens with distance instead of vanishing or shimmering.
- **Whitecaps that remember.** Foam grids in the waves' own coordinates, fed by the Jacobian of the
  horizontal displacement and decaying with a half-life you set. A teleport cannot desynchronise
  them, and `reset()` clears them.
- **Backlit crests**, a hull wake and waterline wash, and the planar mirror of what you name.
- A standard node material, so the scene's own light, shadow, environment reflection, fog and tone
  mapping apply. Nothing here installs a sky, fog, exposure, bloom or tone mapping.

## What it does not do

No shoreline or surf model, no underwater camera, no volumetric transmission, no pixel-identical copy
of the upstream demo, and no anisotropic glitter lobe (the filtered roughness is isotropic). Foam
repeats with its cascade's patch. A software rasteriser gets a cheap material with no shading
detail, so its height copy lands.

## Where each decision lives

| File | Decision |
| --- | --- |
| `src/render/realisticSpectrum.ts` | Which wavelengths carry energy, and from where |
| `src/render/realisticSea.ts` | Cascades, sea state, colours, glitter, foam, wake, mesh |
| `src/render/realisticSeaMaps.ts` | The derivative and foam grids, and how long foam lasts |
| `src/realisticOcean.ts` | The one-call factory and its lifecycle (not appearance) |

Repository checks:

```sh
pnpm exec vitest run packages/create-threenative/__tests__/realistic-ocean*.spec.ts
```
