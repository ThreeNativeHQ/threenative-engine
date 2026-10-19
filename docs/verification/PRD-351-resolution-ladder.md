# PRD-351 — resolution ladder

Status: partial. The resolution prices cover the bound normal slot only.
Recorded on 2026-10-06 at engine HEAD `b616c2c16`.
The earlier pricing note names engine `5d5b0f699`. These captures are supplied evidence, not a new run at HEAD.

## Evidence to record

Quarry uses six props from a fresh 4096² import. The montage labels report these rounded values.
MB means decimal megabytes. GPU values come from the labels, not a conversion of disk bytes.

| Cap | Disk MB | GPU MB | SSIM | Capture |
| --- | ---: | ---: | ---: | --- |
| 1024 | 2.24 | 2.67 | 0.9885 | `res-1024-pose3-rock-near.png` |
| 2048 | 8.92 | 10.67 | 0.9920 | `res-2048-pose3-rock-near.png` |
| 4096 | 35.97 | 42.67 | 0.9950 | `res-4096-pose3-rock-near.png` |
| Per-slot candidate | 2.24 | 2.67 | 0.9885 | `res-perslot-pose3-rock-near.png` |

The labels do not separate distinct texture bytes from other disk bytes. They do not report runtime load bytes.
Those two fields in the PRD evidence block remain unmeasured. The table records the available disk and GPU prices.
The supplied SSIM values do not prove resolution loss against masters or normal-vector accuracy.

Captures use four matched positions: `pose1-trail`, `pose2-rock-mid`, `pose3-rock-near`, and `pose4-route`.
Each position has `montage-<pose>.jpg` and `res-<arm>-<pose>.png` files for all four arms.
The capture metadata reports WebGPU, an NVIDIA Turing adapter, and a 1280×720 viewport.
The close capture shows rock surface detail. It does not show bark detail.

The coordinator judged `pose3-rock-near`: 4096 is sharpest, 2048 is close, and 1024 is visibly softer.
This verdict covers the captured rock surface. It does not establish bark quality or mobile rendering quality.

## Slot limitation

All six imported GLBs bind only `normalTexture`. The importer put the unmappable base-color mask in `textures/`.
That image has no base-color material binding in these GLBs. The compiler caps bound glTF slots.
The proposed 2048 color / 1024 mask candidate therefore reaches only the normal slot at 1024 here.
It equals the scalar 1024 arm. This experiment prices normal resolution, not a combined color and mask policy.

The per-slot investigation found identical model and image hashes for the candidate and scalar 1024 on `SM_rock01`.
Commit `b616c2c16` adds compile specs for separate 4096 color and normal inputs on web and Android.
The supplied investigation reports 46 passing model texture tests. These specs prove cap support, not this pack's missing bindings.

## Phone memory reference

The PRD names the [mobile memory reference](../../packages/create-threenative/agent-docs/references/mobile-memory-budget.md).
Its measured Pixel 8 line is approximately 500 MiB of fixed driver memory, plus the bytes the game requests.
It warns that phones can kill applications below 2 GiB. It gives no Quarry texture ceiling.

The reported GPU prices equal approximately 2.55, 10.18, and 40.69 MiB for 1024, 2048, and 4096.
The 2048 arm adds 8.00 MB over 1024. The 4096 arm adds 40.00 MB over 1024.
These texture prices exclude the phone's fixed driver cost and other game allocations.
No phone memory run proves a safe total for Quarry.

## Decision

Keep compiler defaults. Do not adopt the per-slot candidate on this pack.
It only reaches the normal slot and gives the same result as 1024.
Retain the game's import policy. The temporary 4096 import supplies experiment inputs, not a new shipping policy.
Separate bound color and mask inputs need their own comparison before the game can adopt that policy.

## Evidence sources

The supplied files remain outside this checkout. This record does not copy or remove them.

| Source | Scope |
| --- | --- |
| `/home/joao/projects/threenative/threenative-engine/.afk/scratch/b8res/` | Resolution captures, montage prices, and capture metadata |
| `/home/joao/projects/threenative/threenative-engine/.afk/scratch/b8-res.md` | Partial pricing note and earlier engine revision |
| `/tmp/perslot.md` | Six normal-only GLBs, hash comparisons, and cap specs |
| `/home/joao/projects/threenative/threenative-engine/.afk/scratch/b8-real.md` | Phase 1 run on 48 opaque 128² terrain textures, not pack masters |
| `/tmp/b8-ladder.md` | Phase 2 run, observed failing controls, and RDO probes |
