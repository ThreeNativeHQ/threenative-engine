---
prd_contract: v1
---

# PRD-059 — Native dependency provenance and SBOM

**Status:** BLOCKED — IMPLEMENTATION COMMITTED IN ISOLATED LANE; NOT SQUASHED
**Priority:** P1 — Open boxes demand immutable refs, pre-flight URL validation and hash-before-extract.
**Lane commit:** `fb222c8ae47952179b24163d2149265f52a79dd2`

**Manager gate:** 10 declared controls reran with exact observed-red evidence; local
dependency/SBOM/provenance selectors return green after restoration, but same-candidate hosted
release evidence is unavailable.
**Owner:** Native release operator and runtime maintainers

**Complexity: 6 → MEDIUM mode.** The score is +3 for 10+ repository paths, +2 for a new
dependency-lock/provenance system, and +1 for release-host and upstream-download integration.

**Blast radius: exactly 14 repository paths across native dependency acquisition, generated
compliance artifacts, release provenance, tests, and evidence; no public API, gameplay,
renderer, physics, input, HUD, package-count, tracked `third_party/`, or default native-toolchain
gate changes.**

**Depends on:** PRD-048 for the existing tag-gated native release, prebuilt checksum lock,
failed-prerelease cleanup, and clean-consumer mechanics. PRD-059 adds dependency provenance to
that lane; it does not replace or close PRD-048.

**Existing owners remain authoritative:** PRD-046 owns native physics; PRD-048 owns local native
CLI and distribution mechanics; PRD-053 owns multitouch implementation and device proof;
PRD-054 owns fail-closed cross-target visual/behavior parity and host-shim coverage; PRD-055
owns generated HUD/text. Their outcomes may be release prerequisites, but none is re-specified
here.

## 1. Context

**Problem:** Native source builds fetch executable libraries, source archives, headers, and a
Gradle wrapper from the network, but almost every payload can reach extraction or installation
without first matching a repository-reviewed expected SHA-256, and releases carry no generated
dependency SBOM, license inventory, or artifact-to-input provenance link.

**Files Analyzed:** The native downloader and its package caller, native build CMake warnings,
the native release workflow and structural workflow test, the runtime `NOTICE`, PRD-046,
PRD-048 and their verification ledgers, the native status README, G1–G5 native ledgers, the
Charter, package/root agent rules, and all three production-readiness audit summaries.

**Current Behavior:**

- `packages/runtime-native/package.json:34` runs the downloader before every opt-in native
  build; root `package.json:21` is its workspace entry.
- `packages/runtime-native/scripts/download-deps.mjs:57-442` keeps versions and URLs inline.
  `stb` still resolves mutable `master`; platform variants and separate Dawn headers expand the
  actual payload set beyond the dependency-name list.
- The ordinary archive path downloads at `download-deps.mjs:813-815` and immediately extracts.
  The multi-archive path does the same at `:684-697`; raw headers are written without an
  expected digest at `:729-775`.
- Only the Gradle wrapper compares a repository-known expected SHA-256 before use
  (`download-deps.mjs:573-581`). Wgpu records library hashes only after extraction
  (`:526-545`, `:879-882`), which cannot reject a substituted archive before its contents are
  processed.
- The tag-gated release creates SHA-256 values for the produced runtime artifacts
  (`.github/workflows/native-release.yml:229-257`) and publishes them with PRD-048's prebuilt
  lock (`:259-269`), but it does not publish the native dependency lock, SBOM, license inventory,
  acquisition receipts, or a manifest connecting those inputs to each output.

### Evidence identity and claim boundary

| Evidence class | Current fact | What it may prove for this PRD |
|---|---|---|
| Dirty worktree | The audit observed many modified/untracked runtime, workflow, parity, and verification files over `main`. | Discovery evidence only. It is not a release candidate and cannot close any criterion. |
| Committed HEAD | `50f8eb491fbfcfdbf678cf24fdbe9db0e3e1665d` (`50f8eb4`, tag `runtime-native-v0.1.13`). The downloader and native-release workflow inspected here are committed at that identity. | The implementation baseline; not proof that PRD-059 exists or ran. |
| Older hosted CI | Native cross-runner evidence at `2c5f7f0` predates committed HEAD and PRD-059. | Historical platform evidence only; it cannot satisfy a PRD-059 gate. |
| Emulator | Android x86_64 source/runtime evidence exists under incumbent PRDs. | No supply-chain or physical-hardware claim; an emulator run cannot replace lock/provenance checks. |
| Simulator | Hosted iOS simulator evidence exists at the older SHA. | No physical-device, signing, or current-SHA provenance claim. |
| Hosted runner | Prior macOS, Windows, Android, and iOS jobs establish that runner types exist. | PRD-059 requires a fresh run whose reported source SHA equals its candidate SHA. |
| Physical hardware | No qualifying physical-device evidence is needed or produced by this PRD. | Always outside scope; PRD-053/054 and physical-qualification owners retain it. |
| Signed artifact | No signing/notarization result is claimed. | Outside scope. An unsigned artifact may still have dependency provenance, but not a signed-distribution claim. |
| Published package | No npm publication is required or claimed. | Outside scope and still owned by distribution work. |
| Promoted consumer | No release promotion or public-consumer success is required or claimed. | Outside scope. PRD-048 remains authoritative. |

## 2. Scope Limits and Anti-Scope

**In scope:**

1. One tracked, reviewed lock containing every payload selectable by
   `download-deps.mjs`: archives, multi-archive variants, raw headers, Dawn headers, the Gradle
   wrapper, and both supported wgpu regression versions.
