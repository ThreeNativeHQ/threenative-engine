# Capture the PRD-477 WorldProbe fixture

From a built workspace, run on a named **hardware WebGPU** adapter. The browser scenario
captures the existing KeyF route at 32 ten-tick checkpoints, plus start and settled-end frames.
The runner records the actual pose, flight time and authored landmarks beside each label.

```sh
CAPTURE="$PWD/artifacts/world-reference"
mkdir -p "$CAPTURE"
node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/phase477-world-capture.playtest.json \
  --url 'http://127.0.0.1:5181/?world' \
  --server-command 'pnpm --filter abyss-framework dev --host 127.0.0.1 --port 5181 --strictPort' \
  --browser-recipe webgpu --headed --artifacts "$CAPTURE" > "$CAPTURE/report.json"
pnpm tsx scripts/world-capture-manifest.ts "$CAPTURE" "$(git rev-parse HEAD)" 30
```

`30` is the review's explicit near-band distance in meters, not a measured memory capacity or
an engine default. Use the same distance on both arms. Repeat with the candidate build and a
fresh directory, then pass both `world-capture.json` files to the
[world visual gate](WORLD-VISUAL-GATE.md):

```sh
pnpm tsx scripts/world-visual-gate.ts \
  --before artifacts/world-reference/world-capture.json \
  --after artifacts/world-candidate/world-capture.json --out artifacts/world-gate
```

Bundle creation exits 2 until the independent judgments described in the linked rubric exist.

Any game that records the same label set and `snapshots.world` fields can produce a manifest for
the same gate: pass `--scenario <name>` and `--world <name>` after the three positional arguments
(both default to `phase477-world-capture` and `WorldProbe`). Only the WorldProbe route asserts the
captured start and end poses; another world must show a walk that actually moved.

The importer requires a passing report, matching `capture.json`, all labels, finite observed
poses and times, unchanged landmarks, and the full route. It never replaces existing evidence.
Same-pose frames are start/08/16/24; the chronological series is start/01 through 32. The settled
end checks route completion and is not duplicated into the timed series. Hardware provenance,
nonblank pixels and independent judgments are enforced by the visual gate. Importing a report
is not visual acceptance, and synthetic unit-test images are not capture evidence.

The sibling `phase477-world-streaming.desktop.playtest.json` and
`phase477-world-streaming.android.playtest.json` retain the original eight forty-tick leg.
Android uses the documented CLI `--target android` override of its `web` schema target.
Native network diagnostics use the runner's explicit target-aware waiver because those hosts
have no network observer; the web capture still requires `noNetworkErrors: true`.
They report actual `state.stats`, peak residency/instances and admission diagnostics; the final
admitted unit may exceed 2 ms, so no hard 2 ms elapsed-time assertion is made. They are pending
native packaging/run proof: this example currently selects `loading-leak-game.ts`; the
`world-native.ts` entry must be packaged and verified before these scenarios can prove that
scene. These files alone do not establish a native, emulator, device, frame-budget or
automatic-budget acceptance result.

On 2026-10-02, `build --target desktop` generated a native bundle but exited 1 with
`TN_UI_ENTRY_MISSING` (`ui.renderer: "web"`, absent `src/ui/main.tsx`). The workspace web build
passed; that result does not cover native packaging or the streaming scenarios.
