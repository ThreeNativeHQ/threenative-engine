# Forest leaf appearance — PRD-584 child

**Status:** IN PROGRESS — source/cooked alpha and published budget verified; user still observes squared leaf tips, so final leaf appearance and default-scene preservation remain open
**Priority:** P1 — opaque needle cards remain visible at close range.
**Complexity:** 2 → MEDIUM; risk override: remaining geometry/texture silhouette repair needs runtime identity and visual proof.
**Owner:** parent strata-terrain-hardening lane
**Depends on:** None (remaining forest appearance work belongs to open PRD-584; completed PRD-614 remains closed).

## Context and scope

Layer: game asset preparation. The root reader (`/tmp/prd614-leaf-alpha-root.log`) measured identical opaque twig PNGs in four starter GLBs and four frozen BEFORE GLBs: cut coverage 0%, PNG SHA-256 `a77b3e10ed5702dfb3246deba606fc1e3c68c7899557ce6038d529c10eac596c`. This predates PRD-614 and is already broken before engine cooking. The NVIDIA closeup is `.linchpin/prd614-near-leaves/control-queue-2/near-leaves.png`.

Parent WIP in `examples/strata-terrain-preview/scripts/prep-polyhaven-fir.py` already replaces image Alpha with Color → Separate Color/Red → GREATER_THAN(0.5) → BSDF Alpha and validates exported coverage. Preserve it; do not create a second exporter. Implementation is authorized by `.linchpin/prd614-leaf-alpha-implement.brief`: the existing test, four b/c LOD1/2 GLBs, their two provenance records, this PRD and owned ignored scratch. No commits, builds, GPU runs or unrelated WIP edits.

## Source and measured evidence (2026-10-15)

Official CC0 source: https://polyhaven.com/a/fir_tree_01 (Rob Tuytel, photography; Rico Cilliers, modeling). Official file metadata is `https://api.polyhaven.com/files/fir_tree_01`, saved under `.linchpin/prd614-leaf-alpha-repair/provider-files.json` (the blend/1k/blend subtree). The installed `polyhaven_list_files` returned `POLYHAVEN_UPSTREAM_CHANGED` (file-count limit); direct metadata retrieval with an explicit User-Agent succeeded. Do not raise the shared limit for this repair.

Blend URL: `https://dl.polyhaven.org/file/ph-assets/Models/blend/1k/fir_tree_01/fir_tree_01_1k.blend`; 218986261 bytes; MD5 `a08031ea8ffb49711b294e1c8213a909`; previously recorded SHA-256 `153d20aae6d7c63a4c52689d91e8bead78f6d17a70e11ef4d03d19953383de00` (PRD-584). Restore all 18 declared PNG dependencies under their `textures/` relative paths and verify provider size/MD5. The documented `examples/strata-terrain-preview/local-assets/polyhaven/` source directory is absent; no original blend located in that owned location. Do not search other worktrees.

Only the 371026-byte original alpha PNG was downloaded in this preparation, into the owned ignored directory. URL: `https://dl.polyhaven.org/file/ph-assets/Models/png/1k/fir_tree_01/fir_tree_01_twig_alpha_1k.png`; verified MD5 `02ab808c8b2ff77ad9fdb2f92892db80`; SHA-256 `3f399629337e7ac3af27a01b08ffb9c0d60224a9dd374a1427761a5c2eea9d6e`. Pillow measured RGB 1024×1024, red range 0–255, decoded alpha range 255–255, red < 128 coverage **0.7637729644775391**. Connecting Alpha therefore exports full opacity; connecting Red carries actual needle coverage. Do not substitute the separate twig_mask map.

`command -v blender` returned `/home/joao/.local/bin/blender`; no Blender process was run. Laptop status: load 0.17/0.51/1.67, 16 cores, 21 GB free, 65°C, AC, battery 94%; room available, no job dispatched. Recheck immediately before future jobs. Any export/suite exceeding five minutes uses `~/.agents/skills/laptop-offload/offload.sh`; source bytes are ignored and need explicit transfer to that same owned remote lane. NVIDIA evidence remains on desktop. Remote Blender availability has not been checked.

## Acceptance criteria / execution phases

User correction (2026-10-15): `/tmp/codex-clipboard-N4wOus.png` still shows squared leaf tips. Retain the earlier closeup IMPROVEMENT verdict as historical evidence; it does not prove this remaining appearance requirement. Final acceptance requires the squared tips to be resolved in identified source/cooked/runtime assets and two fresh same-pose headed captures judged independently against natural leaf silhouettes. Aggregate transparent-pixel coverage alone does not establish this outcome.

Fresh CPU diagnosis: `python .linchpin/prd614-leaf-boundary/check.py` exits 0 and observes opaque texels crossing actual card boundaries. Card 865 (triangle 4767 at the recorded closeup pose) has 40/846 opaque boundary samples, including 27 opaque across both sides; a neighbouring card has a 49.06-texel opaque run. This establishes clipping in the inspected source, not the identity or cause of every tip in the user crop. UV plots also show branch attachments crossing card edges, so indiscriminate card expansion is not justified. No geometry repair or new visual verdict is claimed.

