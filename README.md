# PRD-743 BEFORE / AFTER screenshots

Wildwood, headed WebGPU, NVIDIA Turing (`adapter.info` checked), 20 Mbit/s (20000 kbps, 40 ms).
Two runs per arm, same scenario and fixed tick counts. Both arms run engine 0.3.6:
BEFORE installs tarballs packed from the PR base `ae3336204`; AFTER installs this PR's tarballs and
the Wildwood tweak in `wildwood/*.patch`.

| Pose | BEFORE 1 (before-13) | BEFORE 2 (before-15) | AFTER 1 (after-26) | AFTER 2 (after-27) |
| --- | --- | --- | --- | --- |
| spawn | spawn-before-1.png | spawn-before-2.png | spawn-after-1.png | spawn-after-2.png |
| settled | settled-before-1.png | settled-before-2.png | settled-after-1.png | settled-after-2.png |
| walked | walked-before-1.png | walked-before-2.png | walked-after-1.png | walked-after-2.png |
| walked-2 | walked-2-before-1.png | walked-2-before-2.png | walked-2-after-1.png | walked-2-after-2.png |

Visual judge (fresh read-only Opus, 2026-10-26): NEUTRAL at spawn, settled, walked, walked-2 and
after, and overall. The AFTER-to-BEFORE mean pixel difference stays inside the BEFORE-to-BEFORE
spread. Defects seen in both arms: the walked camera sits inside a foliage card, and HUD lines
overlap at walked-2.

## Reveal time (`startup.readyMs`, full forest `trees=2341 ferns=7600` in every run)

| Arm | Run 1 | Run 2 |
| --- | --- | --- |
| BEFORE | 43.96 s | 46.42 s |
| AFTER | 43.60 s | 42.44 s |

AFTER is 2.2 s earlier on the mean, inside the 2.5 s spread between the two BEFORE runs, so
PRD-743 AC-2 stays open. The reveal moves about 50.7 MB, about 20 s at 20 Mbit/s. The first-visit
win needs a coarse tier (PRD-745). before-14 and after-25 hit Chrome `ERR_NETWORK_CHANGED` and are
records only.

Probe at the same throttle, one fresh profile per arm (`reports/return-reveal-*.json`):

| Arm | First visit | Second visit |
| --- | --- | --- |
| BEFORE | 40.6 s | 9.45 s |
| AFTER | 39.7 s | 8.57 s |

## Return visit (AC-1)

`reports/return-visit-final5.json`: second visit `{ hits: 121, misses: 0, bytesOnDisk: 297153760,
bytesTotal: 297153760 }`, 0 requests for any manifest output (GLB, KTX2, HDRI, JPG, PNG). The only
35 requests are the game's non-manifest `public/audio/*.ogg`. `return-visit-nofill-final5.json`
repeats it with `?nofill`: 121/121 from disk, 50,748,558 B on disk. The 2 console errors per visit
are the dev server's web-app-manifest syntax error, in both arms.

## Reproduction

- `wildwood/valley.patch`, `wildwood/animals.patch` and `wildwood/game.patch` are the AFTER
  game-layer tweak: the detail prefetch starts in `load()` behind the critical files, the
  `wildwood:detail-tier` hold stays, and `?nofill` turns the background fill off for the probe.
- `wildwood/streaming.playtest.json` is the scenario: `network: { downloadKbps: 20000, latencyMs: 40 }`,
  fixed poses, a scripted walk and the detail-tier wait.
- `reports/prd743-return-visit.mjs` is the persistent-profile second-visit probe;
  `reports/prd743-return-reveal.mjs` is the throttled two-visit reveal probe.
- `reports/prd743-native-verify.log` is `pnpm native:verify:desktop` on the PR head.
- Older runs kept for history: `before-7`/`before-12` (engine 0.3.3) and `after-11`/`after-14`
  (a reveal that showed `trees=1 ferns=0`, a bug the detail hold fixed).
