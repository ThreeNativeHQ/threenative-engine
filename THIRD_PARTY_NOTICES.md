# Third-party notices

This project is MIT licensed (see `LICENSE`). The parts below are borrowed from other MIT projects,
and each names exactly what was taken.

Algorithms are re-implemented, never copied: the renderer, the shader language and the runtime are
ours, so a source file from another engine is a description of behaviour to rebuild, not code to
vendor. That is why every entry names the behaviour that was ported and the file it came from.

## Ultra Elements

- Upstream: <https://github.com/Humpalumps/ultra-elements>
- Pinned commit: `698b720c81d8f1f282bae53633d72413b5c4408d` (2026-10-30)
- Licence: MIT, Copyright (c) 2026 Humpalumps
- Used by: `@threenative/core/spells` (PRD-777 onwards)
- What was ported, behaviour only:
  - `src/spells/cast.js`: the cast phase clock — charge, release, travel, impact, linger, done — the
    oldest-cast recycling at pool capacity, and the per-cast seed.
    Rebuilt in `packages/core/src/spells/cast-pool.ts`.
  - `src/vfx/GroundField.js`: a per-spell surface field the floor shader reads, with heat, char, wet,
    frost, crack and glow channels that decay.
    Rebuilt in `packages/core/src/spells/reaction-field.ts`. The arena SDF is not ported; the game
    supplies `groundAt` instead.
  - `src/vfx/Particles.js`: a kind table where a particle kind's behaviour is data, so retuning a
    kind recompiles nothing.
  - `src/spells/fire.js`, `src/spells/lightning.js`: the timelines, beat lengths and stock looks of
    the first-wave spells.
- What was not ported: the WebGL2 / raw GLSL renderer, `FluidVolume`, `Metaballs`, `Refraction`,
  `Volumes` and the arena. Everything on screen is rebuilt in TSL for the owned engine and the
  native host.

Full upstream licence text follows.

```
MIT License

Copyright (c) 2026 Humpalumps

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
