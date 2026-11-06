# Kit notes: minimal

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Overview

This template has no React or Tailwind.


## Ownership

ThreeNative owns bootstrap, renderer, fixed-step loop, input, loading, physics bindings, and the state store. This repository owns `src/render/`, `src/entities/`, and `src/scenes/`; all are ordinary user code, and nothing in `@threenative/*` reads or chooses their appearance.


## Start every change

`@threenative/physics/navigation` is browser-only WASM; use portable `ctx`/Three.js for this cross-target template.


## Commands and map

`src/main.ts` boots the canvas; `src/scenes/Play.ts` owns the lifecycle; `src/entities/Player.ts` drives `assets/mannequin.glb` (Quaternius, CC0) through `SkeletalMesh3D`; the arena is one `Group` handed to `buildStaticColliders`; `render/camera.ts` follows from `afterPhysics`. No HUD; `playtests/survives.playtest.json` is the durable smoke proof.

On a touch-primary device (`isMobile() && isTouchscreenAvailable()`), the local `src/render/touch-controls.ts` adds a left movement stick and a right jump button. The scene passes its returned input to `Player`; keep the keyboard mapping as the desktop fallback.


## Portable authoring contracts

`src/render/sky.ts` draws Unreal's default sky (an atmosphere with clouds: `atmosphere.ts`, `clouds.ts`, `gpuSky.ts`) as background, environment light and height-fog colour, and `lighting.ts` tints the sun at `SUN_DIRECTION` by the air it crosses; `SKY_OPTIONS` takes `sky: "photo"` for `assets/sky.jpg` (Poly Haven, CC0) or `clouds: false`, and `ground: false` once the game has its own global illumination (the sunlit ground under the horizon stands in for the bounce); WebGPU adds a `VirtualShadowNode`. The shared look comes from core through `src/render/quality.ts`: the filmic curve and metered auto exposure are enabled by default. `pnpm test` proves behavior, never the look.