2. For every component and payload: immutable version/revision, exact URL, expected SHA-256,
   source repository and revision, license expression, license-evidence URL/hash, target/variant,
   and checksum bootstrap source.
3. Verification in quarantine before extraction, mounting, copying, AAR expansion, header
   installation, or mutation of `third_party/`; deterministic acquisition receipts for fresh
   and cached installs.
4. Deterministic CycloneDX JSON and machine-readable license inventory generated from the
   validated lock and acquisition receipts, then attached to native prereleases.
5. A release provenance manifest linking every PRD-048 runtime artifact to candidate SHA/tag,
   workflow run, dependency-lock hash, acquisition-receipt hashes, SBOM hash, license-inventory
   hash, `pnpm-lock.yaml` hash, and native physics `Cargo.lock` hash.

**Anti-scope:**

- Do not vendor dependency source, archives, headers, license files, or generated reports.
  `packages/runtime-native/third_party/`, `.runtime/`, build outputs, and release staging remain
  ignored and untracked.
- Do not add a package, runtime API, CLI top-level command, renderer path, native physics ABI,
  host shim, parity row, gameplay behavior, HUD, signing/notarization, store submission, npm
  publication, physical-device qualification, or performance claim.
- Do not rewrite PRD-048's prebuilt-runtime checksum/install transaction. Its lock continues to
  answer “did the consumer receive the released runtime bytes?”; PRD-059 answers “which reviewed
  dependency bytes and source identity produced them?”
- Do not make CMake, an NDK, Xcode, Rust, or network access part of the default
  `pnpm typecheck`, `pnpm lint`, `pnpm test`, or `pnpm budgets` gate.
- Do not accept `main`, `master`, `latest`, an unversioned redirect, a post-extraction hash, or a
  freshly downloaded trust-on-first-use digest as an implementation-time lock value.

## 3. Solution

**Approach:**

- Move acquisition authority from inline downloader literals into
  `native-deps.lock.json`. Keep target selection in the downloader, but require every selected
  payload to resolve to exactly one lock entry before any fetch begins.
- Fetch to an ignored quarantine path, compute SHA-256 over the received bytes, compare to the
  lock, and only then extract into an ignored temporary install root. Atomically replace the
  final dependency directory only after existing post-install checks pass. Raw headers follow
  the same verify-before-copy rule.
- Write one receipt per installed component containing the lock hash, payload ids/URLs/digests,
  target, post-install transforms, and installed-file hashes. A cache without a matching receipt
  is stale and is re-acquired; `--force` may refresh bytes but may never bypass the lock.
- Generate a deterministic CycloneDX 1.5 SBOM and license inventory from the validated lock and
  receipts. Sort every component/reference, omit wall-clock timestamps, and fail when any
  selected payload lacks source or license evidence.
- Extend, without replacing, the native release workflow so the prerelease publishes the lock,
  SBOM, license inventory, acquisition reports, and release provenance manifest alongside
  PRD-048's runtime assets and `prebuilt-lock.json`.

**Key Decisions:**

- The lock is hand-reviewed input, never generated from whatever bytes a URL returns during a
  build. Initial hashes come from vendor-published checksums when available. Where a vendor
  publishes none, the evidence ledger records the immutable release asset id/size, exact source
  revision and two matching quarantined downloads on independent hosted runner types before a
  maintainer accepts the hash.
- Floating `stb/master` becomes an immutable source commit and raw-content URL. All derived
  wgpu v24/v25 target URLs are explicit lock entries; string substitution cannot create an
  unlocked URL.
- License metadata is evidence-bearing: SPDX expression plus immutable upstream license URL and
  its SHA-256. `NOASSERTION` or a missing/changed evidence digest blocks generation and release.
- The SBOM describes dependencies acquired by the native downloader. Existing pnpm and Cargo
  lockfiles remain their package managers' authorities; their hashes are linked in release
  provenance rather than duplicating their dependency resolution here.
- Failure is fail-closed: missing entry, unexpected URL, redirect to a different final URL,
  digest mismatch, license-metadata drift, receipt mismatch, or stale generated output exits
  nonzero before extraction/publication.

**Data Changes:** A new schema-versioned tracked JSON dependency lock; generated CycloneDX,
license-inventory, receipt, and release-provenance JSON remain ignored build/release outputs.
There is no database, public configuration, or serialized game-state migration.

### Project Structure

```mermaid
flowchart TD
    root["repository root/"]
    workflows[".github/workflows/native-release.yml<br/>release caller"]
    docs["docs/<br/>PRDs/production-readiness/PRD-059...<br/>PRDs/done/PRD-059...<br/>PRDs/native/PRD-046 · PRD-048 · README.md<br/>architecture/CHARTER.md · verification/PRD-059.md"]
    package["package.json<br/>existing workspace caller"]
    lock["pnpm-lock.yaml<br/>provenance input"]
    release["release/<br/>native-dependencies.cdx.json<br/>native-license-inventory.json<br/>native-release-provenance.json"]
    runtime["packages/runtime-native/"]
    agents["AGENTS.md · .gitignore<br/>authority and invariants"]
    cmake["CMakeLists.txt<br/>live consumer"]
    notice["NOTICE · native-deps.lock.json<br/>inventory pointer and acquisition authority"]
    physics["native/physics/Cargo.lock<br/>provenance input"]
    scripts["scripts/<br/>download-deps.mjs<br/>generate-native-sbom.mjs<br/>generate-native-release-provenance.mjs"]
    tests["tests/<br/>dependency-provenance.test.mjs<br/>native-sbom.test.mjs<br/>native-platform-workflow.test.mjs"]
    thirdParty["third_party/<br/>untracked acquisition destination"]
    state[".runtime/provenance/<br/>generated acquisition report, SBOM and license inventory"]

    root --> workflows
    root --> docs
    root --> package
    root --> lock
    root --> release
    root --> runtime
    runtime --> agents
    runtime --> cmake
    runtime --> notice
    runtime --> physics
    runtime --> scripts
    runtime --> tests
    runtime --> thirdParty
    runtime --> state
```

