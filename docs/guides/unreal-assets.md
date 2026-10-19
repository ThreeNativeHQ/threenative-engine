# Unreal assets without a conversion step

Load an Unreal mesh straight from its bytes. Two parsers cover the two file shapes: one reads a raw
editor `.uasset`, the other reads the `.uemodel` that CUE4Parse exports. Neither installs Unreal, and
neither invents geometry it could not read.

## Choose the parser

| You have | Use | Why |
| --- | --- | --- |
| An uncooked editor `.uasset` from a Fab pack or your own editor | [`@threenative/raw-unreal`](../../packages/raw-unreal) | Reads the package itself: `FMeshDescription` from UE5.x and UE4.2x, and the UE4.18 `FRawMesh` source model. |
| A `.uemodel` you exported with CUE4Parse or FModel | [`@threenative/ueformat`](../../packages/ueformat) | Reads the interchange format, so LODs, skeleton, sockets, collision and morph targets come with it. |
| Cooked game data, an IoStore container or a PAK archive | Neither | Export from the editor, or re-export with CUE4Parse. |

The two packages are independent. `ueformat` cannot read a `.uasset`: it accepts a `.uemodel` whose
first eight bytes are `UEFORMAT`, followed by a `UEMODEL` identifier and version byte `10`.
`raw-unreal` reads no `.uemodel` and parses no skeleton.

## Read the bytes you already have

Both parsers are pure format layers. They never open a file, so the same call works with bytes from
`fetch`, from Node, or from your own asset pipeline.

```ts
import { parseUAssetStaticMesh, createThreeObject } from "@threenative/raw-unreal";

const bytes = await (await fetch("/assets/SM_pine01.uasset")).arrayBuffer();
const mesh = createThreeObject(parseUAssetStaticMesh(bytes));
scene.add(mesh);
```

`parseUAssetStaticMesh` returns plain data: `positions`, `normals`, `uvs`, `indices`, `sections`,
`bounds`, `metadata` and `unreal`. Nothing in it is a three.js object, so you can keep the decode and
the adapter apart. `createThreeGeometry(decoded)` gives you the geometry alone when a framework
pipeline owns the materials.

In the browser, both packages also expose the three.js loader protocol. The loading manager is
optional:

```ts
import { DefaultLoadingManager } from "three";
import { UAssetLoader } from "@threenative/raw-unreal";

const loader = new UAssetLoader(DefaultLoadingManager);
loader.load("/assets/SM_pine01.uasset", (object) => scene.add(object));
```

`DefaultLoadingManager` is three.js's shared instance, not a class, so pass it as it is. The
constructor argument is optional, and `new UAssetLoader()` creates the loader with that same shared
manager. `UEFormatLoader` is the same shape for a `.uemodel`. Both loaders take `parse(bytes)` for
bytes you
already hold, which is the entry point to prefer outside a browser, because it does not depend on the
fetch path of three.js `FileLoader`.

`parseUEModel` and `createThreeObject` are the `.uemodel` pair, with one difference worth knowing:
`createThreeGeometry` takes a single LOD there, not a whole model.

```ts
import { createThreeGeometry, createThreeObject, parseUEModel } from "@threenative/ueformat";

const model = parseUEModel(await file.arrayBuffer());
const hero = createThreeObject(model); // a Group for one LOD, a THREE.LOD for several
const first = createThreeGeometry(model.lods[0]);
```

## What each parser accepts

`raw-unreal` reads legacy-tag uncooked editor packages only. The first four bytes must be the
package tag `0x9e2a83c1`, and three serialized source-model layouts are decoded:

| Layout | Engine generation | Where the payload lives |
| --- | --- | --- |
| `mesh-description` | UE5.x, named element containers | Inline, or in a UE5 `FCompressedBuffer` trailer payload |
| `mesh-description-ue4` | UE4.2x, fixed-order containers | `FByteBulkData`, usually zlib-compressed at the end of the package |
| `raw-mesh` | UE4.18-era `FRawMesh` | Inline uncompressed, or `FByteBulkData` |

A bulk payload is read wherever its flags put it: inline, at the end of the package, or in a sibling
`.uexp`, `.ubulk` or `.uptnl` file whose bytes you pass as `bulkDataFiles`. The parser asks for them;
it never fetches them.

