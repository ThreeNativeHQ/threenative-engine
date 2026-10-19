# VQ-01: actual packaged QuickJS fallback

![Packaged native QuickJS framebuffer](quickjs-native.png)

Left: a Meshopt-authored cube. Centre: a Draco-authored torus. Right: a standalone PNG texture. The two compressed model sources were decoded by the ordinary asset cook before execution; QuickJS is not being credited with compressed-codec support.

The image is the unchanged `after.png` from [successful native run 36998104447](https://github.com/ThreeNativeHQ/threenative/actions/runs/36998104447), source `46a759ad885cede29e0fbb2c719ed75151c5baec`, [artifact 11222881424](https://github.com/ThreeNativeHQ/threenative/actions/runs/36998104447/artifacts/11222881424). It was captured by the actual packaged executable using the native mailbox's `device.screenshot`, on the named Mesa llvmpipe software adapter. No browser capture, mock renderer, synthetic diagnostic image, crop, recolour or image-generation step is used here.

## What passed

- The actual ARM64 QuickJS/wgpu host was built through the repository's locked provisioner and normal native build path.
- Build selection, cooking, compatibility checks, native bundling and final packaging ran through the changed production code. The packaged executable retains the exact selected runtime bytes before its appended game.
- Decoded model positions, triangle counts, texture pixels and animation samples match the authored Meshopt/Draco inputs. Encoded source bytes are measured separately from decoded CPU accessor bytes.
- Authored KTX2 was refused before publishing and left the previous package byte-identical.
- Eight live assertions passed, covering loaded/textured models, decoded vertices, advancing frames/pose and startup milestones. Startup reached ready with compilation settled.
- Strict native host-console checks, actual native adapter/capture provenance, and both authored checker colours as opaque pixels in each specimen region passed. Report diagnostics are empty.
- Downloaded ZIP SHA-256: `5440effcf3acc3978207f8eba941888b0fbbf3de117c43f664145c5f7930fa90`.
- PNG SHA-256: `1ad43cda8e816431b0ab9993066b087c9283351f304ade2c1765eebf8e349c81` (71,626 bytes, 960×640). The downloaded image was visually inspected.

## Limits

This is a Linux desktop QuickJS **decoder-free fallback** proof. It does not qualify Android/iOS, native Basis/Meshopt/Draco decoder admission, hardware performance, peak-load memory, or full repeated-scene lifecycle. The `diagnostics` assertion family is web-only and the game bridge does not expose `runtime.diagnostics`; mandatory native host-console and readiness checks provide the recorded diagnostics evidence without changing engine target guards.

The unchanged runner summary calls its total decoded accessor count `decodedGeometryBytes`; that count includes animation samples. It is a CPU accessor-byte count, not measured GPU allocation or a claimed compression-related GPU saving.

[Machine-readable provenance](provenance.json) and [unchanged runner summary](quickjs-native-summary.json) retain the source, run, runtime, package, adapter and image identities. [Canonical PRD](../../PRDs/done/PRD-VQ-01-native-asset-capabilities.md) remains partial.
