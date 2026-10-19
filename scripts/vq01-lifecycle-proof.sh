#!/bin/sh
# PRD-VQ-01 AC-2 lifecycle box: cook the unchanged examples/abyss-framework/vq-assets fixture for one
# target, then run the leave/re-enter scenario against it. Identical to vq01-web-proof.sh and
# vq01-android-proof.sh except for the scenario both of those name; the scenario's own first step
# presses the fixture's lifecycle key, and both runners deliver a press step as the same keydown, so
# the fixture leaves and re-enters on web and on the device without a URL and without a harness flag.
#
#   sh scripts/vq01-lifecycle-proof.sh <artifact-dir> web
#   sh scripts/vq01-lifecycle-proof.sh <artifact-dir> android <serial>
set -eu

artifacts=${1:?usage: sh scripts/vq01-lifecycle-proof.sh <artifact-dir> web | android <serial>}
target=${2:?usage: sh scripts/vq01-lifecycle-proof.sh <artifact-dir> web | android <serial>}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

scenario=examples/abyss-framework/playtests/vq-native-asset-lifecycle.playtest.json

# The authored sources the cook reads, through the same generator every VQ-01 lane uses.
node --import tsx -e '
const { generateNativeAssetFixture } = await import("./examples/abyss-framework/vq-assets/generate.ts");
await generateNativeAssetFixture("examples/abyss-framework/vq-assets/.generated/assets");
'

case "$target" in
web)
  # The web target build: cooks .generated/assets into .generated/public and publishes dist/.
  (cd examples/abyss-framework/vq-assets && node "$root/packages/create-threenative/dist/threenative.js" build)
  # The runner owns the preview server lifecycle and probes 5193 for readiness.
  node packages/playtest/dist/runner/cli.js "$scenario" \
    --url http://127.0.0.1:5193/ \
    --server-command 'pnpm --dir examples/abyss-framework exec vite preview vq-assets --host 127.0.0.1 --port 5193 --strictPort' \
    --browser-recipe webgpu \
    --headed \
    --artifacts "$artifacts"
  ;;
android)
  serial=${3:?usage: sh scripts/vq01-lifecycle-proof.sh <artifact-dir> android <serial>}
  # adb and the SDK are usually installed but off PATH; Gradle and Kotlin want JDK 17, and the
  # Android slice is one ABI so the emulator's x86_64 runtime is the only one this build needs.
  : "${ANDROID_HOME:=$HOME/Android/Sdk}"
  : "${JAVA_HOME:=/usr/lib/jvm/java-17-openjdk}"
  PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
  export PATH JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$ANDROID_HOME}
  adb -s "$serial" get-state >/dev/null
  (
    cd examples/abyss-framework/vq-assets
    THREENATIVE_RUNTIME_SOURCE="$root/packages/runtime-native" \
    THREENATIVE_GRADLE_ARGS="-PthreenativeJsEngine=v8 -PthreenativeAbis=x86_64" \
      node "$root/packages/create-threenative/dist/threenative.js" build --target android --allow-source-build
  )
  apk=examples/abyss-framework/vq-assets/dist-native/vq-native-assets.apk
  adb -s "$serial" install -r --no-streaming "$apk"
  node packages/playtest/dist/runner/cli.js "$scenario" \
    --target android \
    --device "$serial" \
    --package com.threenative.vq01 \
    --activity com.threenative.runtime.MystralActivity \
    --adb "$ANDROID_HOME/platform-tools/adb" \
    --artifact "$apk" \
    --build-report "$apk.build-report.json" \
    --timeout 120000 \
    --artifacts "$artifacts"
  ;;
*)
  echo "unknown target '$target'; expected web or android" >&2
  exit 2
  ;;
esac