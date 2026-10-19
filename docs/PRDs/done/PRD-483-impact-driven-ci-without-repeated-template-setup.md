---
prd_contract: v1
---

# PRD-483 — Impact-driven CI without repeated template setup

**Status:** DONE — 2026-10-05. Normal PR and merge-group qualification green; merged as `abaa1f0e9` (#435).
**Owner:** CI tooling
**Scope:** One cleanup PR; builds on PRDs 373, 380, 480 and 481 and the conservative #417 reuse repair.

## Decisions

- João, 2026-10-03: first ask whether the change needs tests, then whether each test earns its cost,
  then whether retained tests apply now. Docs-only skips product tests. CI configuration proves its
  routing/contracts. Native runs for native and shared runtime consumers. Unknown meaningful inputs
  keep full coverage. No settings, credentials, runners or concurrency changes.
- João, 2026-10-04 follow-up: allow up to eight existing hosted template legs at once; preserve selected coverage, fail-fast false, runner routing and timeouts. This separately authorized cap change does not alter the original cleanup decision or historical measurements.
- Exhaustive template scenarios remain on broad changes, main qualification and scheduled audits.
  Exact kit changes run the affected kits; shared generator/render sources keep exhaustive fanout in
  this tranche. Narrowing shared sources further needs a proved dependency boundary.
- Unsafe matrix/reusable verdict reuse remains disabled by #417: missing, partial, failed, skipped,
  stale or otherwise unproven source evidence never authorizes a skip. This PR creates no new verdict
  cache. Workspace products remain immutable artifacts from this exact run/candidate.

### Phase 1 — Remove duplication and select retained coverage

- [x] Exact template paths map to shipped kit identities; shared/unknown inputs retain the full matrix; docs and CI review lanes apply to ordinary PR diffs; merge groups now require exhaustive exact-candidate qualification. Original selection proof: `pnpm exec vitest run scripts/__tests__/ci-template-selection.spec.ts`, 19 passed locally on 2026-10-03; qualification follow-up proof: 404 CPU CI/mirror tests passed on 2026-10-04.
- [x] Every nonvisual scenario runs once per selected template, with empty coverage rejected and the matrix derived from kit manifests. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-template-selection.spec.ts`, green in the 264-test focused run on 2026-10-03.
- [x] CI/template unit contracts preserve mixed-scope unions; full unit shards retain their existing unit-only command; native tests honor shared/native reach; the final verdict checks exact queue source identity, with full history at the verdict checkout. proof: `pnpm exec vitest run scripts/__tests__/ci-*.spec.ts scripts/__tests__/verify-template-playtests.spec.ts scripts/__tests__/sync-agent-docs.spec.ts scripts/__tests__/primary-docs.spec.ts`, 303 passed on 2026-10-03.

### Phase 2 — Qualify the smaller pipeline

- [x] Final typecheck, lint, docs and relevant unit checks pass. proof: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm check:docs` exit 0; 303 focused tests passed, 2026-10-03.
- [x] Normal CI passes on this cleanup PR before merge; the authorized ready transition starts qualification. proof: PR run 37256579927 at head `e072c3a6` (65 succeeded, 1 expected policy skip, `ci-required` success) and merge-group run 37259374897 at candidate `c3211d3c` (66 jobs, `ci-required` success 04:31:04); merged as `abaa1f0e9` at 04:38:29, no bypass.

## Acceptance criteria

- [x] **AC-1 [shared; actor: CI]:** An ordinary PR plans only what its diff reaches — a one-kit change runs only that kit's template legs, a Markdown-only change no fixture consumes runs no product job, and a shared or unknown executable input keeps the exhaustive matrix. proof: `pnpm exec vitest run scripts/__tests__/ci-template-selection.spec.ts scripts/__tests__/ci-structure.spec.ts`, 2026-10-05.
- [x] **AC-2 [shared; actor: merge queue]:** A merge group qualifies the exhaustive plan at the exact candidate — all 13 template nonvisual legs, both golden journeys, the full native tier and every Integration lane — and the required `ci-required` verdict passes only on that completed plan. proof: merge-group run 37259374897 (66 jobs: 13 nonvisual legs, 3 golden-path jobs, 16 Integration jobs, `ci-required` success) and PR run 37256579927 (65 succeeded, 1 expected policy skip), 2026-10-05.
- [x] **AC-3 [shared; actor: implementation agent]:** Template setup does not repeat: the sequential pristine-template compiler loop is skipped only when the exact full plan owns every dynamically discovered typecheck template, and a local, partial, unsupported or unknown input keeps it. proof: `pnpm exec vitest run scripts/__tests__/ci-template-typecheck.spec.ts`, 2026-10-05.
- [x] **AC-4 [shared; actor: CI]:** Reusable-verdict reuse stays disabled: a missing, partial, failed, skipped, stale or wrong-source receipt never authorizes a skip, and an attempt receipt is retried only for the observed transport outage against the identical attempt endpoint. proof: `pnpm exec vitest run scripts/__tests__/ci-qualification.spec.ts scripts/__tests__/ci-attempt-receipts.spec.ts`, 2026-10-05.

All six CI-contract specs above ran together at `abaa1f0e9`: 6 files, 282 tests passed.

## Coverage and cost

Measured baseline: [CI run 37078784853](https://github.com/ThreeNativeHQ/threenative/actions/runs/37078784853),
2026-10-02, successful completed jobs API. Nonvisual: 29 jobs, 5,674s (94.6 runner-min), slowest 319s.
Golden journey: 2 jobs, 382s (6.4 runner-min). Total: 31 template jobs, 100.9 runner-min.
There are 13 kit manifests, not a hardcoded CI count.

| Change | Previous PR / queue | Proposed PR / queue |
|---|---|---|
| Inert docs | no product jobs / full board | no product jobs / exhaustive qualification |
| CI configuration | 4 full unit shards, no template jobs / full board | 1 CI-contract unit job, affected Integration / exhaustive qualification |
| One kit | 4 full unit shards + 31 template jobs / full board | 1 scaffolder-contract unit job + 2 template jobs / exhaustive qualification |
| Shared runtime, generator, unknown meaningful code; main/nightly | exhaustive 31 template jobs | exhaustive 13 scenario jobs + 2 journey jobs |

The hosted template cap is eight; selected kits and scenarios are unchanged. The historical baseline at cap four had a nonvisual slot-work lower bound of 94.6 / 4 = 23.6 minutes;
removing 16 repeated setups at the workflow's documented ~65s estimates 17.3 runner-min saved,
retaining both existing golden journeys. That gives ~83.6 template runner-min, an estimate,
not measured after-change wall time. Individual exhaustive template jobs will be longer (shooter
roughly 18 minutes using baseline work minus repeated setup); the 30-minute timeout is retained.
Queue contention can improve while a single heavy leg lengthens; live CI must settle wall time.
Full unit shards keep their existing `pnpm test` with `TN_SUITE_PHASES=unit`; it already excluded builds. No full-unit rebuild saving is claimed. CI-only avoids those product suites entirely.

| Removed work | Why it adds little marginal value | Remaining proof |
|---|---|---|
| 16 per-template scaffold/install/typecheck/cook copies | Same template and exact run tarballs; only scenario partition differed | One setup per template, all classifier scenarios, template compilation/contracts |
| Both full-board golden journeys retained | Distinct starter and platformer proofs remain qualified | In selective multi-kit coverage where platformer is not the chosen golden kit, its existing installed scenario job verifies the production CLI and nonempty artifact |
| Four shard-count snapshot cases and obsolete partition arithmetic | Assert old scheduling constants; do not prove product behavior | Manifest-derived complete matrix, whole classifier execution, empty selection rejection, direct impact fixtures |
| CI structure/needs checks repeated by lint and CI unit lane | Same candidate/contracts in two jobs | CI lane targeted unit run; instructions-only lint retains contracts when no unit job runs |
| Full product units on CI-only changes | No runtime/package/template source changed | CI contracts plus existing typecheck, budgets, lint and supply-chain gates |
| Full unit command retained | Existing unit phase already excluded build | Units execute freshly; existing exact-run producer artifact is consumed |

No rendering PR acceptance tests, security checks or required protection settings are removed.


Integration relevance also compares exact candidate Git objects. A bounded parser validates lane filters,
output identity and transitive job dependencies; an exposure-only job/filter edit selects exposure,
while a native dependent edit selects its root and dependent consumers. Shared scheduling, selector,
header or ambiguous graph changes select every lane. Existing runtime source filters remain applicable,
with native host/action reach retained for decals and fluid and all five canonical/generated exposure
modules covered. Renames include both endpoints. The selector introduction itself runs all integration
lanes; unrelated failures are not hidden. Normal CI run 37141675755 on review-fix head 38ee061be
passed with one relevant unit job, zero template jobs and no native jobs; final integration head still
requires its own normal CI and independent review.

Parent review corrected the full-board count to 15 (13 scenario jobs plus both retained golden journeys); no golden journey saving is claimed. Unsupported output expressions, including bracket access or `||` fallbacks, fail the paths job visibly instead of emitting a partial lane decision.

Final bounded parent-review fixtures pass: 333 focused tests (318 CI contracts and 15 primary-docs/mirror checks). Output inventory spans blank/comment lines, validates filter/root completeness, and fails visibly on deleted outputs or unsupported expressions.

## Bounded qualification follow-up

Ordinary develop reviews retain affected coverage and existing Android coverage. Queue, main, explicit full and unknown inputs require all templates, both golden journeys, full native tier and every Integration lane. Integration is called by CI at the exact candidate; its completion job checks selected canonical receipts against completed-success Jobs API entries for this run and attempt, and `ci-required` independently repeats inventory and identity validation. Full-tree reusable matrix verdict reuse remains disabled.

CPU fixtures exercise writer→collector→protected verdict and reject missing, skipped, failed, stale and wrong-source evidence. Live reusable job-name/output behavior and a genuinely exhaustive queue cold path remain unverified; partial reruns require all selected Integration legs in the current attempt. This follow-up does not complete #430's separate rollout checkbox, defer Android, or change queue settings/timeouts.

PR #435's first ready run37237559625 attempt1 actually selected exhaustive qualification (all13templates, bothgoldens, full native and all Integration) at merge candidate `bb017d1cdf3a5a65f75adf131934abef0cbdd331`, distinct from workflow head `d11a545a8`. Its capture leg failed before runtime frames because the verifier's expected source input incorrectly included run/attempt artifact prefixes. The bounded repair restores the bare candidate SHA and retains attempt-qualified artifacts; proof: regression1 failing/66 passing →67/67 passing, plus299 related CPU contracts passed. Independent review approved the repair. Live corrected capture and full required joins remain unverified; no Android deferral, assertion waiver or timeout/settings change.

The same live attempt subsequently rejected macOS desktop provenance (`dirty:true`, correct candidate SHA, empty tracked diff hash) after runtime checks passed; no cleanliness exemption is accepted. A path-only `git status --porcelain=v1 --untracked-files=all` inventory now precedes the desktop production collector; known generated build/evidence/dependency paths were checked against ignore rules, but the exact untracked macOS path is not recoverable from the old artifact. Linux x64 starter also failed its new receipt writer during a GitHub API connection outage after runtime checks passed. Shared transport now retries only that observed connection error at most three times against the identical current-attempt endpoint, with all permissions, interrupted requests and malformed/incomplete evidence still failing closed; no fallback receipts or native suppression. Both failures remain binding in the first attempt. Live corrected qualification remains pending.

CPU-only source-state reproduction identified the configured root `.cache/ccache` compiler output as a definite dirty-source contributor: actual macOS logs confirm populated ccache storage, while the exact candidate ignore rules covered neither that directory nor its stats. A precise `/.cache/ccache/` output rule fixes the contract; regression1 failing/8 passing reproduces empty tracked diff plus untracked cache stats, and verifies adjacent `.cache/unexpected-source.mjs` remains visible after the fix. Path-only diagnostics remain to identify any additional unexpected source state. No dirty-source report is accepted on the basis of an empty diff hash.

User-authorized CI consolidation retains #435 as survivor and absorbs #436's exact reviewed hosted lint/performance routing content (`22bdd34faec2b17f7503e9247d3bfef4a65ffac1`); original patch/body/branch are preserved until published survivor content is verified. The flaky automatic browser `fluid-consumers` gate is deliberately retired from scheduling and required joins. Solver/gpu-readback CPU and fail-closed collision proof/view contracts, browser GPU collision readbacks/missing-gate control, Linux native fluid correctness, ordinary core fluid tests, authored scenarios and explicit consumer diagnostics remain. No blanket fluid-source exemption or fabricated success receipt is introduced. Full/queue inventory contains every retained Integration leg.

The Android receipt failed because exact packaged-library/compiler provenance was unavailable to the original unstripped-only inspector. A strict CI-only proof now handles legacy and task-scoped merged-library layouts: raw compiled output must match merged output, and any configured NDK symbol-stripping transformation must reproduce the exact executed APK library hash. Configured toolchain, O2, CMake profile and executed-library equality remain required; wrong/stale/mismatched evidence still blocks. This changes no APK build setting, runtime code or V8 recipe. CPU fixtures verify the proof; actual corrected Android qualification remains unverified. Auto-exposure also failed a real browser console-error assertion in the first attempt and remains required; no assertion suppression is authorized.

The consolidated source1015b95bc / candidate1df7d5a0 run37241861419 exposed a stale measured native coverage digest in budgets. The exact contributing delta was only the new pure desktop profile helpers added to native-test-lane.mjs. Those build/CI identity helpers are now isolated in desktop-build-profile.mjs, and the measured lane is restored byte-for-byte to f24 base. Independent review verified all238 measured inputs, the entire four-module coverage import closure, CMake/CTest/LLVM execution paths and downstream Node/helper/fixture/lock inputs unchanged; coverage never reaches native-build or the new helper. The recomputed digestfa76aa26 matches the untouched committed measured record. No numbers, digest stamp, exclusions, floors or execution defaults were edited, and no native build ran locally. Freshness/default-policy regressions: RED1failed/5passed to GREEN44/44. Full normal budget job commands and corrected live qualification remain pending.

The same candidate also failed a Node workflow contract that counted every ios_only != true expression globally (expected5, actual7). The original five desktop/Android job guards were intact; new performance-required-desktop and completion gates were legitimate. The repaired test verifies each named job's own if clause, completion's isolated-iOS receipt exclusion, performance desktop requirements, advisory iOS and event/run concurrency, and rejects inverted guards for all seven owners. RED1failed/45passed→GREEN46/46. Workflow behavior is unchanged; the actual full native suite's subsequent physics/publint and full joins remain unqualified until a corrected normal run passes. Full normal budgets/quality/agent checks passed after the coverage extraction; no assertion suppression or native evidence restamp.


The follow-up removes the repeated sequential pristine-template compiler loop only when the exact full qualification plan owns every dynamically discovered typecheck template through the required hosted matrix. Local, partial, unsupported and incomplete inputs retain the original loop. Each existing matrix leg has an unconditional pristine compiler step before scenarios; the protected verdict independently requires its current-attempt successful Actions step and workflow source identity. CPU protected-chain fixtures reject missing compiler steps and wrong scheduled source SHA, and static ownership rejects appended step exemptions/overrides. Fresh independent review approved these guards; live names/steps remain unqualified until normal CI passes.

Combined run37241861419 also failed Android's producer with TN_ANDROID_JS_O2_PROVENANCE_MISSING after75 conformance cases passed. Retained artifact11317604940 contains393 conformance/performance files but no compiler/cache/ninja/merged/APK inputs; logs do not expose which identity prerequisite rejected every candidate. The bounded change preserves all exact library, configured NDK transformation, optimization and cache checks and writes path/hash/rejection diagnostics to a separate always-uploaded artifact. It claims no Android identity repair or passing qualification before the real producer shape is observed.


Read-only inspection of cached exact NDK28.2.13676358 and CMake3.22.1 confirms a valid producer shape omitted by the original guard: NDK defines CMAKE_CXX_COMPILER as a normal variable; CMake only rewrites an existing compiler cache entry and records the compiler in CMakeFiles/<version>/CMakeCXXCompiler.cmake. The guard now reads that same-build generated metadata and rejects malformed/conflicting cached/generated identities. It still requires the configured NDK root, exact sibling compiler/strip tools, raw-to-merged match, exact strip-to-APK hash, O2 and actual CMake profile. Source-grounded layout fixtures pass; this is a supported repair hypothesis, not an observed cause or successful Android qualification. Attempt-specific diagnostic artifacts preserve the next producer's rejection evidence.499 CPU CI contracts and11 final Android/protected-chain controls pass; no local native execution.


The completed combined board also exposes a separate Windows functional blocker: production playtest mailbox operation3 exceeded35000ms, with startup2130ms but onlyrun-start, zero duration and zero samples. This remains required execution failure, not an advisory timing budget. Its exact artifact11318448059 and logs are retained; source inventory reports three tracked generated core files with an empty normalized diff. A separate read-only investigation is tracing Windows lifecycle/provenance; reviewed CI/Android repairs do not claim this workload fixed or qualify the failed board.


Run37245076840 on source6a41767e / candidate18e5c0b4 confirms the coverage-isolation and iOS-contract repairs: budgets and native workflow tests passed. Android's attempt-specific diagnostics show raw CXX and merged library hashes agree, but generated compiler declarations were absent from the inspector's inventory. The pinned SDK CMake version is3.22.1-g37088a8 (also shipped with-dirty suffix); its supported version directory was excluded by the numeric-only selector. The bounded repair recognizes only numeric release plus optional Git-hex and dirty suffix, reports all immediate metadata directories, and rejects unsupported directories containing compiler records. Both merged layouts and three supported version forms pass actual producer fixtures; unsupported/conflicting toolchains still reject.

Independent review also reproduced an Android provenance false positive: an unrelated target's-O2 or the runtime's later-O0 could satisfy the old whole-file search. The inspector now proves every object linked into the exact runtime output uses its own unique CMake compiler edge/rule, with final effective optimization-O2; unrelated flags, absent or ambiguous edges/rules, unresolved overrides and later-O0 reject. Compiler settings and APK production remain unchanged.

A CPU Git fixture reproduced Windows dirty status with empty normalized diff after a CRLF checkout's generated core file was rewritten as LF. The production source snapshot now records raw status and raw/HEAD/normalized identities, accepting only literal CRLF-to-LF bytes matching the exact indexed HEAD blob, unchanged modes/types, stable source state and empty final diff. Staged, untracked, renamed, deleted, symlink, mode and real content changes remain dirty; clean-filter and concurrent-change controls reject. Thirteen source-state controls and production-profile mock regressions passed; no native execution or tracked-path exemption.

The same current board repeats the Windows functional blocker: installed signed setup and relocated release checks pass, but the required production workload yields zero samples and fails its execution/marker checks. This is separate from source normalization. Bounded failure evidence retention captures the actual failed host console and mailbox request context before cleanup; the original failed diagnostic, timeout, workload and required verdict remain binding. This repair does not claim Windows qualification or complete rollout.


The completed current board has59 successful jobs, three root failures (Windows production workload, Android provenance and unit shard4) and two correct downstream failures. Unit shard4's eight verdict fixture failures came from inheriting the enclosing hosted PR's TN_CI_EVENT/base/head while using a synthetic candidate. An enclosing-PR-context regression reproduces the mismatch (1failed/52passed); isolating inherited TN_CI_* only in that synthetic fixture preserves explicit adversarial inputs and passes70 related CI/Android/chain controls. Production candidate validation is unchanged. The final source-state plus mocked profile suite passes92controls.


Failure evidence controls pass61CPU tests across the new eight failure-evidence cases and existing transport/desktop/lock suites, including actual desktop wrapper behavior when console writing is denied. Console capture/write failures retain the original timeout; pending request context is a single bounded record cleared on successful response/close. Package strict typecheck, scoped lint and diff checks pass. Fresh independent static review reports no actionable findings in the complete repair batch. These checks do not prove the Windows workload is repaired; exact full CI remains required.


Repair3 exact-board evidence: Android qualifies at candidate5daf/source63f; current Windows source is clean after literal CRLF normalization, but packaging feed503 and production workload stall remain binding. Actual failed console reaches frame72/nine presents at2725ms before silence. Separate startup warmup exceeds39seconds; exact blocking function is unproven. CPU controls reproduce a warmup budget-accounting defect where compile invocation's synchronous prefix receives extra waiting time; correction preserves deadlines and cannot preempt that prefix. Android proof controls also reproduce hidden quoted/escaped/response-file optimization overrides; failclosed unknown syntax rejects those shapes without changing compiler settings. Current candidate's first parent64aed differs from stale eventbasef24, so required gate correctly rejects. Clean base reconciliation prepared; full fresh qualification remains mandatory.


Fresh exact board 37252729340 at candidate f63dbf97/source 03399 has 62 successful jobs and only the Windows production workload as a root failure; native and required joins reject it correctly. Android and the unchanged unit3/world-GPU test pass; Windows release packaging and clean-source proof pass. The failed workload answers the bridge handshake then times out its first 60-tick advance during startup. The separate startup arm recovers, with compilation settled at 33,525 ms and framework ready at 43,813 ms. CPU full-runner controls reproduce the ordering failure. The shared device/desktop runner now completes its existing startup gate before all scenario warmup ticks, preserving setup, opt-out/no-startup behavior, every warmup/step tick, observation assertions and existing deadlines. A post-readiness warmup timeout remains binding. Hosted qualification of this sequencing repair remains required.