Not read: IoStore `.utoc`/`.ucas`, PAK archives, cooked render buffers, Nanite clusters, skeletal
meshes and skin weights, textures and material graphs. A `.umap` is not reconstructed.

`ueformat` accepts UEFormat v10 only: the `UEFORMAT` magic, a `UEMODEL` identifier, version byte
`10`, then named attribute sets. Uncompressed and GZIP bodies are handled by the package. It also
parses skeletal mesh data, but it never builds a `SkinnedMesh` and never binds a skeleton: bones,
sockets and skin weights land on `userData` and as `skinIndex`/`skinWeight` attributes, and binding
them stays the game's job.

## Codecs and export prerequisites

Neither package bundles a compression codec that carries a licence or a size cost it did not choose.

| Payload | Codec | Where it comes from |
| --- | --- | --- |
| UE5 `FCompressedBuffer`, Oodle (method 3) | `oodle` | You inject one. `ooz-wasm` works and is GPL-3.0-or-later, so that is your game's licensing decision. |
| UE5 `FCompressedBuffer`, LZ4 (method 4) | `lz4` | You inject one. |
| Editor bulk data, `BULKDATA_SerializeCompressedZLIB` | `zlib` | You inject one. `node:zlib`'s `inflateSync` fits, as do the small browser inflate libraries. |
| `.uemodel` GZIP body | none needed | Bundled through `fflate`, which is why `ueformat` depends on it. |
| `.uemodel` ZSTD body | `zstdDecoder` | You inject one. |

A payload whose codec you did not supply throws `MISSING_CODEC` (or `INVALID_COMPRESSION` in
`ueformat`) naming the codec. It never guesses, and it never falls back to undecoded bytes.

```ts
import { inflateSync } from "node:zlib";
import { parseUAssetStaticMesh } from "@threenative/raw-unreal";

const zlib = (compressed: Uint8Array, rawSize: number): Uint8Array => {
  const inflated = new Uint8Array(inflateSync(compressed));
  if (inflated.byteLength !== rawSize) throw new Error("inflate size mismatch");
  return inflated;
};

const decoded = parseUAssetStaticMesh(bytes, { zlib });
```

## Materials are the game's

Neither package decides how anything looks. `raw-unreal` gives you one draw group per material
section and leaves the material to `materialFactory`. `ueformat` does the same through
`materialFactory`, plus `coordinateSystem`, `unitScale`, `flipV`, `repairWinding` and `lodDistances`.
The fallback in both is three.js's own plain `MeshStandardMaterial`; a `.uemodel` carries material
slot names and index ranges, not texture payloads, so textures come from your own pipeline. See
[Assets](assets.md) for that side.

## Inspecting a file before you build from it

`ueformat` ships a CLI, `ueformat-inspect`, as the bin of `@threenative/ueformat`. Add that package,
then run the binary through `pnpm exec`.

```sh
pnpm add @threenative/ueformat
pnpm exec ueformat-inspect model.uemodel
pnpm exec ueformat-inspect --json model.uemodel
```

Inside this repository, the workspace install already links the binary, so `pnpm exec
ueformat-inspect` is enough. It exits `0` on success, `1` on a `UEFormatError` (printing `CODE:
message (offset N)`) and `2` when no file is given. A ZSTD body cannot be inspected from the CLI,
because the CLI injects no decoder.

In code, `summarizeUEModel(parseUEModel(bytes))` returns the same summary. `readPackageSummary`
reports which engine generation wrote a `.uasset` before you decode it, and `readPackageLayout`
returns where the export data and bulk-data regions begin, or `undefined` when that walk cannot be
trusted.

## Limits and safety

Both parsers validate before they allocate. A candidate offset is trusted only after a parse consumes
its byte range exactly with every count agreeing, and rejected candidates are dropped as byte
patterns rather than reported as defects.