Fresh laptop focused check: `pr483-forest-focused-current` terminated with exit 75 before testing (thermal guard); `pr483-forest-focused-current2` ran the five forest-stage, forest-startup, strata-loading, forest-runtime and kit-assets suites and exited 1: 82 passed, 3 failed, 3 skipped. Failures: forest-runtime surface precedence, strata-loading missing built `IWorldPlacementEdits` export, and kit-assets archive hash versus the preserved immutable 0.1.0 pin. These failures remain evidence, not passing acceptance. The laptop job log retains the output; no product or platform gate is claimed.

Follow-up: normal laptop builds of `@threenative/core` and `@threenative/terrain` resolve the surface-precedence and missing-export failures without source edits. Fresh `forest-runtime`, `terrain-consumer` and `strata-loading` suites pass **77/77**, exit 0; output retained in `.linchpin/pr483-focused-repair/laptop-after-build.log`. The initial failures came from stale built JavaScript/declarations. This does not resolve the repaired-asset/published-pin mismatch or prove any browser/native appearance or movement criterion.

### Phase 1: Reproduce from original bytes

- [x] AC-1 [local]: original mask has the measured RGB range and coverage above, while every original starter fir fails the coverage assertion. proof: `pnpm exec vitest run examples/strata-terrain-preview/__tests__/forest-stage.spec.ts -t 'original starter fir'` executed 2026-10-15: 1 test failed with 4 actual assertions, one per original GLB; all had cut coverage 0 (absolute error 0.7637729644775391, required <0.005). Source measurement reproduced red (0,255), alpha (255,255), coverage 0.7637729644775391. Eight unrelated tests filtered. Actual output retained in ignored `.linchpin/prd614-leaf-alpha-repair/red.log`.

Reuse `exportedCut` and `SOURCE_CUT` in that existing test file. Add `fir_tree_01_twig: 0.7637729644775391` and an **always-running** test named “original starter fir” over checked-in `packages/terrain/starter-assets/fir_tree_01/fir-{b,c}-lod{1,2}.glb`; assert the named twig material is present, is MASK, and has cut coverage within 0.005. Keep source tests outside the current `skipIf(!after/world.json || !candidates)` block: current candidate/cooked coverage is gated by local assets and excludes original fir. Run once against actual current GLBs; record observed failure. No generated deliberately broken GLB.

### Phase 2: Regenerate unchanged authored trees

- [x] AC-2 [local CPU]: four original fir GLBs retain raw geometry/accessor bytes, UVs, normal/albedo RGB, material constants, transforms, extensions, base and LODs; only twig PNG alpha and image/container layout bytes change. proof: `python .linchpin/prd614-leaf-alpha-repair/compare.py` exits 0 for all four, 16 raw/decoded accessors each, exact official cut coverage 0.7637729644775391, all nonleaf bufferViews/images byte-exact; RGB and geometry corruption rejected. Production files equal verified scratch. Original-fir focused test and full suites recorded below. Cooked candidate proof remains pending and is not included in this CPU checkbox.

- [x] AC-2 cooked alpha [local CPU]: fresh installed-SDK `compileAssets` exits 0; all four aliases reference the 219323-byte lossless palette PNG, SHA-256 `3027af1ecfe24cf0d0079eedc9d5d508b781dc76392e69640b91777e7d19b968`. proof: `python .linchpin/prd614-leaf-alpha-repair/cooked-proof.py` exits 0; every decoded RGBA byte equals repaired source, MASK 0.5, coverage 0.7637729644775391, manifest alpha SSIM 1 / MAE 0 / changed pixels 0, PNG signature checked. This is PNG alpha, not KTX2 alpha.
- [x] AC-2 published forest budget [local CPU]: actual streamed total **26166992 <= 26214400 bytes**, margin **47408 bytes**; all 16 other terrain inputs byte-identical. proof: fresh actual recook plus `cooked-proof.py` exits 0 (not projection). Historical 26526416-byte failure below is superseded by the verified lossless palette compression.

The original Blender-export approach below is retained as rejected historical evidence: it changed decoded quantized geometry and twig RGB. The superseding `.linchpin/prd614-leaf-alpha-preserve.brief` authorizes only an alpha patch to existing GLBs. Reuse installed `@gltf-transform/core` NodeIO with ALL_EXTENSIONS and lossless Sharp PNG output (`palette: false`); no geometry transforms or re-export. Pillow thresholds the official source Red channel at >=128 before encoding. Sharp's 16-bit source conversion differed at two threshold texels, so its converted mask was rejected in scratch and replaced with the exact Pillow-derived mask. Existing Blender WIP remains for future exports.

