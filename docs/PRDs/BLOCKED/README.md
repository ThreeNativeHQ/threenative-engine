# Blocked PRDs

This folder contains PRDs whose status is explicitly `BLOCKED`. Each reason folder names the
missing evidence, external capability, review outcome, or failing gate that prevents closure.
`NOT STARTED`, `PARTIAL`, `OPEN`, and `PROPOSED` PRDs stay in their owning batch even when a
dependency is not ready.

| Reason | PRDs | What unblocks it |
|---|---|---|
| [`requires-portable-native-residency-consumer/`](requires-portable-native-residency-consumer/) | [PRD-253](requires-portable-native-residency-consumer/PRD-253-content-residency-and-screen-space-hlod.md) | The detached Bistro load-all consumer must resolve the same authored assets on browser and staged Linux native, complete the mandatory native census/capture, and restore or replace the missing canonical census executable with fail-closed tests |
| [`requires-runnable-many-soldier-consumer/`](requires-runnable-many-soldier-consumer/) | [PRD-258](requires-runnable-many-soldier-consumer/PRD-258-many-actors-share-one-animation-texture.md) | A committed Bayview consumer whose configured asset manifest exists, boots from exact current-engine tarballs, installs the playtest bridge, and completes the five pre-registered Phase 0 arms |
| [`requires-parity-rerun/`](requires-parity-rerun/) | [PRD-054](requires-parity-rerun/PRD-054-write-once-run-anywhere.md) | A clean, non-blocked cross-platform parity run |
| [`requires-touch-evidence/`](requires-touch-evidence/) | [PRD-055](requires-touch-evidence/PRD-055-native-hud-reopened.md) | Android touch-playability evidence |
| [`requires-physical-device/`](requires-physical-device/) | [PRD-056](requires-physical-device/PRD-056-physical-mobile-qualification.md), [PRD-366](requires-physical-device/PRD-366-one-consumer-game-proves-supported-platforms.md) | Named physical Android/iOS devices, signed artifacts, and Apple credentials. PRD-360 was filed here on 2026-09-07 and returned to its batch the same day once a Pixel 8 was attached and the measurement ran. PRD-366 was filed here on 2026-09-28 under R6 (all 19 phase and 3 acceptance boxes ticked): it also wants a Windows and a macOS host with registry access and a republished `@threenative/*` cohort, so a phone is necessary but not sufficient. |
| [`review-cap/`](review-cap/) | [PRD-057](review-cap/PRD-057-native-audio-parity.md), [PRD-160](../done/PRD-160-android-emulator-lane-repair-and-parity-adjudication.md) | Specification reopen after the review cap; for PRD-160, an owner-approved parity run that reaches pixel comparison |
| [`requires-physical-proof/`](requires-physical-proof/) | [PRD-058](requires-physical-proof/PRD-058-performance-reliability-observability.md) | Current-candidate physical evidence and marker-control repair |
| [`requires-ray-measurement/`](requires-ray-measurement/) | [PRD-088](requires-ray-measurement/PRD-088-physics-spatial-queries.md) | Authoritative pre-implementation ray measurement |
| [`requires-sealed-proof/`](requires-sealed-proof/) | [PRD-113](requires-sealed-proof/PRD-113-sealed-brief-naming-contract.md), [repair](requires-sealed-proof/PRD-113-repair-sealed-behavior-proof.md) | Positive behavior-based sealed proof |
| [`requires-hosted-run/`](requires-hosted-run/) | [PRD-059](requires-hosted-run/PRD-059-native-dependency-provenance-sbom.md) | One release run with all five build legs green |
| [`requires-evdev-delivery/`](requires-evdev-delivery/) | [PRD-077](requires-evdev-delivery/PRD-077-desktop-multitouch-injector.md) | A host that delivers a kernel input device to the window under test: this user in the `input` group, or the desktop lane on a seated X server instead of Xvfb. The injector itself is built and proved to the kernel boundary |
| [`requires-asan-libuv-source-build/`](requires-asan-libuv-source-build/) | [PRD-184](requires-asan-libuv-source-build/PRD-184-native-shutdown-ownership-transfer.md), [PRD-177](requires-asan-libuv-source-build/PRD-177-native-restart-shutdown-lifetime.md) | A libuv source build wired through `scripts/download-deps.mjs` plus an ASan build configuration for the native runtime, so the shutdown write-after-free can turn a run red; until then its negative control cannot fire |
| [`requires-ios-ecossystem/`](requires-ios-ecossystem/) | [PRD-065](requires-ios-ecossystem/PRD-065-ios-evidence-lane.md) | Physical iOS hardware and signing credentials for the on-device legs; the simulator leg already runs green on the hosted `macos-15` runner after Phase 0 pinned a real iPhone simulator instead of an Apple Vision Pro |
| [`requires-release-credentials/`](requires-release-credentials/) | [PRD-445](requires-release-credentials/PRD-445-public-release-hygiene.md) | An upstream `threenative-sculpt-mcp` release that moves its `sharp` pin off `0.35.3`, and three owner calls on tracked repository junk. Every box in it is ticked; only the `## Blocked on` list is open. Filed here 2026-09-25 under R6. The `CLOUDFLARE_API_TOKEN` item left this list the same day: the owner set both `site-production` secrets and the `site` run on `main` (36063649413) went green |
| [`requires-owner-provider-checkpoint/`](requires-owner-provider-checkpoint/) | [PRD-P2-5](requires-owner-provider-checkpoint/PRD-P2-5-evidence-storage-boundary.md) | An owner checkpoint naming the bulk-evidence provider, credentials source, retention policy, cost bound, and restore owner. Phase 1 (immutable evidence manifests, Git-only) is delivered and green; only provider selection is an owner decision no agent can make |
| [`requires-examples-checkout/`](requires-examples-checkout/) | [PRD-443](requires-examples-checkout/PRD-443-lossless-gltf-flatten-join-instance.md) | A commit in the `ThreeNativeHQ/examples` checkout replacing the five AC-5-verified compacted GLBs, and Midway's own `tools/run-handoff.sh` gates (`check-carrier-cycle`, `check-repair`, `maxPassTriangles`) going green there. No code change is left in this repository: the engine passes, proof and 0.3.4 release all landed. Every box is ticked; only the `## Blocked on` list is open. Filed here 2026-09-25 under R6 |
| [`requires-owner-decision/`](requires-owner-decision/) | [PRD-299](requires-owner-decision/PRD-299-request-decomposition-index.md) | An owner ruling in §0 of the PRD. |