**How will this feature be reached?**

- Entry point: `pnpm native:build` reaches `packages/runtime-native/package.json:34`, and a
  `runtime-native-v*` tag reaches `.github/workflows/native-release.yml:3-6`.
- Pre-existing files edited to call it: `packages/runtime-native/package.json:33-34` and
  `.github/workflows/native-release.yml:218-269`.
- Registration/wiring: package scripts invoke lock verification/SBOM generation; every release
  build uploads its acquisition receipt; the publish job validates all receipts and stages the
  three generated compliance/provenance artifacts before `gh release create`.

**Is this user-facing?** No runtime UI. It is an operator/consumer-integrity feature triggered
by native dependency acquisition and release production.

**Full flow:**

1. A source builder or hosted release runner invokes the existing native build command.
2. The downloader resolves the requested target/variant to the tracked lock before fetching.
3. Verified bytes are extracted into an ignored temporary root, installed, and receipted.
4. The release job aggregates receipts and generates deterministic SBOM/license/provenance JSON.
5. A release operator or consumer can follow each runtime artifact's provenance record to the
   exact candidate SHA, dependency lock, source revisions, hashes, licenses, and workflow run.

**What does this replace?** Inline URL/version authority and skip-unverified caches in the
downloader. It does not replace the downloader, wgpu's post-install structural checks,
PRD-048's prebuilt lock, or any upstream package-manager lock.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `native-deps.lock.json` | `packages/runtime-native/package.json:34` invokes `download-deps.mjs`; its live fetch/extract boundary is `packages/runtime-native/scripts/download-deps.mjs:813-815` | inline version/URL authority at `download-deps.mjs:57-442` | yes; downloader retains selection logic but no independent downloadable URL/version/checksum/license constants | remove the selected entry; acquisition exits nonzero before fetch/extract |
| 2 | verify-before-extract transaction and acquisition receipt | `packages/runtime-native/package.json:34`; root caller `package.json:21` | direct download→extract at `download-deps.mjs:684-697` and `:813-835`, plus unverified non-wgpu cache skips at `:664-680` and `:784-800` | yes; all archive/header paths delegate to one locked transaction; wgpu post-install inspection remains secondary | serve tampered bytes; extractor call count stays zero and destination stays absent/unchanged |
| 3 | deterministic SBOM and license generator | `.github/workflows/native-release.yml:218-229` is the existing publish path; `packages/runtime-native/package.json:33` is the local operator script surface | generic third-party sentence in `packages/runtime-native/NOTICE:9-10` | now delegates readers to generated inventory; package license/NOTICE remain | change license metadata after generation; `--check` exits nonzero on stale output |
| 4 | `native-release-provenance.json` | tag event `.github/workflows/native-release.yml:3-6` reaches publish job `:218-269` | release outputs with hashes but no input/source/workflow linkage | additive; PRD-048 `prebuilt-lock.json` remains live and gains only a provenance URL field | omit one runtime subject or use a source SHA different from the candidate; generation exits nonzero |
| 5 | release provenance structural gate | `.github/workflows/native-release.yml:229-269` generates then publishes `release/*` | green release wiring that can omit compliance artifacts | yes; publication is ordered after receipt/SBOM/license/provenance validation | remove the generator/upload token from an in-memory workflow copy; focused test exits nonzero |

## 4. Execution Phases

The first proving subject is the real complete acquisition surface: every dependency selected by
desktop, `--android`, `--ios`, `--all`, and both supported wgpu regression versions. A toy single
archive cannot close Phase 1. Every phase stops for its checkpoint before the next begins.

#### Phase 1: Locked acquisition — every selected payload is verified before extraction

**Outcome:** A source builder can run the existing native acquisition path only with
repository-reviewed immutable URL/version/source/license/SHA metadata, and tampered or
unlocked input cannot invoke an extractor or alter an installed dependency.

**Files (4):**

- `packages/runtime-native/native-deps.lock.json` - NEW: schema-versioned component and payload matrix; provenance is the audited inline `DEPS` census plus independently bootstrapped expected hashes.
- `packages/runtime-native/scripts/download-deps.mjs` - EDIT: validate/resolve the lock, quarantine downloads, verify redirect and SHA-256, extract transactionally, emit receipts, and reject stale unreceipted caches; existing caller evidence: `packages/runtime-native/package.json:34`.
- `packages/runtime-native/tests/dependency-provenance.test.mjs` - NEW: focused lock/acquisition tests collected by the existing Vitest package gate at `packages/runtime-native/package.json:43`.
- `packages/runtime-native/package.json` - EDIT: add bounded `deps:verify` and `deps:sbom` script callers without changing `native:build`; current live dependency caller is line 34.

**Implementation:**

- [ ] Enumerate every actual payload, including platform variants, separate Dawn headers, raw
  stb/cgltf headers, Gradle wrapper, iOS/Android multi-archives, and wgpu v24/v25 variants.
- [ ] Replace every floating ref with an immutable revision. Require exact HTTPS URL, final URL,
  64-hex SHA-256, byte size when published, source repository/revision, SPDX license expression,
  immutable license-evidence URL/SHA-256, and checksum-bootstrap evidence.
