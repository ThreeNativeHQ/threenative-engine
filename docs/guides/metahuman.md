# MetaHuman heads

Put a MetaHuman head in a game and drive its expression from code, with no Unreal install, no baked
clip and no CDN fetch. One prepared specimen gives you a plain Three.js object graph, a list of
named controls, and one `update()` call per frame.

This is the task walkthrough. [`@threenative/metahuman`](../../packages/metahuman) holds the full API
reference, including the binding-sidecar schema.

## What you need on disk

Three files, all served through your game's own asset loader:

| File | What it is |
| --- | --- |
| `head.dna` | The specimen's original head DNA, exported from the MetaHuman creator or your Unreal project. |
| `specimen.glb` | The prepared head: the DNA's meshes and joint names, in glTF. |
| `bindings.json` | The sidecar that maps the rig's controls and channels onto that GLB. |

The WASM binary is not one of them. `riglogic.mjs` and `riglogic.wasm` ship inside the package and
are checksum-verified before the evaluator instantiates them, so there is no build step for a game
to run and no file to host. See
[Building the WASM](../../packages/metahuman/README.md#building-the-wasm) only if you are changing
the rig itself.

## Prepare the specimen once

`bindings.json` is what makes a prepared GLB honest about the rig it claims to drive. Nothing infers
it at load time; a specimen without a sidecar cannot load.

Validate the sidecar against the real rig and the real GLB before you build anything on top of it:

```ts
import {
  validateMetaHumanAssets,
  type IMetaHumanGltfFacts,
  type IMetaHumanRigFacts,
} from "@threenative/metahuman";

function checkSpecimen(
  bindings: unknown,
  dnaSha256: string,
  glbSha256: string,
  rig: IMetaHumanRigFacts,
  gltf: IMetaHumanGltfFacts,
) {
  return validateMetaHumanAssets({ bindings, dnaSha256, glbSha256, rig, gltf });
}
```

It reads the rig's real joint names and the GLB's real node, mesh and target counts, then returns
the bindings only when every name, index, domain and hash holds up. A sidecar naming a joint the rig
does not have is rejected rather than ignored.

Run this in your asset pipeline, not at startup: it needs the rig and the GLB parsed, and its result
is what you commit. `glbSha256` is optional, because it is a preparation-time contract and a loaded
model is not re-downloaded to be hashed.

## Load a head

```ts
import { loadMetaHuman } from "@threenative/metahuman";

const human = await loadMetaHuman({
  assets: ctx.assets,
  model: "metahuman/specimen.glb",
  dna: "metahuman/head.dna",
  bindings: "metahuman/bindings.json",
  lod: 0,
});
ctx.scene.add(human.root);
```

`assets` is the game's own loader, which needs two methods: `model(path)` returns the loaded object
and `resolve(path)` returns the urls worth trying for a logical path. `loadMetaHuman` never opens a
file itself, and it never fetches from a CDN.

The model is cloned per instance, so two characters never write each other's face, and `dispose()`
frees the rig without touching the geometry or textures the loader still owns.

## Drive the face

`human.controls` is the declared control list. Each entry carries its `alias`, the rig's `gui`
channel name, its `min`/`max` domain and its `default`.

```ts
for (const control of human.controls) {
  console.log(control.alias, control.min, control.max, control.default);
}

human.setControls({ jawOpen: 0.4, eyeBlinkLeft: 1 });
human.reset(); // every control back to its declared default
```

Values are applied on the next `update()`, and nothing is clamped. An alias the specimen does not
declare throws `TN_MH_UNKNOWN_CONTROL`; a value outside the declared domain throws
`TN_MH_BAD_DOMAIN`; a non-finite one throws `TN_MH_NON_FINITE`. A silently clamped face is a worse
bug report than a throw.

## Update it in the loop

Call `update()` once per frame, after any base or body animation and before the renderer draws. The
rig writes the face joints, its output is applied, and the skeleton updates as it always does.

```ts
// In the scene: keep this removal function for the scene's teardown.
const removeFace = ctx.beforeRender(() => {
  human.update();
});
```

There is deliberately no `dt`. Facial evaluation has no time step, and a body mixer's update
position belongs to the caller.

To switch LOD, call `human.setLod(n)`. The evaluator's LOD, the visible mesh set, the active
mappings and the current expression change together, and the replacement is evaluated before it is
shown, so a switch never shows a neutral frame. A LOD the specimen does not declare throws
`TN_MH_BAD_LOD`.

Animated maps are a pull, not a write: `human.animatedMapNames()` and `human.animatedMaps()` return
the rig's last evaluation. Bind them to your own material inputs. The handle drives joints and
morphs and never writes a material.

## Read the diagnostics

```ts
const info = human.diagnostics();
// info.backend, info.openRigLogic, info.lod, info.joints, info.blendShapes,
// info.animatedMaps, info.controls
```

`backend` reads `"wasm"` in a browser game. In a native host that installed the MetaHuman resident,
the C++ evaluator runs instead and `backend` reads `"native"`; the game code does not change.
`openRigLogic` is the pinned upstream revision, which belongs in a bug report.

## Clean up

```ts
removeFace();
human.dispose();
```

`removeFace()` comes first, because the scene still holds the before-render callback that calls
`human.update()`, and every other method throws `TN_MH_DISPOSED` after `dispose()`.

`dispose()` is idempotent and frees the evaluator. Every other method throws `TN_MH_DISPOSED`
afterwards, so a stale handle fails loudly instead of writing into freed memory.

## Failures

Every rejection in this package is a `MetaHumanAssetError` with a stable `code`. Branch on the code,
not the message.

| Code | What happened | What to do |
| --- | --- | --- |
| `TN_MH_PATH_ESCAPE` | An asset path leaves the asset root | Pass logical paths. `assertAssetPath` rejects absolute paths, drive letters, backslashes and `..` before the path is joined. |
| `TN_MH_SCHEMA` | The sidecar is not a bindings document of the expected schema version | Re-run preparation. `METAHUMAN_BINDINGS_SCHEMA_VERSION` is the version it must declare. |
| `TN_MH_HASH_MISMATCH` | The sidecar's recorded hash differs from the bytes on disk | Regenerate the sidecar from the files you are shipping. |
| `TN_MH_UNKNOWN_JOINT`, `TN_MH_UNKNOWN_NODE`, `TN_MH_UNKNOWN_CHANNEL`, `TN_MH_UNKNOWN_MAP` | The sidecar names something the rig or the GLB does not contain | Re-run preparation against these files. The sidecar and the model are out of step. |
| `TN_MH_INDEX_RANGE` | A joint, morph or LOD index is past the end of its array | Same as above. |
| `TN_MH_BAD_LOD` | The requested LOD is not one the specimen declares | Read the LODs from the sidecar. |
| `TN_MH_UNKNOWN_CONTROL`, `TN_MH_BAD_DOMAIN`, `TN_MH_NON_FINITE`, `TN_MH_DUPLICATE_ALIAS` | The game passed a control the specimen does not declare, or a value outside its domain | Check `human.controls` before writing the call. |
| `TN_MH_ABI`, `TN_MH_WASM_LOAD`, `TN_MH_WASM_CHECKSUM` | The WASM build does not match the ABI, failed to load, or failed its checksum | Do not bypass the checksum. Reinstall the package, or rebuild the binary with the documented toolchain. |

## Limits

- The rig's own GUI-to-raw mapping runs. The adapter never re-derives it, which is why a sidecar
  that lies about a channel is rejected rather than quietly compensated.
- Nothing is clamped, coerced or smoothed. Every value you pass is the value the rig evaluates.
- Animated maps are read-only to the handle. Binding them to materials is the game's job.
- A native arm changes which evaluator runs and nothing else. It is not a different API, and the
  conformance vectors that prove it are run by
  `packages/runtime-native/scripts/verify-desktop-metahuman.mjs`, not by this guide.

## Where this is verified

`pnpm exec vitest run packages/metahuman` compares the WASM evaluator against the standalone
upstream evaluator on the committed synthetic DNA, drives the binding and its LOD switch against
that rig, and proves two instances stay isolated over ten create/dispose cycles. Two optional lanes
report themselves as skipped, never as passed: `TN_METAHUMAN_SAMPLE_DIR` adds a real `Sample.dna`,
and `TN_METAHUMAN_SPECIMEN_DIR` adds a licensed specimen compared against the exported GLB's rest
transforms.