**A PRD whose only remaining work is `## Blocked on` items lives here** (owner decision,
2026-09-25, R6) — it stops reading as live work while the owner can still validate it. A PRD with any
doable work left stays in its owning folder and keeps its blocked items listed, release-critical or
not: `docs/PRDs/production-readiness/critical/` holds what still blocks a release. This supersedes
the 2026-09-23 rule that kept blocked PRDs in `critical/`. PRD-080, PRD-112 and PRD-196 moved the
other way, from this folder to `critical/`.

**Every entry above carries a tier, and the tiers are not the same promise.**
[`ROADMAP.md`](../../strategy/ROADMAP.md) states the split and this folder inherits it: **Tier 1** is
the shipping bar — it renders-the-same, controls and UI green on browser, Linux desktop and the
Android emulator, with performance and soak green on web and native desktop — and **Tier 2** is
deferred, not dropped: physical Android and iOS, real GPU drivers, arm64, frame-rate parity, device
soak and signed distribution. **An emulator result is never a device result**, and no entry here
licenses a mobile-readiness claim by being unblocked into Tier 1. The reason a PRD sits in this
folder is its unlock condition in the table above; the tier says which promise that unlock serves.

**Tier 2 reopens on one thing: a stranger.** The first external user who installs the framework and
asks for a device build starts Tier 2 — concretely, the five-minute stranger test, not a calendar
date. A physical Android device arriving earlier reopens the Android half alone; it does not reopen
iOS.

Moved on 2026-08-15. The old `docs/PRDs/native/blocked/README.md` remains as a native-lane
compatibility pointer; no PRD files remain there.