Copy only the four strictly verified GLBs; update only existing fir file byte/hash entries and accurate provenance in `packages/terrain/starter-assets/credits.json` and `packages/terrain/starter-credits.json`. Archive/manifest pins change only following actual consumer failure. Parent recooking, cooked-alpha proof, unchanged 25 MiB cooked-budget check and visual Phase 3 remain pending. No frozen/candidate clone, SDK, install, shared dist, build, GPU or Git action is authorized here.

### Phase 3: Visible needles and default-scene preservation

- [x] AC-3 [local]: fixed-pose NVIDIA leaf closeups show actual cutout needles without opaque card borders. proof: two BEFORE (control-queue-2, control-before-2) and two AFTER (palette-after-1, palette-after-2) headed NVIDIA Turing WebGPU captures; identical recorded camera/projection and original 1920×1080 image area. Fresh read-only /root/forest_leaf_visual_judge inspected all four labeled pixel-preserving copies in .linchpin/prd614-near-leaves/leaf-judge/: each pair and overall **IMPROVEMENT; PASS**. Cutouts align, needles and branches remain; no missing foliage patches or unintended visual regression. Scenario remains FAIL on three unused edge-view observations (-1); render p95 null/UNMEASURED, not a budget overrun. Zero runtime errors. The 0.8 m distance and source/config identity are preparation/worker-provided, not independently stored in capture metadata. No FPS, full product-gate or default-view claim.
- [ ] AC-4 [local]: default forest retains its intended appearance and scenario behavior. proof: `pnpm --filter strata-terrain-preview test:terrain:web`, plus two matched BEFORE/AFTER default-view captures and the same independent judge — pending.
- [ ] AC-5 [local]: the user-observed squared leaf tips are resolved without hiding detail, losing branches or introducing adjacent texture islands. Identify the displayed asset/pose, retain the original crop and failures, and obtain two fresh same-pose headed WebGPU pairs with a new independent IMPROVEMENT verdict against natural leaf silhouettes. Source alpha coverage alone is insufficient; current UV-boundary diagnosis is not a visual pass. proof: pending.

Reuse the existing capture command below, with isolated baseline/candidate clones and unique artifact directories. Keep the recorded pose from `.linchpin/prd614-near-leaves/clones.json` (0.8 m from the same card), identical resolution/seed/camera/settings; default scene uses the unchanged parent scenario. Burn large BEFORE/AFTER labels into copies of all judged frames; preserve raw captures. A fresh read-only judge that did not write the fix must receive both runs per arm and the intended alpha-only effect; return per-frame and overall IMPROVEMENT for repaired closeups. Default scene must have no regression (neutral preservation is acceptable only as preservation, never as the repair verdict). Fix and rejudge a neutral/regressed repair. Record verdict on these boxes; post images on the parent PR via its existing screenshot branch workflow only when implementation is authorized.

## Bounded implementation commands (fetch and four exports executed)

From this checkout, use an owned ignored source directory. Prefer the installed asset MCP's `asset_download_file(provider=polyhaven, acceptLicense=true, fileName=<owned-cache-name>, url=<provider URL>)` when its dedicated cache is configured to this task; never point downloads at another lane or shared SDK. If unavailable, the following direct provider retrieval uses only the owned directory and standard tools, with no new helper file:

```sh
python - <<'FETCH'
import hashlib,json,pathlib,subprocess
root=pathlib.Path('.linchpin/prd614-leaf-alpha-repair/source'); root.mkdir(parents=True,exist_ok=True)
meta=json.loads(pathlib.Path('.linchpin/prd614-leaf-alpha-repair/provider-files.json').read_text())
for relative,info in [('fir_tree_01_1k.blend',meta),*meta['include'].items()]:
    dest=root/relative; dest.parent.mkdir(parents=True,exist_ok=True)
    if not dest.exists():
        subprocess.run(['curl','--fail','--location','--silent','--show-error','--max-time','120',info['url'],'-o',str(dest)],check=True)
    data=dest.read_bytes()
    assert len(data)==info['size'] and hashlib.md5(data).hexdigest()==info['md5'], str(dest)
assert hashlib.sha256((root/'fir_tree_01_1k.blend').read_bytes()).hexdigest()=='153d20aae6d7c63a4c52689d91e8bead78f6d17a70e11ef4d03d19953383de00'
FETCH
for pair in b:1 b:2 c:1 c:2; do
  /home/joao/.local/bin/blender -b .linchpin/prd614-leaf-alpha-repair/source/fir_tree_01_1k.blend \
    --python examples/strata-terrain-preview/scripts/prep-polyhaven-fir.py -- \
    --only "$pair" --out .linchpin/prd614-leaf-alpha-repair/export
 done
pnpm exec vitest run examples/strata-terrain-preview/__tests__/forest-stage.spec.ts -t 'original starter fir'
```

