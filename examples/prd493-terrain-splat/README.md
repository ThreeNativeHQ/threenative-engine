# PRD-493 — terrain splat, sixteen layers

Sixteen terrain layers, each with an albedo, a normal and an ORM map, over one streamed
heightfield. Every map is an uncompressed JPEG: 48 textures, which is the shape that used to bind
one sampler per map and stop at WebGPU's 16 sampled textures a stage.

Same-size layers now stack into one array texture per set — `splat + albedo + normal + ORM`, four
sampled textures — and the material prints what it costs:

```text
TN_TERRAIN_SPLAT layers=16 samplers=4 stacked=3
```

The numbers are also in `material.userData.TN_TERRAIN_SPLAT`, which this scene publishes so the
scenario asserts the cost rather than a screenshot's opinion.

## Run it

```sh
pnpm --filter prd493-terrain-splat dev
node packages/playtest/dist/runner/cli.js examples/prd493-terrain-splat/playtests/terrain-splat.playtest.json \
  --url http://127.0.0.1:5193 \
  --server-command "pnpm --filter prd493-terrain-splat dev --host 127.0.0.1 --port 5193 --strictPort" \
  --browser-recipe webgpu --headed
```

The same scenario on the native host, where the GPU copies do the same stacking:

```sh
pnpm --filter prd493-terrain-splat build:native
node packages/playtest/dist/runner/cli.js examples/prd493-terrain-splat/playtests/terrain-splat-desktop.playtest.json \
  --target desktop \
  --executable examples/prd493-terrain-splat/dist-native/prd493-terrain-splat \
  --build-report examples/prd493-terrain-splat/dist-native/prd493-terrain-splat.build-report.json
```

## Regenerate the world package

The package is what a DCC export produces, not a second format: the script writes the layer table
and the map files a game would author, then hands them to `export_terrain_layers` in the shipped
`export_world.py` recipe. Blender writes the JPEGs.

```sh
pnpm --filter prd493-terrain-splat world
```

The maps are proof fixtures, not art: values go straight into 8-bit sRGB JPEGs, so the normal and
ORM channels carry the transfer curve of the file format rather than exact numbers. The masks are
five RGB planes in bands across the map, which is what puts a different layer under the camera as
it orbits.

## What each arm looks like

`world-terrain-splat.spec.ts` proves the mechanism in node; this package proves it on a GPU. On
`develop` the same package fails before the first frame:

```text
Uncaptured WebGPU GPUValidationError: The number of samplers (34) in the Fragment stage exceeds the maximum per-stage limit (16).
```
