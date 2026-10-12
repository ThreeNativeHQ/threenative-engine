# Charter amendment log

The [Charter](CHARTER.md) is the binding document. This file records how it changed, so the
Charter itself can state the current rule without carrying its own diff history.

| Date | Sections | Change |
| --- | --- | --- |
| 2026-08-02 | all | Adopted as binding. Supersedes the predecessor project (`threejs-to-bevy`, abandoned 2026-08-02 after ~790k lines in 7 weeks). |
| 2026-08-17 | §3, §5, §5b, §11.1 | The 20-line size rule is replaced by the two questions in §11.1. §5b splits mechanism from appearance. The kill switch and the closed list are unchanged. |
| 2026-08-22 | §1, §11 | Performance becomes a shipped default bounded by §5b, §11.2 and §10a, not a tuning pass left to each game. |
| 2026-08-24 | §4, §6b | React UI may opt into the isolated `@threenative/core/react` subpath; the vanilla main entry and scene graph stay React-free. |
| 2026-08-24 (PRD-217) | §6b | One UI layer — the same React DOM, Tailwind, CSS and SVG on every target, through the platform's own browser-class renderer. The quad renderer becomes the opt-in. The old rule assumed embedding a browser meant shipping one; a measured Pixel 8 run showed the platform composites its own for free. |
| 2026-08-31 (PRD-314) | §5b | Pose conformance measurement is named as mechanism, on the same footing as the tracer and instancing entries. |
| 2026-09-02 | all | Condensed. Rationale that had been restated across sections is stated once; open work and known limitations move to [`CURRENT-CHALLENGES.md`](../CURRENT-CHALLENGES.md). No rule changed. |
| 2026-09-05 | §1 | Added the out-of-the-box principle: ordinary games work without configuration pain, and configuration remains an escape hatch rather than a prerequisite. |
| 2026-09-30 (PRDs 466–468) | §2, §9a, §11.5 | Owner-approved optional Strata terrain-authoring addon, editable terrain documents and terrain-only authoring companions; baked runtime data and game-owned appearance, with no general game editor or runtime recipe/scene format. |