Mask reproduction: `python -c "from PIL import Image; im=Image.open('.linchpin/prd614-leaf-alpha-repair/fir_tree_01_twig_alpha_1k.png').convert('RGBA'); h=im.getchannel('R').histogram(); print(im.getchannel('R').getextrema(), im.getchannel('A').getextrema(), sum(h[:128])/sum(h))"`.

Capture entry point (repeat with unique `$out` for each run/arm; `$game` is that isolated prepared clone, `$repo` is this checkout; server port must be free):

```sh
cd "$game"
TN_PLAYTEST_HOST_DISPLAY=1 node "$repo/packages/playtest/dist/runner/cli.js" \
  "$repo/.linchpin/prd614-near-leaves/near-leaves.playtest.json" \
  --url http://127.0.0.1:5835 \
  --server-command 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5835 --strictPort' \
  --headed --browser-recipe webgpu --artifacts "$out"
```

Do not reuse the existing capture wrapper blindly: it writes the other owner's near-leaves directory and refuses existing output. Use its existing runner invocation with this task's own output paths. Clone recooking/serving must be completed by the parent before capture; this preparation does not claim those clones contain repaired assets.

## Integration and dependencies

Integration unchanged: starter forest assets.json → parent cook → WorldCells/ctx.assets → existing needle material. Forest and coastal share fir LOD2; include coastal appearance in scope review if production assets are replaced. No engine-cooker fix is supported by observed evidence.

Capability gate run: search “Preserve RGB leaf opacity mask as exported glTF base color alpha using existing asset preparation and cooking workflow”; all five returned details inspected (`loadTerrainSplat`, `createAssetLoader`, `UEFormatLoader`, `loadAnimalBake`, `animalBakePass`). None replaces Blender channel wiring; reuse the existing exporter and loader. Repeat a focused capability search/detail before any later new helper or render-stage modification; neither is planned.

## Blocked on

- Implementation authorized by the parent brief; Phase 3 remains parent-coordinated.
- Full blend plus all 18 dependencies fetched and provider size/MD5 verified; blend SHA-256 matches `153d20aae6d7c63a4c52689d91e8bead78f6d17a70e11ef4d03d19953383de00`. Runtime/judge outcomes remain unverified.

## Preparation checks

Phases 1 and 2 CPU checks are verified. Initial Blender preservation failed; the subsequently authorized alpha-only patch passes strict preservation. Cooked proof and Phase 3 remain pending.

## Historical Blender implementation execution (rejected)

Laptop exception: read-only SSH found no Blender on PATH, `/usr/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.local/opt/blender*` or `/opt/blender*`. Status immediately before export: load 0.12/0.35/1.31, 21 GB free, 65°C, AC, battery 94%; capacity exists but required Blender is absent. No remote job or lane created. Use existing desktop Blender 5.2.0 LTS, sequential CPU-only exports, two threads, nice 10; no render/preview.

### Required stop: raw export changes decoded geometry (satisfied; alternate alpha patch authorized)

All four unchanged-script exports exited 0. Two-thread sequential CPU-only commands wrote only owned scratch; logs are `export-b1.log`, `export-b2.log`, `export-c1.log`, `export-c2.log` in the ignored repair directory. No laptop job/lane identity exists because the required Blender is absent there. No production GLB, credits, manifest, frozen game, exporter, SDK, dist or parent/UX source was changed by this lane.

Full CPU comparison decoded every index, POSITION, NORMAL and TEXCOORD_0 accessor, including byte strides and normalized integer components, applied each node's position scale/translation, normalized normal directions, compared complete expanded streams independent of vertex order, and compared canonical indexed triangles. It also compared material constants with glTF defaults normalized and decoded texture pixels. Results are in the permitted ignored mechanical artifact `comparison.json`; its runnable checker is `compare.py`.

**Preservation failure:** every material in every file has unequal decoded POSITION and NORMAL data; bark/twig/dead-branch UVs differ (trunk UVs match). Full decoded indexed triangle signatures differ in all 16 primitives. Original GLBs identify glTF-Transform v4.4.2 and use KHR_mesh_quantization plus node scale/translation; scratch Blender GLBs carry unquantized float streams. This is an actual decoded-value difference, not only a container/index-order change. Example bark position-bound differences are 0.0003946237205809666 m (b LOD1/2), 0.0003133692798003018 m (c LOD1), 0.0004296651324415812 m (c LOD2). These are bounding-coordinate differences, not a maximum per-vertex error claim.

Triangle totals remain exactly 128464, 54927, 68879, 31512 for b1/b2/c1/c2; material constants and decoded normal-map pixels match in every primitive. Non-twig albedo RGB matches; twig composite RGB differs as well as alpha. Effective samplers match after supplying glTF default wrapS/wrapT=REPEAT. These matching checks do not waive the required geometry preservation.

