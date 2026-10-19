# Quiet matched gameplay performance

Three ABBA cycles per template, six fresh launches per arm, unchanged 1920×1080 performance scenarios and 33 ms p95 limit. Frozen local framework archives, source/assets/scenario/camera helper identity checks retained. Actual hardware WebGPU NVIDIA Turing, high tier. No owned concurrent builds during timing; external host activity and driver/OS caches uncontrolled. Exact camera snapshots were not requested by these unchanged scenarios: camera helper hashes match, but snapshot equality is unmeasured.

| Template | Original mean per-run p95 (sample sd) | Current mean per-run p95 (sample sd) | Passes original/current |
|---|---|---|---|
| Shooter | 29.23 ms (0.74) | 48.17 ms (2.50) | 6/6 / 0/6 |
| Snow | 33.83 ms (1.26) | 29.72 ms (3.26) | 1/6 / 5/6 |

Shooter has a repeatable whole-current-source regression in this setup; no individual shader/update cause is established. Candidate reports 102 converted materials, measured bright environment radiance ~0.548, extra fill not admitted. Snow retains authored fill with added fillGain zero and 19 conversions; its original template also frequently fails, and the current template is not uniformly below 33 ms. No threshold was changed, no best sample selected, no full-gameplay green claim.

Every per-launch outcome/sample count is in summary.json. Full summaries/source manifests/reports are compressed here; all original full PNGs remain in the durable local performance-controls1 tree, inventoried by image-manifest.json. Failed wrapper imports before measurement were retained separately; they produced no measured samples.

## Historical capture coordination limitation

A reported `held` capture lease establishes ownership within that process's temporary namespace. `defaultCaptureLockRoot()` derives its path from `TMPDIR`; durable-TMPDIR gameplay/native-opening and matched performance runs used private namespaces. We manually serialized our own jobs, but shared global GPU exclusion and external workload isolation were not established for those historical runs. Their measured outcomes remain retained with this limitation; they must not be described as globally exclusive qualification. Future timing runs use an explicit outer existing-API shared `/tmp/threenative-playtest-capture` lease and durable child temps.
