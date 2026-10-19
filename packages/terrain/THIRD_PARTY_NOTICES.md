# Strata source provenance

João supplied `strata-terrain.html` and `AGENT_GUIDE.md` and explicitly confirmed
on 2026-09-30: “I own it; use MIT.” The recovered modules and their integration
are distributed under the accompanying MIT license. The supplied files contained
no earlier copyright/license notice; no upstream license or attribution is invented.

Source SHA-256:

- `strata-terrain.html`: `c0230e6891db829a5196d93ff7c9d714a8f2d964cac4722eb8ce4b2f723d794b`.
- `AGENT_GUIDE.md`: `487453218f870c5e829d58aea3fe9323e74ea93e0aecef8d5c329ecf56972d06`.

Recovery used the HTML's named `sources` module map, rather than its duplicated
worker blob or minified viewer. The algorithms, validation and transactions are
maintained as TypeScript source. Viewer appearance/renderer code is excluded;
baking takes optional caller-owned colours and exports no chosen material.

The optional `src/editor/` tooling also recovers the supplied app, icons, starter
recipes, worker and static UI shell. Local-storage authority and the separate
Three.js viewer are replaced by a revisioned project document and a required
project-owned view. Formatting changes preserve the recovered controls; GUI
swatches receive the game's explicit colours. Root and `/three` imports do not
load this tooling.

Maintained behavior difference: scatter candidates use layer/unsigned-seed/attempt
keys and consume the same five seeded draws even when rejected. This fixes the
supplied accepted-index identity and conditional-RNG defect. Placement lists
intentionally differ from the supplied source; the supplied noise/erosion
regression remains unchanged. The adapter's pine, boulder and grass shapes are
adapted in the example's editable `src/render/props.ts`, using installed merge and
instance mechanisms; no addon material or renderer is introduced.

Landform extensions add positive vertical gain to stamp/paste and a bounded,
translated/rotated rectangular footprint to heightmap. Additive stamp/paste now
honor the supplied vertical offset, which the recovered additive branch ignored.
Height data validation rejects missing or nonnumeric samples. Default gain/offset and heightmaps without
footprint fields retain the recovered sampling; the numerical noise/erosion
golden remains unchanged.