| Guard | `raw-unreal` | `ueformat` |
| --- | --- | --- |
| Mesh elements | 10,000,000 | `maxArrayElements`, 50,000,000 by default |
| Attribute values | 100,000,000 | `maxAttributes`, 100,000 by default |
| Texture coordinate sets | 8 | no extra cap |
| String length | no length-prefixed strings; the metadata scrape is capped at 256 KiB | `maxStringBytes`, 16 MiB by default |
| Custom versions, generations, chunk ids | 512, 4096, 65536 | not applicable |
| Compression chunk size | 64 MiB | declared size must match exactly |

`ueformat`'s three limits are yours to change per call through `IParseUEModelOptions`. 64-bit fields
are rejected beyond `Number.MAX_SAFE_INTEGER` instead of silently rounding.

Two things are best-effort and should be treated as such. `raw-unreal` scrapes `metadata` from the
first 256 KiB of the package by regex, so `engineVersion` and `objectPath` can come back `"unknown"`
or absent; and material slot names are only present when the layout records them. Neither is
authoritative package data.

## Failures and troubleshooting

Every parse and geometry failure is a typed error with a code. Catch the class, not the message.

| Code | Package | What happened | What to do |
| --- | --- | --- | --- |
| `INVALID_PACKAGE_TAG` | `raw-unreal` | The first four bytes are not the legacy package tag | The file is not an uncooked editor `.uasset`. Re-export with CUE4Parse and use `ueformat`. |
| `UNSUPPORTED_STATIC_MESH_LAYOUT` | `raw-unreal` | No inline mesh description, compressed buffer, bulk data or raw mesh blob matched | Read `error.details.probed` and `error.details.supported`: the error names what it looked for, so a cooked or IoStore asset is identifiable from it. |
| `MISSING_CODEC` | `raw-unreal` | A compressed payload needs `oodle`, `lz4` or `zlib` | Inject the codec named in the message. See the table above. |
| `MISSING_BULK_DATA_FILE` | `raw-unreal` | The payload is in a sibling `.ubulk`/`.uptnl` | Read the file the message names and pass it as `bulkDataFiles`. |
| `INVALID_RAW_MESH` | `raw-unreal` | An `FRawMesh` blob does not validate: a version pair the parser does not model, a truncated array, a UV channel that disagrees with the wedge count, or no renderable geometry | Read `error.details`. It carries `offset` plus the count or version that disagreed. A `version` outside `0`/`1`, or a nonzero `licenseeVersion`, means the blob uses a serialized layout this parser does not model, so re-export the model. Every other case means the candidate was not a real `FRawMesh`, so it was rejected as a byte pattern and another blob in the same file may still parse. |
| `INVALID_MAGIC` | `ueformat` | The file does not start with `UEFORMAT` | It is not a `.uemodel`. |
| `UNSUPPORTED_VERSION` | `ueformat` | The version byte is not `10` | Re-export with a CUE4Parse build that writes UEFormat v10. |
| `INVALID_COMPRESSION` | `ueformat` | A ZSTD body, or a compression format this build does not know | Inject `zstdDecoder` in the parse options. The CLI cannot do this. |
| `SIZE_MISMATCH`, `ATTRIBUTE_SIZE_MISMATCH` | `ueformat` | A declared size disagrees with the bytes, or the body does not end where it should | The export is truncated. Re-export it. |
| `INVALID_GEOMETRY` | `ueformat` | Indices, channels or sections disagree with the vertex count | Read `error.offset`. It names the count that did not add up. |

`raw-unreal` reports a `details` record; `ueformat` reports a byte `offset`. They are not
interchangeable, so log both fields rather than assuming one.

When a parse fails in a way this table does not cover, [Troubleshooting](troubleshooting.md) lists
the engine-wide diagnostics, and the `raw-unreal` and `ueformat` test suites are the executable
reference for what each layout contains.

## Where this is verified

`packages/raw-unreal` holds a committed UE 5.7 editor fixture, `SM_cube.uasset`, and asserts the
decoded geometry, the draw groups and `userData.unreal` against it. `packages/ueformat` ships three
committed `.uemodel` fixtures (a table model, a GZIP table, a rigged GZIP model) and builds
synthetic models to assert coordinate conversion, winding, tangents, morphs and skin attributes.
Neither package has a native-arm conformance case, so the claim that these parsers run on the native
arm rests on their source using only typed arrays, not on a recorded result.