| File | Original SHA-256 (unchanged production) | Scratch SHA-256 (rejected replacement) | Scratch bytes |
| --- | --- | --- | --- |
| fir-b-lod1.glb | `86185f844cb03a3489aa27fbf5e9fe48f8d061697d7d014e8f720eb5a763d5d3` | `c63d468216babe3394d7ed6780e94568a67f0a1f5920b47179ae4ed91823c37d` | 6439548 |
| fir-b-lod2.glb | `5e277deb77381b5f60dc590faceb6bbb845f4c458516a8939eb9773080695cbc` | `0cabe0a68f7513b5b6932f8473bcebbe8c707d620730497c78221791d5385621` | 5308212 |
| fir-c-lod1.glb | `f27850031b60ce72f9d6eba047c7ab5259140dad49e620ca09f850078e2dec32` | `99781ef1138d55a12e0aef36ec8764c34a5a43a2c159b74d87cf3a3780295658` | 4666324 |
| fir-c-lod2.glb | `34c9010750f28549d4c7140d47eb353bf0443e42c070843ee6e7f88754ebb766` | `27e02fa25c345693733f3b398825376e4ea250be3d2a14598ae50e56e0c91132` | 4126724 |

CPU checks: focused original-fir test FAILS with four coverage assertions (all originals cut 0); full forest-stage suite **8 passed, 1 failed, 0 skipped** (only the new original-fir test fails). Biome check exits 0 with two existing complexity warnings in `exportedCut` and the candidate/cooked test. Existing exporter and owned comparison Python AST parse PASS. Kit archive tests and new manifest pins were not run/changed because production replacement was rejected; no root build, recook or GPU claim is made. Capability search/detail inspected all five hits again; the existing Blender exporter remains the appropriate workflow.

Next bounded action for the parent: inspect this preservation failure before choosing an alpha-only update that retains the existing quantized geometry bytes. This brief requires stopping before copying when other semantics differ; no alternate repair was attempted. Phase 3 captures/judging stay open.


### Alpha-only preservation correction (2026-10-15)

Layer: game source assets. Capability search targeted existing GLB texture editing and inspected all 14 returned details (including modelPass, parsePng, compileAssets and texturePass); no production helper/API is needed. Reused installed NodeIO/ALL_EXTENSIONS, Sharp and Pillow in ignored one-shot `patch.mjs`, existing `compare.py` and `comparison.json`. The rejected Blender exports remain separate under `export/`; originals are retained under owned ignored `original/`, accepted bytes under `patched/`.

Spatial orientation is direct: official diffuse vs embedded RGB correlations R/G/B = 0.959067/0.970626/0.866688; vertical flip = -0.093535/-0.025651/-0.110393; horizontal flip = 0.129981/0.137404/0.107483; 180 degrees = 0.017763/-0.076809/0.057329. No UV/image flips or RGB adjustments applied. All four original twig PNGs share SHA-256 `a77b3e10ed5702dfb3246deba606fc1e3c68c7899557ce6038d529c10eac596c`; accepted lossless RGBA twig PNG SHA-256 `824d18ccf7155472e3bf28749726c6a8b3352543b90a8095b6d9235d76cf7fe5`, exactly 0/255 alpha from official mask and unchanged RGB.

Strict checker compares complete JSON semantics allowing only bufferView offsets, target PNG byteLength and buffer byteLength; all other bufferViews (including complete raw accessor bytes and padding) and nonleaf image bytes match exactly. All decoded accessors match, KHR_mesh_quantization and material/scene/node/texture bindings remain unchanged. Triangle counts b1/b2/c1/c2 remain 128464/54927/68879/31512. Its negative checks flip an actual geometry byte and one actual decoded RGB component; both are rejected for every file.

| File | Accepted SHA-256 | Bytes | Delta |
| --- | --- | --- | --- |
| fir-b-lod1.glb | `489e4ac9dd7ad187514d9c56371e664b7284044d550e26624a5c8307108c8302` | 4752288 | +109936 |
| fir-b-lod2.glb | `4303e8ffc5158e7e00ea3a9b865699d03acaff167fac25804760c31538b16387` | 3854132 | +109936 |
| fir-c-lod1.glb | `aeea7189285e01daa1a570cdc57880093b7a1a3c2fae7e5e8a5ccbd3fc5f86b2` | 3490216 | +109936 |
| fir-c-lod2.glb | `6ae6e10b2870bdb34725807828854cec482d0b24a03b32aaa7297e4499dc3438` | 3049508 | +109936 |

Total source increase: 439744 bytes. This is not a cooked-budget result. Cooked alpha and both visual criteria remain open for the parent.

Focused original-fir check: 1 passed, 8 filtered/skipped, exit 0. Initial combined suites: forest-stage 9 passed with no skips; kit-assets 11 passed and 1 actual archive-pin failure. The existing deterministic packer then generated `.linchpin/prd614-leaf-alpha-repair/starter-assets.tar.gz` and updated the committed pin via `--write-manifest`: SHA-256 `3dd11f94c66207c00b1b99d580fb3b3cbbf34fecc4701c84ebaedbb90cb2be00`, 32026157 bytes (previous 31598616, +427541). This follows the consumer failure, with no waiver. Both credits records' existing fir LOD2 hashes/sizes match production; all four production GLBs equal the verified scratch bytes.

