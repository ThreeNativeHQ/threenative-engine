---
name: procedural-asset-authoring
description: Choose, build, and review reusable ThreeNative procedural model kits and wire them into the Asset Library. Use for new bakeable props, modular geometry, and new variants or placement contracts for existing procedural models.
---

# Author reusable procedural assets

1. **Find a gap with an actual use.** Search `environmentElements()`, the Asset Library, and the engine capability manifest before choosing a pack. Name two plausible uses for the same geometry or placement contract. A straight track and curve can connect into routes for a mining game and a transport sim. Build the pieces those uses share. Reuse an existing module when a color, dimension, or arrangement already covers the request.
2. **Design the placement contract first.** Use metres, +Y up, and a predictable origin and front. Document the local axes on named GLB nodes for connections, pivots, contact surfaces, and mounts that a game actually needs. Configure matching seams, clearances, or gauge once across the kit. Keep the model useful without gameplay code. Export moving parts as named child groups so games can animate them.
3. **Expose controls that preserve the contract.** Use independent dimensions where uniform scale would distort a shared part, such as changing net height while keeping post width. Use scale for the whole assembly, colors for team or theme palette, and seed for variation that keeps fit intact. Bound numeric inputs, keep filenames distinct, and expose the same useful controls in the bake API and viewer. Skip knobs that produce the same output or break compatibility without a clear use.
4. **Use the existing bake and catalog.** In `packages/procedural-environment`, follow the nearest kit for the bake export and catalog rows in `src/index.ts` and the source controls and route in `src/asset-library.ts`. Reuse `StaticKitMesh` and the shared static GLB exporter for opaque PBR props. Use `pnpm asset-library` to check search, preview, rebake, and the exact Docs call. Reuse a fitting material scan across models and kits before fetching another. Get new scans from Poly Haven, keep the source credit, and verify the size and codec of the embedded textures. Follow the repo vegetation source rule when a kit includes plants.
5. **Prove reuse in context.** For a modular kit, connect or seat pieces and check both ends or contacts after an override. For a standalone prop, check that grip, front, opening, or silhouette survives the intended alternate use. Inspect actual GLBs and review matching headed captures with the visual judge in `AGENTS.md`. Fix concrete issues and recapture. Report the checks that ran. Keep screenshots for João together in `~/Downloads/ThreeNative-Asset-Library`.

Use the Asset Library's separate visual style, setting, and category fields. The visual style
comes from the finished appearance. A medieval asset may be realistic or stylized. Register a
new kit's style and settings in `CATALOG_TAGS` in the procedural source, and put each asset in
a useful category. Give individual assets setting overrides when they fit different settings
from their kit. Verify the expected style, setting and category together in the browser.

Treat dimensions, states and material finishes as independent controls. Reuse the shared wood finishes where they fit. Use named material-slot overrides on static kits,
keep common choices in Controls, and list the slots for the selected model in Docs. Let bake
callers supply custom PBR map bytes. Verify that changing a finish preserves the exported
geometry, anchors and default appearance.
