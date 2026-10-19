<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — @threenative/terrain

Read `/AGENTS.md` first. This optional addon is authoring tooling, not a game runtime.

- Preserve the recovered evaluator, stable semantic IDs, validation and atomic transactions.
- The root is headless; `/three` creates only ordinary indexed geometry from supplied arrays.
- Keep renderer, scene, camera, material, DOM, editor and worker code outside both imports.
- `/export` encodes caller-prepared static worlds; browser FileReader/canvas is required only when encoding.
- Its MeshStandardMaterial images and final placement/water matrices come from the game; unresolved/deforming/stale content fails.
- Appearance belongs to game `src/render/`; never add palette, material or lighting defaults.
- `starter/<world>/` is copy-out game source (recipe, bake, look, colliders); package code never imports it.
- Bake before play. Games own their camera, mesh lifetime and existing physics registration.
- Keep raw terrain-only exports labelled; they do not prove full-world GLB delivery.

Run `pnpm --filter @threenative/terrain build` and
`pnpm exec vitest run packages/terrain/__tests__/terrain-consumer.spec.ts`.