Existing candidate/cooked assertions passed against their current local assets; these were not recooked here and do not prove the new source GLBs' cooked alpha. No build, install, shared dist, frozen/candidate edit, GPU capture, judge, Git or push was performed.

Final combined verification: `pnpm exec vitest run examples/strata-terrain-preview/__tests__/forest-stage.spec.ts packages/terrain/__tests__/kit-assets.spec.ts` exits 0: **21 passed, 0 skipped**, 2 files (forest-stage 9, kit-assets 12), 8.50 seconds. Strict `compare.py` rerun exits 0 for all four; `node --check` on ignored `patch.mjs` passes. No new source/test helper or production API was introduced; the existing always-running original-fir regression now passes. Phase progress: 2/3 complete, 2/4 boxes, `prd:50%`; visual Phase 3 and repaired cooked-alpha/budget proof remain pending.


### Isolated cooked-proof attempt (2026-10-15): source identity blocked

Execution of `.linchpin/prd614-leaf-alpha-cook.brief` stopped at its required exact-old-hash gate, before replacement or cooking. None of the four original GLB SHA-256 values recorded above matches any model input in `/tmp/prd614-near-leaves-p_fkjg6t/control/assets/terrain/forest/models/`. The four fir alias hashes begin `09179cd1ccbd` (fir), `e88eb0bcae47` (fir_lod1), `a08b3e9751d1` (fir-c), and `dadd7f15e9e0` (fir-c_lod1). Filenames alone do not establish the authorized mapping, so no replacement was made.

Owned clone: `/tmp/prd614-leaf-alpha-after-hbwwg4iu/after`. Its source, every asset/public file, both configs, package manifest and lockfile remain byte-identical to the baseline; model input delta is empty. The clone retains the read-only-use node_modules symlink; no SDK writes, production edits, Git actions, GPU work, cook or build were performed. The workflow-consumed ignored `.linchpin/prd614-leaf-alpha-repair/cook-identity.json` records full expected/actual hashes, empty matches and unchanged-input checks.

Actual repaired cooked alpha, published 25 MiB budget and preview build are **unverified**; no acceptance box changed. Capture is not ready and must not use this unchanged clone as an AFTER arm. Required next input: a verified mapping from these frozen alias bytes to the original sources, or authorization for a preservation-checked alpha-only patch of the frozen alias bytes.


### Frozen-alias correction and mandatory budget stop (2026-10-15)

Executed `.linchpin/prd614-leaf-alpha-cook-correct.brief` directly, without agents. Existing clone `/tmp/prd614-leaf-alpha-after-hbwwg4iu/after` only; no production assets, parent/UX WIP, Git, shared dist, installed SDK or GPU modifications. Capability search and every returned detail inspected; reused installed compileAssets, NodeIO/ALL_EXTENSIONS, Sharp, Pillow and the existing strict checker. All CPU jobs completed under five minutes (model pass 16.9 seconds), so no offload was required.

The original full-hash gate is superseded by verified mapping: b LOD1 → fir.glb; b LOD2 → fir_lod1.glb; c LOD1 → fir-c.glb; c LOD2 → fir-c_lod1.glb. Complete JSON semantics, raw bufferViews/accessors, decoded accessors, nodes/transforms/materials and all PNG bytes match; only JPEG encoded containers differ, with every decoded JPEG RGBA byte exact. No ambiguous mapping. All four old leaf PNGs match a77b3e10ed5702dfb3246deba606fc1e3c68c7899557ce6038d529c10eac596c and MASK 0.5 before patching.

Alpha-only patch reused the official Pillow Red >=128 mask. Strict before/after verification passes for each alias: geometry, node/material/extension semantics, leaf RGB and ALL other encoded image bytes (including optimized JPEGs) remain exact. Each GLB grows 109936 bytes; aggregate +439744. New hashes: fir `0e999bd59f6df2887e03cbaf694fda9eea474b7178006d6692e5568e500adbf6`; fir_lod1 `b046640b5c5be6566d0159754f9b72d46ce60f3aed2d24d1ca396ae2666e9c0b`; fir-c `9ccedfa5922a5f6d3ff67ab1ed302d082313c8291a2f5248e76da914d1149dd7`; fir-c_lod1 `bf20c19e7a1cd8b600d262e1f2f96aad8530d7e6010ba101153d5fa43c77cc26`. All 16 nonmodel streamed terrain inputs, combined world.glb, source files, camera, configs, package and lockfile remain unchanged. Only the four intended input GLBs differ.

