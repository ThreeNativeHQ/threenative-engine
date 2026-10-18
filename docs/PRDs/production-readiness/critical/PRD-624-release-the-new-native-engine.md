# PRD-624 — Release the new native engine

**Status:** IN PROGRESS
**Priority:** P0 — Native Runner still loses its GPU, startup preparation is incomplete, and PR #493 has merge conflicts.
**Complexity:** 6 → HIGH; security-boundary override for the public dependency chain.
**Owner:** ThreeNative engine/release agent; João owns merge and publication approval.
**Depends on:** PRD-573 release-blocking v1 work only; its later performance cycles do not block this release.
**Progress:** 0/7 remaining outcomes verified.
**Execution:** Planning only. Implementation is paused.

## Scope

Ship the first release of the new engine through its real browser-WASM and supported native consumers. This document contains only outstanding release work. Technical history and existing proof remain in [PRD-573](../../performance/PRD-573-unreal-class-performance-in-release-cycles.md); do not repeat completed tasks or require that entire performance epic to finish.

Exclude new features, performance cycles v2–v5, another Sailing shake investigation, and already-qualified Windows/SMAA repairs. Reuse their evidence while the relevant source and artifacts remain unchanged; changed rendering still needs the existing regression and visual checks.

## Current blockers

At planning time, [PR #493](https://github.com/ThreeNativeHQ/threenative-engine/pull/493) is open, draft and `CONFLICTING`; published head is `a62f8c324818c6988cd8daf1f517a2aa17d363be`. Local fixes are ahead of that head and include interrupted, unreviewed native preparation edits. Preserve those edits; they are not a verified fix.

Strict Runner runs `10498` and `1629` exit 2 on Google SwiftShader: GPU-process exit 512, then bright-pixel ratio 0.03947 below the unchanged 0.05 guard. The observed run completes submissions 1–11; submission 12 is the first unconfirmed packet and contains one intact equirectangular PMREM face. Splitting submissions alone failed; this does not identify the executing shader or prove the cause of every parity failure.

The Three.js arm renders valid frames but abandons warmup at its unchanged 15-second deadline before attempting scene compilation. PMREM work continues beyond that cutoff. Sailing's original 33 ms performance gate is also unqualified; the prior 95.9 ms result was recorded under heavy host load.

The last full qualification, `39126674780`, failed seven software parity jobs and the required aggregator on an older source revision. Neither that run nor skipped draft checks qualifies the eventual release candidate.

## Acceptance and execution

The seven phase boxes below are the complete agent-executable acceptance checklist. `[local]` work is executed by the engine/release agent; `[shared]` qualification is triggered and verified by that agent through the existing CI workflow. Keep results on their owning box or link the existing PRD/CI proof; do not create another evidence report. Owner dependencies below also block release, even when every box is green.

### Phase 1 — Finish startup readiness

**Status:** IN PROGRESS (1/2; box 2 needs the owner threshold call)
**Files:** Existing native renderer/render-database preparation and tests; existing core warmup and Three patch paths. Review interrupted edits before choosing what to keep.

- [x] [local] **Native PMREM becomes fully ready before covered rendering.** Through the unchanged WASM render entry, complete the original full-quality target without GPU loss or a placeholder capture. Preserve resource identity, version/disposal safety, shader math, sample counts, formats and deadlines. Private completion-gated preparation must advance only after prior GPU work completes and must not interleave the shared environment uniform buffer. Prove the shared mechanism on native too. proof: focused existing renderer/resource CTest cases, unchanged strict stock Runner via `scripts/engine-parity.ts`, and the affected native conformance case.
  - Result 2026-10-18 at 2c83ba331: startup waits for the native frame-gated bake (18eb7c539), bounded by the warm-up deadline (fe493a075). The red-green review fixed retirement reaching only the first sweeping renderer and a probe capture publishing the previous target during a bake (1699bf5a1, 2c83ba331). CTest `native_engine_(render_|renderer_|traa_|gpu_|pmrem|probe)` 113/113. Native-engine conformance on RTX 2080: pmrem-hdr-equirect 0.00342/0.00187, pmrem-texture 0.00130/0.00075, sky-equirect 0.00266/0.00136, textures-data-equirect 0.00113/0.00083, material-ao-environment 0.00005/0.000024, materials-physical-clearcoat-environment 0.00073/0.00043, all against 0.01/0.02. `pbr-grid-envmap` stays blocked by the per-material `envMap` refusal, unchanged since 0e01e2fc5. Strict stock `scripts/engine-parity.ts` on 3-CPU SwiftShader with this WASM: Runner 0.039 and action-rpg 0.001 against 0.12, with no device loss. Fresh visual judge on two headed NVIDIA captures per arm: IMPROVEMENT.
- [ ] [local] **Three.js startup completes preparation within the existing contract.** Repair the pending PMREM/warmup path so full lighting is available before covered rendering and warmup reports completed rather than abandoned. Preserve the 15-second warmup budget and outer capture deadline; a valid screenshot alone is insufficient. proof: focused warmup/patch tests and strict stock Runner's warmup, completion and capture observations.
  - Open 2026-10-18 at 2c83ba331: owner chose split budgets. 870dfd578 gives the PMREM bake its own `environmentBudgetMs` (default `STARTUP_HOLD_BUDGET_MS`, 45 s), and the unchanged 15 s compile budget starts after it. `warmup.spec` 48/48; the new spec fails on the previous code. NVIDIA completes. On 3-CPU SwiftShader under tn-local load, Runner and action-rpg still report `timedOut` at 45003/45035 ms with no compile attempted. The bake is real compute: a full-quality 1024 cube is about 8 fence groups of `_sizeLods[1]² × 512` GGX samples, at about 10 s each. The earlier 20–27 s estimate measured `ready`, not the bake. No bound inside the 180 s ≥ 3× launch contract (`startup-ready-bound.spec.ts`) fits about 80 s. Lighting is correct at capture (parity above). Needs the owner's threshold call.

Verification: extend the existing real renderer/completion tests rather than adding a harness. Test pending completion, final publication and stale-source cleanup. Before accepting appearance preservation, compare full-quality output with the retained stock bake and run the required two headed NVIDIA captures per arm at the same pose, followed by a fresh visual judge. Record results with the relevant startup box; a pixel diff alone is not the visual verdict.

### Phase 2 — Freeze a clean, installable candidate

**Status:** DONE
**Files:** PR #493 integration, existing release preparation/package manifests, Three patch mirrors and lockfile, existing template consumer checks.

- [x] [local] **Resolve PR #493 against current `origin/develop`.** Preserve the CI improvements and engine fixes, resolve the complete candidate diff, and make the PR mergeable without rewriting another owner's worktree. proof: conflict-free integration checkout, affected checks and `gh pr view 493 --json mergeable,headRefOid` after the authorized source push.
  - Result 2026-10-18: develop merged in bc64a2505 (8 conflicts, three patch rebuilt 3-way, 13 scaffold fingerprints re-measured); `gh pr view 493 --json mergeable,mergeStateStatus,headRefOid` = MERGEABLE / CLEAN at pushed head e5ec2c179, 0 commits behind origin/develop; affected checks: three-patch-upgrade, warmup, scaffold and engine-parity specs 166/166, `pnpm typecheck` exit 0.
- [x] [local] **The fresh core consumer resolves the repaired public dependency chain.** After the sculpt maintainer publishes its fix, update the real dependency floor and prove a normal fresh install resolves the patched SDK/transitives. A workspace override or local manifest patch does not close this. proof: packed core manifest, resolved installed versions, frozen consumer install and existing MCP/package contracts.
  - Result 2026-10-18 at 386e7fbcf: `threenative-sculpt-mcp` 0.2.2 is published (source jonit-dev/threenative-sculpt-mcp `fix/sdk-1.31` 2a3732c, 62/62 tests). The core floor is 0.2.2 in 386e7fbcf, and the packed core manifest reads `"threenative-sculpt-mcp": "0.2.2"`. In fresh frozen starter and sailing consumers on two machines, `pnpm why` resolves `@modelcontextprotocol/sdk` 1.31.0, `proxy-addr` 2.0.8 (express 5.3.0) and `fast-uri` 3.1.8 (ajv 8.20.0), all through core → sculpt 0.2.2. MCP, scaffold and budgets contracts: 127 passed, with the sculpt tool surface recaptured from the published tarball (12 tools).
- [x] [local] **All candidate packages come from one frozen source and install normally.** Select cohort versions before final qualification, use `pnpm release:prepare` and the ordinary pack/build paths, refresh changed patch hashes/mirrors and all 13 affected template fingerprints, and scaffold/install the candidate outside the workspace. Verify all 15 package identities and the installed WASM binary; do not reuse stale `node_modules` or treat old platform artifacts as current. proof: existing release/package/scaffolder contracts, immutable archive hashes and clean consumer build/playtest results.
  - Result 2026-10-18 at 386e7fbcf: `pnpm release:prepare` passed (15 packages at current versions, nothing published). The one acknowledged finding is the missing `runtime-native-v0.3.5` prebuilt release. One `pnpm sandbox` pack gave 15 archives, sha256 prefixes 73239509 a6fbabcc f6404638 f475a230 9a4a240b f5e577c8 2da72253 16bb1b4f 19eb63e4 34e5449e fc042093 0b7ce35e fa3dc12c a58d0829 895ed3e2, byte-identical on both machines. Fresh frozen installs outside the workspace on desktop and laptop match all 15 identities to those archives. The installed `tn-native-engine-web.wasm` cd16636b… equals a clean rebuild. Starter `build:web` passes, and the shipped playtests pass 4/4 with `--browser-recipe webgpu` on Intel gen-12lp hardware. Finding, not fixed: repacking the same head reorders workspace-dependency keys in some manifests, so archive bytes are immutable per pack, not reproducible across packs.
- [x] [local] **Sailing passes its original performance gate on the final cohort.** Measure the unchanged 33 ms gate in a legitimately quiet window on the real adapter, retaining load/adapter metadata. Preserve the already-fixed ocean and rerun rendered-motion regression when the final engine changes invalidate its evidence. proof: installed Sailing `playtests/performance.playtest.json` and `playtests/live/render-motion.playtest.json`, using the shipped runner and `--browser-recipe webgpu`.
  - Result 2026-10-18 at 386e7fbcf: installed Sailing from the same archive set, shipped runner, `--browser-recipe webgpu`, on the Debian laptop's Intel gen-12lp (adapterClass hardware). `performance.playtest.json` ×2 gave `maxFrameMsP95` 15.3 / 15.1 ms against the unchanged 33 ms, `minFps` 100 / 103.1, 62 draws and 75505 triangles. `live/render-motion.playtest.json --live-clock` passed: 2533 rendered frames, hull range 1.58, max jitter 0.094 px against 1. Load was 1.4–2.9 with no CI worker; package temperature 79–97 °C. Earlier passes: 12.9 / 14.0 ms at 5cbeadeab and 15.1 / 14.8 ms at a069e1450. Sailing pins `engine: "threejs"`.

Verification: use fresh normally generated consumers and the shipped scenarios. Fingerprint and archive checks follow final patch bytes. Build long jobs on the laptop when suitable; native-host/NVIDIA-specific proof stays on its required machine. Never reduce quality, timing thresholds or assertions to obtain green results.

### Phase 3 — Qualify the exact release source

**Status:** IN PROGRESS
**Files:** Existing qualification workflows and release-candidate PR metadata; no workflow per feature.

- [ ] [shared] **The frozen candidate passes the complete required qualification.** Run required local checks, then one fresh full exact-source CI board under runner admission. Require actual successful executions of all seven previously failing parity jobs, `ci-required`/Integration, the full unit suite, shipped-template/golden journeys and supported native/platform lanes. The host-projection check retains its 120-second watchdog; investigate recurring failures instead of rerunning blindly. Any later source change invalidates the affected proof. proof: `pnpm typecheck`, `pnpm lint`, `pnpm test`, and completed exact-head full qualification jobs/receipts linked on the release PR.

Verification: final evidence must identify source revision, dependency/artifact cohort and target. Draft skips, cancelled jobs, an older green run, local unit tests alone or an adapter substitute do not qualify the required platform. Reuse the final CI unit result when it proves the same frozen source; do not add equivalent reruns.

## Integration ledger

| Boundary | Intended consumer | Required result |
| --- | --- | --- |
| GPU preparation | Existing WASM/native render entry → renderer environment preparation | Complete lighting before covered rendering; no GPU loss or stale publication |
| Distribution | Normal packed CLI/core/native install → generated game | Exact frozen cohort runs without workspace state or vulnerable dependency pins |
| Qualification | Frozen candidate → existing exhaustive CI and promotion workflow | Every required selected job executes successfully on that candidate |

## Blocked on

- **Sculpt maintainer:** publish the prepared external SDK-floor repair; a real fixed registry version is required before the public core dependency proof can close.
- **Native release owner:** produce/authorize the complete supported prebuilt matrix for the final cohort. Existing partial 0.3.5 artifacts are insufficient; each published artifact needs matching immutable-source provenance and its platform proof.
- **João:** decide whether the outstanding Android instrumented receipt/pump qualification and unresolved host-projection intermittency need additional initial-release evidence. They remain explicitly unverified; this plan grants no waiver. Required platform CI still must pass.
- **João:** lift the existing draft/merge/publication hold after reviewing the qualified candidate. Promotion remains the ordinary full-checked `develop → main` PR with a merge commit. Tags, registry publication, deployment and post-publication fresh-install smoke require that authorization; this planning request authorizes none of them.

## Completion rule

Release-ready means all seven outcomes have current proof, required native artifacts and dependency publication exist, and the owner dependencies are resolved. Publication is a separate authorized action. Until then, keep this PRD open and report the exact missing outcome; do not mark PRD-573's later cycles complete or substitute merge readiness for release readiness.
