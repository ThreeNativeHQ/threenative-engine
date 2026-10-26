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
after, and overall. Per pose the AFTER-to-BEFORE mean pixel difference is the same size as the
BEFORE-to-BEFORE one (spawn 5.6-11.4 against 9.6, settled 6.8-11.3 against 10.0, walked 3.1-4.3
against 3.9, walked-2 5.8-10.4 against 9.7). Defects seen in both arms: the walked camera sits inside a foliage card, and HUD lines
overlap at walked-2.

## Reveal time (`startup.readyMs`, full forest `trees=2341 ferns=7600` in every run)

| Arm | Run 1 | Run 2 |
| --- | --- | --- |
| BEFORE | 43.96 s | 46.42 s |
| AFTER | 43.60 s | 42.44 s |

AFTER is 2.2 s earlier on the mean, inside the 2.5 s spread between the two BEFORE runs, so
PRD-743 AC-2 is not met; it moved to PRD-745 (2026-10-26). The reveal moves about 50.7 MB, about 20 s at 20 Mbit/s. The first-visit
win needs a coarse tier (PRD-745). before-14 and after-25 hit Chrome `ERR_NETWORK_CHANGED` and are
records only.

Probe at the same throttle, one fresh profile per arm (`reports/return-reveal-*.json`):

| Arm | First visit | Second visit |
| --- | --- | --- |
| BEFORE | 40.6 s | 9.45 s |
| AFTER | 39.7 s | 8.57 s |

## Waterfall (2026-10-26, why AC-2 moved to PRD-745)

`reports/waterfall-before.json` and `reports/waterfall-after.json`, one fresh profile per arm, 20 Mbit/s and
40 ms, both arms routing the clips through the manifest (`reports/prd743-waterfall.mjs`). The dev
server sends 31.7 MB of JS in 80 requests; the first asset request starts at 13.0 s on both arms. 51.5 MB of
assets then fill the link until about 34 s. Reveal: BEFORE 39.96 s, AFTER 39.62 s. After the last
byte, 5.2 s are pipeline compile on both arms: a 2.2 s attach frame, then a 2.8 s held warm-up of 226
pipelines.

## Return visit (AC-1)

PASS on the planned text (2026-10-26). `reports/return-visit-audio.json`: second visit 0 asset requests,
`{ hits: 121, misses: 0, bytesOnDisk: 297838428, bytesTotal: 297838428 }`, 0 console errors on both
visits, fill 3.23 s. The clips now load through the manifest (`wildwood/audio.patch`), and the dev server
serves its web-app manifest (engine fix 34ad0792a). A third cached visit (`reports/prd743-audio-ready.mjs`)
logged `TN_AUDIO_READY beds=2 steps=15 water=2 animals=16 clipDrift=0` with 0 asset requests.

Earlier, kept: `reports/return-visit-final5.json` had 0 manifest-output requests but 35 raw
`public/audio/*.ogg` requests and 2 dev web-app-manifest console errors per visit.

## Reproduction

- `wildwood/valley.patch`, `wildwood/animals.patch` and `wildwood/game.patch` are the AFTER
  game-layer tweak: the detail prefetch starts in `load()` behind the critical files, the
  `wildwood:detail-tier` hold stays, and `?nofill` turns the background fill off for the probe.
- `wildwood/streaming.playtest.json` is the scenario: `network: { downloadKbps: 20000, latencyMs: 40 }`,
  fixed poses, a scripted walk and the detail-tier wait.
- `reports/prd743-return-visit.mjs` is the persistent-profile second-visit probe;
  `reports/prd743-return-reveal.mjs` is the throttled two-visit reveal probe.
- `wildwood/audio.patch` moves the clips to `assets/audio/` and loads them with `ctx.assets.audio` (both arms).
- `reports/prd743-native-verify.log` is `pnpm native:verify:desktop` on the PR head.
- Older runs kept for history: `before-7`/`before-12` (engine 0.3.3) and `after-11`/`after-14`
  (a reveal that showed `trees=1 ferns=0`, a bug the detail hold fixed).