- [ ] Validate the entire requested set before the first network request. A missing, duplicate,
  malformed, or target-inapplicable entry exits nonzero and reports its payload id.
- [ ] Download to `.runtime` quarantine; hash before any extraction/mount/copy; install into a
  temporary directory; apply current QuickJS/SDL/layout transforms; then atomically replace the
  final untracked destination and write its receipt.
- [ ] Preserve wgpu's tag/library post-install inspection as a second gate. Generalize cache
  validation so every dependency requires a receipt matching the current lock hash.

**Wiring (the phase is not done without this):**

- [ ] Caller edited: package `native:build` continues to invoke the now-locked downloader.
- [ ] Registration: all desktop/mobile/wgpu selectors resolve lock ids, never construct an
  unreviewed downloadable URL.
- [ ] Old path: inline authority and direct download→extract branches are removed or delegate to
  the locked transaction.
- [ ] Ledger rows filled: #1 and #2 with implementation `file:line` values; no pending cells.

**Tests Required:**

| Gate | Test File | Test Name | Explicit assertion semantics | Negative control |
|---|---|---|---|---|
| `dep-lock-coverage` | `packages/runtime-native/tests/dependency-provenance.test.mjs` | `should lock every selectable payload when the full target matrix is resolved` | Set equality between resolver payload ids and lock payload ids for desktop platforms, Android, iOS and both wgpu versions; zero duplicate ids/URLs; every revision immutable and every digest exactly 64 lowercase hex characters. | Delete one selected entry in the fixture; expect `TN_NATIVE_DEP_LOCK_MISSING`, zero fetches and zero extractor calls. |
| `archive-before-extract` | same | `should reject a tampered archive before extraction when downloaded bytes differ` | Child exits nonzero with expected/actual digest and payload id; extractor spy count is `0`; old destination bytes are unchanged and no new destination exists. | Bypass the digest comparison; the destination/extractor assertions must turn the test red. |
| `locked-url` | same | `should reject a changed or redirected URL before accepting bytes` | Requested and final URLs must equal the lock; mismatch exits nonzero before extraction even when bytes happen to match the expected digest. | Change one resolver URL while retaining the old lock; expect `TN_NATIVE_DEP_URL_MISMATCH`. |
| `license-metadata` | same | `should reject missing or changed license evidence before acquisition` | Missing SPDX, evidence URL/hash, source revision, or stale generated-license hash exits nonzero before fetch and names the component. | Change the SPDX/evidence tuple after inventory generation; `--check` must fail. |
| `reproducible-acquisition` | same | `should produce byte-identical receipts for fresh and cached acquisition` | Two isolated acquisitions of the same fixture yield byte-identical canonical receipts, identical lock hash/payload hashes/installed file list, and the second cache path verifies rather than silently skips. | Inject a timestamp or reorder an installed-file list; byte comparison fails. |

**Revert check:** Restore the current direct extraction path or remove lock loading; the focused
tamper/missing-entry tests fail, and the existing package `native:build` path loses its required
receipt. This is a pre-existing live flow, not a test-only importer.

**User Verification:** Run `pnpm --filter @threenative/runtime-native deps:verify`. Expected:
every selectable payload is reported locked with immutable source/license evidence; no download,
extract, CMake, NDK, Xcode, or Rust invocation occurs.

#### Phase 2: Deterministic SBOM and license inventory — operators can audit acquired inputs

**Outcome:** The complete locked dependency matrix generates byte-stable CycloneDX and license
inventory artifacts, and generation refuses incomplete or stale acquisition evidence.

**Files (4):**

- `packages/runtime-native/scripts/generate-native-sbom.mjs` - NEW: validate lock/receipts and generate canonical CycloneDX 1.5 plus license inventory; existing release caller to edit is `.github/workflows/native-release.yml:218-229`.
- `packages/runtime-native/tests/native-sbom.test.mjs` - NEW: generator/schema/determinism tests collected by `packages/runtime-native/package.json:43`.
- `packages/runtime-native/package.json` - EDIT: wire `deps:sbom` and `deps:sbom:check` to the generator; existing operator-script surface is lines 32-43.
- `packages/runtime-native/NOTICE` - EDIT: retain fork notice and direct release/package auditors to the generated inventory; existing third-party statement is lines 9-10.

**Implementation:**

- [ ] Emit CycloneDX 1.5 JSON with one component per name+version+source revision, artifact hashes
  as external references/properties, target applicability, license expression, and dependency
  relationships. Validate the result against the committed schema expectations in tests.
- [ ] Emit a sorted license inventory containing component/version/source revision, SPDX
  expression, evidence URL/hash, attribution/notice requirement, and all payload ids.
- [ ] Use canonical key/list ordering and no wall-clock timestamp. Re-running from identical lock
  and receipts must produce byte-identical outputs.
- [ ] `--check` compares regenerated bytes with supplied outputs and exits nonzero on missing,
  extra, stale, or self-inconsistent components, licenses, payloads, or receipts.
- [ ] Keep generated files under ignored `.runtime` locally and release staging on hosted runners;
  do not add them to package `files` or git.

**Wiring (the phase is not done without this):**

- [ ] Caller edited: package scripts expose deterministic generation/check; Phase 3 calls the
  same production script rather than a workflow-only reimplementation.
- [ ] Registration: each acquisition receipt references the lock digest consumed by the generator.
- [ ] Old path: `NOTICE` no longer implies that an untracked dependency tree has no auditable
  inventory; it points to the generated release artifact without embedding generated data.