Actual frozen-SDK compile succeeded: 4 written, 21 cached. First invocation failed because Node workers inherited `--input-type=module`; corrected invocation used `node -e` with dynamic import and exited 0. No compiler change or repeated same-cause failure. Own public output/cache only. Every cooked alias retains MASK 0.5 and references `shared/images/3073577f763b72f5.none.png`, SHA256 `824d18ccf7155472e3bf28749726c6a8b3352543b90a8095b6d9235d76cf7fe5`, 309182 bytes. Pillow decodes all four references to exact source RGBA and exact official alpha, coverage 0.7637729644775391. Manifest records alpha SSIM 1, mean absolute error 0, 247702 covered pixels at threshold 0.5, changed pixels 0.

The existing published starter-package cap covers the authored streamed forest (combined world.glb is its alternative). Actual frozen-clone baseline is 26086672 bytes, 29 above the earlier reported 26086643; the preserved clone is the measured input. Patched streamed total is **26526416 bytes**, +439744, **312016 over the unchanged 26214400 cap**. Exact composition: fir aliases 14988480; boulders 3096988; eight terrain textures 5788083; other terrain/package files 2652865 bytes. Full per-file sizes and hash deltas remain in the existing workflow-consumed ignored cook-identity.json. The separately compiled manifest-reachable runtime forest is 15616820 bytes (baseline 15443216, +173604); that smaller representation does not waive the published-package cap.

Required STOP taken at the actual cap assertion; no quality settings, geometry, LOD, recipes, budget or source pins changed. Vite build/preview was not run; captureReady=false. Phase 3 remains open and no AFTER GPU capture is authorized by this result. Parent must resolve the package overrun before building this exact clone and using the existing capture command.


### Lossless palette completion (2026-10-15)

Latest direct execution authorization supersedes the earlier no-build/no-clone scope for this owned clone only. Reused installed NodeIO/ALL_EXTENSIONS and the existing strict comparators; no engine/game source, SDK/dist, config, camera, quality, geometry, LOD or budget changes. No delegation, Git or GPU actions. Palette PNG shrank 309182 to 219323 bytes, 34 colors, every decoded RGBA byte (including transparent RGB) and pHYs preserved. All four production GLBs and the four separately patched frozen aliases pass strict raw/decoded geometry, normal/UV/index, transforms, material constants, RGB and other-image preservation checks. Frozen aliases retain their own lossless JPEG-Huffman savings; no whole production GLB was copied onto an alias.

Current production bytes supersede the historical tables above:

| File | SHA-256 | Bytes |
| --- | --- | --- |
| fir-b-lod1.glb | `0af64c3f93986905a5732c2f275904ff52ad258f680f75e38c84ca4b1257b670` | 4662432 |
| fir-b-lod2.glb | `88799ec1333f02a2a1965cb32efaaa4f6b6beb03478f8da64b00e2daeb976ace` | 3764276 |
| fir-c-lod1.glb | `2616989e119c07cec013d94ab5510f7082fc55194c182d0cb523ca0a7e7288e1` | 3400360 |
| fir-c-lod2.glb | `351c1bee2fbd236e2e757b6e0a154c2945ddb6cf632b9d426a2a507003a0aa46` | 2959652 |

Both existing credits records now identify all four actual GLBs. Existing deterministic `packages/terrain/scripts/pack-starter-assets.mjs` recreated the same ignored archive and pin: **31675260 bytes**, SHA-256 `ae229a3d80464185ec0ad25086b57c1ac2a9d5b976cb5c5022bdc0b41dc4a5d9`. Focused forest-stage + kit-assets suites: **21 passed, 0 skipped**, exit 0, 9.37 seconds. Strict production/alias comparators exit 0. Fresh cook exits 0; actual published total and runtime PNG checks are recorded in Phase 2 above. Owned clone `/tmp/prd614-leaf-alpha-after-hbwwg4iu/after` builds successfully: `node node_modules/vite/bin/vite.js build --configLoader runner`, exit 0, 896 ms. Existing chunk-size warning remains. Built manifest equals cooked public manifest and built leaf PNG hashes match all four references; no shared node_modules cache/config bundling. After build, all source files, configs, package/lockfile and every asset except the four intended aliases still match the frozen baseline. Phase 3 remains open.

Capture-ready CPU artifact only; visual outcome remains unverified. Source/pose matches the original 0.8 m closeup: Digit5, placement 2463, triangle 4767, camera `[44.11922325624535,18.499591000853645,-19.308327830103284]`, look `[43.61721301331486,18.219878244350397,-18.751779099225]`, 1920×1080. Use the existing capture entry point above with `game=/tmp/prd614-leaf-alpha-after-hbwwg4iu/after` and fresh owned artifact directories (for example `.linchpin/prd614-leaf-alpha-repair/after-1` and `after-2`), preserving seed/settings. No browser, GPU, capture, visual judge, Git commit or push was run. Next parent action: run the two authorized headed closeups and independent visual judge, followed by default/coastal appearance preservation checks.

### Independent closeup visual acceptance (2026-10-15)

