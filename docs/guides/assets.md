# Assets and loading

Load models, textures and sounds by their source name, show real loading progress, and release
what a scene no longer needs.

## How assets reach the game

You put source models, images and sounds in `assets/`. At build time `@threenative/assets`
compiles them into `public/` and writes a manifest that maps each source name to its output file.

| Path | Contents |
| --- | --- |
| `assets/` | Your source files. Add or replace files here. |
| `public/assets.manifest.json` | Source name to compiled output. The loader reads it. |
| `public/bake.receipt.json` | Every file the build produced, with its producer and source. |

You load through `ctx.assets` with the source name. The loader looks up the manifest, so your code
keeps working when a rebuild changes an output filename. Without a manifest it tries the verbatim
path and then the source directory.

## Load in a scene

Load what the first frame needs in the scene's async `load` method. ThreeNative awaits it before
`enter`.

```ts
import type { ICtx } from "@threenative/core";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

// In your Scene subclass:
private model: GLTF | undefined;

async load(ctx: ICtx): Promise<void> {
  this.model = await ctx.assets.model<GLTF>("models/robot.glb");
}

// In enter(): ctx.add(this.model!.scene);
```

The type parameter only describes the result. It does not validate the file.

| Method | Returns |
| --- | --- |
| `ctx.assets.model<T>(path)` | The parsed model |
| `ctx.assets.texture(path, options?)` | A `Texture`. With options you get a configured copy, so the shared cached one stays untouched. |
| `ctx.assets.audio(path)` | An `AudioBuffer` |

The loader caches every result, so a second call for the same path returns the same object. If
several characters animate independently, create each one with `SkeletalMesh3D`. See
[Animation](animation.md).

## Formats and compression

The build writes each distinct model image once, compresses model textures to KTX2/Basis and can
simplify geometry. Check the compiled result from the gameplay camera before you keep it.

Android's default runtime is V8, and its packaged loader decodes KTX2 and Meshopt as the web does.
A QuickJS Android build and iOS ship no WebAssembly, so they have no Basis transcoder and no
Meshopt decoder: there the build wants `assets.textures: "none"` and refuses a compressed model
with `TN_NATIVE_KTX2_UNSUPPORTED`. Draco is browser-only. `npx threenative doctor --text` reports
which decoder a target you asked for is missing.

A ready GLB loads directly. Converting `.fbx`, `.blend`, `.obj` or `.dae` needs Blender. If
conversion fails, run `npx threenative doctor --text` and install Blender with the command it
prints. Keep each asset's license and attribution with your project.

Measure a model before you author against it. `inspect` reads a glTF and reports its bounds, a
units heuristic, the axis it observed, clips with durations, bones, mesh, material and texture
counts. It never modifies the file.

```sh
npx create-threenative inspect assets/models/robot.glb
npx create-threenative inspect assets/models/robot.glb --json
```

## Browse the asset library while you develop

`pnpm dev` serves the Asset Library at `/__assets/`. It lists the project's `assets/`, its
`src/**/*.story.ts` pages and a Scene Bundler, so you can look at a model or tune a material
without writing a scene. A project that turns it off answers 404 there and nothing else changes:
the library is a dev-server route, never part of a build.

A code story is one `src/**/*.story.ts` module whose default export is `defineAssetStory`. Its
controls tune the props live, and `create` builds the object from them:

```ts
import { defineAssetStory } from "create-threenative";

export default defineAssetStory({
  title: "Crate",
  controls: [{ key: "size", label: "Size (m)", type: "range", min: 0.2, max: 3, default: 1 }],
  create: ({ size }) => new Mesh(new BoxGeometry(size, size, size), new MeshStandardMaterial()),
});
```

## Loading progress

`ctx.assets.progress` reports what the loader is doing.

| Field | Meaning |
| --- | --- |
| `requested`, `settled` | Loads asked for, and loads that resolved or rejected |
| `requestedBytes`, `settledBytes` | The same, weighed by manifest sizes. Both stay 0 without a manifest. |
| `pending` | Source paths still loading, in request order |

Drive a loading bar from the byte counts. A file count treats a huge model and a tiny icon alike.
`settled` includes failures, so handle a failed required asset yourself and show the player what
to do.

`ctx.startup` covers the rest of the launch, such as shader compilation and a stable frame
window. `ctx.startup.progress` runs from 0 to 1 and never goes backwards. `whenReady()` resolves
when the world is safe to show.

## Hold startup for your own assets

If the game streams a second tier of assets after launch, register a hold during scene entry.
Startup then waits for your work too.

```ts
const criticalTier = ctx.startup.whenFrameworkReady().then(async () => {
  // Load and attach the critical content. Handle failures in your UI.
});
ctx.startup.hold("critical-tier", criticalTier, 15_000);
```

Start that work from `whenFrameworkReady()`. `whenReady()` waits for every hold, so work started
from it waits on itself until the hold's budget runs out. A hold settles when its promise
resolves or rejects, or after `budgetMs` (45 s by default). `hold()` throws if startup has
already resolved.

## Bake a procedural model to a GLB

A Node script under `scripts/` can build a model from Three.js parts and write it as a `.glb` under
`assets/`. `@threenative/core/bake` carries the plumbing: `createPbrMaterial`,
`createEmissiveMaterial`, `addPart`, and `exportProceduralGlb`, which merges meshes by material,
rests the model on `y = 0`, checks its bounds and writes `asset.extras.tnOrigin = "procedural"`.
The script chooses every shape and colour.

```ts
import { exportProceduralGlb } from "@threenative/core/bake";

const receipt = await exportProceduralGlb(root, "assets/lamp.glb", { prompt: "street lamp" });
```

Check the result with `threenative inspect assets/lamp.glb --json`.

## Custom loaders and cleanup

For loaders ThreeNative does not wrap, such as an HDR sky or a font, call
`ctx.assets.resolve(path)`. It returns the URLs to try in order. Never hard-code a compiled
output name, because it changes on every rebuild.

Call `ctx.assets.release(kind, path)` or `ctx.assets.clear()` once nothing uses a cached asset.
Removing an object from the scene does not free its GPU resources. Dispose scene-specific
resources in `exit`, and keep anything another instance still shares.

If a load fails, check the name, its manifest entry and the network or decoder error. See
[Troubleshooting](troubleshooting.md).

## Source

- [assets.ts](../../packages/core/src/assets.ts)
- [scene.ts](../../packages/core/src/scene.ts)
- [README.md](../../packages/assets/README.md)
