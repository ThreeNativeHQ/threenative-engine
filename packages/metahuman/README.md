# @threenative/metahuman

MetaHuman head expressions for ThreeNative games: a checksum-verified OpenRigLogic evaluator
over a browser WASM build and a native C++ one, the binding-metadata contract that keeps a
prepared GLB honest about the rig it claims to drive, and the Three.js handle that drives it.

```ts
import { RigEvaluator, loadMetaHuman, validateMetaHumanAssets } from "@threenative/metahuman";

const evaluator = await RigEvaluator.create(dnaBytes);
evaluator.setLod(0);
evaluator.setGuiControls(new Float32Array(evaluator.counts().gui));
evaluator.evaluate(true);
const joints = evaluator.jointOutputs(); // deltas from neutral, 10 floats per joint
evaluator.dispose();
```

A prepared head, through the game's own asset loader:

```ts
import { loadMetaHuman } from "@threenative/metahuman";

const human = await loadMetaHuman({
  assets: ctx.assets,
  model: "metahuman/specimen.glb", // the prepared GLB
  dna: "metahuman/head.dna", // its original head DNA
  bindings: "metahuman/bindings.json", // the sidecar the preparation step wrote
  lod: 0, // source LOD, the default
});
ctx.scene.add(human.root);

human.setControls({ jawOpen: 0.4, eyeBlinkLeft: 1 }); // the aliases this specimen declares

// In the scene update, after any base/body animation, before the renderer draws:
human.update();

// On teardown:
human.dispose();
```

`human.controls` is the declared control list (alias, GUI channel, domain, default),
`human.setLod(n)` switches the mesh set and the rig together, `human.animatedMaps()` reads the
last evaluation's animated-map weights, and `human.diagnostics()` reports the backend, the pinned
OpenRigLogic revision and the live LOD. An undeclared control, a value outside its domain, an
undeclared LOD and any call after `dispose()` throw a `MetaHumanAssetError` with a stable `code`.
The model is loaded through `ctx.assets` and cloned per instance, so two characters never write
each other's face and `dispose()` frees the rig without touching the loader's geometry or textures.

## What it does

- `loadMetaHuman` binds one prepared specimen: it validates the sidecar against the rig and the
  loaded model, then drives the face from the aliases the sidecar declares. Every table it needs
  is built once, so `update()` is a straight-line pass over pre-resolved joint and morph slots.
  A LOD switch re-evaluates the current controls before the replacement mesh is shown, so it never
  shows a neutral frame.
- `RigEvaluator` loads `wasm/riglogic.mjs`, verifies the binary's SHA-256 against
  `wasm/checksums.json` before instantiating it, and returns copies of every output array.
  A stale or disposed evaluator throws instead of reading freed memory.
- `validateMetaHumanAssets({ bindings, dnaSha256, glbSha256, rig, gltf })` rejects a bindings sidecar
  whose hashes, joint names, node names, blend-shape channels, morph indices, LOD indices, control
  domains or aliases do not hold up. Failures carry a stable `code` on `MetaHumanAssetError`.
  `glbSha256` is optional: it is a preparation-time contract, and a loaded model is not re-downloaded
  to be hashed.
- `assertAssetPath` keeps a caller-supplied path inside the asset directory.

## Building the WASM

The binary is committed. Rebuild it only with the Emscripten toolchain:

```sh
source ~/.cache/emsdk/emsdk_env.sh
node packages/metahuman/scripts/build-wasm.mjs
```

`wasm/checksums.json` records the pinned OpenRigLogic commit, the `emcc` version and both
file hashes, so a rebuilt binary is never silently swapped in.

## Tests

`pnpm exec vitest run packages/metahuman` compares the WASM evaluator against the standalone
upstream evaluator on the committed synthetic DNA, drives the binding and its LOD switch against
that rig, and proves two instances stay isolated over ten create/dispose cycles. Set
`TN_METAHUMAN_SAMPLE_DIR` to add the local `Sample.dna` lane; without it that lane is reported as
skipped, never as passed.

`TN_METAHUMAN_SPECIMEN_DIR` adds the licensed-specimen lane: every neutral joint the DNA carries
is converted and compared with the exported GLB's own rest transform, to 0.1 mm and 0.1°. Without
it that lane is skipped, never passed.

`node packages/runtime-native/scripts/verify-desktop-metahuman.mjs` builds and runs the same
reference vectors through the native C++ backend; add `--sanitize` for the same contract under
AddressSanitizer and UBSan in a build directory of its own.