- [ ] Ledger row filled: #3 with implementation `file:line`; no pending cells.

**Tests Required:**

| Gate | Test File | Test Name | Explicit assertion semantics | Negative control |
|---|---|---|---|---|
| `native-sbom` | `packages/runtime-native/tests/native-sbom.test.mjs` | `should generate a complete deterministic CycloneDX document from the real lock` | Every lock component appears exactly once by package URL; every payload SHA/source revision is reachable from its component; two runs are byte-identical; no timestamp or absolute workstation path exists. | Remove one component after generation; `deps:sbom:check` exits nonzero and names it. |
| `native-license-inventory` | same | `should fail when license evidence is absent changed or orphaned` | Set equality between lock components and inventory components; exact SPDX/evidence URL/evidence SHA match; `NOASSERTION`, missing evidence, or an orphan inventory row is rejected. | Change one license tuple without regenerating; check exits nonzero. |

**Revert check:** Delete the generator or omit a lock component; `deps:sbom:check` and the Phase 3
workflow structural gate fail. A green native binary without auditable input inventory is no
longer releasable.

**User Verification:** Run the generator twice in separate ignored output directories and compare
both JSON files byte-for-byte. Expected: equal bytes and no tracked-file change.

#### Phase 3: Release provenance — every runtime asset links to reviewed inputs

**Outcome:** A tag-gated native prerelease cannot publish unless every runtime output has a
same-candidate acquisition receipt and a provenance record linking it to lock, SBOM, licenses,
workflow run, source/package-manager lock hashes, and PRD-048's artifact URL.

**Files (3):**

- `packages/runtime-native/scripts/generate-native-release-provenance.mjs` - NEW: validate subjects/receipts/SHA identity and emit the canonical release provenance manifest; existing live publish caller is `.github/workflows/native-release.yml:218-269`.
- `.github/workflows/native-release.yml` - EDIT: verify lock before every build, upload per-job receipts, aggregate them, generate/publish compliance artifacts before `gh release create`, and add the provenance URL to PRD-048's prebuilt lock; tag event caller is lines 3-6.
- `packages/runtime-native/tests/native-platform-workflow.test.mjs` - EDIT: assert source-SHA identity, receipt aggregation, generator ordering, exact artifact set, and publication wiring; existing workflow readers are lines 5-12.

**Implementation:**

- [ ] Every platform build runs lock validation before acquisition and uploads its canonical
  receipt with `if-no-files-found: error`; receipts identify runner OS/arch but contain no
  absolute runner path or secret.
- [ ] The publish job rejects missing/duplicate receipts, lock-hash disagreement, a receipt source
  SHA other than `github.sha`, an artifact subject not in PRD-048's expected set, or a subject
  without a receipt applicable to its target.
- [ ] Generate a manifest with schema version, candidate SHA/tag, repository, workflow/run attempt
  URL, subject artifact URL/SHA-256, dependency lock URL/SHA-256, SBOM/license URLs/SHA-256,
  receipt URLs/SHA-256, and pnpm/Cargo lock hashes.
- [ ] Add a non-circular top-level provenance URL to `prebuilt-lock.json`; the provenance manifest
  hashes that prebuilt lock and every release subject. The installer behavior remains unchanged.
- [ ] Publish runtime assets, prebuilt lock, tracked dependency lock copy, receipts, SBOM, license
  inventory and provenance in one prerelease transaction. Existing failed-prerelease cleanup and
  consumer jobs remain PRD-048's responsibility.

**Wiring (the phase is not done without this):**

- [ ] Caller edited: the existing tag event and publish job invoke the production generators.
- [ ] Registration: `release/*` includes all provenance/compliance files before the existing
  `gh release create` call.
- [ ] Old path: inline runtime checksum generation may remain only for PRD-048 artifact selection;
  release input linkage is no longer absent or workflow prose.
- [ ] Ledger rows filled: #4 and #5 with implementation `file:line`; no pending cells.

**Tests Required:**

| Gate | Test File | Test Name | Explicit assertion semantics | Negative control |
|---|---|---|---|---|
| `release-provenance` | `packages/runtime-native/tests/native-platform-workflow.test.mjs` | `should require one same-SHA provenance subject for every released runtime artifact` | Exact set equality with PRD-048 artifact names; each subject SHA matches staged bytes; candidate/receipt SHA equals expected SHA; all lock/SBOM/license/receipt hashes and URLs are present; missing or extra subject rejects. | Supply older `2c5f7f0` receipt for a `50f8eb4` candidate or omit one artifact; generator exits nonzero. |
| `release-wiring` | same | `should generate and validate provenance before publishing release assets` | Workflow token order is lock validation → build → receipt upload → aggregate → SBOM/license → provenance → `gh release create`; all upload/download steps fail on missing files. | Remove the generator or receipt upload token; focused workflow test exits nonzero. |

**Revert check:** Remove provenance generation from the workflow while leaving runtime builds green;
the pre-existing workflow structural test now fails. This is the required integration litmus: a
release cannot be indistinguishable from the pre-PRD release lane.

**User Verification:** Inspect a staged prerelease subject and follow its provenance URLs. Expected:
subject hash, candidate SHA, dependency lock, SBOM, license inventory, receipts and workflow run all
resolve and agree; no signed/published/promoted claim is inferred.

#### Phase 4: Evidence and cutover — the plan becomes DONE only on same-candidate hosted evidence

**Outcome:** The evidence ledger distinguishes local/dirty proof from a same-SHA hosted prerelease,
and the PRD moves to `done/` only when every binary criterion is satisfied.

