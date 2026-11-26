# @threenative/assets

The asset compile step for ThreeNative games. Walks a game's `assets/` source
directory, applies ordered passes over each input, and writes content-addressed
outputs into `public/` alongside an `assets.manifest.json` describing every
managed file.

Node-only. Carries the encoder dependencies the runtime must never inherit.

## Cook profiles

One compiler, one asset tree, a different representation per artifact: `buildProfiles` in
`threenative.config.ts` names a set of processing options per profile, and a build picks one with
`threenative build --profile <name>` or from `buildProfiles.defaults.<target>`. With neither, the
`assets` block is used exactly as declared, which is what every project without the feature gets.

An overlay may change `audio`, `budget`, `lod`, `models`, `targets` and `textures` — the passes
themselves. It may not restate `source`, `output` or `exclude`: one project compiles one tree, and
those are refused rather than quietly producing two answers.

A `maxSize` cap is applied here, per asset kind, and never upscales. On a target whose runtime has
no WebAssembly — an Android QuickJS build and iOS, which have no Basis transcoder and no Meshopt
decoder — the cap is applied by resizing during the compile and shipping a PNG, because a KTX2
nobody can decode is not a smaller texture, it is an unreadable one. The dimension requested is the
dimension the file decodes to, alpha kept, and the source on disk is untouched.

Everything about appearance stays the game's: a profile decides which bytes reach the disk, never
what they look like. `node_modules/create-threenative/agent-docs/references/build-profiles.md` carries the full
contract, the `artifactBudget` / `performanceBudget` blocks and the `<artifact>.build-report.json`
a build publishes.

## The delete-test, and the receipt that makes it possible

Every baking pass in here obeys one rule: **delete the entire baked output and the game runs
identically, just slower.** That is what separates a baking pass from a compiler of game meaning —
the thing this project has already tried once and deleted. A pass that cannot pass the delete-test
does not ship.

Each compile therefore writes `public/bake.receipt.json` beside the manifest, listing every file
the run produced — compiled outputs, auxiliary outputs like the lightmap atlas, and the Basis
transcoder — with the producer and the source each came from. The producer writes it because only
the producer knows: a consumer that reconstructed the list by globbing `public/` would either miss
an output or delete a source asset, and both mistakes look like a passing test.

Two consequences worth knowing before you add a pass:

- **A pass that writes a file it does not declare fails the build**, by name
  (`TN_ASSETS_UNDECLARED_OUTPUT`). Declare auxiliary outputs through `auxiliaryOutputs`.
- **Nothing in the shipped runtime reads the receipt.** `@threenative/core` falls back to the
  source path when the manifest is absent, and deleting the receipt is part of the test.

`pnpm bake:delete-test --template starter` runs it: build, switch the dev server's asset watcher
off so it cannot re-bake what is about to be deleted, run the scenario, delete every file the
receipt names plus the manifest and the receipt, run the same scenario again, and compare. The
comparison is against a same-code band measured in the same run — captures are not
bit-deterministic — not against an assumed zero.

It went in **red**, and the red was the finding: the loader's no-manifest fallback resolved
`<basePath>/<logical path>`, which in a compiled project points at nothing, because the sources live
in `assets/` and the outputs are content-addressed. A logical path now resolves against an ordered
candidate list — verbatim first, then the source directory — and the gate is green. It runs as part
of `pnpm test:templates`, not in CI: the delete-test compares captured frames, and the CI job that
scaffolds templates deliberately runs only non-visual scenarios because its runner has no GPU. A run
there reports `frames: 0`, which is the runner, not the game. The account is in
`docs/verification/bake-delete-test-2026-08-31.md` and `delete-test-passes-2026-09-01.md`.

## Embedded model textures

| Setting | Default | Override |
| --- | --- | --- |
| `assets.models.sharedImages` | `true`: write each distinct image once under `shared/images/` | `false` embeds and re-encodes duplicate images in every model |

