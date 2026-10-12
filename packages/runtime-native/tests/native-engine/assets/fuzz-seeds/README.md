# glTF fuzz seeds

`native_engine_asset_fuzz_gltf` mutates these alongside the GLB corpus files. They are two corpus GLBs
(`test-support/fixtures/skinned-character.glb`, `examples/csg-doorway/assets/doorway.glb`) rewritten as
`.gltf` JSON with the binary chunk as a base64 data URI, so mutations reach the JSON structure that a
GLB's length-prefixed chunks mostly protect.
