# Mobile is not shippable: no UI, 18 fps, intermittent SIGSEGV, and a build lane nobody can run

**Status:** open — 4 of 12 fixed and committed, 1 gated on a release, 1 diagnosed to the wrong layer and corrected,
8 recorded with evidence and not yet fixed
**Severity:** blocker — a game built with this framework has no user interface on Android, runs at
30% of the display's refresh rate, and its Android build cannot be produced from a clean install of
the published packages
**Reported:** 2026-08-23, from runs on a physical Pixel 8
**Repository:** ThreeNative (`packages/assets`, `packages/runtime-native`, `packages/ui`,
`packages/create-threenative`)
**Full evidence:** `docs/verification/mobile-stability-2026-08-23.md`

Device: Pixel 8 (`37251FDJH0037Z`), Mali-G715, Vulkan, V8, **60 Hz** display. Game:
`sandbox/fps-framework` (Bayview), `com.threenative.bayview`. Every number below was executed on
the physical device — no emulator, no simulator, no desktop substitute.

---

## Index

| # | Bug | Severity | Layer | Status |
| --- | --- | --- | --- | --- |
| [1](#bug-1) | Health report kills any build using `EXT_texture_webp` | blocker | `packages/assets` | **fixed** `36831d96` |
| [2](#bug-2) | No HUD, no loading screen, no touch controls on native | blocker | templates (**regression**, `0aaacc12` + `acabc39d`) | open, **cause found** |
| [3](#bug-3) | 18.3 fps — 68% of the frame is JS outside the renderer | blocker | `packages/runtime-native` / core | open, diagnosed — **shadows ARE a lever**, 46.15→35.20 ms; see below |
| [4](#bug-4) | Intermittent SIGSEGV, no tombstone | high | `packages/runtime-native` | **fix landed** `89c785ef` — device proof open |
| [5](#bug-5) | Android APK not reproducible from the repo | high | `packages/runtime-native` | **fixed** — PRD-211; emulator boot proof 2026-10-07 |
| [6](#bug-6) | Published install cannot build for Android | high | `packages/runtime-native` | **gated** `8df8e6b2` — clean-room gate green offline; real release waits on PRD-078 |
| [7](#bug-7) | `catalog:` specifiers leak into the published tarball | high | publishing | **fixed** `439b9fd7` — tarball specifier census in `publish:check` |
| [8](#bug-8) | 393 MB of GPU resources requested, 828 MB held | medium | game + driver | open, **attributed** — a ~480 MiB floor, not a 2.11x multiplier |
| [9](#bug-9) | Render loop keeps drawing with the screen off | medium | `packages/runtime-native` | **fix landed** `89c785ef` — device proof open |
| [10](#bug-10) | Preflight claims no libwebp; the runtime has it | low | `packages/runtime-native` | **fixed** `01ec0658` — capability derived from the build; device proof open |
| [11](#bug-11) | Runtime could not report its own GPU memory | low | `packages/runtime-native` | **fixed** `d6e21511` |
| [12](#bug-12) | Every surface resize permanently costs ~64 MiB | **high** | driver / `packages/runtime-native` | open, measured |

**Not a bug:** landscape orientation. `android:screenOrientation=0` is in the manifest and a live
screencap is 2400×1080 landscape with the scene correct. My first capture was black and portrait
because I took it before the surface had presented.

---

<a id="bug-1"></a>
## Bug 1 — the asset health report kills any build using `EXT_texture_webp`

**Severity:** blocker. **Status:** fixed, `36831d96`.

### The convention this establishes

Stated by the owner on 2026-08-23, and binding beyond the fix:

> **UI / HUD / etc should be available on all platforms, always, and we should have tests that
> prevent this from happening again.**

That is a convention in the root AGENTS.md sense — it ships **on by default**, working and
discoverable before any game asks, with a named override on the same object, and **turning it off
must not turn its measurement off**. It is not a per-template HUD check.

The gate it requires has two axes, and neither may be a hand-written list:

| Axis | Derived from |
| --- | --- |
| every template | `readdir` of `templates/` — a template with no UI is a **failure**, not an absence |
| every platform that template claims | the template's own config — browser, desktop native, Android today |

The cell that matters is **(template x platform) → UI observed on screen**. A template that
supports a platform and has no UI proof on it is red. iOS is named **unproven** rather than
omitted: there is no physical lane on this machine, and claiming a platform that did not execute is
exactly what this batch's acceptance forbids.

**A source-presence check is not sufficient, and this bug proves it twice.** The HUD deletion would
have been caught by one. The web-mobile defect would not: `platformer` has `touch-controls.ts` on
disk, wired, 175 lines — and `isNative() && isMobile() && isTouchscreenAvailable()` means it never
appears in a mobile browser. Source present, feature absent, on a platform nobody had looked at.
So each cell needs a runtime half wherever a lane exists.

Where a browser lane stands in for a native one, that substitution must be stated. It is legitimate
for camera-parented geometry — PRD-209 measured `pixelMismatchRatio` 0 against the browser
reference on all three native lanes — but the record must say which cells were executed and which
were inferred from that equivalence.

### What happens

`threenative build --target android` on a game whose model is an ordinary webp GLB compresses every
texture, then exits 1:

```
TN_ASSETS_MODEL_UNREADABLE: could not parse 'models/enemy-terrorist.glb' for the health report:
Missing required extension, "EXT_texture_webp".
```

No APK is produced.

### Root cause

`packages/assets/src/health.ts` built its reader with a bare `new NodeIO()`, while
`packages/assets/src/passes/model.ts` registers `ALL_EXTENSIONS` through `createIo()`.
glTF-Transform refuses any document whose `extensionsRequired` names an extension the reader was
not told about.

The report is advisory — it measures triangles, texture sizes and licences. It was deciding whether
builds run.

### Fix

Register `ALL_EXTENSIONS` in `parseModel`. Red test at
`packages/assets/__tests__/health.spec.ts:378`; green at 13/13, including the existing "refuse an
unreadable model" case, so genuinely broken files still fail closed.

---

<a id="bug-2"></a>
## Bug 2 — a native game has no user interface at all

**Severity:** blocker. **Status:** open — but the fix layer is now **decided by measurement, and it
is not `packages/`**. PRD-209's Phase 0 spike ran the portable text path on web, Linux desktop
native, the Android emulator and a physical Pixel 8: one unbranched source, 2 152 bright glyph
pixels and bounds `[49,56,313,85]` on every lane, `pixelMismatchRatio` 0 against the browser
reference on all three native lanes, and legible on each capture. The SDF-atlas alternative costs
53 % more source and renders `SCORE 1200` as `2COKE ]500`. Candidate **E is withdrawn**: the game's
cost under candidate G is three statements, so there is nothing a `@threenative/core` text surface
would remove. What shipped instead is the convention, in the templates' `AGENTS.md`, where an agent
reads it. Evidence: `docs/verification/prd-209-2026-08-23.md`. The remaining half of this bug —
touch controls, and which HUD layer each React template should pick — stays with PRD-055.

### What happens

On Android the game renders its world correctly and shows **no HUD, no crosshair, no minimap, no
loading screen and no touch controls**. The player has no readouts and, on a phone, no way to move.

### Evidence

Checked against the APK actually installed on the phone, pulled from `/data/app/…/base.apk`:

```
LOADING occurrences:    0
createRoot occurrences: 0
```

### Root cause

**CORRECTED 2026-08-23: this IS a regression.** The original entry below called it "structural, not
a regression". That was wrong, and the owner's recollection that it used to work was right.

Every template shipped a working, camera-parented, native-capable geometry HUD, and `starter`
shipped a native loading screen. They were deleted on **2026-08-15**:

| Commit | Deleted |
| --- | --- |
| `0aaacc12` "land the production-readiness batch (PRD-110 to PRD-116)" | `starter/src/render/hud.ts` (53 lines, `InstancedMesh` glyphs, `camera.add(root)`), plus `render/loading.ts`, `render/particles.ts`, `pick.ts` and `scenes/Boot.ts` |
| `acabc39d` "rounds 9 and 10 — the framework loses the visual column, and **the templates are below their own floor**" | `src/render/hud.ts` from `defense`, `platformer`, `racing` and `shooter` |

**Scope: every template except `minimal` has no native HUD today.** Five lost one to those two
commits; `action-rpg` postdates both and never had one.

Both were reached from the **portable scene**, which is exactly what the native entry runs.
`starter/src/scenes/Play.ts` before the deletion:

```
:8   import { createHud } from "../render/hud.js";
:10  import { createLoadingScreen } from "../render/loading.js";
:63  const loading = createLoadingScreen(ctx);
:71  createHud(ctx.camera as PerspectiveCamera, "SCORE", "ITEMS"),
```

The React `Hud.tsx` **already existed alongside it**. Web got React, native got geometry, and the
two coexisted by design. The deletion removed the native half and left only the half that cannot
run on a phone.

**Correction to this correction (same day): the loading screen is NOT missing.** An earlier draft
of this entry listed `loading.ts` as deleted and unrecovered. It was deleted at `0aaacc12` and then
re-added twice, at `97a6ea8b` and `930569b3`; today's version is ~10 KB, exists in **all six**
templates, and is already called from the portable scene (`starter/src/scenes/Play.ts:98`,
`:192`). It draws through `ctx.canvasLayer` — an `OrthographicCamera` and `Scene` rendered by
`renderer.renderOverlay` (`packages/core/src/game.ts:600-602`) — with no DOM on that path, so the
backdrop, track and progress fill **already render on native today**.

The real gap is narrower and worth stating exactly: the only *textual* part, `statusMesh()` at
`loading.ts:84`, is a `CanvasTexture` over `document.createElement("canvas")` that bails on
`typeof document === "undefined"`, and it is `showStatus: false` by default anyway. **An Android
player gets a progress bar with no percentage.** Drawing that readout with the same bitmap-glyph
mechanism as the HUD also removes the last `CanvasTexture` from the template render path.

**A second platform has the same defect, unnoticed.** `platformer` does ship touch controls —
`src/render/touch-controls.ts` (175 lines) and `touch-layout.ts` (63), an anchored thumbstick wired
at `Level.ts:56`. Its gate is `isNative() && isMobile() && isTouchscreenAvailable()`, so the
controls **never appear in a mobile browser**: a phone on the web target has had the same "no way
to move" as the phone on Android. The investigation only ever looked at Android, so nobody saw it.
No other template has any touch input.

So the deeper defect is not the missing HUD. **The gate did not fail to notice — the same commit
deleted the feature and the gate's coverage of it, together.**

`packages/create-threenative/__tests__/template.spec.ts:25` holds the guard's coverage as a
hand-edited constant:

```ts
const geometryHudTemplates = ["minimal"] as const;
```

`acabc39d` — the commit that deleted `hud.ts` from `defense`, `platformer`, `racing` and
`shooter` — contains exactly this hunk:

```diff
-const geometryHudTemplates = ["minimal", "platformer"] as const;
+const geometryHudTemplates = ["minimal"] as const;
```

The HUD assertions were never bypassed or weakened. They were simply pointed at a shorter list, in
the same change that removed what they would have caught, and the suite stayed green. `pnpm
budgets` then reported the result as a template-LOC improvement, so the deletion **scored as a
win**.

That is the class of defect worth fixing, not the missing glyphs: **a gate whose own coverage is a
hand-maintained enumeration protects nothing, because deleting a feature and deleting it from the
list are the same size of edit and neither is loud.** The list must be derived from what exists —
every template gets asserted, and a template without a HUD is a failure rather than an absence.
This repository has been bitten by the identical shape before: five parallel package enumerations
where `@threenative/assets` landed in only one, redding two gates. The templates were scored
"below their own floor" on LOC, and the lines that went were the ones that made the game usable on
a phone. Any fix that restores the HUD without adding that gate will be undone by the next
tidy-up round.

What follows was the original, incorrect analysis, kept because the mechanism it describes is
still accurate for the React layer: `threenative.config.ts` sets `nativeEntry: "src/game.ts"`. Every UI
piece — `Hud`, `DebugOverlay`, `GameCanvas`, `Minimap`, `TouchOverlay` — mounts from `src/main.ts`
via React DOM, which the native host never executes. The loading readout is `Hud.tsx:243`.

The build guard `TN_NATIVE_WEB_ONLY_UI` exists precisely to make this loud, and `PRD-051` chose it
deliberately (candidate D: `@threenative/ui` stays web-only). `PRD-055` reopened the decision with a
real game's evidence and is parked in `docs/PRDs/BLOCKED/requires-touch-evidence/`, recommending
"**G now, E next**".

### Why this is a bug and not a design choice

`/AGENTS.md` states that a feature working on web only is unfinished. The UI is the part of a game
a player reads. Today it works on exactly one of three targets.

### Fix direction (decided by João, 2026-08-23; revised by measurement, PRD-209 Phase 0)

The direction as filed was framework work in `packages/` — PRD-055 candidate **E**: the framework
ships portable screen-space text and nothing else. PRD-209's Phase 0 was the spike that priced
that, and it came back **G-only**.

The prior art it named — `templates/minimal/src/render/hud.ts`, 69 lines, a 5×7 bitmap font drawn
as an `InstancedMesh` of quads — turned out to be the whole answer. It already renders identical,
legible text on all four lanes measured, and it already costs the game three statements: an import,
`createHud(...)`, and `hud.update(...)`. A package surface would have to re-expose the glyph table,
colour, size, anchor, labels and update timing as options — a widget with extra steps, and a rule 3
violation. Conformance rows `25-camera-parented-overlay`, `30-screen-space-text` and
`31-hud-readout-updates` all pass on web, desktop native and the emulator; row 30 also passes on the
physical Pixel 8.

So the real defect was never a missing mechanism. It was that nothing told the agent the mechanism
existed or that the React one does not run: `starter/AGENTS.md` called a native HUD optional
(*"only if your game needs one"*), and `minimal/AGENTS.md` described a DOM readout its own
`main.ts` does not have. Both now state the rule and name the file to copy.

---

<a id="bug-3"></a>
## Bug 3 — 18.3 fps, and 68% of the frame is JavaScript outside the renderer

**Severity:** blocker. **Status:** open, diagnosed.

> **Correction, 2026-08-23.** Any statement in this section that shadows were refuted as the lever
> is **withdrawn**. The bundle the 20:18 measurement ran from
> (`sandbox/fps-framework/.threenative/build/game.js`, mtime 20:13, shipped as
> `dist-native/bayview-noshadow.apk`) disabled `shadowMap` and cleared `castShadow` on every light
> *before the measurement window opened* — the `KILL_SHADOWS` constant was folded away as
> always-true by the bundler — so the comparison was a shadows-off build against itself. No
> pre-kill capture survives anywhere in the sandbox tree or `docs/`; `gpuMemoryProbe.ts` was
> untracked, so there is no history to date one by. **Shadows are untested, not refuted.**
> PRD-214 Phase 0 carried a shadows-ON baseline as R0 and shadows-off as R1.
>
> **Measured 2026-08-23, physical Pixel 8 (192.168.1.192:5555), 11 rungs from one build, 180
> presented frames per window, one settle window discarded before each. Shadows ARE a lever.**
>
> | rung | fps | presented p50 (ms) | render p50 (ms) | render share | visible meshes |
> | --- | --- | --- | --- | --- | --- |
> | R0-baseline (shadows ON) | 16.89 | 58.96 | 46.15 | 0.785 | 492 |
> | R1-shadows-off | 20.37 | 48.74 | 35.20 | 0.729 | 822 |
>
> Turning the shadow map off took `renderer.render()` p50 from **46.15 ms to 35.20 ms** — about
> 11 ms — *while drawing more objects* (822 visible against 492). The original "refuted" reading
> was an artefact of comparing a shadows-off build against itself.

### What happens

The game presents at **18.3 fps** on a 60 Hz display — 30% of refresh.

It does **not** look like 18 fps to a person holding the phone, which is why this went unreported
for so long. The compositor explains that: `droppedFrames = 0`, `jankyFrames = 0`. The pacing is
perfectly even, so it reads as "soft" rather than "broken".

### Evidence — two independent instruments

| Instrument | Reading |
| --- | --- |
| `TN_PRESENTS_TICK` (engine) | 60 frames per 3.27 s → **18.3 fps** |
| `dumpsys SurfaceFlinger --timestats` (compositor) | `totalFrames = 366` over ~20 s → **18.3 fps** |

`frames` and `presents` match exactly at every tick under `fifo` vsync, so every counted frame
reaches the screen.

### Where the frame goes

Built with `-PthreenativeJsProfile=true`, at 54.6 ms/frame:

| Component | ms | share |
| --- | --- | --- |
| JS→native WebGPU bindings | ~5.5 | 10% |
| Submit poll | ~0.7 | 1% |
| Present wait (GPU) | ~10.9 | 20% |
| **Unaccounted — JS/CPU outside the render bindings** | **~37** | **68%** |

The game's own sections, logged on a device for the first time (`TN_FRAME_STATS`, 1799 frames):

```json
{"frames":1799,"p50":3.72,"p95":65.75,"p99":75.68,"worstMs":27489.89,
 "spikes":395,"playSpikes":376,"playFrames":1709,
 "sectionP99":{"effects":0.21,"audio":0.11,"player":0.12,"enemies":5.13,"state":0.07,
               "gameFrame":5.72,"physics":1.25,"outsideGame":65.87}}
```

1. **`outsideGame` p99 = 65.87 ms vs `gameFrame` p99 = 5.72 ms.** The game's own code is not the
   problem by an order of magnitude. `outsideGame` is the engine side — physics step, scene
   projection, draw.
2. **The distribution is bimodal**: p50 = 3.72 ms, p95 = 65.75 ms, 376 spikes in 1709 play frames
   (**22%**). Mostly-fast frames punctuated by very slow ones.

### Honest caveat

`p50 = 3.72 ms` is below the 16.67 ms vsync floor, so `markFrame` runs more often than once per
presented frame — most likely once per fixed-step simulation step (`maxSteps` defaults to 5). The
*ratios between sections* are trustworthy; the absolute p50 is not a frame time. `worstMs: 27489.89`
(a 27-second sample) also needs explaining before it is trusted. Both are open questions, not
results.

### Correction to an earlier line of attack

I initially pursued GPU memory as the FPS cause and was heading toward texture compression. The
profile says the frame is CPU-bound in JS, so that was the wrong lever. Recorded here so the next
person does not repeat it.

### Next action

CPU-profile `outsideGame`. Not more texture work.

---

<a id="bug-4"></a>
## Bug 4 — intermittent SIGSEGV with no tombstone

**Severity:** high. **Status:** open; leading hypothesis only, **not proven**.

### What happens

`dumpsys activity exit-info` recorded three crashes, all `reason=2 (SIGNALED) status=11` (SIGSEGV):

```
18:32:41  pid 22109
18:37:31  pid 22737   (49 s after launch)
18:40:03  pid 23011   (93 s after launch)
```

A fourth exit at 18:34:56 was `reason=10 (USER REQUESTED)` carrying **`rss=2.3GB`**. No tombstone
was written for any crash.

### Hypotheses tested and rejected

| Hypothesis | Test | Result |
| --- | --- | --- |
| Screen-off / surface destroyed | `KEYCODE_SLEEP`, 60 s with screen off | survived, no crash |
| Growing memory leak | `GL mtrack` sampled repeatedly | bit-identical `848124` KB — one-time, not per-frame |
| Round-clock restart | ran well past the 1:45 round | survived |

A later unattended run survived **10 min 44 s** and died only to `am force-stop` (signal 9).

### Leading hypothesis

All three crashes happened while relaunching on top of a still-winding-down 1.5 GB instance. An
unchecked native allocation failure under memory pressure produces exactly `SIGNALED/11` with no
tombstone. Consistent with everything observed; **not demonstrated**.

### Next action

Audit unchecked allocation returns in the WebGPU bindings; reproduce under deliberate memory
pressure.

### Update, 2026-08-24 — PRD-210 Phases 1-2 landed

The no-tombstone half was self-inflicted and is fixed: `runtime.cpp` installed `signal()` handlers
for SIGSEGV/SIGABRT/SIGBUS/SIGTRAP/SIGILL on every platform, replacing the dispositions Android's
zygote had chained debuggerd into, so any crash after startup exited `SIGNALED status=11` and wrote
nothing. Android now installs no handler at all. The ranked unchecked wgpu handles throw to JS
naming the operation instead of arming an FFI fault, with the raw SIGSEGV reproduced in a contained
child process as the negative control.

**The crash itself is still unnamed.** This makes the next one nameable; it did not catch this one.

**Proven on the physical Pixel 8, 2026-08-23 22:04.** Same binary, same deliberate post-startup
fault, one variable. With the handlers left to the platform: a new symbolized `data_app_native_crash`
tombstone naming `crashDeliberately() -> pollEvents() -> run() -> SDL_main`, recorded by exit-info
as `reason=5 (APP CRASH(NATIVE)) status=11`. With the pre-fix handlers reinstated
(`debug.threenative.prefix_handlers=1`): no dropbox entry at all, and exit-info reads
`reason=2 (SIGNALED) subreason=0 (UNKNOWN) status=11` — the 2026-08-23 signature, character for
character. Evidence: [`../verification/prd-210-2026-08-23.md`](../verification/prd-210-2026-08-23.md).
The device proofs — a symbolized tombstone in dropbox, and the relaunch-over-pressure cycles — are
open and listed in [`../verification/prd-210-2026-08-23.md`](../verification/prd-210-2026-08-23.md).

---

<a id="bug-5"></a>
## Bug 5 — the Android APK cannot be reproduced from this repository

**Severity:** high. **Status:** fixed — the runtime decodes Ogg Vorbis; proof in `docs/PRDs/done/PRD-211-android-asset-lane-boots-from-repo-assets.md`.

### What happens

Building the Android APK from the repo's own assets produces an app that dies at boot:

```
TN_NATIVE_START_FAILED: decodeAudioData could not decode the supplied audio.
```

### Evidence

The `.ogg` files inside the **working installed** APK begin `52494646` — `RIFF`, i.e. WAV data under
an `.ogg` extension. The repo's `public/` files begin `4f676753` — `OggS`, genuine Ogg.

Someone hand-transcoded a staging copy that does not exist in the repository. The shipped app cannot
be rebuilt from source.

### Root cause

`packages/runtime-native/scripts/asset-preflight.mjs` states outright that it "does not transcode" —
it detects undecodable assets and prints `ffmpeg`/`gltf-transform` commands for a human to run. So a
working Android build depends on a manual out-of-band step that is recorded nowhere.

### Fix direction

Either the pipeline stages and transcodes for the target, or the staging step becomes a recorded,
runnable command. A build that only works after undocumented manual surgery is not a build lane.

---

<a id="bug-6"></a>
## Bug 6 — a published install cannot build for Android at all

**Severity:** high. **Status:** open. Related: PRD-196.

### What happens

In a sandbox that installs the packages the way a user's machine would:

```
Prebuilt release manifest fetch failed for 'android-arm64-v8a-runtime': HTTP 404.
```

### Root cause

The installed `@threenative/runtime-native@0.2.0` contains **zero** occurrences of
`THREENATIVE_RUNTIME_SOURCE`, so the source-checkout escape hatch added by PRD-196 is unreachable
from a published install. The build falls through to downloading a GitHub release that has never
been published — this repository has zero surviving releases across ten tags (PRD-078).

### Workaround used this session

Drive the engine's own `packages/runtime-native/scripts/package-android.mjs` directly with
`THREENATIVE_RUNTIME_SOURCE` pointed at `packages/runtime-native`. Not available to a user.

---

<a id="bug-7"></a>
## Bug 7 — `catalog:` specifiers leak into the published tarball

**Severity:** high. **Status:** open.

### What happens

Packing the current `@threenative/runtime-native@0.3.0` from the engine and installing it into a
non-workspace project fails. npm reports it plainly:

```
packages within the pnpm workspace may use catalogs. Usages of the catalog
protocol are replaced with real specifiers on 'pnpm publish'.

This is likely a bug in the publishing automation of this package.
```

`npm pack` does not perform the catalog substitution that `pnpm publish` does, so the tarball ships
unresolvable specifiers. This is the second half of why bug 6 has no workaround: you cannot even
hand-build a replacement package.

---

<a id="bug-8"></a>
## Bug 8 — 393 MB of GPU resources requested, 849 MB held by the driver

**Severity:** medium (contributes to bug 4, not to bug 3). **Status:** open, attributed —
PRD-213, evidence `docs/verification/prd-213-2026-08-23.md`.

### Attributed, 2026-08-23 (physical Pixel 8)

Three corrections to what is written below, all measured, none estimated:

1. **The table mixes units.** `TN_GPU_TEXTURES` prints MiB; the `GL mtrack` figure was kB/1000.
   In consistent MiB it is 393 requested against 828 held — a **2.11x** amplification with a
   **435 MiB** excess, not 456 MB.
2. **It is a floor, not a multiplier.** `GL mtrack` was already 480 MiB at the first presented
   frame, before a single asset texture existed, and grew by only 348 MiB across the whole asset
   load against a 393 MiB request — **0.885x**. The driver does not amplify what the game asks
   for. Budget a fixed ~500 MiB floor plus roughly your own bytes.
3. **It is not a `meminfo` artefact.** `/proc/<pid>/status` `RssFile` minus the sum of file-backed
   `Rss` across `/proc/<pid>/smaps` is 853,816 kB against `GL mtrack`'s 847,764 kB — 0.7 % apart.
   Two independent kernel instruments agree the memory is physically resident.

70.9 MiB of the gap is named exactly (the surface BufferQueue, `EGL mtrack`, invisible to the
engine counter because `wgpuSurfaceGetCurrentTexture` never passes `createTexture`). The
remaining floor's component is still open.

### Measurements

| Source | Amount |
| --- | --- |
| Textures (72) | **379 MB** |
| Buffers (2,976) | **14 MB** |
| Game total | **393 MB** |
| `GL mtrack` (driver) | **849 MB** |
| Process RSS | 1.5–1.6 GB |

Top buckets:

| Bucket | n | MB |
| --- | --- | --- |
| `1536x1536x6 rgba8unorm-srgb` | 1 | 54 |
| `1536x2048 rgba16float` | 2 | 48 |
| `2048x2048 rgba8unorm-srgb mips12` | 2 | 42 |
| `1024x1024 rgba8unorm mips11` | 8 | 42 |
| `1024x1024 rgba8unorm-srgb mips11` | 7 | 37 |
| `3072x1536 rgba8unorm-srgb mips12` | 1 | 23 |

### Two distinct problems

**(a) The game asks for too much.** `src/render/sky.ts` assigns one 3072×1536 equirect JPEG to both
`scene.background` and `scene.environment`. That yields the 54 MB cubemap (background conversion)
*and* 48 MB of `rgba16float` PMREM scratch (IBL). A further ~146 MB is uncompressed 1024²/2048²/512²
textures that would be roughly 18 MB as ETC2/ASTC — the pipeline can already produce those, but
these textures live in `public/` and never enter it.

**(b) The driver more than doubles it**, 393 → 849 MB. That amplification is wgpu/Mali behaviour and
warrants its own investigation.

### Measured experiment

Commenting out `scene.environment = environment` alone:

| | baseline | IBL off |
| --- | --- | --- |
| FPS | 18.3 | **24.8** (+38%) |
| Textures | 379 MB | 331 MB |
| `GL mtrack` | 849 MB | 738 MB |

This corrected an inference: the 54 MB cubemap **survives** with IBL off, so it is the background
equirect→cubemap conversion, not PMREM.

---

<a id="bug-9"></a>
## Bug 9 — the render loop keeps drawing with the screen off

**Severity:** medium (battery). **Status:** open.

`packages/runtime-native/src/` handles `SDL_EVENT_WINDOW_FOCUS_GAINED`, `WINDOW_RESIZED`,
`WINDOW_RESTORED` and `WINDOW_SHOWN` — only the resume half. There is **no** handling of
`WINDOW_HIDDEN`, `WINDOW_MINIMIZED`, `FOCUS_LOST`, `DID_ENTER_BACKGROUND` or `WINDOW_DESTROYED`.

Confirmed on device: frames kept presenting for the full 60 s the screen was off.

### Update, 2026-08-24 — PRD-210 Phase 3 landed

The host now installs an `SDL_AddEventWatch` — the only mechanism that can work, because SDL on
Android queues the background events and then blocks the pump inside `Android_WaitLifecycleEvent`,
so a polled handler runs only after the app is already parked. Backgrounding and minimize set a
paused flag, suspend every live AudioContext through a new host-side registry, and emit
`TN_LIFECYCLE` markers; `display.backgroundMode: "continue"` opts out of the pause without opting
out of the markers. The transition table, the watch and the registry are proven by an executable
that needs no display.

**On the physical Pixel 8, 2026-08-23 22:06:** screen-off stops presenting. One further 60-frame
tick is emitted and then presenting halts, against this bug's recorded baseline of a full 60 s of
continued presenting. Two caveats, both recorded rather than smoothed over: tick granularity is 60
frames, so the "~1 s" bound is consistent with the data rather than measured by it; and no
`TN_LIFECYCLE` marker is observable *while* paused — every marker arrives in one burst on resume,
because the thread that writes them is parked inside SDL's `Android_WaitLifecycleEvent`.

**And resume is now broken**, which is worse than what this bug reported: the loop restarts but
presents nothing, and the player sees black. Filed separately as
[`./resume-presents-nothing-2026-08-23.md`](./resume-presents-nothing-2026-08-23.md). This item is
not closed.

---

<a id="bug-10"></a>
## Bug 10 — preflight rejects webp claiming the runtime lacks libwebp

**Severity:** low. **Status:** open.

`asset-preflight.mjs` refuses a webp GLB for Android with "the android runtime is built without
libwebp", while the same device logs:

```
[Mystral] WebP format support: YES
```

The check is stale relative to `62fac4d5`, and it fails a build closed on a false premise.

---

<a id="bug-11"></a>
## Bug 11 — the runtime could not report its own GPU memory

**Severity:** low (a gap, not a defect). **Status:** fixed, `d6e21511`.

Nothing in `runtime-native` reported how much GPU memory a game holds, so "the process is using
1.6 GB" had no answer inside the engine — it had to be inferred from `dumpsys meminfo` and
arithmetic. Every texture and buffer the WebGPU bindings create is now measured and emitted beside
the present tick, bucketed by dimensions/format and usage bits.

Every number in bug 8 comes from this instrumentation. Package suite after the change: **356 passed,
31 skipped, 0 failed** — that commit also repairs a pre-existing red where
`runtime-next-contract.test.mjs` asserted an `androidDeps` array that `62fac4d5` had changed.

---

## Suggested order of work

1. **Bug 3** — CPU-profile `outsideGame`. It is the blocker a player feels, and it is not where I
   was originally looking.
2. **Bug 2** — PRD-055 candidate E. Without it there is no shippable mobile game regardless of fps.
3. **Bugs 5, 6, 7** — the build lane. These block everyone else's ability to reproduce anything
   here, and they cost this session several hours.
4. **Bug 4** — reproduce under deliberate memory pressure once bug 8 is reduced.
5. **Bugs 8, 9, 10** — real, bounded, lower urgency.

## Reproduction notes

- Wi-Fi adb needs `adb tcpip 5555` over USB first; the cable can then be pulled.
- `adb logcat -G 16M` before any session, or early markers evict.
- A `WAKEUP` keyevent every few seconds stops the screen dozing mid-measurement.
- `dumpsys activity exit-info <pkg>` gives the signal for a vanished process — better than hunting a
  tombstone that may never have been written.
- `dumpsys SurfaceFlinger --timestats -enable` / `-dump` is an fps source independent of the engine.
- Temporary instrumentation lives in `sandbox/fps-framework/src/gpuMemoryProbe.ts`, registered in
  `src/game.ts`. **Delete both when this closes.**

---

## Bug 12 — every surface resize permanently costs ~64 MiB {#bug-12}

**Severity:** high. **Status:** open, measured. **Found:** 2026-08-23 by PRD-213, out of PRD-214's
resolution sweep — neither lane was looking for it.

Filed as its own numbered item rather than folded into bug 4 or bug 8. It is a *defect*, not an
attribution result, and its fix layer is different from either.

### The measurement

From the committed sweep (`docs/verification/prd-213-piggyback-resolution-gl-mtrack.txt`,
physical Pixel 8, one process, `dumpsys meminfo` `GL mtrack`):

| transition | `GL mtrack` delta |
| --- | --- |
| full → 50% | **+65,732 kB**, in one one-second sample |
| 50% → 25% | −408 kB — nothing |
| 25% → full | **+66,212 kB**, in one one-second sample |

None of it comes back.

**The middle row is the control that makes the other two readable.** This is not "any resize costs
64 MiB": two transitions cost ~64 MiB each and one costs nothing. Plateaus between transitions are
flat to 0.5 MB, and a separate fixed-resolution run held a ±0.5 MB band over 60 s. So **at a fixed
resolution, memory is bounded. It is resizing that is not.**

### Why it matters more than it looks

A phone resizes on **rotation** and on entering or leaving **multi-window**. Rotate a few times and
several hundred MiB are gone, permanently, from a process already at 1.4 GiB VmRSS on a device that
begins killing apps under 2 GiB.

That is bug 4's memory-pressure hypothesis arrived at from a completely different direction, by a
lane that was not investigating crashes.

### Hypothesis, explicitly not a finding

The signature fits `gpu-alloc` pooling freed blocks rather than returning them to Vulkan, and the
steps being a whisker over exactly 64 MiB is the coincidence a power-of-two chunk allocator
produces. Unproven.

### The instrument cannot see this, which is its own defect

`g_textureBytesLive` / `g_bufferBytesLive` in `packages/runtime-native/src/webgpu/bindings.cpp` are
never decremented despite the name, and the recorders are wired to one of four texture creation
sites and one of five buffer sites. They would report **nothing at all** for a 64 MiB resize step.
Repairing them needs red-green, `pnpm census` and a native build; PRD-213 filed it with file:line
rather than fixing it blind.

### What would settle it

Rotate the device N times with `GL mtrack` sampled per rotation, on a build whose counters have
been repaired. Three cold launches at three fixed resolutions would separately turn "the floor is a
fixed arena" from consistent-with into proven — those are different questions and want different
runs.