With no asset config, models share their content-addressed images across the build and reuse the
store on later builds. Tiny images retain their original bytes when KTX2 would grow the download
without reducing resolution; an explicit slot codec override can still force compression.
Automatic cooking also retains sources whose encode dimensions are not divisible by four,
without changing their bytes or dimensions. The report and manifest name `block-size` as the
reason; these retained bytes still count toward the uncooked budget. An explicit compression
codec override rejects an unaligned image, while `codec: "none"` remains available.

The images inside a `.glb` go through the pipeline too, on by default. A prop carrying three
2048x2048 JPEGs is a small file and about 64 MiB of VRAM once the driver decodes it, so each
embedded image is transcoded to KTX2/Basis (UASTC for normal maps, ETC1S for colour and
metallic-roughness) and capped to a maximum resolution. The compiled model declares
`KHR_texture_basisu`; `ctx.assets.model()` wires three's shared, support-detected `KTX2Loader`
for exactly those files, and the Basis transcoder is copied next to the compiled assets even in
a project that has no standalone texture at all.

```ts
assets: {
  models: {
    // Defaults: every image compressed, longest edge capped at 2048.
    textures: { maxSize: 1024, quality: 150, overrides: [{ slot: "normalTexture", codec: "uastc" }] },
    // Off unless declared: the one stage that removes triangles on purpose.
    simplify: { ratio: 0.5, error: 0.001 },
  },
}
```

`models: { textures: "none" }` ships every image exactly as authored. Measured on an 11.2 MB
sandbox prop with three 2048x2048 JPEGs:

| Setting | File | Embedded images | Estimated GPU bytes |
| --- | --- | --- | --- |
| geometry only (`textures: "none"`) | 10.74 -> 7.74 MiB | untouched | 64.00 MiB |
| default (`maxSize: 2048`) | 10.74 -> 6.13 MiB | 6.93 -> 5.33 MiB | 10.67 MiB |
| `maxSize: 1024` | 10.74 -> 2.30 MiB | 6.93 -> 1.49 MiB | 2.67 MiB |

The pass verifies its own output: every embedded image is re-read from the written `.glb` and
compared against what went in for the material slot and UV set it is bound to, so a texture the
encoder or the writer dropped fails the build instead of shipping.

## LOD simplification

Off unless `models.simplify` is declared: it is the one stage that removes triangles on purpose,
so it trades the pass's exact triangle guarantee for a bounded one — joints and clips still
compared exactly, triangles required to fall but stay above a floor derived from the ratio, and
the bounding box held to 1% instead of 0.1%.

**How far can a ratio go before the silhouette changes?** Measured, not guessed: a 99,482-triangle
candelabrum rendered at the condition it is played at — scaled to 3 m tall, camera 3 m from its
centre, the framework's default 60° vertical fov, 1920x1080, twelve azimuths — with the coverage
mask compared against the unsimplified baseline by exact Euclidean distance transform.

| ratio | triangles | worst IoU | mean outline shift | p99 | max |
| --- | --- | --- | --- | --- | --- |
| 0.75 | 74,608 | 0.998 | 0.03 px | 1.0 px | 1.0 px |
| 0.50 | 49,738 | 0.997 | 0.05 px | 1.0 px | 1.0 px |
| 0.35 | 34,818 | 0.995 | 0.11 px | 1.0 px | 1.4 px |
| **0.25** | **24,870** | **0.992** | **0.17 px** | **1.0 px** | **3.2 px** |
| 0.15 | 15,126 | 0.985 | 0.35 px | 3.2 px | 16.0 px |
| 0.10 | 15,152 | 0.984 | 0.36 px | 5.1 px | 21.0 px |

**0.25 is the floor for a hero prop at that distance.** Down to it the outline moves at most one
pixel over 99% of its length — a quarter of the triangles for a silhouette that cannot be told
apart. Below it the simplifier starts removing whole features (the 16–21 px maxima are candle
wicks and tracery openings disappearing), and that is visible without an A/B. A seven-branch bar
of 42,904 triangles behaves the same way: 0.25 costs 1.0 px, 0.15 costs 4.0 px.

