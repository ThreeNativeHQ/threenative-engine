# World visual gate: sealed judge protocol

This rubric supplements the visual baseline above. Judge only the supplied blind directory.
Do not inspect source captures, private reveal mappings, build names, previous judgments, or
other critics' answers. A model judgment is not a human blind session. Do not manufacture
verdicts to make a run pass. A synthetic unit test does not prove a real world's appearance.

## Same-pose frames

Score every `samePose` label independently, using the preceding 1–5 visual baseline rubric.
Attend to ground contact, forest-floor and road shadows, lighting, displaced terrain, holes,
and geometry/vegetation continuity. Each frame must reach 4/5. Some frames are intentionally
repeated to measure the instrument's resolution; score what you see, without trying to infer
which frames repeat or which arm they belong to.

## Chronological fixed walk

For each anonymous `walk` series, inspect every adjacent pair in the listed time order and
review the complete sequence. Coordinates are meters. The camera position/target, fixed
landmarks and per-frame camera-to-landmark distances provide metric context for the near band.
Name every element that abruptly appears, disappears, or swaps LOD. Events caused solely by
normal occlusion, entering/leaving the field of view, or continuous animation are not popping.
Report other visible popping even outside the near band. Distance means camera-to-element
world-space distance at the transition, not screen-space distance. Use the supplied landmark
context; if a transition or its distance cannot be judged, do not submit a complete verdict.
The run remains unjudged until complete reliable evidence is available.

Every transition must appear exactly once in chronological order, including transitions
with no popping (`events: []`). Every event requires an identifiable element, kind, distance
in meters, and a description locating the change in the frames. Do not infer absence from
missing data. The candidate fails if any critic reports popping at or inside `nearBandMeters`.
A reference-arm event is reported but does not by itself fail the candidate. With multiple runs
per side, a candidate event counts only when the same critic reports it in every candidate run
and in no reference run; an event the reference shows too is run-to-run noise, not a regression.
Candidate-only events reported in some but not all candidate runs appear in score JSON as
`intermittent: [{critic, series, kind, distanceMeters, candidateRuns, referenceRuns}]`.
Run counts are distinct captures reported by the same critic for the same transition, kind and
element; each entry names a reporting candidate series. An event at or inside the near band,
or of kind `missing`/`disappear` at any distance, makes the verdict `inconclusive` (exit 2,
`reason: "needs more runs"`) unless a measured regression already requires exit 1. Score with
`--allow-intermittent` to permit a pass despite these events; they remain in the JSON and the
flag never overrides a measured regression. Other intermittent events retain the usual verdict.

A bundle may carry more than two anonymous series: a side is captured more than once because
streaming arrival makes a single run unreliable. Judge every series on its own. When comparing
series to each other, the numbers are anonymous and the pairing is hidden, so there is no
"the other series" to single out.

## Content one series never draws

Then compare the series pairwise at the same walk index. Content that is absent for the whole
route produces no transition at all, so this is the only place its absence can be seen: a band
of forest, a building, a shadow one series draws and another does not. Report it as `missing`
in the series that lacks it, naming one frame id from the series that draws it, this series'
frame id at the same walk index, the element, and the camera-to-element distance you can infer
from the landmark context. Use `missing: []` when a series draws the same content at every
index as the series you compared it with. Report these even far outside the near band; the near
band is not a licence to look away.

## Verdict file

Each of three independent critics submits one JSON file. Copy `promptSha256` from bundle.json
and compute `bundleSha256` as the SHA-256 of the exact bundle.json bytes. Choose a distinct
critic identity. Do not exchange results. The file shape is:

```json
{
  "critic": "unique-critic-identity",
  "bundleSha256": "sha256-of-bundle.json",
  "promptSha256": "copied-from-bundle.json",
  "samples": [{"label": "sample-01", "visuals": 4}],
  "series": [{
    "label": "series-1",
    "transitions": [{
      "from": "frame-001", "to": "frame-002",
      "events": [{
        "element": "pine left of road beside landmark tree-4",
        "kind": "lod-swap",
        "distanceMeters": 12,
        "description": "The upper silhouette abruptly loses its left branch."
      }]
    }],
    "missing": [{
      "element": "forest band beyond the highway",
      "kind": "missing",
      "from": "frame-032", "to": "frame-032",
      "distanceMeters": 300,
      "description": "The other series draws this band at this walk index; this series draws sky."
    }]
  }]
}
```

This shape illustrates the schema only, not an actual judgment. Supply every sample, series
and transition from the bundle. Transition events take the kinds `appear`, `disappear` and
`lod-swap`; `missing` is only valid in the cross-series list, where `from` is the other
series' frame id at that walk index and `to` this series' frame id, and both are required.

## Capture contract and command

Use the existing playtest runner with its WebGPU browser recipe, named hardware adapter,
labeled screenshots and actual observed camera positions. Do not substitute synthetic images,
software rendering, idealized poses, or a scene's configured camera for captured observations.
Each arm's manifest has schemaVersion 1, nonempty world/build/route/seed strings,
positive nearBandMeters, a relative capture path to runner capture.json, and nonempty
landmarks [{id, position:[x,y,z]}], samePose [{id,image,position,target}], and
walk [{id,image,timeMs,position,target}]. Walk requires at least two chronological frames and
actual camera movement. Frame IDs, positions, targets, walk times, landmarks, route, seed,
world and near-band distance must match across arms and across runs on one arm. Each image must
match the capture viewport.

Capture two or more runs per side: repeat `--before` and `--after`. With two runs on each side
the gate measures the reference's own run-to-run spread and counts a candidate event only when
every candidate run reports it and no reference run does. One run per side has no spread to
measure, so any candidate near-band event fails.

```sh
pnpm visuals:world --before reference/world.json --before reference/world-2.json \
  --after candidate/world.json --after candidate/world-2.json --out artifacts/world-gate
pnpm visuals:world --score artifacts/world-gate --verdict critic-1.json --verdict critic-2.json --verdict critic-3.json
```

Only share artifacts/world-gate/blind with critics. Keep the rest private until judging is
complete. Bundle-only exits 2 (unjudged); inconclusive, malformed, missing, stale or mutated evidence also
exits 2. A complete candidate reaches exit 0 only if every same-pose median is at least 4/5,
no same-pose row is a measured LOSS at the duplicate-calibrated resolution, no candidate
near-band popping event is reported, and no candidate `missing` event is reported at any
distance. A measured regression exits 1. The source captures,
provenance, rubric, reveal maps and blinded pixels are hash-bound and must remain available
and unchanged through scoring. A public test world's pass is mechanics evidence; Machinefall's
known shadow regression still needs its own real red/green capture and independent judgments.