Both repaired closeups eliminate solid rectangular leaf cards and dark borders while preserving aligned needles and branches. The fresh read-only judge rated each corresponding pair and overall IMPROVEMENT. AFTER 2 grass was slightly less crisp in places; the judge found no matching softness in trunks, shoreline, foreground branches or distant detail and no whole-frame visual regression. Restored cutouts plausibly explain changed ground-shadow shapes. Four raw screenshots remain immutable; labels occupy an added 120-pixel strip and every original pixel was checked exact. AC-4 default-view preservation and scenario behavior remain unchecked. No commit, push, native proof or measured render timing is claimed by these captures.

### Immutable asset release preparation (2026-10-15)

Prepared only; **not published, install-ready or delivered to package consumers**. The earlier `ae229a3d…` pin against the existing 0.1.0 URL was invalid: the immutable published archive remains 31598616 bytes, SHA-256 `3062b90cd7f84e6ff14f6a96de64ad406eeba30c55c95cc045b6219edf71f5b0` (publication proof: `docs/PRDs/done/PRD-589-the-terrain-package-ships-code-not-kit-data.md`). No old release was replaced. Read-only `gh release view terrain-starter-assets-v0.1.1 --repo ThreeNativeHQ/threenative-engine --json tagName,assets,url` returned `release not found`; release listing showed 0.1.0 only for terrain assets. This observation does not reserve 0.1.1; recheck before any future publication and stop if different bytes already exist.

Actual consumer `packages/terrain/src/kit-assets.ts:starterAssetsDir` prefers workspace assets, otherwise reads the manifest URL and validates byte length and SHA-256 before atomic extraction; cache identity is SHA-256. It does not compare manifest version to package version. The existing packer `packages/terrain/scripts/pack-starter-assets.mjs` supports an output path and optional `--write-manifest`, with no version argument. `--write-manifest` derives version/URL from `packages/terrain/package.json` (still 0.1.0) and also writes credits, so it was deliberately omitted. The manifest candidate below was populated from the actual newly packed bytes; package/source/tests/credits were not edited by this preparation.

- Ready local archive: `.linchpin/prd614-leaf-alpha-repair/release-0.1.1/terrain-starter-assets-0.1.1.tar.gz` (ignored).
- Candidate manifest: `packages/terrain/starter-assets.json`, version **0.1.1**; URL `https://github.com/ThreeNativeHQ/threenative-engine/releases/download/terrain-starter-assets-v0.1.1/terrain-starter-assets-0.1.1.tar.gz`.
- Actual archive: **31675260 bytes**, SHA-256 **`ae229a3d80464185ec0ad25086b57c1ac2a9d5b976cb5c5022bdc0b41dc4a5d9`**. Existing packer completed in 0.70 seconds; independent read/hash populated the manifest from these exact bytes.
- Focused `pnpm exec vitest run packages/terrain/__tests__/kit-assets.spec.ts`: **15 passed, 1 failed**, exit 1, 6.89 seconds. Deterministic archive equality, SHA and size assertions passed before `:83` failed: candidate manifest 0.1.1 differs from package 0.1.0. File-archive extraction, cache, baking, HTTP, rejection and all four needle-alpha checks passed. No test was weakened; the suite is not green.

**Parked:** publication has no authorization; no upload, tag, release, push or other Git/GitHub mutation was performed. Root must keep this candidate manifest out of the deliverable until the owning release coherently advances package/asset versions and publishes the exact immutable archive, then reruns focused checks and proves a fresh-cache public download. Running the current packer with `--write-manifest` before that cohort bump would recreate the invalid 0.1.0 URL/new-hash pairing. No terrain-specific future publish command was found in the inspected existing packer workflow/documentation; no command is invented here. Browser/GPU/native proof and the broader test board were not run by this bounded preparation. Existing visual acceptance above does not establish package delivery.

### Current release pin preserved (2026-10-15)

The prepared 0.1.1 manifest failed the real package-version invariant because the owning package is still 0.1.0. Its exact bytes remain beside the prepared archive as ignored release-0.1.1/manifest-candidate.json. The tracked manifest is restored to the existing published 0.1.0 URL/hash/size; neither that immutable release nor its integrity contract was changed. Four repaired source GLBs and their provenance/test remain in this checkout. The corrected source dataset is not delivered to published-package consumers until the owning release publishes a new archive and advances the version/pin together. Publication is parked under the AFK no-deploy rule; no approval is inferred and no test invariant was weakened.

2026-10-15 bounded geometry approach stopped without changing source GLBs. Exact normalized-u16 root-line preservation first required 36.06 texels of padding; allowing one native UV storage step produced a 6-texel proposal with 0.006280-texel root-line error and 0.000143526 m position-rounding error, but branch-preservation validation rejected it (81 ray samples crossed transparent gaps). No candidate was emitted or visually accepted. The doubtful assumption is that local alpha connectivity/ray continuation reliably identifies the intended branch; the original crop's asset identity also remains unestablished. Keep AC-5 open and re-plan from an identified visible tip rather than relaxing the branch-preservation check blindly.