`error` is the quality guard, not the target — it is the largest a vertex may move as a fraction
of mesh extent (default 0.001, so 3 mm on a 3 m prop). It is what holds candela at 15.2% when the
config asks for 5%; reaching a true 10% needs `error: 0.005`, and no value looser than that
reduces further. Because that gap is silent by nature, the compile step prints both numbers:

```
simplified candela.glb: 99482 -> 15104 triangles (15.2% kept, requested 5.0%) — the error tolerance 0.001 stopped it short
```

Android QuickJS and iOS JSC have no WebAssembly and therefore no Basis transcoder. The build
automatically skips the unsupported texture and model passes for those targets; games do not
need an `assets.models: "none"` override. Already-compressed source assets still fail native
preflight when their required decoder is unavailable.

## Static lightmaps

Opt a project's existing model pipeline into deterministic UV2 generation and offline static-light
baking through `threenative.config.ts`:

```ts
assets: {
  models: { lightmap: { atlasSize: 1024, padding: 4 } },
}
```

Games still load the logical `.glb` with `ctx.assets.model()`. The compiler writes standard
`TEXCOORD_1` data and a content-addressed KTX2; the runtime attaches it through Three.js
`material.lightMap`. Removing the `lightmap` config removes the pass. Android and iOS builds still
fail closed on KTX2 because those native hosts do not yet carry a decoder.

| Proof | Result |
| --- | --- |
| Deterministic compile | Independent fresh directories produced byte-identical GLB, KTX2, and manifest hashes. |
| Ordinary consumer | Stock `GLTFLoader` + `KTX2Loader` loaded the compiled binary paths without `@threenative/core`. |
| Web gameplay | Packed-tarball sandbox required `material.lightMap` before reaching the goal could win. |
| Negative control | Setting `material.lightMap = null` made `staticLightReady` and the win assertion fail. |
| Native status | Linux desktop rendered the packed GLB/KTX2 with a clean playtest; Android/iOS still fail closed because their hosts have no KTX2 decoder. |

## Audio conditioning

`AssetKind` classified `.ogg`, `.wav` and `.mp3` as audio from the beginning and nothing acted on
it, so audio was classified and then shipped through untouched. This pass does the conditioning a
game should never hand-roll, and — like the model pass — measures its own output rather than
trusting that the chain behaved.

Which clips loop, which are positional, and what a clip is *for* are facts only the game knows, so
every one of them is declared. There is no filename convention: a pass that decided `chime.ogg`
must be a chime would be confidently wrong on the first asset named against it.

```ts
assets: {
  audio: {
    overrides: [
      { glob: "audio/*-bed.ogg", loop: true },
      { glob: "audio/music/*.ogg", loop: { crossFadeMs: 0 } },
      { glob: "audio/step-*.ogg", positional: true, spectrum: { band: "sub", maxPercent: 15 } },
      { glob: "audio/landmark.ogg", spectrum: { band: "high", minPercent: 40 } },
    ],
  },
}
```

| Declaration | What it turns on |
| --- | --- |
| `loop: true` | Equal-power tail-onto-head cross-fade, then the seam assertion below. |
| `loop: { crossFadeMs: 0 }` | Keeps the clip's own length — a bar-accurate musical loop — and still asserts the seam. |
| `loop: { spliceToleranceMs }` | How far the splice may move to find a quiet join. Default 25 ms. |
| `positional: true` | Mono downmix, which halves the decoded cost as well as the wire cost. |
| `spectrum: { band, minPercent }` | Fails the build when too little of the clip's energy is in the band it is for. |
| `spectrum: { band, maxPercent }` | Fails the build when too much of it is somewhere it should not be. |
| `normalise: "peak"` | Lifts a quiet clip to the ceiling. Off by default: see below. |
| `peakDb` | The ceiling, in dBFS. Default `-1`. |
| `conditioning: "none"` | Ships the bytes as committed. Measurement, and a declared loop's assertion, still run. |
| `assets.audio: "none"` | Drops the pass, exactly as `textures: "none"` drops the KTX2 pass. |