**Files (4):**

- `docs/verification/PRD-059.md` - NEW: dated command/output, lock bootstrap sources, negative-control reds, artifact hashes/URLs, runner identities, dirty-state disclosure, and acceptance audit.
- `docs/PRDs/native/README.md` - EDIT: add dependency-provenance status without changing its emulator/simulator/physical/release claims; existing status identity is lines 1-12.
- `docs/PRDs/production-readiness/PRD-059-native-dependency-provenance-sbom.md` - DELETE: moved only after all criteria pass; this planning artifact is the source.
- `docs/PRDs/done/PRD-059-native-dependency-provenance-sbom.md` - NEW: same artifact moved with checked acceptance/evidence links; provenance is the production-readiness path above.

**Implementation:**

- [ ] Record every initial expected digest's authoritative checksum source or two-run bootstrap
  evidence. A local current-URL hash without source/revision/asset identity is rejected.
- [ ] Record focused positive gates and one observed-red result for every gate in the Negative
  Controls table. Green-only results remain `UNVERIFIED`.
- [ ] Record `git status --short`, exact candidate SHA, lock/SBOM/license/provenance hashes, hosted
  workflow URL/run attempt, and all runner target identities. The hosted run must report the same
  SHA as the candidate.
- [ ] State explicitly that emulator/simulator, physical hardware, signing, npm publication and
  promoted-consumer results were not produced by PRD-059.
- [ ] When and only when every acceptance box is checked, use `git mv` to the `done/` path in the
  same finishing commit. Never copy two live PRDs.

**Wiring (the phase is not done without this):**

- [ ] Caller edited: native status README points to the evidence ledger and exact candidate run.
- [ ] Registration: review packet includes the verbatim Integration Ledger, Negative Controls,
  Acceptance Criteria and checkpoint evidence.
- [ ] Old path: production-readiness PRD path is removed by `git mv` only at DONE; it remains in
  place for NOT STARTED, IN PROGRESS, or BLOCKED.
- [ ] Ledger has zero pending cells and all implementation callers are real non-test `file:line`.

**Tests Required:**

| Gate | Test File | Test Name | Explicit assertion semantics | Negative control |
|---|---|---|---|---|
| `evidence-truth` | `docs/verification/PRD-059.md` | `same-candidate release evidence audit` | Candidate SHA equals every receipt and workflow SHA; all required artifact URLs/hashes resolve in the recorded prerelease; dirty/local/older SHA evidence is labelled and excluded from PASS. | Feed an older-SHA receipt or cancelled/missing run; audit verdict is BLOCKED/nonzero, never PASS. |

**Revert check:** Remove the hosted-run link or substitute older `2c5f7f0` evidence; acceptance
criterion 9 and the evidence-truth audit fail, and the PRD stays outside `done/`.

**User Verification:** Open the prerelease provenance asset from the recorded workflow run and
compare its candidate SHA with `git rev-parse HEAD`. Expected: exact equality and resolvable hashes;
otherwise status is BLOCKED.

## Negative Controls

These are specifications for implementation checkpoints. The listed result is not claimed as
observed during authoring. The worker must deliberately apply each failure action in an isolated
worktree, run the exact command, record the real nonzero exit/output, restore the change, and then
run the green gate. `PASS` without that observed-red packet is `UNVERIFIED`.

