# PRD-743 BEFORE / AFTER screenshots

Wildwood, headed WebGPU, NVIDIA Turing (`adapter.info` checked), 20 Mbit/s (20000 kbps, 40 ms).
Two runs per arm, same scenario and fixed tick counts. BEFORE is `@threenative/*` 0.3.3; AFTER installs
this PRD's tarballs and calls `ctx.assets.prefetch` after the reveal.

| Pose | BEFORE 1 | BEFORE 2 | AFTER 1 | AFTER 2 |
| --- | --- | --- | --- | --- |
| settled | settled-before-1.png | settled-before-2.png | settled-after-1.png | settled-after-2.png |
| walked | walked-before-1.png | walked-before-2.png | walked-after-1.png | walked-after-2.png |
| walked-2 | walked-2-before-1.png | walked-2-before-2.png | walked-2-after-1.png | walked-2-after-2.png |
| spawn (intended difference) | spawn-before-1.png | spawn-before-2.png | spawn-after-1.png | spawn-after-2.png |

Reveal (`startup.readyMs`): BEFORE 44.18 s and 49.39 s; AFTER 20.88 s and 20.50 s.
Visual judge (final code): NEUTRAL at settled, walked and walked-2. The spawn pose differs by design:
AFTER reveals the critical tier before the detail fill.

Return visit in one persistent profile: `cache.misses` 0, 297,153,760 of 297,153,760 bytes on disk,
0 requests for any manifest output (GLB, shared KTX2, HDRI). The only 35 asset requests are the
game's non-manifest `public/audio/*.ogg`. Second-visit fill from prefetch to detail done: 2.26 s.

Reports: `reports/before-12.txt`, `reports/before-7.txt`, `reports/after-10.txt`,
`reports/after-11.txt`, `reports/return-visit.json`.
