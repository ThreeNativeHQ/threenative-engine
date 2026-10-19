#!/bin/sh
# PRD-VQ-01 Phase 3, web box: cook the unchanged examples/abyss-framework/vq-assets fixture for the
# web target, then run the shared scenario against it in a WebGPU browser.
#
#   sh scripts/vq01-web-proof.sh <artifact-dir>
#
# The web build and its preview server are started here; the browser run is the runner's job and
# is the one step whose result this script cannot report for you.
set -eu

artifacts=${1:?usage: sh scripts/vq01-web-proof.sh <artifact-dir>}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# The authored sources the cook reads: real Meshopt and Draco GLBs plus the PNG it transcodes to
# KTX2. The native verifier generates them through the same function, so both targets cook the
# same inputs instead of two sets that can drift.
node --import tsx -e '
const { generateNativeAssetFixture } = await import("./examples/abyss-framework/vq-assets/generate.ts");
await generateNativeAssetFixture("examples/abyss-framework/vq-assets/.generated/assets");
'

# The web target build: cooks .generated/assets into .generated/public and publishes dist/.
(cd examples/abyss-framework/vq-assets && node "$root/packages/create-threenative/dist/threenative.js" build)

# `pnpm --dir` runs the vite that examples/abyss-framework already installs, with the fixture as
# its root; the runner owns the server lifecycle and probes 5193 for readiness.
node packages/playtest/dist/runner/cli.js \
  examples/abyss-framework/playtests/vq-native-asset-capabilities.playtest.json \
  --url http://127.0.0.1:5193/ \
  --server-command 'pnpm --dir examples/abyss-framework exec vite preview vq-assets --host 127.0.0.1 --port 5193 --strictPort' \
  --browser-recipe webgpu \
  --headed \
  --artifacts "$artifacts"