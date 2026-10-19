# @threenative/playtest

Run a schema-version-1 browser scenario against any development URL:

```bash
npx @threenative/playtest playtests/movement.playtest.json \
  --url http://127.0.0.1:5173 --server-command "npm run dev"
```

Install the bridge from `@threenative/playtest/three` when semantic entity, camera,
movement, or visibility assertions are required. Browser-only input, screenshot,
DOM, console, network, and trace evidence does not require an adapter. Run
`npx @threenative/playtest init` to create a config, smoke scenario, and adapter
example without changing application source.

Pass chromium flags with `--browser-arg`, repeated once per flag. A WebGPU
target does not start without them:

```bash
npx @threenative/playtest playtests/movement.playtest.json \
  --url http://127.0.0.1:5173 \
  --browser-arg --enable-unsafe-webgpu \
  --browser-arg --enable-features=Vulkan
```

## Doctor

```sh
npx @threenative/playtest doctor --text              # can this machine run a playtest?
npx @threenative/playtest doctor --url <url> --text  # and what is in the game running there
```

## Native targets

The same scenario format runs through `--target browser`, `--target android`, `--target desktop`,
or `--target ios`. A desktop run launches a caller-supplied packaged native game executable,
creates a temporary local mailbox, and removes it with the child process when the run ends:

```bash
npx @threenative/playtest playtests/device-smoke.playtest.json \
  --target desktop --executable .threenative/build/ThreeNative
```

The native host receives the mailbox root through `TN_PLAYTEST_MAILBOX_ROOT` and injects the
shared `TN_PLAYTEST_MAILBOX` global before evaluating the game entry, so the game source is
unchanged. `--live-clock` on the desktop target also passes `TN_PLAYTEST_CLOCK=wall-clock`, which
the host reads before that same entry. On Linux without a display, prefix the command with
`sh scripts/xvfb.sh`.

An iOS simulator run installs a built app, launches it with `simctl`, and
uses the app data-container mailbox:

```bash
npx @threenative/playtest playtests/device-smoke.playtest.json \
  --target ios --app build/threenative-ios.app \
  --bundle-id dev.threenative.runtime --device booted
```

For a signed physical build, add `--ios-transport device --device <devicectl-id>`.
Network, DOM, and `assert.visual` assertions are unsupported on device targets and fail
`TN_PLAYTEST_UNSUPPORTED_ON_TARGET` with exit code 2. Default CI does not run Android or
iOS device scenarios. `.github/workflows/native-platforms.yml` is an explicit opt-in
platform lane; an absent run is not a pass.

## What a passing run means

A scenario only reports `pass` when at least one assertion was evaluated
against an observation that actually arrived. Assertions fail closed: a missing
entity, an absent resource, an empty effect log, or a scenario with no
assertions at all is a failure, never a silent pass. Wrong-typed assertion
values are rejected when the scenario loads rather than dropped, so a scenario
cannot quietly run with fewer checks than its author wrote.


## Tone gates and offline inspection

`npx @threenative/playtest tone shot.png other.png` prints tab-separated rows for mean, p1, p50,
p99, clip%, black%, plus an unweighted frame-average row. No browser is started. Empty input,
unreadable PNGs and images without visible pixels exit 2 without a partial table.

```json
{ "assert": { "tone": [{ "atStep": "landed", "mean": { "min": 60, "max": 140 }, "p99": { "min": 150 }, "clipFraction": { "max": 0.005 } }] } }
```

`atStep` selects a named step; omission selects the final capture. Every metric takes inclusive
min/max bounds. Empty arrays, empty bounds, non-finite/out-of-range numbers, unknown keys and
reversed ranges fail at load. Missing capture evidence fails TN_PLAYTEST_TONE_UNOBSERVED.
Failed bounds name the measured and required values.

All six metrics use the capture guard's existing PNG decode without downsampling: rounded
Rec.709 display luminance fills 256 bins; mean averages bin values and percentiles use nearest
rank. Clip/black fractions count bins 255/0 and use 0..1 in assertions (percentages in the CLI).
Fully transparent pixels are excluded; other pixels retain stored RGB without compositing.
These numbers measure exposure, not aesthetic quality.


Browser, Android, desktop and iOS scenario captures now record TN_TONE under observations.tone,
even without tone assertions. Explicit tone requests force their captures despite disabled
convenience screenshots. A named step's existing screenshot is reused. This host-side support
is exercised with target-driver fixtures; it does not turn unit tests into native GPU proof.


Repository runtime proof: `pnpm test:tone` builds the isolated calibration fixture and captures
its real WebGPU output at exposure 0.25 and 1. The same assertions must fail then pass. PNGs,
observations, reports and adapter provenance are retained under `artifacts/tone-exposure`; the
summary names the exact source SHA. It also runs after `pnpm test:templates`. The maintained
`integration-tone` workflow permits software WebGPU for pixel correctness only, not native
execution, hardware performance or aesthetic qualification.