| Gate | Negative control | Expected red | Exact command/result |
|---|---|---|---|
| `dep-lock-coverage` | remove one real `--all` payload entry from the lock fixture | focused test names `TN_NATIVE_DEP_LOCK_MISSING`; fetch and extractor counts remain zero; command exits nonzero | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/dependency-provenance.test.mjs -t "should lock every selectable payload when the full target matrix is resolved"`; result: RED observed: selected payload missing from lock; exit: 1 |
| `archive-before-extract` | bypass the expected SHA-256 comparison while the server returns the tampered archive fixture | extractor/destination assertions fail and command exits nonzero | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/dependency-provenance.test.mjs -t "should reject a tampered archive before extraction when downloaded bytes differ"`; result: RED observed: tampered archive reached extraction boundary; exit: 1 |
| `locked-url` | change one resolver URL while retaining the reviewed lock URL and digest | test reports `TN_NATIVE_DEP_URL_MISMATCH`, zero extraction, nonzero exit | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/dependency-provenance.test.mjs -t "should reject a changed or redirected URL before accepting bytes"`; result: RED observed: changed URL was not rejected; exit: 1 |
| `license-metadata` | change/remove one component's SPDX or license-evidence URL/hash after generating the inventory | lock/inventory check names component and exits nonzero before fetch/release | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/dependency-provenance.test.mjs -t "should reject missing or changed license evidence before acquisition"`; result: RED observed: changed license metadata was accepted; exit: 1 |
| `reproducible-acquisition` | inject a wall-clock timestamp and unstable file ordering into the receipt | fresh/cached receipt byte comparison fails with nonzero exit | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/dependency-provenance.test.mjs -t "should produce byte-identical receipts for fresh and cached acquisition"`; result: RED observed: acquisition receipts differ for identical locked inputs; exit: 1 |
| `native-sbom` | delete one real component from a generated SBOM before `--check` | set-equality check names missing component and exits nonzero | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/native-sbom.test.mjs -t "should generate a complete deterministic CycloneDX document from the real lock"`; result: RED observed: incomplete SBOM accepted; exit: 1 |
| `native-license-inventory` | add an orphan row and remove one locked component's row | exact component/license set check exits nonzero | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/native-sbom.test.mjs -t "should fail when license evidence is absent changed or orphaned"`; result: RED observed: stale license inventory accepted; exit: 1 |
| `release-provenance` | use an `2c5f7f0` receipt for a candidate at `50f8eb4` and omit one subject | generator/test rejects SHA mismatch and missing subject with nonzero exit | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/native-platform-workflow.test.mjs -t "should require one same-SHA provenance subject for every released runtime artifact"`; result: RED observed: stale or incomplete release provenance accepted; exit: 1 |
| `release-wiring` | remove receipt aggregation/provenance generation from the workflow copy while leaving runtime build steps | structural gate reports missing/incorrect ordering and exits nonzero | `command: pnpm --filter @threenative/runtime-native exec vitest run tests/native-platform-workflow.test.mjs -t "should generate and validate provenance before publishing release assets"`; result: RED observed: release can publish without provenance; exit: 1 |
| `evidence-truth` | point the evidence audit at a cancelled, missing, dirty-only, or older-SHA run | verdict is BLOCKED and command exits nonzero | `command: node packages/runtime-native/scripts/generate-native-release-provenance.mjs --check-evidence docs/verification/PRD-059.md`; result: RED observed: evidence SHA or hosted run is not the candidate; exit: 1 |

## Acceptance Criteria

Binary rule: every box is either checked with recorded evidence or unchecked. There is no partial
credit, and an unchecked box means the PRD is not DONE.

- [ ] A source builder selecting any desktop, Android, iOS, `--all`, or supported wgpu regression
  payload can acquire only entries present in the tracked lock; each has immutable URL/version,
  source revision, expected SHA-256, and license evidence.
- [ ] Tampered bytes, missing lock entry, changed/redirected URL, and missing/changed license
  metadata each fail before extractor/mount/copy invocation and before the existing dependency
  destination changes.
- [ ] Fresh and cached acquisition of the same locked payloads produce byte-identical canonical
  receipts, and `--force` cannot bypass verification.
- [ ] No generated report, payload, source tree, archive, header, or license file is tracked under
  `third_party/`, `.runtime/`, build, artifacts, or release staging; `pnpm budgets` retains all hard
  invariants and the native LOC trigger remains visible.
- [ ] The real complete lock produces byte-identical CycloneDX 1.5 and license-inventory JSON on
  repeated generation, with exact component/payload/license set equality and no absolute path or
  wall-clock field.
- [ ] Every native prerelease runtime subject links to a provenance record containing its own
  hash/URL, candidate SHA/tag/run, dependency lock, applicable receipts, SBOM, license inventory,
  pnpm lock and native physics Cargo lock hashes.
- [ ] PRD-048's prebuilt lock/install/cleanup/consumer mechanics remain green and authoritative;
  PRD-059 adds only a provenance URL and release files, with no installer fallback or duplicate
  distribution implementation.
- [ ] Default repository gates remain toolchain-free and green; source compilation/acquisition
  stays opt-in or hosted-release-only.
- [ ] A fresh hosted native prerelease run at the final candidate SHA publishes and validates all
  provenance/compliance artifacts. Dirty-worktree proof, committed baseline `50f8eb4`, older CI
  `2c5f7f0`, emulator, simulator, physical hardware, signed artifact, npm package, or promoted
  consumer is never substituted for that same-candidate run.
- [ ] Every Integration Ledger row has a final real non-test `file:line`; every gate has recorded
  observed-red evidence; the production-readiness PRD is moved with `git mv` to `docs/PRDs/done/`
  in the finishing commit.

### Explicit BLOCKED / DONE semantics

- **NOT STARTED:** This validated planning artifact exists, but no implementation evidence exists.
- **IN PROGRESS:** At least one phase has implementation evidence, but a later phase or criterion is
  open. The PRD remains at its production-readiness path.
- **BLOCKED:** Local code/tests may be complete, but the same-candidate hosted prerelease cannot run,
  a trusted expected digest/license source cannot be established, or any required external release
  artifact is unavailable. BLOCKED is nonzero/not delivered and cannot be called DONE.
- **DONE:** All ten acceptance boxes are checked, all negative controls were observed red, the
  same-candidate hosted prerelease evidence exists, no incumbent owner was rewritten, and the PRD
  plus evidence move is included in the finishing commit. Code-complete, locally green, emulator
  green, simulator green, signed, published, or promoted alone is not DONE.

## Checkpoint Protocol

After each phase, the worker records a packet in `docs/verification/PRD-059.md` and stops for the
manager. Creator planning never launches a worker/reviewer or continues automatically.

| Checkpoint field | Required evidence | Delivery blocker |
|---|---|---|
| Automated gates | Exact command, exit, test count, relevant output hashes, and files collected for the phase tests plus repository verification commands. | Any nonzero positive gate, missing collection, stale generated artifact, or green-only gate blocks. |
| Observed-red controls | One exact command/result row per phase gate copied verbatim from Negative Controls, with actual nonzero exit and failure message, followed by restored green result. | Missing red, exit 0, wrong test, or a red caused before the named assertion is `UNVERIFIED`. |
| Caller census | Updated Integration Ledger with real non-test `file:line`; `rg` output showing package/release callers and no second URL/version authority. | Test-only caller, definition-only hit, inline duplicate authority, or pending cell blocks. |
| Revert/incumbent check | Disable the new path and show existing native build/release structural flow fails; confirm PRD-048 prebuilt lock remains live and PRD-046/053/054/055 files were not functionally changed. | New path can be deleted unnoticed, or an incumbent implementation is duplicated/replaced. |
| Scope/budget check | `git diff --name-only`, `git ls-files packages/runtime-native/third_party`, package count, default toolchain-free gates, and `pnpm budgets` output including the nonfatal native LOC trigger. | Any out-of-scope path, tracked third-party file, hidden trigger, new package, or default native-toolchain requirement blocks. |
| Manual security checkpoint | Owner: runtime release maintainer. Action: review each initial checksum/license bootstrap source and one complete staged provenance traversal. Expected: immutable identity and all hashes/URLs agree. Confirmation required in evidence. | Missing maintainer confirmation blocks Phase 1 lock acceptance and Phase 4 DONE. |
| Final hosted checkpoint | Owner: manager/release operator. Action: inspect the same-candidate hosted prerelease and evidence without modifying it. Expected: every release subject and compliance artifact resolves and matches. | Cancelled/missing/older-SHA run or unavailable artifact sets status BLOCKED. |

Evidence status vocabulary is exact: `PASS`, `RED observed`, `UNVERIFIED`, `BLOCKED`, `DONE`.
A green-only command is `UNVERIFIED`; an unexecuted external/hardware/release row is `BLOCKED`,
never `PASS`.

## Migration / Cutover

| Owner | From | To | Criteria | Recovery | Rollback |
|---|---|---|---|---|---|
| Runtime dependency maintainer | Inline downloader URL/version authority, mutable `stb/master`, direct extraction, and non-wgpu cache skips | Reviewed `native-deps.lock.json`, verify-before-extract transaction, and receipts | Phase 1 gates and manual checksum/license bootstrap review pass for the complete real matrix | Keep the last verified untracked cache read-only, correct the lock or transaction in a new review, then re-run acquisition; never “fix” by recording the received bad hash | Revert the Phase 1 commit as one unit and return to the prior source-build behavior; do not publish or claim provenance while rolled back |
| Runtime release maintainer | PRD-048 runtime assets plus `prebuilt-lock.json`, without dependency compliance/input linkage | Same PRD-048 artifacts plus lock copy, receipts, SBOM, license inventory and provenance URL/manifest | Phase 2/3 gates pass and a same-SHA prerelease stages the exact expected set | Leave the prerelease unpromoted, retain logs, repair generation/receipt mismatch, and rerun at a new candidate/tag according to PRD-048 policy | Invoke PRD-048's existing failed-prerelease cleanup; do not delete a successful prior release or alter consumer installer fallback behavior |
| PRD manager | Active production-readiness artifact with unchecked criteria | One moved artifact under `docs/PRDs/done/` plus verification ledger | All acceptance boxes checked, final checkpoint passed, same finishing commit contains `git mv` | If external release evidence disappears or is invalidated before finish, keep the active path and mark BLOCKED | Revert the finishing move/status commit; restore the active path with the invalidated criterion unchecked |

Cutover is all-or-nothing. The downloader must not consult both an inline and locked authority, and
the release must not publish a provenance URL before the referenced artifacts exist.

## Verification Commands

Implementation checkpoints run these commands from the repository root and record exact output;
they are specified, not claimed as executed by this author lane:

1. `pnpm --filter @threenative/runtime-native deps:verify` — schema and complete target/variant
   resolution only; no fetch or native toolchain.
2. `pnpm --filter @threenative/runtime-native exec vitest run tests/dependency-provenance.test.mjs tests/native-sbom.test.mjs tests/native-platform-workflow.test.mjs` — focused unit/integration and release-wiring gates.
3. `pnpm --filter @threenative/runtime-native deps:sbom` followed by
   `pnpm --filter @threenative/runtime-native deps:sbom:check` — generate and byte-check ignored
   compliance outputs from the real lock.
4. `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets && pnpm sync:agents --check` — default
   repository gate; must remain green without CMake, NDK, Xcode or Rust.
5. `git diff --check && test -z "$(git ls-files packages/runtime-native/third_party)"` — whitespace
   and hard untracked-third-party invariant.

The hosted release command is the existing tag-gated workflow, not a new local release command.
Its exact run URL, source SHA, tag, runner matrix and artifact hashes belong in the evidence ledger.
No push, tag, release, publish, signing, or promotion is authorized by this planning artifact.

## Rollback and Kill Conditions

- Kill the lock design if a selectable URL can be produced without a pre-existing reviewed entry,
  or if any checksum is learned and accepted from the same build that consumes it.
- Kill the transaction abstraction if a tampered payload can invoke an extractor/mounter/copier,
  alter an existing dependency destination, or leave a success-looking receipt.
- Kill/rewrite the generator if its output is nondeterministic for identical inputs, omits a
  selected component/license, embeds workstation paths/secrets, or requires a native toolchain in
  the default gate.
- Roll back release wiring if it changes PRD-048 installer semantics, requires a second release
  mechanism, publishes partial provenance, or can cite a workflow/SHA other than the subject's.
- Stop and mark BLOCKED if an upstream artifact has no immutable source identity, trustworthy
  expected digest bootstrap, or license evidence. Removing the dependency or selecting an
  auditable upstream is allowed only as a separately reviewed implementation decision.
- Any tracked `third_party/` file, new package, silenced native LOC trigger, or claim of physical,
  signed, published, promoted, mobile-ready, or production-ready evidence from this PRD fails the
  scope checkpoint and must be reverted.

## Verification Evidence

Contract conformance: prd_contract: v1

- Authoring validator: `CONFORMING`; installed `linchpin.sh contract` exited `0` on 2026-08-09.
- Output whitespace check: `git diff --check -- <output>` exited `0` on 2026-08-09.
- Implementation/runtime/hardware/release gates: not run; this is planning-only evidence and
  makes no PASS claim for them.