**Ogg Vorbis is forced, not preferred.** `packages/runtime-native`'s `decodeAudioFile` implements
exactly RIFF/WAVE and Ogg Vorbis, compiled into desktop, Android and iOS alike, so an MP3 asset is
silent on every native target. The pass therefore reads only those two containers and fails the
bake, naming the file and the re-encode command, rather than letting a build reach a player and
play nothing. Both codecs are in-process WASM — as with the KTX2 pass, users install nothing extra
and there is no `ffmpeg` in the install story.

**Content is the check that matters most.** The hand pass this replaces got every join right and
never looked at what was *in* the clips: it shipped a chime that was 83% low-mid where a struck bell
should be, and fifteen footsteps carrying up to 45% of their energy below 100 Hz — a band a wood has
nothing in, and which spends a phone speaker's whole headroom on something nobody can hear. A seam
check alone would have caught neither, which is why both a floor and a ceiling are declarable.

Bands are named, not measured in Hz, and the names and edges are the audio inspector's own — `sub`
(0-100 Hz), `low` (100-500), `mid` (500-2k), `high` (2k-8k), `air` (8k-Nyquist) — so a game declares
one band in one vocabulary and means the same thing to the build gate and to
`packages/playtest`'s inspector. Percentages are on the same 0-100 scale for the same reason. Every
clip's full five-band profile is measured and reported whether or not a bound was declared.

**The seam is judged as a ratio, not a magnitude.** A click is a step that is anomalous *where it
happens*: the same 0.02 jump is inaudible under a dense bed and an obvious tick in near-silence, so
an absolute bound condemns loud clips and excuses quiet ones. What the pass measures is the wrap
step against the 99th-percentile ordinary step within 50 ms of the join, and the default limit is
`1.5x` — not `1.0x`, because a flawless wrap that lands on the signal's steepest point legitimately
*is* the largest step in its neighbourhood, and a looped pure sine scores `1.000000000000223` there
on float error alone. This is the same measurement `packages/playtest`'s audio inspector makes, so
the build gate and the inspector cannot disagree about one file; `audio-seam-parity.spec.ts` pins
them together.

It is measured on the **decoded output bytes**, because a cross-fade that is exact in the
intermediate PCM and undone by the encoder is still a click in the player's ears.

**The fade length is not a lottery ticket, and this was checked rather than assumed.** After a
tail-onto-head cross-fade the wrap step is exactly the source's own adjacent-sample delta wherever
the splice lands, so with a fixed fade length the *bare step* is a draw from the material's step
distribution — on one real bed it moved from 0.0084 at a 250 ms fade to 0.0807 at 400 ms, a spread
that would make a magnitude gate's verdict luck. In the ratio the gate actually reads, the same
sweep over 17 fade lengths and three real beds stays between 0.00x and 0.89x and never reaches the
1.5x limit, because the numerator and denominator move together. The pass also searches a declared
tolerance for the quietest join, which takes it to 0.00x at every fade length tested and 0.00x-0.23x
after a real encode.

The one configuration that can still lose that lottery is `spliceToleranceMs: 0`, which pins the
fade where the declared length puts it. When the gate fires it says which situation the build is in
— splice pinned, no fade at all, or a search that had room and found nothing — and it deliberately
never offers raising `seamMaxRatio` or walking `crossFadeMs` as the way out, because a throwing gate
people learn to tune around is worse than no gate.

**The peak is a ceiling, not a target.** Normalising every clip up to one level would make a
footstep as loud as a chime and force the game to undo the pipeline in its volume settings — that
is deciding how the game sounds, and it belongs to the game.

**A pass with nothing to do says so.** A source that is already Ogg Vorbis, already the right
channel count, under the ceiling and carrying no DC is shipped byte-identical, because re-encoding
it would cost a generation of lossy Vorbis to deliver the same audio.

Measured over one game's nineteen generated clips: the three declared beds cross-fade to seam
ratios of `0.10x`, `0.03x` and `0.10x`, and the other sixteen pass through byte-identical. The
declared-band checks fail the build on both of that game's real defects — the chime that came back
a hum, and the footsteps built out of sub-bass — neither of which any seam check would have seen.
