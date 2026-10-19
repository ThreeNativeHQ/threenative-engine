# Snow glade starter

A small winter glade where the snow remembers. The explorer leaves boot prints that sink with
their weight; a ball dropped into the powder settles into the crater it makes, and pushed, it rolls
and carves a connected track. A crate and a fallen log press their own shapes. Switch on the
blizzard and fresh snow slowly fills every track.

`SnowField` stores the deformation and `attachSnowPhysics` connects it to real Rapier contacts, so
the ball rests on the same surface you see. Everything that decides how it looks — the snow
material, the boot, the explorer, the forest, the flakes — is ordinary source in `src/render/`.

Controls: WASD or the arrow keys to walk (Shift to run), drag to orbit and scroll to zoom; `F` drops
the ball and `G` pushes it; `B` blizzard, `C` camera view, `V` compaction view, `P` auto-explore,
`R` clears every footprint, `M` sound. On a touch screen, drag the left stick.

The crunch and wind clips in `assets/` are generated noise; replace either with a recording.

## Commands

```sh
pnpm dev
pnpm build
pnpm typecheck
pnpm test
pnpm test:native
```
