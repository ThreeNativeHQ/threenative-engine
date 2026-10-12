# @threenative/terrain

Optional, headless terrain authoring recovered from Strata. One seeded recipe produces
height/splat arrays, resolved placements, baked LOD chunks and numerical exports.
Games consume baked data and own appearance, collision registration and disposal.

```ts
import { Terrain, Mask, bakeMesh } from '@threenative/terrain';
import { toGeometry } from '@threenative/terrain/three';

const terrain = new Terrain({ size: 512, resolution: 257, seed: 73 })
  .noise({ id: 'hills', amplitude: 35 })
  .flatten({ id: 'camp', height: 12, mask: Mask.circle([20, 30], 15) });
const geometry = toGeometry(bakeMesh(terrain.evaluate()));
// Your game creates the Mesh/material and disposes geometry.
```

Repeating an operation ID replaces that layer in place. `applyPatch` batches edits
atomically; malformed writes preserve the previous recipe. Evaluation is synchronous
and belongs in authoring/build jobs. Browser/editor dependencies are absent from
root and geometry imports. Three.js is a peer, never a bundled second copy.

The recovered `makeExport` GLB/runtime archives contain terrain geometry. The separate
`@threenative/terrain/export` entry exports resolved static worlds through Three.js
GLTFExporter: the caller supplies final models/matrices, baked UV PBR maps and
coherent water snapshots. It requires browser FileReader/canvas for encoding,
embeds images/buffers, excludes model cameras/lights, and uses ordinary shared
mesh nodes. Missing models/maps, shader deformation or stale water fail by name.
The default GUI full-world action, chosen-resolution baking and five final starter
world exports remain pending. See the agent guide for the explicit contract.
No browser/native terrain-game acceptance result is claimed by these library tests.

See [agent guide](AGENT_GUIDE.md) and [source provenance](THIRD_PARTY_NOTICES.md).

Optional live authoring uses `@threenative/terrain/editor/server` in the project's
Vite configuration and `@threenative/terrain/editor` in its browser authoring entry.
`terrainEditor({ documentPath })` mounts revisioned JSON/SSE endpoints on the
existing loopback server. The configured file contains `{ version: 1, recipe }`;
agent patches and GUI changes share that authority. Invalid external saves retain
the last valid document with a diagnostic, and stale writes return conflict.

The project provides `/terrain-editor/index.html` and calls `mountTerrainEditor`
with its own `IEditorView` and material colours. The addon creates no renderer or
scene. `TerrainEditorController(editorUrl)` exposes `activate`, `snapshot` and
atomic `commit`; the activation result names the actually bound URL, project,
session and revision. Use a configured forwarded viewer URL for remote access;
the loopback API does not become a public write service.

Scatter placement `id` identifies the layer, unsigned seed and candidate attempt,
not the accepted array index. Mask/spacing changes can remove candidates without
retargeting surviving keys or their seeded scale/yaw. Changing a seed creates new
identities. Save keys rather than mesh instance indices for later authoring edits.

The authoring document may also contain `placementOverrides`, keyed by those IDs.
`validatePlacementOverrides()` validates finite position/quaternion/positive scale
and defaults omitted `grounding` to true. `applyPlacementOverrides(state, overrides)`
attaches each requested transform to its placement and reports retained unmatched
keys. `bakeTerrain()` preserves those records. The game applies grounding against
its actual mesh bounds and terrain triangles; disabling grounding retains measured
clearance. The example's Select tool uses ordinary Three.js TransformControls and
numeric fields, saves once per drag, and preserves newer edits on conflict.

`mountTerrainEditor` passes `(host, controller)` to `createView`. The view implements
`setDocument(document, revision)` for metadata changes without terrain evaluation;
its `update(state)` may return the resolved state for inspection and data bakes.

The example also selects stamp, paste and heightmap layers by stable ID. One proxy
edits recipe footprints and vertical gain/offset; its line follows the visible
terrain, with rebuilding on commit. X/Z rotation is disabled because a heightfield
cannot overhang. `stamp`/`paste` accept positive vertical `scale`; `heightmap` also
accepts optional metre `at`/`size`, degree `rotation` and `falloff` for a bounded
footprint. The original full-world heightmap path remains the default.
